const test = require('node:test');
const assert = require('node:assert/strict');
const Registration = require('../../api/models/registration-request.model');
const AuditLog = require('../../api/models/auditLog.model');
const service = require('../../api/services/registration-request.service');

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
