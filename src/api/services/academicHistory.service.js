const CourseLoad = require('../models/courseLoad.model');
const Enrollment = require('../models/enrollment.model');
const Horario = require('../models/horario.model');
const Periodo = require('../models/periodo.model');
const ReportCard = require('../models/reportCard.model');
const School = require('../models/school.model');
const Student = require('../models/student.model');

const FINAL_RESULTS = Object.freeze([
  'Aprovado',
  'Reprovado',
  'Transferido',
  'Em andamento',
  'Outro',
]);

function httpError(message, statusCode = 400, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function idOf(value) {
  if (!value) return '';
  return String(value._id || value.id || value);
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function actorId(actor) {
  return actor?.id || actor?._id || null;
}

function canManage(actor) {
  const roles = [
    ...(Array.isArray(actor?.roles) ? actor.roles : []),
    ...(actor?.role ? [actor.role] : []),
  ].map((role) => normalize(role));
  return roles.some((role) => ['admin', 'coordenador', 'staff'].includes(role));
}

function requireManager(actor) {
  if (!canManage(actor)) {
    throw httpError(
      'Somente administracao, coordenacao ou secretaria podem alterar o historico anual.',
      403,
      'academic_history_permission_denied'
    );
  }
}

function parseTermOrder(term) {
  const label = normalize(term?.titulo || term?.label);
  const digit = label.match(/(^|\D)([1-4])(\D|$)/);
  if (digit) return Number(digit[2]);
  const words = { primeiro: 1, segundo: 2, terceiro: 3, quarto: 4 };
  for (const [word, order] of Object.entries(words)) {
    if (label.includes(word)) return order;
  }
  return null;
}

function roundOne(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

function gradeKey(grade) {
  const subjectId = idOf(grade.subjectId);
  return subjectId
    ? `id:${subjectId}`
    : `name:${normalize(grade.historicalName || grade.subjectName)}`;
}

function dedupeGrades(grades = []) {
  const map = new Map();
  for (const raw of grades) {
    const subjectName = String(raw.historicalName || raw.subjectName || '').trim();
    if (!subjectName) continue;
    const next = {
      ...raw,
      subjectName,
      historicalName: subjectName,
      gradeValue: String(raw.gradeValue ?? raw.concept ?? raw.finalGrade ?? '').trim(),
      bimonthlyGrades: Array.isArray(raw.bimonthlyGrades)
        ? raw.bimonthlyGrades.slice(0, 4).map((value) => {
            if (value === null || value === undefined || value === '') return null;
            const numeric = Number(value);
            if (!Number.isFinite(numeric) || numeric < 0 || numeric > 10) {
              throw httpError('As notas bimestrais devem estar entre 0 e 10.', 400);
            }
            return numeric;
          })
        : [],
    };
    const key = gradeKey(next);
    if (!map.has(key)) map.set(key, next);
  }
  return [...map.values()];
}

class AcademicHistoryService {
  async _student(studentId, schoolId, fields = null) {
    let query = Student.findOne({ _id: studentId, school_id: schoolId });
    if (fields) query = query.select(fields);
    const student = await query;
    if (!student) throw httpError('Aluno nao encontrado nesta escola.', 404);
    return student;
  }

  async _resolveEnrollment({ studentId, schoolId, schoolYear, enrollmentId }) {
    const filter = { student: studentId, school_id: schoolId };
    if (enrollmentId) filter._id = enrollmentId;
    if (schoolYear) filter.academicYear = Number(schoolYear);
    return Enrollment.findOne(filter)
      .populate('class', 'name grade level schoolYear')
      .sort({ academicYear: -1 });
  }

  async _curriculumSubjects({ schoolId, classId, schoolYear }) {
    if (!classId) return { source: 'none', subjects: [] };

    const terms = await Periodo.find({ school_id: schoolId })
      .populate('anoLetivoId', 'year')
      .sort({ dataInicio: 1 });
    const termIds = terms
      .filter((term) => Number(term.anoLetivoId?.year) === Number(schoolYear))
      .map((term) => term._id);
    const loads = termIds.length
      ? await CourseLoad.find({
          school_id: schoolId,
          classId,
          periodoId: { $in: termIds },
        }).populate('subjectId', 'name level')
      : [];

    if (loads.length) {
      const bySubject = new Map();
      for (const load of loads) {
        const id = idOf(load.subjectId);
        if (!id) continue;
        const current = bySubject.get(id) || {
          subjectId: id,
          subjectName: load.subjectId?.name || 'Disciplina',
          curriculumCategory: '',
          workloadHours: 0,
          source: 'curriculum_matrix',
        };
        current.workloadHours += Number(load.targetHours || 0);
        bySubject.set(id, current);
      }
      return { source: 'curriculum_matrix', subjects: [...bySubject.values()] };
    }

    const reportCards = await ReportCard.find({ school_id: schoolId, classId, schoolYear });
    const fromCards = new Map();
    for (const card of reportCards) {
      for (const subject of card.subjects || []) {
        const id = idOf(subject.subjectId);
        const name = String(subject.subjectNameSnapshot || '').trim();
        const key = id || normalize(name);
        if (!key || fromCards.has(key)) continue;
        fromCards.set(key, {
          subjectId: id || null,
          subjectName: name || 'Disciplina',
          curriculumCategory: '',
          workloadHours: null,
          source: 'report_cards',
        });
      }
    }
    if (fromCards.size) {
      return { source: 'report_cards', subjects: [...fromCards.values()] };
    }

    const horarios = await Horario.find({ school_id: schoolId, classId })
      .populate('subjectId', 'name level');
    const fromSchedule = new Map();
    for (const horario of horarios) {
      const id = idOf(horario.subjectId);
      if (!id || fromSchedule.has(id)) continue;
      fromSchedule.set(id, {
        subjectId: id,
        subjectName: horario.subjectId?.name || 'Disciplina',
        curriculumCategory: '',
        workloadHours: null,
        source: 'weekly_schedule',
      });
    }
    return {
      source: fromSchedule.size ? 'weekly_schedule' : 'none',
      subjects: [...fromSchedule.values()],
    };
  }

  async getContext({ schoolId, studentId, schoolYear, enrollmentId }) {
    const year = Number(schoolYear || new Date().getFullYear());
    const [student, school, enrollment] = await Promise.all([
      this._student(studentId, schoolId, 'fullName enrollmentNumber academicHistory classId'),
      School.findOne({ _id: schoolId }).select(
        'name legalName inepCode address authorizationProtocol academicSettings'
      ),
      this._resolveEnrollment({ studentId, schoolId, schoolYear: year, enrollmentId }),
    ]);
    const classDoc = enrollment?.class || null;
    const curriculum = await this._curriculumSubjects({
      schoolId,
      classId: idOf(classDoc),
      schoolYear: year,
    });
    return {
      finalResults: FINAL_RESULTS,
      student: {
        id: idOf(student),
        fullName: student.fullName,
        enrollmentNumber: student.enrollmentNumber || '',
      },
      school: school
        ? {
            id: idOf(school),
            name: school.name || '',
            legalName: school.legalName || '',
            inepCode: school.inepCode || '',
            city: school.address?.city || '',
            state: school.address?.state || '',
            authorizationProtocol: school.authorizationProtocol || '',
          }
        : null,
      enrollment: enrollment
        ? {
            id: idOf(enrollment),
            academicYear: enrollment.academicYear,
            status: enrollment.status,
            class: classDoc
              ? {
                  id: idOf(classDoc),
                  name: classDoc.name || '',
                  grade: classDoc.grade || '',
                  level: classDoc.level || '',
                }
              : null,
          }
        : null,
      curriculum,
    };
  }

  async previewImport({ schoolId, studentId, schoolYear, enrollmentId }) {
    const year = Number(schoolYear);
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      throw httpError('Ano letivo invalido.', 400);
    }
    await this._student(studentId, schoolId, '_id');
    const enrollment = await this._resolveEnrollment({
      studentId,
      schoolId,
      schoolYear: year,
      enrollmentId,
    });
    if (!enrollment) {
      throw httpError('Matricula nao encontrada para o ano letivo informado.', 404);
    }

    const classId = idOf(enrollment.class);
    const cards = await ReportCard.find({
      school_id: schoolId,
      studentId,
      schoolYear: year,
      classId,
    }).populate('termId', 'titulo dataInicio dataFim');

    const terms = new Map();
    const subjects = new Map();
    let minimumAverage = 7;
    for (const card of cards) {
      const termId = idOf(card.termId);
      const order = parseTermOrder(card.termId);
      if (termId && order) {
        terms.set(termId, {
          id: termId,
          label: card.termId?.titulo || `${order}o bimestre`,
          order,
        });
      }
      if (Number(card.minimumAverage) >= 0) minimumAverage = Number(card.minimumAverage);
      for (const subject of card.subjects || []) {
        const key = idOf(subject.subjectId) || normalize(subject.subjectNameSnapshot);
        if (!subjects.has(key)) {
          subjects.set(key, {
            subjectId: idOf(subject.subjectId) || null,
            subjectName: subject.subjectNameSnapshot || 'Disciplina',
            scoresByTerm: {},
            recoveriesByTerm: {},
            absencesByTerm: {},
          });
        }
        const score = subject.score === null || subject.score === undefined
          ? null
          : Number(subject.score);
        subjects.get(key).scoresByTerm[termId] = Number.isFinite(score) ? score : null;
      }
    }

    const orderedTerms = [...terms.values()].sort((a, b) => a.order - b.order);
    const proposal = [...subjects.values()].map((subject) => {
      const available = orderedTerms
        .map((term) => subject.scoresByTerm[term.id])
        .filter((score) => Number.isFinite(score));
      const finalGrade = available.length === 4
        ? roundOne(available.reduce((sum, score) => sum + score, 0) / available.length)
        : null;
      return {
        ...subject,
        finalGrade,
        gradeValue: finalGrade === null ? '' : finalGrade.toFixed(1),
        situation: finalGrade === null
          ? 'Em andamento'
          : finalGrade >= minimumAverage
            ? 'Aprovado'
            : 'Reprovado',
        action: 'create',
      };
    });

    return {
      schoolYear: year,
      enrollmentId: idOf(enrollment),
      classId,
      gradeLevel: enrollment.class?.grade || '',
      terms: orderedTerms,
      subjects: proposal,
      minimumAverage,
      formula: {
        type: 'equal_weight_fallback',
        expression:
          'Soma das quatro notas bimestrais dividida por 4, com arredondamento para uma casa decimal.',
        configured: false,
        requiresFourTerms: true,
      },
      warnings: cards.length
        ? [
            'A escola nao possui pesos, recuperacao ou regra de arredondamento anual configurados no dominio atual; revise a formula de fallback antes de confirmar.',
          ]
        : ['Nenhuma nota bimestral foi encontrada para a matricula selecionada.'],
    };
  }

  _sanitizeRecord(recordData, actor, { imported = false } = {}) {
    const finalResult = String(recordData.finalResult || '').trim();
    if (!FINAL_RESULTS.includes(finalResult)) {
      throw httpError(
        `Resultado final invalido. Valores permitidos: ${FINAL_RESULTS.join(', ')}.`,
        400
      );
    }
    const schoolYear = Number(recordData.schoolYear);
    if (!Number.isInteger(schoolYear) || schoolYear < 1900 || schoolYear > 2200) {
      throw httpError('Ano letivo invalido.', 400);
    }
    const state = String(recordData.state || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) throw httpError('UF invalida.', 400);
    const institutionType = String(recordData.institutionType || 'legacy');
    if (!['legacy', 'current_school', 'external_school'].includes(institutionType)) {
      throw httpError('Origem da instituicao invalida.', 400);
    }
    const gradeEntryMode = String(recordData.gradeEntryMode || 'final_only');
    if (!['final_only', 'bimonthly'].includes(gradeEntryMode)) {
      throw httpError('Forma de lancamento das notas invalida.', 400);
    }
    return {
      ...recordData,
      schoolYear,
      state,
      grades: dedupeGrades(recordData.grades),
      institutionType,
      gradeEntryMode,
      origin: imported ? 'system_import' : recordData.origin || 'manual',
      updatedByUserId: actorId(actor),
    };
  }

  _assertUnique(student, recordData, ignoredRecordId = null) {
    const duplicate = (student.academicHistory || []).find((record) => {
      if (ignoredRecordId && idOf(record) === String(ignoredRecordId)) return false;
      const sameInstitution = recordData.inepCode && record.inepCode
        ? normalize(record.inepCode) === normalize(recordData.inepCode)
        : normalize(record.schoolName) === normalize(recordData.schoolName);
      return Number(record.schoolYear) === Number(recordData.schoolYear)
        && normalize(record.gradeLevel) === normalize(recordData.gradeLevel)
        && sameInstitution;
    });
    if (duplicate) {
      throw httpError(
        'Ja existe registro anual para a mesma serie, ano e instituicao.',
        409,
        'academic_history_duplicate'
      );
    }
  }

  async createRecord({ schoolId, studentId, recordData, actor, imported = false }) {
    requireManager(actor);
    const student = await this._student(studentId, schoolId);
    const sanitized = this._sanitizeRecord(recordData, actor, { imported });
    this._assertUnique(student, sanitized);
    sanitized.createdByUserId = actorId(actor);
    student.academicHistory.push(sanitized);
    student._user = actor;
    await student.save();
    return student.academicHistory;
  }

  async updateRecord({ schoolId, studentId, recordId, recordData, actor }) {
    requireManager(actor);
    const student = await this._student(studentId, schoolId);
    const record = student.academicHistory.id(recordId);
    if (!record) throw httpError('Registro anual nao encontrado.', 404);
    const sanitized = this._sanitizeRecord(
      { ...record.toObject(), ...recordData },
      actor
    );
    this._assertUnique(student, sanitized, recordId);
    Object.assign(record, sanitized);
    student._user = actor;
    await student.save();
    return student.academicHistory;
  }

  async deleteRecord({ schoolId, studentId, recordId, actor }) {
    requireManager(actor);
    const student = await this._student(studentId, schoolId);
    const record = student.academicHistory.id(recordId);
    if (!record) throw httpError('Registro anual nao encontrado.', 404);
    student.academicHistory.pull(recordId);
    student._user = actor;
    await student.save();
    return student.academicHistory;
  }
}

module.exports = new AcademicHistoryService();
module.exports.AcademicHistoryService = AcademicHistoryService;
module.exports.FINAL_RESULTS = FINAL_RESULTS;
module.exports._private = {
  canManage,
  dedupeGrades,
  normalize,
  parseTermOrder,
  roundOne,
};
