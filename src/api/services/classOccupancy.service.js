const Class = require('../models/class.model');
const Enrollment = require('../models/enrollment.model');
const Request = require('../models/reEnrollmentRequest.model');
const Registration = require('../models/registration-request.model');
const Student = require('../models/student.model');
const Invoice = require('../models/invoice.model');
const School = require('../models/school.model');
const { normalizeName, normalizeCpf, isValidCpf, buildBirthDateKey } = require('../utils/guardianAccess.util');
const { normalizeAcademicGrade } = require('../utils/academicGrade.util');

const id = value => String(value?._id || value || '');
const error = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const identity = person => isValidCpf(person?.cpf) ? `cpf:${normalizeCpf(person.cpf)}`
  : normalizeName(person?.fullName) && buildBirthDateKey(person?.birthDate)
    ? `birth:${normalizeName(person.fullName)}:${buildBirthDateKey(person.birthDate)}` : null;
const identityKeys = person => [...new Set([identity(person), identity({ fullName: person?.fullName, birthDate: person?.birthDate })].filter(Boolean))];
// Same structural identity as Class's active unique index (school/name/year/shift).
const classKey = c => [normalizeName(c.name), normalizeName(c.shift)].join('|');

// A read-only planning projection. Actual destination configuration always wins.
function resolveClasses(classes, year) {
  const eligible = classes.filter(c => ['Planejada', 'Ativa'].includes(c.status) && c.schoolYear <= year);
  const previousYear = Math.max(0, ...eligible.filter(c => c.schoolYear < year).map(c => c.schoolYear));
  const actual = eligible.filter(c => c.schoolYear === year);
  const configuredKeys = new Set(classes.filter(c => c.schoolYear === year).map(classKey));
  const byKey = new Map(actual.map(c => [classKey(c), c]));
  const aliases = new Map();
  const rows = actual.map(c => ({ ...c, id: id(c), isProjection: false, referenceYear: year, sourceClassId: id(c) }));
  for (const c of eligible.filter(c => c.schoolYear === previousYear)) {
    const key = classKey(c), existing = byKey.get(key);
    if (existing) { aliases.set(id(c), id(existing)); continue; }
    if (configuredKeys.has(key)) continue; // Do not resurrect a cancelled destination class.
    const projectedId = `planning:${year}:${id(c)}`;
    rows.push({ ...c, id: projectedId, isProjection: true, referenceYear: previousYear, sourceClassId: id(c) });
    aliases.set(id(c), projectedId);
    byKey.set(key, { _id: projectedId });
  }
  return { rows, aliases };
}

function buildOccupancy({ classes, enrollments, requests, registrations = [], students = [], blockedStudentIds = [], year }) {
  const resolved = resolveClasses(classes, year);
  const rows = resolved.rows.map(c => ({ id: c.id, name: c.name, level: c.level, grade: c.grade, shift: c.shift,
    isProjection: c.isProjection, referenceYear: c.referenceYear, sourceClassId: c.sourceClassId,
    capacity: Number.isInteger(c.capacity) && c.capacity > 0 ? c.capacity : null,
    confirmedStudents: [], pendingStudents: [], approvedStudents: [] }));
  const byClass = new Map(rows.map(c => [c.id, c]));
  const diagnostics = { unresolved: 0, blocked: 0, approvedWithoutEnrollment: 0, invalid: 0, duplicates: 0,
    webUnknownYear: 0, reEnrollmentConsidered: 0, webConsidered: 0, projectedClasses: rows.filter(r => r.isProjection).length };
  const unallocated = [], blocked = new Set(blockedStudentIds.map(id));
  const destinationStudents = new Set(), confirmedByStudent = new Map();
  const studentIdentities = new Map();
  const studentById = new Map();
  // Reuse the existing CPF / normalized name + birthdate identity, scoped to this school.
  for (const s of [...students, ...enrollments.map(e => e.student), ...requests.map(r => r.studentId)].filter(Boolean)) {
    studentById.set(id(s), s);
    for (const key of identityKeys(s)) {
      const entries = studentIdentities.get(key) || new Set(); entries.add(id(s)); studentIdentities.set(key, entries);
    }
  }
  const seenEnrollments = new Set();
  for (const e of [...enrollments].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))) {
    if (e.academicYear !== year || !e.student || seenEnrollments.has(id(e.student))) continue;
    seenEnrollments.add(id(e.student));
    // A draft enrollment is still awaiting effectivation. Closed/transfer records
    // suppress stale requests, while an active enrollment confirms the seat.
    if (e.status !== 'Pendente') destinationStudents.add(id(e.student));
    // Only real classes can receive confirmed enrollments. Never move source-year students.
    const row = byClass.get(id(e.class));
    if (e.status !== 'Ativa' || e.student.isActive === false) continue;
    if (!row || row.isProjection) { diagnostics.invalid++; continue; }
    const person = { studentId: id(e.student), name: e.student.fullName || '', status: 'Ativa', targetClass: row.name };
    row.confirmedStudents.push(person); confirmedByStudent.set(id(e.student), person);
  }
  const seen = new Set();
  const classesById = new Map(classes.map(c => [id(c), c]));
  const web = registrations.map(r => {
    const selected = classesById.get(id(r.selectedClassId));
    // Legacy requests can only be dated by an explicit, school-scoped class or snapshot year.
    const academicYearTo = r.academicYearTo || r.selectedClassSnapshot?.schoolYear || selected?.schoolYear;
    const matches = identityKeys(r.studentData).map(key => studentIdentities.get(key)).find(Boolean);
    const studentId = r.approvedStudentId || (matches?.size === 1 ? [...matches][0] : null);
    return { ...r, academicYearTo, source: 'web', resolvedStudentId: id(studentId), ambiguousIdentity: matches?.size > 1 };
  });
  const demand = [...requests.map(r => ({ ...r, source: 'reEnrollment', resolvedStudentId: id(r.studentId) })), ...web]
    .sort((a, b) => (a.status === 'APPROVED' ? 0 : 1) - (b.status === 'APPROVED' ? 0 : 1) || new Date(b.createdAt) - new Date(a.createdAt));
  for (const r of demand) {
    if (!['PENDING', 'APPROVED'].includes(r.status)) continue;
    if (!r.academicYearTo && r.source === 'web') { diagnostics.webUnknownYear++; continue; }
    if (r.academicYearTo !== year) continue;
    const studentId = r.resolvedStudentId;
    const personKey = studentId ? `student:${studentId}` : identity(r.studentData) || `request:${id(r)}`;
    if (destinationStudents.has(studentId)) {
      const confirmed = confirmedByStudent.get(studentId);
      if (confirmed && !confirmed.requestId) Object.assign(confirmed, { source: r.source, requestId: id(r), createdAt: r.createdAt, currentClass: r.currentClassSnapshot?.name || '' });
      continue;
    }
    if (seen.has(personKey)) { diagnostics.duplicates++; continue; }
    seen.add(personKey);
    if (r.source === 'reEnrollment' && (!r.studentId || r.studentId.isActive === false || !r.currentEnrollmentId || r.currentEnrollmentId.status !== 'Ativa')) { diagnostics.invalid++; continue; }
    if (r.source === 'web' && r.ambiguousIdentity && !r.approvedStudentId) { diagnostics.invalid++; continue; }
    if (r.source === 'web' && studentById.get(studentId)?.isActive === false) { diagnostics.invalid++; continue; }
    diagnostics[r.source === 'web' ? 'webConsidered' : 'reEnrollmentConsidered']++;
    if (r.status === 'APPROVED') diagnostics.approvedWithoutEnrollment++;
    const financialBlocked = r.source === 'reEnrollment' && r.status === 'PENDING' && blocked.has(studentId);
    if (financialBlocked) diagnostics.blocked++;
    const targetId = id(r.source === 'web' ? (r.selectedClassId || r.projectedClassSourceId) : r.targetClassId);
    let row = byClass.get(targetId) || byClass.get(resolved.aliases.get(targetId));
    const sourceClass = classesById.get(id(r.currentClassId || r.currentClassSnapshot?.id || r.currentEnrollmentId?.class));
    const targetShift = r.targetShiftName?.trim() || r.currentClassSnapshot?.shift || sourceClass?.shift || '';
    let resolution = row ? 'explicit' : 'unresolved';
    // Planning only: the user authorized retaining the source shift. A unique
    // destination stage/level/shift may resolve demand, never create enrollment.
    if (!targetId && r.source === 'reEnrollment' && targetShift && r.targetGradeName && r.targetLevelName) {
      const candidates = rows.filter(c => normalizeAcademicGrade(c.grade, c.name) === normalizeAcademicGrade(r.targetGradeName)
        && normalizeName(c.level) === normalizeName(r.targetLevelName) && normalizeName(c.shift) === normalizeName(targetShift));
      if (candidates.length === 1) { row = candidates[0]; resolution = 'stageShift'; }
    }
    const person = { studentId: studentId || null, name: r.studentId?.fullName || r.studentNameSnapshot || r.studentData?.fullName || '',
      source: r.source, status: r.status, requestId: id(r), createdAt: r.createdAt, financialBlocked, resolution,
      currentClass: r.currentClassSnapshot?.name || '', targetClass: row?.name || '',
      targetGrade: r.targetGradeName || r.studentData?.intendedGrade || r.selectedClassSnapshot?.grade || '',
      targetLevel: r.targetLevelName || r.selectedClassSnapshot?.educationLevel || '',
      targetShift: r.source === 'reEnrollment' ? targetShift : r.selectedClassSnapshot?.shift || '' };
    if (!row) { diagnostics.unresolved++; unallocated.push(person); continue; }
    row[r.status === 'APPROVED' ? 'approvedStudents' : 'pendingStudents'].push(person);
  }
  return { rows: rows.map(row => {
    const confirmed = row.confirmedStudents.length, pending = row.pendingStudents.length, approved = row.approvedStudents.length, capacity = row.capacity;
    const blockedPending = row.pendingStudents.filter(s => s.financialBlocked).length;
    const eligiblePending = pending - blockedPending;
    const occupancy = capacity == null ? null : confirmed / capacity * 100;
    return { ...row, confirmed, pending, approved, blockedPending, eligiblePending,
      reEnrollmentPending: row.pendingStudents.filter(s => s.source === 'reEnrollment').length,
      webPending: row.pendingStudents.filter(s => s.source === 'web').length,
      available: capacity == null ? null : capacity - confirmed,
      projected: confirmed + eligiblePending + approved, afterPending: capacity == null ? null : capacity - confirmed - eligiblePending - approved,
      occupancy, situation: occupancy == null ? 'Sem capacidade' : occupancy >= 100 ? 'Lotada' : occupancy >= 85 ? 'Próxima do limite' : 'Disponível' };
  }), diagnostics, unallocated };
}

async function load(schoolId, academicYear) {
  if (!schoolId) throw error('Usuário sem escola autorizada.', 403);
  const year = Number(academicYear);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw error('Informe um ano letivo válido.', 400);
  const school = await School.findById(schoolId).select('name educationModel').lean();
  if (!school || school.educationModel === 'technical_apprenticeship') throw error('Painel disponível para ensino regular.', 403);
  const [classes, enrollments, requests, registrations, years] = await Promise.all([
    Class.find({ school_id: schoolId, schoolYear: { $lte: year } }).select('name level grade shift capacity schoolYear status').sort({ name: 1 }).lean(),
    Enrollment.find({ school_id: schoolId, academicYear: year }).select('student class status academicYear updatedAt')
      .populate({ path: 'student', match: { school_id: schoolId }, select: 'fullName isActive cpf birthDate' }).lean(),
    Request.find({ school_id: schoolId, academicYearTo: year, status: { $in: ['PENDING', 'APPROVED'] } })
      .select('studentId studentNameSnapshot currentEnrollmentId currentClassId targetClassId currentClassSnapshot targetGradeName targetLevelName targetShiftName status academicYearTo createdAt')
      .populate({ path: 'studentId', match: { school_id: schoolId }, select: 'fullName isActive cpf birthDate' })
      .populate({ path: 'currentEnrollmentId', match: { school_id: schoolId }, select: 'status class' }).lean(),
    Registration.find({ school_id: schoolId, status: { $in: ['PENDING', 'APPROVED'] }, $or: [{ academicYearTo: year }, { academicYearTo: { $exists: false } }, { academicYearTo: null }] })
      .select('studentData.fullName studentData.cpf studentData.birthDate studentData.intendedGrade academicYearTo selectedClassId projectedClassSourceId selectedClassSnapshot approvedStudentId status createdAt').lean(),
    Class.distinct('schoolYear', { school_id: schoolId }),
  ]);
  const identityFilters = registrations.flatMap(r => {
    const person = r.studentData, filters = [];
    if (r.approvedStudentId) filters.push({ _id: r.approvedStudentId });
    if (isValidCpf(person?.cpf)) filters.push({ cpf: { $in: [person.cpf, normalizeCpf(person.cpf)] } });
    const fullNameNormalized = normalizeName(person?.fullName), birthDateKey = buildBirthDateKey(person?.birthDate);
    if (fullNameNormalized && birthDateKey) filters.push({ fullNameNormalized, birthDateKey });
    return filters;
  });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [students, blockedStudentIds] = await Promise.all([
    // Indexed identity candidates only; never download the school's entire student roster.
    Student.find({ school_id: schoolId, $or: identityFilters.length ? identityFilters : [{ _id: { $in: [] } }] }).select('fullName birthDate cpf isActive').lean(),
    Invoice.distinct('student', { school_id: schoolId,
    student: { $in: requests.filter(r => r.studentId).map(r => r.studentId._id) },
    dueDate: { $lt: today }, status: { $nin: ['paid', 'canceled'] } }),
  ]);
  return { ...buildOccupancy({ classes, enrollments, requests, registrations, students, blockedStudentIds, year }),
    year, years: [...new Set([...years, year])].sort((a, b) => b - a), school: { id: String(school._id), name: school.name }, generatedAt: new Date().toISOString() };
}

module.exports = { load, buildOccupancy, resolveClasses };
