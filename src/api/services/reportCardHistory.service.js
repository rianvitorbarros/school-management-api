const ReportCard = require('../models/reportCard.model');
const Student = require('../models/student.model');
const School = require('../models/school.model');

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function extractId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function readName(value, fallback = '') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  return (
    value.name ||
    value.fullName ||
    value.full_name ||
    value.titulo ||
    value.label ||
    fallback
  );
}

function actorSummary(value, fallbackName = '') {
  if (!value) return { id: '', name: fallbackName, role: '' };
  if (typeof value === 'string') {
    return { id: value, name: fallbackName, role: '' };
  }
  const roles = Array.isArray(value.roles)
    ? value.roles.map(String)
    : [value.role || value.type || value.perfil].filter(Boolean).map(String);
  return {
    id: extractId(value),
    name: readName(value, fallbackName),
    role: roles.join(', '),
  };
}

function parseDateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTermOrder(label) {
  const normalized = normalizeText(label);
  const directMatch = normalized.match(/(^|\D)([1-4])(\D|$)/);
  if (directMatch) return Number(directMatch[2]);

  const words = [
    ['primeiro', 1],
    ['segundo', 2],
    ['terceiro', 3],
    ['quarto', 4],
  ];

  const found = words.find(([word]) => normalized.includes(word));
  return found ? found[1] : null;
}

function termStartTime(term) {
  const date = parseDateValue(term?.dataInicio || term?.startDate);
  return date ? date.getTime() : null;
}

function compareTerms(left, right) {
  const leftStart = termStartTime(left);
  const rightStart = termStartTime(right);
  if (leftStart !== null && rightStart !== null && leftStart !== rightStart) {
    return leftStart - rightStart;
  }

  const leftOrder = left.order ?? parseTermOrder(left.label || left.titulo);
  const rightOrder = right.order ?? parseTermOrder(right.label || right.titulo);
  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return String(left.label || '').localeCompare(String(right.label || ''), 'pt-BR');
}

function roundToOne(value) {
  return Math.round(Number(value) * 10) / 10;
}

class ReportCardHistoryService {
  constructor(options = {}) {
    this.ReportCardModel = options.ReportCardModel || ReportCard;
    this.StudentModel = options.StudentModel || Student;
    this.SchoolModel = options.SchoolModel || School;
  }

  async _loadStudent(studentId, schoolId) {
    const student = await this.StudentModel.findOne({
      _id: studentId,
      school_id: schoolId,
    }).select('fullName enrollmentNumber school_id');

    if (!student) {
      throw createHttpError('Aluno nao encontrado nesta escola.', 404);
    }

    return student;
  }

  async _loadSchool(schoolId) {
    if (!this.SchoolModel?.findOne) {
      return { _id: schoolId, name: '' };
    }

    return this.SchoolModel.findOne({ _id: schoolId }).select('name') ||
      { _id: schoolId, name: '' };
  }

  async _loadReportCards({ schoolId, studentId, schoolYear }) {
    return this.ReportCardModel.find({
      school_id: schoolId,
      studentId,
      schoolYear,
    })
      .populate('termId', 'titulo dataInicio dataFim anoLetivoId')
      .populate('classId', 'name grade schoolYear')
      .populate('subjects.teacherId', 'name fullName full_name roles role type perfil')
      .populate('subjects.filledBy', 'name fullName full_name roles role type perfil')
      .populate('subjects.lastEditedBy', 'name fullName full_name roles role type perfil')
      .populate('subjects.scoreHistory.actorId', 'name fullName full_name roles role type perfil')
      .sort({ createdAt: 1 });
  }

  _buildTermInfo(reportCard, insertionOrder) {
    const term = reportCard.termId;
    const termId = extractId(term);
    const label = readName(term, 'Bimestre');
    const parsedOrder = parseTermOrder(label);
    const startDate = term?.dataInicio || term?.startDate || null;

    return {
      id: termId,
      label,
      order: parsedOrder ?? insertionOrder,
      startDate: startDate ? new Date(startDate).toISOString() : null,
      _sortStart: termStartTime(term),
      _stableOrder: insertionOrder,
    };
  }

  _buildClassInfo(classDoc) {
    const id = extractId(classDoc);
    return {
      id,
      name: readName(classDoc, 'Turma nao informada'),
    };
  }

  _buildSubjectKey(subject) {
    const subjectId = extractId(subject.subjectId);
    if (subjectId) return `id:${subjectId}`;

    const subjectName = normalizeText(subject.subjectNameSnapshot);
    return `name:${subjectName || 'disciplina'}`;
  }

  _buildSubjectName(subject) {
    return String(subject.subjectNameSnapshot || '').trim() || 'Disciplina';
  }

  _scoreValue(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? roundToOne(numeric) : null;
  }

  async getStudentHistory({ schoolId, studentId, schoolYear }) {
    if (!schoolId) {
      throw createHttpError('Contexto da escola nao informado.', 403);
    }
    if (!studentId) {
      throw createHttpError('studentId e obrigatorio.', 400);
    }

    const parsedSchoolYear = Number(schoolYear);
    if (!Number.isInteger(parsedSchoolYear) || parsedSchoolYear < 1900) {
      throw createHttpError('schoolYear invalido.', 400);
    }

    const [student, school, reportCards] = await Promise.all([
      this._loadStudent(studentId, schoolId),
      this._loadSchool(schoolId),
      this._loadReportCards({
        schoolId,
        studentId,
        schoolYear: parsedSchoolYear,
      }),
    ]);

    const warnings = [];
    const termMap = new Map();
    const classMap = new Map();
    const subjectMap = new Map();

    for (const reportCard of reportCards || []) {
      const termId = extractId(reportCard.termId);
      if (!termId) {
        warnings.push('Foi encontrado boletim sem bimestre vinculado.');
        continue;
      }

      if (!termMap.has(termId)) {
        termMap.set(termId, this._buildTermInfo(reportCard, termMap.size + 1));
      }

      const classInfo = this._buildClassInfo(reportCard.classId);
      if (classInfo.id && !classMap.has(classInfo.id)) {
        classMap.set(classInfo.id, classInfo);
      }

      for (const subject of reportCard.subjects || []) {
        const key = this._buildSubjectKey(subject);
        const subjectId = extractId(subject.subjectId);
        if (!subjectMap.has(key)) {
          subjectMap.set(key, {
            subjectId,
            subjectName: this._buildSubjectName(subject),
            scoresByTerm: {},
            statusesByTerm: {},
            contextsByTerm: {},
            _minimumAverage:
              Number(reportCard.minimumAverage) > 0
                ? Number(reportCard.minimumAverage)
                : 7,
          });
        }

        const entry = subjectMap.get(key);
        const score = this._scoreValue(subject.score);
        entry.scoresByTerm[termId] = score;
        entry.statusesByTerm[termId] =
          String(subject.status || '').trim() || (score === null ? 'Pendente' : 'Preenchido');
        const teacher = actorSummary(
          subject.teacherId,
          subject.teacherNameSnapshot || ''
        );
        const lastEditor = actorSummary(subject.lastEditedBy);
        const filledBy = actorSummary(subject.filledBy);
        entry.contextsByTerm[termId] = {
          reportCardId: extractId(reportCard),
          classId: extractId(reportCard.classId),
          score,
          testScore: this._scoreValue(subject.testScore),
          activityScore: this._scoreValue(subject.activityScore),
          participationScore: this._scoreValue(subject.participationScore),
          teacherId: teacher.id,
          teacherName: teacher.name,
          filledBy,
          filledAt: subject.filledAt || null,
          lastEditedBy: lastEditor,
          lastEditedAt: subject.lastEditedAt || null,
          lastEditedRole: subject.lastEditedRole || lastEditor.role || '',
          lastEditedSource: subject.lastEditedSource || '',
          observation: subject.observation || '',
          history: (subject.scoreHistory || [])
            .map((event) => {
              const actor = actorSummary(
                event.actorId,
                event.actorNameSnapshot || ''
              );
              return {
                id: extractId(event),
                actor,
                actorRole: event.actorRole || actor.role || '',
                source: event.source || '',
                reason: event.reason || '',
                changedAt: event.changedAt || null,
                previous: event.previous || null,
                current: event.current || null,
              };
            })
            .sort(
              (left, right) =>
                new Date(right.changedAt || 0) - new Date(left.changedAt || 0)
            ),
        };
      }
    }

    const terms = [...termMap.values()].sort(compareTerms).map((term, index) => ({
      id: term.id,
      label: term.label,
      order: term.order || index + 1,
      startDate: term.startDate,
    }));

    const termIds = terms.map((term) => term.id);
    const subjects = [...subjectMap.values()]
      .map((subject) => {
        const filledScores = termIds
          .map((termId) => subject.scoresByTerm[termId])
          .filter((score) => score !== null && score !== undefined);

        const hasFourBimesters = filledScores.length >= 4;
        const finalAverage = hasFourBimesters
          ? roundToOne(
              filledScores.slice(0, 4).reduce((sum, score) => sum + Number(score), 0) / 4
            )
          : null;

        const situation = !hasFourBimesters
          ? 'Em andamento'
          : finalAverage >= subject._minimumAverage
            ? 'Aprovado'
            : 'Abaixo da média';

        return {
          subjectId: subject.subjectId,
          subjectName: subject.subjectName,
          scoresByTerm: subject.scoresByTerm,
          statusesByTerm: subject.statusesByTerm,
          contextsByTerm: subject.contextsByTerm,
          filledTermsCount: filledScores.length,
          finalAverage,
          situation,
        };
      })
      .sort((left, right) => left.subjectName.localeCompare(right.subjectName, 'pt-BR'));

    const classes = [...classMap.values()];
    if (classes.length > 1) {
      warnings.push('Foram encontrados boletins em mais de uma turma no ano letivo.');
    }

    return {
      student: {
        id: extractId(student),
        fullName: student.fullName || '',
        enrollmentNumber: student.enrollmentNumber || '',
      },
      schoolYear: parsedSchoolYear,
      school: {
        id: extractId(school) || String(schoolId),
        name: school?.name || '',
      },
      classes,
      terms,
      subjects,
      warnings,
    };
  }
}

module.exports = new ReportCardHistoryService();
module.exports.ReportCardHistoryService = ReportCardHistoryService;
