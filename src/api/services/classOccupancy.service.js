const Class = require('../models/class.model');
const Enrollment = require('../models/enrollment.model');
const Request = require('../models/reEnrollmentRequest.model');
const Invoice = require('../models/invoice.model');
const School = require('../models/school.model');

const id = value => String(value?._id || value || '');
const error = (message, statusCode) => Object.assign(new Error(message), { statusCode });

// Same identity as Enrollment's unique index: school + student + academicYear.
// Never infer a destination from grade/name or count approval as enrollment.
function buildOccupancy({ classes, enrollments, requests, blockedStudentIds = [], year }) {
  const rows = classes.filter(c => c.schoolYear === year && ['Planejada', 'Ativa'].includes(c.status))
    .map(c => ({ id: id(c), name: c.name, level: c.level, grade: c.grade, shift: c.shift,
      capacity: Number.isInteger(c.capacity) && c.capacity > 0 ? c.capacity : null,
      confirmedStudents: [], pendingStudents: [] }));
  const byClass = new Map(rows.map(c => [c.id, c]));
  const diagnostics = { unresolved: 0, blocked: 0, approvedWithoutEnrollment: 0, invalid: 0, duplicates: 0 };
  const blocked = new Set(blockedStudentIds.map(id));
  const destinationStudents = new Set();
  for (const e of [...enrollments].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))) {
    if (e.academicYear !== year || !e.student || destinationStudents.has(id(e.student))) continue;
    destinationStudents.add(id(e.student));
    const row = byClass.get(id(e.class));
    if (e.status !== 'Ativa' || e.student.isActive === false) continue;
    if (!row) { diagnostics.invalid++; continue; }
    row.confirmedStudents.push({ studentId: id(e.student), name: e.student.fullName || '', status: 'Ativa', targetClass: row.name });
  }
  const seen = new Set();
  const confirmedByStudent = new Map(rows.flatMap(row => row.confirmedStudents.map(s => [s.studentId, s])));
  for (const r of [...requests].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))) {
    if (r.academicYearTo !== year || !['PENDING', 'APPROVED'].includes(r.status)) continue;
    const studentId = id(r.studentId);
    if (destinationStudents.has(studentId)) {
      const confirmed = confirmedByStudent.get(studentId);
      if (confirmed && !confirmed.requestId) Object.assign(confirmed, { requestId: id(r), createdAt: r.createdAt, currentClass: r.currentClassSnapshot?.name || '' });
      continue;
    }
    if (seen.has(studentId)) { diagnostics.duplicates++; continue; }
    seen.add(studentId);
    if (!r.studentId || r.studentId.isActive === false || !r.currentEnrollmentId || r.currentEnrollmentId.status !== 'Ativa') { diagnostics.invalid++; continue; }
    if (r.status === 'APPROVED') { diagnostics.approvedWithoutEnrollment++; continue; }
    if (blocked.has(studentId)) { diagnostics.blocked++; continue; }
    const row = byClass.get(id(r.targetClassId));
    if (!row) { diagnostics.unresolved++; continue; }
    row.pendingStudents.push({ studentId, name: r.studentId.fullName || r.studentNameSnapshot || '', status: 'PENDING',
      requestId: id(r), createdAt: r.createdAt, currentClass: r.currentClassSnapshot?.name || '', targetClass: row.name });
  }
  return { rows: rows.map(row => {
    const confirmed = row.confirmedStudents.length, pending = row.pendingStudents.length, capacity = row.capacity;
    const occupancy = capacity == null ? null : confirmed / capacity * 100;
    return { ...row, confirmed, pending, available: capacity == null ? null : capacity - confirmed,
      projected: confirmed + pending, afterPending: capacity == null ? null : capacity - confirmed - pending,
      occupancy, situation: occupancy == null ? 'Sem capacidade' : occupancy >= 100 ? 'Lotada' : occupancy >= 85 ? 'Próxima do limite' : 'Disponível' };
  }), diagnostics };
}

async function load(schoolId, academicYear) {
  if (!schoolId) throw error('Usuário sem escola autorizada.', 403);
  const year = Number(academicYear);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw error('Informe um ano letivo válido.', 400);
  const school = await School.findById(schoolId).select('name educationModel').lean();
  if (!school || school.educationModel === 'technical_apprenticeship') throw error('Painel disponível para ensino regular.', 403);
  const [classes, enrollments, requests, years] = await Promise.all([
    Class.find({ school_id: schoolId, schoolYear: year, status: { $in: ['Planejada', 'Ativa'] } }).select('name level grade shift capacity schoolYear status').sort({ name: 1 }).lean(),
    Enrollment.find({ school_id: schoolId, academicYear: year }).select('student class status academicYear updatedAt')
      .populate({ path: 'student', match: { school_id: schoolId }, select: 'fullName isActive' }).lean(),
    Request.find({ school_id: schoolId, academicYearTo: year, status: { $in: ['PENDING', 'APPROVED'] } })
      .select('studentId studentNameSnapshot currentEnrollmentId targetClassId currentClassSnapshot status academicYearTo createdAt')
      .populate({ path: 'studentId', match: { school_id: schoolId }, select: 'fullName isActive' })
      .populate({ path: 'currentEnrollmentId', match: { school_id: schoolId }, select: 'status' }).lean(),
    Class.distinct('schoolYear', { school_id: schoolId }),
  ]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // Mirrors reEnrollmentService._financialState without changing approval rules.
  const blockedStudentIds = await Invoice.distinct('student', { school_id: schoolId,
    student: { $in: requests.filter(r => r.studentId).map(r => r.studentId._id) },
    dueDate: { $lt: today }, status: { $nin: ['paid', 'canceled'] } });
  return { ...buildOccupancy({ classes, enrollments, requests, blockedStudentIds, year }),
    year, years: [...new Set([...years, year])].sort((a, b) => b - a), school: { id: String(school._id), name: school.name }, generatedAt: new Date().toISOString() };
}

module.exports = { load, buildOccupancy };
