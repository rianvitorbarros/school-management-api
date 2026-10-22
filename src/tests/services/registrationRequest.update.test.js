const test = require('node:test');
const assert = require('node:assert/strict');
const Registration = require('../../api/models/registration-request.model');
const AuditLog = require('../../api/models/auditLog.model');
const service = require('../../api/services/registration-request.service');
const acquireLock = service._acquireSchoolMutationLock;
const releaseLock = service._releaseSchoolMutationLock;
test.beforeEach(() => { service._acquireSchoolMutationLock = async () => 'test'; service._releaseSchoolMutationLock = async () => {}; });
test.afterEach(() => { service._acquireSchoolMutationLock = acquireLock; service._releaseSchoolMutationLock = releaseLock; });

test('edits a pending request with validation and records its audit trail', async () => {
  const originalFindOne = Registration.findOne;
  const originalAuditCreate = AuditLog.create;
  const request = {
    _id: '507f1f77bcf86cd799439012',
    school_id: '507f1f77bcf86cd799439011',
    status: 'PENDING',
    registrationType: 'MINOR_STUDENT',
    studentData: { fullName: 'Ana', birthDate: new Date('2018-01-01'), parents: { mother: { fullName: 'Maria', email: 'maria@old.test' } } },
    tutorData: { fullName: 'Maria', cpf: '529.982.247-25', email: 'maria@old.test' },
    markModified() {},
    toObject() { return { studentData: this.studentData, tutorData: this.tutorData }; },
    async save() { return this; },
  };
  const auditEntries = [];
  Registration.findOne = async () => request;
  AuditLog.create = async (entry) => { auditEntries.push(entry); return entry; };
  try {
    const updated = await service.updateRequestData(
      '507f1f77bcf86cd799439012',
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439013',
      { studentData: { birthDate: '2017-02-03', parents: { mother: { phoneNumber: '(94) 99999-9999' } } } }
    );
    assert.equal(updated.studentData.birthDate, '2017-02-03');
    assert.equal(updated.studentData.parents.mother.fullName, 'Maria');
    assert.equal(updated.studentData.parents.mother.phoneNumber, '(94) 99999-9999');
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0].reason, 'REGISTRATION_REQUEST_EDITED_BEFORE_APPROVAL');
  } finally {
    Registration.findOne = originalFindOne;
    AuditLog.create = originalAuditCreate;
  }
});

test('does not edit an approved request', async () => {
  const originalFindOne = Registration.findOne;
  Registration.findOne = async () => ({ status: 'APPROVED' });
  try {
    await assert.rejects(
      service.updateRequestData('id', 'school', 'actor', { studentData: { fullName: 'Ana' } }),
      (error) => error.statusCode === 409
    );
  } finally {
    Registration.findOne = originalFindOne;
  }
});

test('changes year and class together and clears incompatible offer', async () => {
  const originalFind = Registration.findOne;
  const originalClass = service._getSelectableClassOrThrow;
  const originalResolve = service._resolveDestination;
  const originalAudit = AuditLog.create;
  const oldClass = '507f1f77bcf86cd799439012';
  const newClass = '507f1f77bcf86cd799439014';
  const request = {
    _id: '507f1f77bcf86cd799439015', status: 'PENDING',
    registrationType: 'MINOR_STUDENT', academicYearTo: 2026,
    selectedClassId: oldClass, selectedClassSnapshot: { schoolYear: 2026 },
    selectedEnrollmentOfferId: '507f1f77bcf86cd799439016',
    requestedPermanenceClassId: oldClass, requestedRegime: 'full_time',
    studentData: { fullName: 'Ana' }, tutorData: { fullName: 'Maria' },
    toObject() { return { ...this }; }, markModified() {}, async save() { return this; },
  };
  let audit;
  Registration.findOne = async () => request;
  service._getSelectableClassOrThrow = async () => ({ classDoc: { _id: newClass, schoolYear: 2027 }, snapshot: { schoolYear: 2027, name: 'Destino' } });
  service._resolveDestination = async (_, year) => { if (year !== 2027) throw Object.assign(new Error('year mismatch'), { statusCode: 409 }); return service._getSelectableClassOrThrow(); };
  AuditLog.create = async (entry) => { audit = entry; };
  try {
    await assert.rejects(service.updateRequestData('id', 'school', 'actor', { academicYearTo: 2026, selectedClassId: newClass }), e => e.statusCode === 409);
    assert.equal(request.academicYearTo, 2026);
    const updated = await service.updateRequestData('id', 'school', 'actor', { academicYearTo: 2027, selectedClassId: newClass });
    assert.equal(updated.academicYearTo, 2027);
    assert.equal(updated.selectedClassId, newClass);
    assert.equal(updated.selectedClassSnapshot.schoolYear, 2027);
    assert.equal(updated.selectedEnrollmentOfferId, undefined);
    assert.equal(updated.requestedPermanenceClassId, undefined);
    assert.equal(updated.studentData.fullName, 'Ana');
    assert.equal(updated.tutorData.fullName, 'Maria');
    assert.equal(audit.changes.previous.selectedClassId, oldClass);
    assert.equal(audit.changes.current.selectedClassId, newClass);
  } finally {
    Registration.findOne = originalFind;
    service._getSelectableClassOrThrow = originalClass;
    service._resolveDestination = originalResolve;
    AuditLog.create = originalAudit;
  }
});
