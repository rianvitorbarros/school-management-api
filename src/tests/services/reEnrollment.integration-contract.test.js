const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../api/services/reEnrollment.service');
const Student = require('../../api/models/student.model');
const Tutor = require('../../api/models/tutor.model');
const Enrollment = require('../../api/models/enrollment.model');
const Class = require('../../api/models/class.model');
const Progression = require('../../api/models/academicProgression.model');
const Request = require('../../api/models/reEnrollmentRequest.model');
const pricing = require('../../api/services/academicMonthlyFeePlan.service');

async function fixture({ grade, className, rules, classes = [], price = null, blocked = false }, run) {
  const originals = [Student.findOne, Tutor.findOne, Enrollment.findOne, Class.find, Progression.find, Request.findOne, pricing.publishedForDestination, service._assertGuardianLink, service._financialState];
  Student.findOne = () => ({ select: () => ({ lean: async () => ({ _id: 'student', fullName: 'Aluno' }) }) });
  Tutor.findOne = () => ({ select: () => ({ lean: async () => ({ _id: 'tutor' }) }) });
  Enrollment.findOne = () => ({ populate: () => ({ lean: async () => ({ _id: 'enrollment', class: { _id: 'class', name: className, grade, level: 'Educação Infantil', shift: 'Vespertino' } }) }) });
  Class.find = () => ({ sort: () => ({ lean: async () => classes }) });
  Progression.find = () => ({ lean: async () => rules });
  Request.findOne = () => ({ sort: () => ({ lean: async () => null }) });
  pricing.publishedForDestination = async () => price;
  service._assertGuardianLink = async () => ({});
  service._financialState = async () => ({ blocked, count: blocked ? 6 : 0 });
  try { await run(await service._buildEligibility({ schoolId: 'school', accountId: 'account', tutorId: 'tutor', studentId: 'student', period: { academicYearFrom: 2026, academicYearTo: 2027 } })); }
  finally { [Student.findOne, Tutor.findOne, Enrollment.findOne, Class.find, Progression.find, Request.findOne, pricing.publishedForDestination, service._assertGuardianLink, service._financialState] = originals; }
}

test('explicit first-period progression supersedes the collapsed legacy terminal rule', async () => {
  await fixture({ grade: 'PERIODO', className: 'I PERIODO B', rules: [{ fromGrade: 'PERIODO', progressionType: 'TERMINAL' }, { fromGrade: '1º Período', toGrade: '2º Período', progressionType: 'NEXT_GRADE' }], classes: [{ _id: 'next', name: 'II PERIODO B', grade: 'PERIODO', shift: 'Vespertino' }], price: { cents: 35000, value: 350, versionId: 'plan', version: 2 } }, async result => {
    assert.equal(result.eligibility, 'ELIGIBLE');
    assert.equal(result.suggestedNextClass._id, 'next');
    assert.equal(result.suggestedNextGrade.grade, '2º Período');
    assert.equal(service._serializeEligibility(result).publishedMonthlyFeeCents, 35000);
  });
});
test('financial block is returned even when pricing has a separate configuration issue', async () => {
  await fixture({ grade: 'PERIODO', className: 'I PERIODO B', rules: [{ fromGrade: '1º Período', toGrade: '2º Período', progressionType: 'NEXT_GRADE' }], blocked: true }, async result => {
    assert.equal(result.eligibility, 'NO_PUBLISHED_MONTHLY_FEE');
    assert.deepEqual(service._serializeEligibility(result).financial, { blocked: true, count: 6 });
  });
});
test('a legacy terminal progression remains terminal until an explicit school rule exists', async () => {
  await fixture({ grade: 'PERIODO', className: 'I PERIODO B', rules: [{ fromGrade: 'PERIODO', progressionType: 'TERMINAL' }] }, async result => {
    assert.equal(result.eligibility, 'TERMINAL_PROGRESSION');
    assert.equal(result.suggestedNextGrade, null);
  });
});
test('effectivation accepts the correct legacy second-period class and rejects the first', async () => {
  const originalClass = Class.findOne;
  const originalEnrollment = Enrollment.findOne;
  const target = { _id: 'target', schoolYear: 2027, level: 'Educação Infantil', grade: 'PERIODO', name: 'II PERIODO B' };
  Class.findOne = () => ({ lean: async () => target });
  Enrollment.findOne = async () => ({ _id: 'existing', class: 'target' });
  try {
    const request = { studentId: 'student', academicYearTo: 2027, targetGradeName: '2º Período', targetLevelName: target.level, monthlyFeeSnapshotCents: 35000 };
    const result = await service._createTargetEnrollment(request, 'school', 'staff', 'target');
    assert.equal(result.enrollment._id, 'existing');
    assert.equal(request.monthlyFeeSnapshotCents, 35000);
    assert.equal(request.targetClassSnapshot.grade, '2º Período');
    target.name = 'I PERIODO B';
    await assert.rejects(service._createTargetEnrollment({ ...request, approvalEnrollmentId: null }, 'school', 'staff', 'target'), error => error.code === 'INVALID_TARGET_CLASS');
  } finally { Class.findOne = originalClass; Enrollment.findOne = originalEnrollment; }
});
