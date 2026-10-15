const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOccupancy, load } = require('../../api/services/classOccupancy.service');
const { authorize, get } = require('../../api/controllers/classOccupancy.controller');
const Class = require('../../api/models/class.model');
const Enrollment = require('../../api/models/enrollment.model');
const Request = require('../../api/models/reEnrollmentRequest.model');
const Invoice = require('../../api/models/invoice.model');
const School = require('../../api/models/school.model');
const Registration = require('../../api/models/registration-request.model');
const Student = require('../../api/models/student.model');

const cls = (overrides = {}) => ({ _id: 'c', name: '1º ANO A', schoolYear: 2027, capacity: 30, status: 'Planejada', ...overrides });
const student = i => ({ _id: `s${i}`, fullName: `Aluno ${i}`, isActive: true });
const enrollment = (i, overrides = {}) => ({ student: student(i), class: 'c', academicYear: 2027, status: 'Ativa', ...overrides });
const request = (i, overrides = {}) => ({ _id: `r${i}`, studentId: student(i), academicYearTo: 2027, status: 'PENDING', targetClassId: 'c', currentEnrollmentId: { status: 'Ativa' }, createdAt: '2026-10-15', ...overrides });
const build = (options = {}) => buildOccupancy({ classes: [cls()], enrollments: [], requests: [], year: 2027, ...options });

test('empty, partial, near-full, full and over-capacity classes use confirmed occupancy', () => {
  for (const [count, situation] of [[0, 'Disponível'], [18, 'Disponível'], [26, 'Próxima do limite'], [30, 'Lotada'], [33, 'Lotada']]) {
    const row = build({ enrollments: Array.from({ length: count }, (_, i) => enrollment(i)) }).rows[0];
    assert.equal(row.confirmed, count); assert.equal(row.available, 30 - count);
    assert.equal(row.occupancy, count / 30 * 100); assert.equal(row.situation, situation);
  }
});
test('85 percent boundary is classified without rounding', () => {
  assert.equal(build({ classes: [cls({ capacity: 20 })], enrollments: Array.from({ length: 17 }, (_, i) => enrollment(i)) }).rows[0].situation, 'Próxima do limite');
});
test('18 confirmed + 6 pending = 60%, 12 available, projection 24 / 30', () => {
  const r = build({ enrollments: Array.from({ length: 18 }, (_, i) => enrollment(i)), requests: Array.from({ length: 6 }, (_, i) => request(i + 18)) }).rows[0];
  assert.deepEqual([r.confirmed, r.pending, r.available, r.occupancy, r.projected, r.afterPending], [18, 6, 12, 60, 24, 6]);
});
test('excess pending demand preserves counts and confirmed status', () => {
  const r = build({ classes: [cls({ capacity: 1 })], requests: [request(1), request(2)] }).rows[0];
  assert.equal(r.projected, 2); assert.equal(r.afterPending, -1); assert.equal(r.situation, 'Disponível');
});
test('confirmed wins over duplicate and old pending requests across destination classes', () => {
  const data = build({ classes: [cls(), cls({ _id: 'other' })], enrollments: [enrollment(1), enrollment(1)], requests: [request(1, { targetClassId: 'other' }), request(2), request(2)] });
  assert.equal(data.rows[0].confirmed, 1); assert.equal(data.rows[0].pending, 1); assert.equal(data.rows[1].pending, 0); assert.equal(data.diagnostics.duplicates, 1);
});
test('rejected/cancelled requests, inactive students and transferred/cancelled enrollments reserve no seats', () => {
  const data = build({ enrollments: [enrollment(1, { status: 'Transferido' }), enrollment(2, { status: 'Inativa' }), enrollment(3, { student: { ...student(3), isActive: false } })],
    requests: [request(1), request(2), request(3), request(4, { status: 'REJECTED' }), request(5, { status: 'CANCELLED' }), request(6, { currentEnrollmentId: { status: 'Transferido' } })] });
  assert.equal(data.rows[0].confirmed, 0); assert.equal(data.rows[0].pending, 0);
});
test('approval alone does not occupy a seat; effectivation does; rejection removes projection', () => {
  const r = request(1);
  assert.equal(build({ requests: [r] }).rows[0].pending, 1);
  assert.equal(build({ requests: [{ ...r, status: 'REJECTED' }] }).rows[0].pending, 0);
  const approved = { ...r, status: 'APPROVED' };
  assert.equal(build({ requests: [approved] }).diagnostics.approvedWithoutEnrollment, 1);
  const effective = build({ requests: [approved], enrollments: [enrollment(1)] });
  assert.equal(effective.rows[0].confirmed, 1); assert.equal(effective.diagnostics.approvedWithoutEnrollment, 0);
});
test('current-year students are not destination enrollments and other years are excluded', () => {
  const data = build({ classes: [cls(), cls({ _id: 'old', schoolYear: 2026 })], enrollments: [enrollment(1, { academicYear: 2026 })], requests: [request(1), request(2, { academicYearTo: 2028 })] });
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].confirmed, 0); assert.equal(data.rows[0].pending, 1);
});
test('missing capacity remains unknown, unresolved and financially blocked requests are diagnosed', () => {
  const data = build({ classes: [cls({ capacity: null })], requests: [request(1, { targetClassId: null }), request(2), request(3)], blockedStudentIds: ['s2'] });
  assert.equal(data.rows[0].capacity, null); assert.equal(data.rows[0].available, null); assert.equal(data.rows[0].occupancy, null);
  assert.equal(data.rows[0].pending, 2); assert.equal(data.rows[0].eligiblePending, 1); assert.equal(data.rows[0].projected, 1); assert.equal(data.diagnostics.unresolved, 1); assert.equal(data.diagnostics.blocked, 1);
});
test('no classes returns empty and cancelled classes are excluded', () => {
  assert.deepEqual(build({ classes: [] }).rows, []);
  assert.equal(build({ classes: [cls({ status: 'Cancelada' })] }).rows.length, 0);
});
test('only existing administrative roles can read occupancy or student names', () => {
  for (const role of ['Admin', 'Coordenador', 'Staff']) assert.equal(authorize({ user: { roles: [role] } }), true);
  for (const role of ['Professor', 'student', 'guardian']) assert.equal(authorize({ user: { roles: [role] } }), false);
  assert.equal(authorize({}), false);
});
test('queries and populated relations are school-scoped, bounded and year-specific', async () => {
  const originals = [Class.find, Class.distinct, Enrollment.find, Request.find, Invoice.distinct, School.findById, Registration.find, Student.find];
  let queries = 0;
  const query = (filter, data, expectedYear) => {
    queries++; assert.equal(filter.school_id, 'school-A');
    if (expectedYear) assert.equal(filter[expectedYear], 2027);
    return { select() { return this; }, sort() { return this; }, populate(options) { assert.equal(options.match.school_id, 'school-A'); return this; }, lean: async () => data };
  };
  Class.find = f => { assert.deepEqual(f.schoolYear, { $lte: 2027 }); return query(f, [cls()]); };
  Registration.find = f => { assert.ok(f.$or); return query(f, []); };
  Student.find = f => query(f, []);
  Class.distinct = async (field, f) => { assert.equal(f.school_id, 'school-A'); return [2026, 2027]; };
  Enrollment.find = f => query(f, [enrollment(1)], 'academicYear');
  Request.find = f => query(f, [request(2)], 'academicYearTo');
  Invoice.distinct = async (field, f) => { assert.equal(f.school_id, 'school-A'); return []; };
  School.findById = school => { assert.equal(school, 'school-A'); return { select() { return this; }, lean: async () => ({ _id: school, name: 'Escola A', educationModel: 'regular' }) }; };
  try {
    const result = await load('school-A', '2027'); assert.equal(queries, 5); assert.equal(result.rows[0].pending, 1);
    let body; const res = { json(v) { body = v; return this; }, status(v) { this.code = v; return this; } };
    await get({ user: { roles: ['Admin'], school_id: 'school-A' }, query: { academicYear: '2027' }, params: {} }, res);
    assert.equal('confirmedStudents' in body.rows[0], false);
    assert.equal('approvedStudents' in body.rows[0], false);
    assert.equal('unallocated' in body, false);
    await get({ user: { roles: ['Admin'], school_id: 'school-A' }, query: { academicYear: '2027' }, params: { classId: 'foreign' } }, res);
    assert.equal(res.code, 404);
  } finally { [Class.find, Class.distinct, Enrollment.find, Request.find, Invoice.distinct, School.findById, Registration.find, Student.find] = originals; }
});
test('missing school and invalid year fail before any data query', async () => {
  await assert.rejects(load(null, 2027), e => e.statusCode === 403);
  await assert.rejects(load('school', '2027 OR 1'), e => e.statusCode === 400);
});

test('planning uses latest prior structure, actual configuration wins, and never copies source students', () => {
  const data = build({ classes: [cls({ _id: 'old', schoolYear: 2026, capacity: 20 }), cls({ _id: 'older', schoolYear: 2025 }),
    cls({ _id: 'other', name: '2º ANO A', schoolYear: 2026 }), cls({ capacity: 25 })],
    enrollments: [enrollment(1, { academicYear: 2026, class: 'old' })] });
  assert.equal(data.rows.length, 2);
  assert.equal(data.rows[0].capacity, 25); assert.equal(data.rows[0].isProjection, false);
  assert.equal(data.rows[1].referenceYear, 2026); assert.equal(data.rows[1].isProjection, true);
  assert.equal(data.rows.reduce((s, r) => s + r.confirmed, 0), 0);
});
test('explicit reference-class destination maps to projection but a grade alone stays unallocated', () => {
  const data = build({ classes: [cls({ _id: 'reference', schoolYear: 2026 })],
    requests: [request(1, { targetClassId: 'reference' }), request(2, { targetClassId: null, targetGradeName: '1º Ano' })] });
  assert.equal(data.rows[0].pending, 1); assert.equal(data.unallocated.length, 1);
  assert.equal(data.unallocated[0].studentId, 's2');
});
test('8 confirmed + 5 reenrollments + 3 Web + 2 approved = 18 projected and 7 free', () => {
  const registrations = Array.from({ length: 3 }, (_, i) => ({ _id: `web${i}`, academicYearTo: 2027, status: 'PENDING', selectedClassId: 'c', studentData: { fullName: `Candidato ${i}`, birthDate: '2020-01-01' } }));
  const row = build({ classes: [cls({ capacity: 25 })], enrollments: Array.from({ length: 8 }, (_, i) => enrollment(i)),
    requests: [...Array.from({ length: 5 }, (_, i) => request(i + 8)), request(20, { status: 'APPROVED' }), request(21, { status: 'APPROVED' })], registrations }).rows[0];
  assert.deepEqual([row.confirmed, row.pending, row.approved, row.projected, row.available, row.afterPending, row.occupancy, row.reEnrollmentPending, row.webPending], [8, 8, 2, 18, 17, 7, 32, 5, 3]);
});
test('Web needs reliable year, no date inference; grade only is unallocated; rejected ignored', () => {
  const data = build({ registrations: [
    { _id: 'unknown', status: 'PENDING', createdAt: '2026-10-15', studentData: { intendedGrade: '1º Ano' } },
    { _id: 'current', status: 'PENDING', academicYearTo: 2026, selectedClassId: 'c' },
    { _id: 'grade', status: 'PENDING', academicYearTo: 2027, studentData: { intendedGrade: '1º Ano' } },
    { _id: 'legacy', status: 'PENDING', selectedClassId: 'c' },
    { _id: 'rejected', status: 'REJECTED', academicYearTo: 2027, selectedClassId: 'c' },
  ] });
  assert.equal(data.rows[0].pending, 1); assert.equal(data.diagnostics.webUnknownYear, 1);
  assert.equal(data.unallocated.length, 1); assert.equal(data.unallocated[0].requestId, 'grade');
});
test('cross-source student deduplication, approved demand precedence, and enrollment wins', () => {
  const person = { ...student(1), cpf: '52998224725' };
  const registrations = [{ _id: 'web', status: 'PENDING', academicYearTo: 2027, selectedClassId: 'c', studentData: { cpf: '529.982.247-25' } }];
  const data = build({ students: [person], requests: [request(1, { status: 'APPROVED', studentId: person })], registrations });
  assert.equal(data.rows[0].approved, 1); assert.equal(data.rows[0].pending, 0); assert.equal(data.diagnostics.duplicates, 1);
  const effective = build({ students: [person], enrollments: [enrollment(1, { student: person })], registrations });
  assert.equal(effective.rows[0].confirmed, 1); assert.equal(effective.rows[0].pending, 0);
});
test('unallocated approval remains visible and does not consume any class capacity', () => {
  const data = build({ requests: [request(1, { status: 'APPROVED', targetClassId: null })] });
  assert.equal(data.rows[0].projected, 0); assert.equal(data.diagnostics.approvedWithoutEnrollment, 1);
  assert.equal(data.unallocated[0].status, 'APPROVED');
});
test('cancelled destination configuration is not resurrected from the reference year', () => {
  assert.equal(build({ classes: [cls({ schoolYear: 2026 }), cls({ _id: 'destination', status: 'Cancelada' })] }).rows.length, 0);
});
test('destination configuration can change grade and capacity without duplicate reference class', () => {
  const rows = build({ classes: [cls({ _id: 'old', schoolYear: 2026, grade: 'legacy' }), cls({ grade: 'normalized', capacity: 25 })] }).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].capacity, 25);
});
test('Web without CPF matches confirmed school student by normalized name and birthdate', () => {
  const person = { ...student(1), fullName: 'José Silva', birthDate: '2018-01-02', cpf: '52998224725' };
  const data = build({ enrollments: [enrollment(1, { student: person })], registrations: [{ _id: 'web', status: 'PENDING', academicYearTo: 2027, selectedClassId: 'c', studentData: { fullName: ' JOSE  SILVA ', birthDate: '2018-01-02' } }] });
  assert.equal(data.rows[0].confirmed, 1); assert.equal(data.rows[0].pending, 0);
});
test('draft enrollment is not confirmed and does not hide an approved request awaiting effectivation', () => {
  const row = build({ enrollments: [enrollment(1, { status: 'Pendente' })], requests: [request(1, { status: 'APPROVED' })] }).rows[0];
  assert.equal(row.confirmed, 0); assert.equal(row.approved, 1); assert.equal(row.projected, 1);
});
test('unique destination grade/level/shift resolves planning and defaults missing shift to current class', () => {
  const data = build({ classes: [cls({ grade: '2° ANO', level: 'Ensino Fundamental I', shift: 'Matutino' }), cls({ _id: 'evening', grade: '2° ANO', level: 'Ensino Fundamental I', shift: 'Vespertino' })], requests: [request(1, { targetClassId: null, targetGradeName: '2º Ano', targetLevelName: 'Ensino Fundamental I', targetShiftName: '', currentClassSnapshot: { shift: 'Matutino' } })] });
  assert.equal(data.rows[0].pending, 1); assert.equal(data.rows[1].pending, 0);
  assert.equal(data.rows[0].pendingStudents[0].resolution, 'stageShift');
});
test('explicit shift prevails; multiple classes in the same shift remain unallocated', () => {
  const classes = [cls({ grade: '1º Ano', level: 'L', shift: 'Matutino' }), cls({ _id: 'b', name: '1º ANO B', grade: '1º Ano', level: 'L', shift: 'Matutino' })];
  const r = request(1, { targetClassId: null, targetGradeName: '1º Ano', targetLevelName: 'L', targetShiftName: 'Matutino', currentClassSnapshot: { shift: 'Vespertino' } });
  assert.equal(build({ classes, requests: [r] }).unallocated.length, 1);
  assert.equal(build({ classes: [classes[0]], requests: [r] }).rows[0].pending, 1);
  assert.equal(build({ classes: [classes[0]], requests: [{ ...r, targetShiftName: 'Vespertino' }] }).unallocated.length, 1);
});
test('anonymized production replay reconciles 44 approvals and four financially blocked pending requests', () => {
  const input = require('../fixtures/occupancy-planning-anonymized.json');
  const data = buildOccupancy(input);
  assert.equal(data.rows.length, 21); assert.equal(data.rows.reduce((s,r) => s + (r.capacity || 0),0),443);
  assert.equal(data.rows.reduce((s,r) => s + r.approved,0),40);
  assert.equal(data.rows.reduce((s,r) => s + r.confirmed,0),0);
  assert.equal(data.rows.reduce((s,r) => s + r.pending,0),3);
  assert.equal(data.rows.reduce((s,r) => s + r.eligiblePending,0),0);
  assert.equal(data.unallocated.filter(r => r.status === 'APPROVED').length,4);
  assert.equal(data.unallocated.filter(r => r.status === 'PENDING').length,1);
  assert.equal(data.diagnostics.blocked,4);
});
