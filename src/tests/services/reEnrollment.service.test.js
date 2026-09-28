const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../../api/services/reEnrollment.service');
const Invoice = require('../../api/models/invoice.model');
const ReEnrollmentPeriod = require('../../api/models/reEnrollmentPeriod.model');
const GuardianAccessLink = require('../../api/models/guardianAccessLink.model');

const schoolId = '507f1f77bcf86cd799439011';
const studentId = '507f1f77bcf86cd799439012';
const accountId = '507f1f77bcf86cd799439013';
const tutorId = '507f1f77bcf86cd799439014';

test('financial eligibility only queries overdue open invoices', async () => {
  const originalFind = Invoice.find;
  let filter;
  Invoice.find = (query) => { filter = query; return { select: () => ({ lean: async () => [] }) }; };
  try {
    const result = await service._financialState(schoolId, studentId);
    assert.deepEqual(result, { blocked: false, count: 0 });
    assert.equal(filter.school_id, schoolId);
    assert.equal(filter.student, studentId);
    assert.ok(filter.dueDate.$lt instanceof Date);
    assert.deepEqual(filter.status.$nin, ['paid', 'canceled']);
  } finally { Invoice.find = originalFind; }
});

test('a matching overdue open invoice blocks re-enrollment', async () => {
  const originalFind = Invoice.find;
  Invoice.find = () => ({ select: () => ({ lean: async () => [{ _id: 'invoice-1' }] }) });
  try { assert.deepEqual(await service._financialState(schoolId, studentId), { blocked: true, count: 1 }); }
  finally { Invoice.find = originalFind; }
});

test('a closed period rejects guardian request before any enrollment mutation', async () => {
  const originalFindOne = ReEnrollmentPeriod.findOne;
  ReEnrollmentPeriod.findOne = () => ({ sort: async () => null });
  try {
    await assert.rejects(service.createGuardianRequest({ schoolId, accountId, tutorId, studentId }), (error) => error.code === 'RE_ENROLLMENT_PERIOD_CLOSED');
  } finally { ReEnrollmentPeriod.findOne = originalFindOne; }
});

test('a guardian without an active link cannot request for another student', async () => {
  const originalPeriod = ReEnrollmentPeriod.findOne;
  const originalLink = GuardianAccessLink.findOne;
  ReEnrollmentPeriod.findOne = () => ({ sort: async () => ({ _id: '507f1f77bcf86cd799439015', academicYearFrom: 2026, academicYearTo: 2027 }) });
  GuardianAccessLink.findOne = () => ({ lean: async () => null });
  try {
    await assert.rejects(service.createGuardianRequest({ schoolId, accountId, tutorId, studentId }), (error) => error.code === 'GUARDIAN_STUDENT_FORBIDDEN');
  } finally { ReEnrollmentPeriod.findOne = originalPeriod; GuardianAccessLink.findOne = originalLink; }
});

test('readiness is safely incomplete when no period is configured', async () => {
  const originalFindOne = ReEnrollmentPeriod.findOne;
  ReEnrollmentPeriod.findOne = () => ({ sort: () => ({ lean: async () => null }) });
  try {
    const result = await service.readiness(schoolId);
    assert.equal(result.periodConfigured, false);
    assert.equal(result.ready, false);
    assert.equal(result.issues[0].code, 'PERIOD_NOT_CONFIGURED');
  } finally { ReEnrollmentPeriod.findOne = originalFindOne; }
});
