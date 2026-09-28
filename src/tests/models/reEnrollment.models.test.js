const test = require('node:test');
const assert = require('node:assert/strict');

const ReEnrollmentPeriod = require('../../api/models/reEnrollmentPeriod.model');
const ReEnrollmentRequest = require('../../api/models/reEnrollmentRequest.model');
const AcademicProgression = require('../../api/models/academicProgression.model');

test('re-enrollment period only accepts consecutive academic years', async () => {
  const period = new ReEnrollmentPeriod({ school_id: '507f1f77bcf86cd799439011', academicYearFrom: 2026, academicYearTo: 2028, startDate: new Date('2026-09-01'), endDate: new Date('2026-12-31') });
  await assert.rejects(period.validate(), /ano seguinte/i);
});

test('request protects one pending re-enrollment per student and target year', () => {
  const index = ReEnrollmentRequest.schema.indexes().find((entry) => entry[1].name === 'uniq_pending_reenrollment_per_student_year');
  assert.ok(index);
  assert.deepEqual(index[0], { school_id: 1, studentId: 1, academicYearTo: 1 });
  assert.deepEqual(index[1].partialFilterExpression, { status: 'PENDING' });
});

test('academic progression is scoped to the school and grade source', () => {
  const index = AcademicProgression.schema.indexes().find((entry) => entry[1].name === 'uniq_school_academic_progression_source');
  assert.ok(index);
  assert.deepEqual(index[0], { school_id: 1, level: 1, fromGrade: 1 });
});

test('academic progression rejects the same source and destination grade', async () => {
  const progression = new AcademicProgression({ school_id: '507f1f77bcf86cd799439011', level: 'Ensino Fundamental I', fromGrade: '5º Ano', toGrade: '5º Ano' });
  await assert.rejects(progression.validate(), /não pode ser igual/i);
});

test('terminal progression does not require a fictional destination grade', async () => {
  const progression = new AcademicProgression({ school_id: '507f1f77bcf86cd799439011', level: 'Ensino Fundamental II', fromGrade: '9º Ano', progressionType: 'TERMINAL' });
  await progression.validate();
  assert.equal(progression.toGrade, null);
});

test('period exposes a unique open-period index per target year', () => {
  const index = ReEnrollmentPeriod.schema.indexes().find((entry) => entry[1].name === 'uniq_open_reenrollment_period_per_target_year');
  assert.ok(index);
  assert.deepEqual(index[0], { school_id: 1, academicYearTo: 1 });
  assert.deepEqual(index[1].partialFilterExpression, { status: 'OPEN' });
});
