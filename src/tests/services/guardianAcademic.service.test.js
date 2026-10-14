const test = require('node:test');
const assert = require('node:assert/strict');
const { GuardianAcademicService, termNumber } = require('../../api/services/guardianAcademic.service');
const { GuardianAuthService } = require('../../api/services/guardianAuth.service');

const sid = '111111111111111111111111', studentId = '222222222222222222222222', classId = '333333333333333333333333';
const accountId = '444444444444444444444444', yearId = '555555555555555555555555', enrollmentId = '666666666666666666666666';
const termId = '777777777777777777777777', subjectId = '888888888888888888888888', teacherId = '999999999999999999999999';
const fieldId = value => String(value?._id || value || '');
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => value?.$in
    ? value.$in.map(fieldId).includes(fieldId(row[key])) : fieldId(row[key]) === fieldId(value));
}
function model(rows, queries) {
  const query = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, lean() { return Promise.resolve(value); } });
  return { find(filter) { queries.push(filter); return query(rows.filter(r => matches(r, filter))); },
    findOne(filter) { queries.push(filter); return query(rows.find(r => matches(r, filter)) || null); } };
}
function fixture(options = {}) {
  const queries = [];
  const period = { _id: termId, school_id: sid, anoLetivoId: yearId, tipo: 'Letivo', titulo: '2º Bimestre', dataInicio: '2026-05-01', dataFim: '2026-06-30T23:59:59Z' };
  const subject = { subjectId, teacherId, teacherNameSnapshot: 'Professora', subjectNameSnapshot: 'Matemática', score: 8.5,
    testScore: 4, activityScore: 3, participationScore: 1.5, status: 'Acima da Média', observation: 'Observação liberada' };
  const card = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', school_id: sid, studentId, classId, schoolYear: 2026, termId, enrollmentId,
    evaluationMode: 'numeric', minimumAverage: 7, releasedForPrint: true, status: 'Completo', subjects: [subject], ...options.card };
  const tables = {
    School: [{ _id: sid, educationModel: options.technical ? 'technical_apprenticeship' : 'regular' }],
    Class: [{ _id: classId, school_id: sid, schoolYear: 2026, name: '2º Ano A', grade: '2º Ano', level: options.developmental ? 'Educação Infantil' : 'Ensino Fundamental I' }],
    SchoolYear: [{ _id: yearId, school_id: sid, year: 2026 }], Periodo: options.periods || [period],
    ReportCard: options.cards || [card], Horario: [{ school_id: sid, classId, termId, subjectId: { _id: subjectId, name: 'Matemática' }, teacherId: { _id: teacherId, name: 'Professora' } }],
    Evaluation: [{ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', school: sid, schoolYear: yearId, classInfo: classId, subject: subjectId, term: '2º Bimestre', date: '2026-05-10', title: 'Trabalho', type: 'WORK', maxScore: 20 }],
    Grade: [{ evaluation: 'bbbbbbbbbbbbbbbbbbbbbbbb', student: studentId, enrollment: enrollmentId, value: 17 }],
    ...options.tables,
  };
  const models = Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, model(rows, queries)]));
  const auth = new GuardianAuthService({ GuardianAccessLinkModel: model([
    { school_id: sid, guardianAccessAccountId: accountId, studentId, status: 'active' },
    { school_id: 'another-school', guardianAccessAccountId: accountId, studentId: 'other-student', status: 'active' },
    { school_id: sid, guardianAccessAccountId: accountId, studentId: 'revoked-student', status: 'inactive' },
  ], queries), StudentModel: model([{ _id: studentId, school_id: sid, isActive: true, fullName: 'Aluno autorizado', classId }], queries),
    EnrollmentModel: model([{ _id: enrollmentId, school_id: sid, student: studentId, class: classId, academicYear: 2026, status: 'Ativa' }], queries), ClassModel: models.Class });
  const service = new GuardianAcademicService({ models, resolveContext: context => auth._resolveGuardianStudentContext(context), now: () => new Date('2026-05-15T12:00:00Z') });
  return { service, queries, tables, card, subject, period, get: (overrides = {}) => service.getPerformance({ schoolId: sid, accountId, studentId, ...overrides }) };
}

test('uses official consolidated scores, known scale and snapshotted criterion, not diary average', async () => {
  const f = fixture(); const result = await f.get(); const term = result.terms[1];
  assert.equal(result.initialTerm, 2); assert.equal(result.selectedStudent.id, studentId);
  assert.equal(result.selectedStudent.class.level, 'Ensino Fundamental I');
  assert.deepEqual(result.scale, { min: 0, max: 10 });
  assert.equal(term.average, 8.5); assert.equal(term.subjects[0].score, 8.5);
  assert.equal(term.subjects[0].evaluations[0].score, 17); assert.equal(term.subjects[0].evaluations[0].maxScore, 20);
  assert.equal(term.subjects[0].evaluations[0].weight, null); assert.equal(term.performance, 'meets_criterion');
  assert.equal(term.subjects[0].components.length, 3);
});
test('saved unreleased reports expose official entries as ongoing, per school policy', async () => {
  const result = await fixture({ card: { releasedForPrint: false, status: 'Completo' } }).get();
  const term = result.terms[1]; assert.equal(term.average, 8.5); assert.equal(term.state, 'in_progress');
  assert.equal(term.subjects[0].score, 8.5); assert.equal(term.subjects[0].components.length, 3);
  assert.equal(term.subjects[0].evaluations[0].score, 17); assert.equal(result.visibility, 'saved_report_cards');
});
test('a report without saved scores never manufactures a mean from diary grades', async () => {
  const f = fixture({ card: { releasedForPrint: false, status: 'Rascunho' } }); f.subject.score = null;
  const term = (await f.get()).terms[1]; assert.equal(term.average, null); assert.equal(term.subjects[0].score, null);
  assert.equal(term.subjects[0].evaluations[0].score, 17); assert.equal(term.performance, null);
});
test('diary-only grades remain available in details without inventing a consolidated subject score', async () => {
  const term = (await fixture({ cards: [] }).get()).terms[1];
  assert.equal(term.average, null); assert.equal(term.subjects[0].score, null);
  assert.equal(term.subjects[0].evaluations[0].score, 17); assert.equal(term.subjects[0].evaluations[0].maxScore, 20);
});
test('partial and zero grades are distinct from missing results', async () => {
  const f = fixture(); f.card.subjects.push({ ...f.subject, subjectId: 'another-subject', subjectNameSnapshot: 'Ciências', score: null });
  f.subject.score = 0; const term = (await f.get()).terms[1];
  assert.equal(term.average, 0); assert.equal(term.evaluatedCount, 1); assert.equal(term.partial, true); assert.equal(term.performance, null);
  assert.equal(term.subjects.find(s => s.name === 'Matemática').performance, 'below_criterion');
});
test('imported exams retain their original maximum without changing the consolidated score', async () => {
  const f = fixture(); f.subject.testScoreSource = { type: 'exam_result_import', examId: 'original-exam', examTitle: 'Prova importada de teste', originalGrade: 18, originalMaxGrade: 20 };
  const subject = (await f.get()).terms[1].subjects[0];
  assert.equal(subject.score, 8.5); assert.equal(subject.evaluations[1].score, 18); assert.equal(subject.evaluations[1].maxScore, 20);
});
test('respects different school criteria and does not synthesize a missing criterion', async () => {
  const strict = fixture({ card: { minimumAverage: 9 } }); assert.equal((await strict.get()).terms[1].performance, 'below_criterion');
  const unknown = fixture({ card: { minimumAverage: null } }); assert.equal((await unknown.get()).terms[1].performance, null);
});
test('four bimesters preserve absent, future and unpublished periods without a zero score', async () => {
  const f = fixture(); f.tables.Periodo.push({ ...f.period, _id: 'future-term', titulo: '4º Bimestre', dataInicio: '2026-10-01', dataFim: '2026-12-01' });
  const result = await f.get(); assert.equal(result.terms.length, 4); assert.equal(result.terms[0].state, 'not_configured');
  assert.equal(result.terms[3].state, 'not_started'); assert.equal(result.terms[3].average, null);
});
test('descriptive assessments never become numeric grades and retain official criteria', async () => {
  const f = fixture({ developmental: true, card: { evaluationMode: 'developmental', developmentalAssessments: [
    { subjectId, teacherId, completionStatus: 'completed', criteria: [{ description: 'Comunicação', status: 'support' }] },
  ] } }); const term = (await f.get()).terms[1];
  assert.equal(term.average, null); assert.equal(term.subjects[0].score, null); assert.equal(term.performance, null);
  assert.equal(term.subjects[0].criteria[0].status, 'support'); assert.equal(term.evaluatedCount, 1);
  assert.deepEqual(term.subjects[0].evaluations, []);
});
test('legacy numeric defaults on early-childhood cards obey the existing class evaluation-mode rule', async () => {
  const term = (await fixture({ developmental: true }).get()).terms[1];
  assert.equal(term.gradingType, 'developmental'); assert.equal(term.average, null); assert.equal(term.subjects[0].score, null);
});
test('unauthorized, cross-school, inactive and unknown student IDs are rejected before academic queries', async () => {
  for (const requested of ['other-student', 'revoked-student', 'unknown']) {
    const f = fixture(); await assert.rejects(f.get({ studentId: requested }), e => e.statusCode === 404);
    assert.equal(f.queries.some(q => q.studentId || q.schoolYear), false);
  }
});
test('another account and school cannot reuse the requested student ID', async () => {
  await assert.rejects(fixture().get({ accountId: 'other-account' }), e => e.statusCode === 404);
  await assert.rejects(fixture().get({ schoolId: 'other-school' }), e => e.statusCode === 404);
  await assert.rejects(fixture().get({ accountId: null }), e => e.statusCode === 401);
});
test('another enrollment cannot contribute a diary grade to this report card', async () => {
  const f = fixture(); f.tables.Grade[0].enrollment = 'different-enrollment';
  assert.equal((await f.get()).terms[1].subjects[0].evaluations[0].score, null);
});
test('changes to the official report are reflected on the next query', async () => {
  const f = fixture(); assert.equal((await f.get()).terms[1].average, 8.5);
  f.subject.score = 9.25; assert.equal((await f.get()).terms[1].average, 9.25);
});
test('non-bimester calendars and technical education are explicit unsupported states', async () => {
  const f = fixture(); f.tables.Periodo[0].titulo = '1º Trimestre';
  assert.equal((await f.get()).reason, 'NON_BIMESTER_CALENDAR');
  assert.equal((await fixture({ technical: true }).get()).reason, 'TECHNICAL_EDUCATION_MODEL');
  assert.equal(termNumber('2º Bimestre'), 2); assert.equal(termNumber('1º Trimestre'), null);
});

test('actual HTTP route validates guardian JWT, authorization and private cache headers', async () => {
  const originalSecret = process.env.GUARDIAN_JWT_SECRET;
  process.env.GUARDIAN_JWT_SECRET = 'local-academic-http-test-secret';
  const jwt = require('jsonwebtoken');
  const express = require('express');
  const Account = require('../../api/models/guardianAccessAccount.model');
  const singleton = require('../../api/services/guardianAcademic.service');
  const originalFind = Account.findOne, originalGet = singleton.getPerformance;
  let server;
  try {
    Account.findOne = filter => ({ select: async () => filter._id === accountId && filter.school_id === sid
      ? { _id: accountId, school_id: sid, tutorId: 'local-test-tutor', status: 'active', tokenVersion: 1 } : null });
    const f = fixture(); singleton.getPerformance = context => f.service.getPerformance(context);
    const app = express(); app.use('/api', require('../../api/routes/guardianAuth.routes'));
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/guardian-auth/students`;
    const token = jwt.sign({ principalType: 'guardian', tokenType: 'guardian_auth', accountId, school_id: sid, tutorId: 'local-test-tutor', tokenVersion: 1 }, process.env.GUARDIAN_JWT_SECRET);
    const headers = { Authorization: `Bearer ${token}` };
    const result = await fetch(`${base}/${studentId}/performance`, { headers });
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.equal((await result.json()).terms[1].subjects[0].score, 8.5);
    assert.equal((await fetch(`${base}/other-student/performance`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/${studentId}/performance`)).status, 403);
    const staffToken = jwt.sign({ principalType: 'staff' }, process.env.GUARDIAN_JWT_SECRET);
    assert.equal((await fetch(`${base}/${studentId}/performance`, { headers: { Authorization: `Bearer ${staffToken}` } })).status, 401);
  } finally {
    Account.findOne = originalFind; singleton.getPerformance = originalGet;
    if (server) await new Promise(resolve => server.close(resolve));
    if (originalSecret === undefined) delete process.env.GUARDIAN_JWT_SECRET; else process.env.GUARDIAN_JWT_SECRET = originalSecret;
  }
});
