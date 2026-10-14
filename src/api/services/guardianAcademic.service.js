const ReportCard = require('../models/reportCard.model');
const SchoolYear = require('../models/schoolyear.model');
const Periodo = require('../models/periodo.model');
const Class = require('../models/class.model');
const School = require('../models/school.model');
const Horario = require('../models/horario.model');
const Evaluation = require('../models/evaluation.model');
const Grade = require('../models/grade.model');
const { evaluationModeForClass } = require('../utils/reportCardEvaluationMode.helper');

const id = value => String(value?._id || value?.id || value || '');
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const termNumber = title => {
  const match = String(title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/^\s*([1-4])\s*[º°.oªa]*\s*bim(?:estre)?\b/i);
  return match ? Number(match[1]) : null;
};
const released = card => card.releasedForPrint === true || ['Liberado', 'Impresso'].includes(card.status);
function error(message, statusCode) { return Object.assign(new Error(message), { statusCode }); }

// Read-only projection of the existing official report cards. It never writes
// grades, imports exam results, or recalculates a subject's consolidated score.
class GuardianAcademicService {
  constructor(options = {}) {
    this.models = { ReportCard, SchoolYear, Periodo, Class, School, Horario, Evaluation, Grade, ...options.models };
    this.resolveContext = options.resolveContext || (context => require('./guardianAuth.service')._resolveGuardianStudentContext(context));
    this.now = options.now || (() => new Date());
  }

  async getPerformance({ schoolId, accountId, studentId }) {
    if (!schoolId || !accountId) throw error('Sessão do responsável inválida.', 401);
    // Must precede every academic read, including queries for arbitrary IDs.
    const { selectedStudent, linkedStudents } = await this.resolveContext({ schoolId, accountId, studentId });
    if (!selectedStudent || id(selectedStudent.id) !== String(studentId)) throw error('Aluno vinculado não encontrado.', 404);
    const { models: m } = this;
    const classId = id(selectedStudent.class?.id);
    const [classDoc, school] = await Promise.all([
      classId ? m.Class.findOne({ _id: classId, school_id: schoolId }).lean() : null,
      m.School.findOne({ _id: schoolId }).select('educationModel').lean(),
    ]);
    const academicYear = Number(selectedStudent.enrollment?.academicYear || classDoc?.schoolYear) || null;
    const student = { ...selectedStudent, class: classDoc ? { ...selectedStudent.class, level: classDoc.level } : null };
    const base = { selectedStudent: student, linkedStudents, academicYear, generatedAt: this.now().toISOString(),
      source: 'official_report_cards', visibility: 'saved_report_cards', gradingType: evaluationModeForClass(classDoc || {}),
      scale: { min: 0, max: 10 }, summaryMethod: 'unweighted_mean_of_published_subject_scores',
      summaryMeaning: 'Indicador informativo do boletim; não representa aprovação anual.', terms: [] };
    if (school?.educationModel === 'technical_apprenticeship') return { ...base, supported: false, reason: 'TECHNICAL_EDUCATION_MODEL' };
    if (!classDoc || !academicYear) return { ...base, supported: false, reason: 'NO_ACADEMIC_CONTEXT' };
    const year = await m.SchoolYear.findOne({ school_id: schoolId, year: academicYear }).lean();
    const [periods, cards, schedule] = await Promise.all([
      year ? m.Periodo.find({ school_id: schoolId, anoLetivoId: year._id, tipo: 'Letivo' }).sort({ dataInicio: 1 }).lean() : [],
      m.ReportCard.find({ school_id: schoolId, studentId: studentId, schoolYear: academicYear }).sort({ updatedAt: -1 }).lean(),
      m.Horario.find({ school_id: schoolId, classId }).populate('subjectId', 'name').populate('teacherId', 'name fullName').lean(),
    ]);
    const configured = periods.filter(p => termNumber(p.titulo));
    if (periods.length && configured.length !== periods.length) return { ...base, supported: false, reason: 'NON_BIMESTER_CALENDAR' };
    // School-approved product policy: show saved official entries immediately,
    // explicitly marking report cards that have not been released as ongoing.
    const available = cards;
    const evaluations = year ? await m.Evaluation.find({ school: schoolId,
      schoolYear: year._id, classInfo: { $in: [...new Set([classId, ...available.map(c => id(c.classId))])] },
      term: { $in: configured.map(p => p.titulo) } }).populate({ path: 'subject', select: 'name', match: { school_id: schoolId } })
      .populate({ path: 'teacher', select: 'name fullName', match: { school_id: schoolId } }).sort({ date: 1 }).lean() : [];
    const grades = evaluations.length ? await m.Grade.find({ student: studentId,
      evaluation: { $in: evaluations.map(e => e._id) } }).lean() : [];
    const gradeByEvaluation = new Map(grades.map(g => [id(g.evaluation), g]));
    const belongsToPeriod = (e, period, contextClassId) => period && id(e.classInfo) === id(contextClassId)
      && e.term === period.titulo && new Date(e.date) >= new Date(period.dataInicio) && new Date(e.date) <= new Date(period.dataFim);
    const evaluationDetails = (subject, period, contextClassId, contextEnrollmentId) => evaluations
      .filter(e => id(e.subject) === id(subject) && belongsToPeriod(e, period, contextClassId))
      .map(e => { const grade = gradeByEvaluation.get(id(e._id));
        return { id: id(e._id), title: e.title, type: e.type, date: e.date,
          score: grade && id(grade.enrollment) === id(contextEnrollmentId) ? numeric(grade.value) : null,
          maxScore: numeric(e.maxScore), weight: null }; });
    const now = this.now().getTime();
    const terms = [1, 2, 3, 4].map(number => {
      const matches = configured.filter(p => termNumber(p.titulo) === number);
      // Ambiguous configuration must not silently merge results.
      const period = matches.length === 1 ? matches[0] : null;
      const matchingCards = period ? available.filter(c => id(c.termId) === id(period._id)) : [];
      const card = matchingCards.find(c => id(c.enrollmentId) === id(selectedStudent.enrollment?.id)) || matchingCards[0] || null;
      const gradingType = base.gradingType === 'developmental' || card?.evaluationMode === 'developmental'
        || card?.gradingType === 'developmental' || card?.developmentalAssessments?.length
        ? 'developmental' : 'numeric';
      const minimumAverage = card ? numeric(card.minimumAverage) : null;
      const threshold = minimumAverage !== null && minimumAverage >= 0 && minimumAverage <= 10 ? minimumAverage : null;
      let subjects = card ? (card.subjects || []).map(s => {
        const subjectKey = id(s.subjectId) || s.areaId;
        const assessment = gradingType === 'developmental' ? (card.developmentalAssessments || []).find(a =>
          (id(a.subjectId) || a.areaId) === subjectKey && id(a.teacherId) === id(s.teacherId)) : null;
        const score = gradingType === 'numeric' ? numeric(s.score) : null;
        const details = gradingType === 'numeric' ? evaluationDetails(s.subjectId, period, card.classId, card.enrollmentId) : [];
        const imported = s.testScoreSource;
        if (gradingType === 'numeric' && imported?.type === 'exam_result_import' && numeric(imported.originalGrade) !== null) {
          details.push({ id: id(imported.examId), title: imported.examTitle || 'Prova importada', type: 'EXAM',
            date: imported.importedAt || null, score: numeric(imported.originalGrade), maxScore: numeric(imported.originalMaxGrade), weight: null });
        }
        return { id: `${subjectKey}:${id(s.teacherId)}`, subjectId: id(s.subjectId), name: s.subjectNameSnapshot,
          teacherName: s.teacherNameSnapshot || assessment?.teacherName || null, score,
          performance: score === null || threshold === null ? null : score >= threshold ? 'meets_criterion' : 'below_criterion',
          status: s.status, observation: assessment?.generalObservation || s.observation || '',
          components: gradingType === 'numeric' ? [['testScore', 'Prova'], ['activityScore', 'Atividades'], ['participationScore', 'Participação']]
            .filter(([key]) => numeric(s[key]) !== null).map(([key, title]) => ({ title, score: s[key], maxScore: null, weight: null })) : [],
          evaluations: details, criteria: assessment?.criteria?.map(c => ({ description: c.description, status: c.status })) || [],
          completionStatus: assessment?.completionStatus || null, updatedAt: s.lastEditedAt || s.filledAt || card.updatedAt };
      }) : [];
      // With no official report card yet, the existing timetable supplies only
      // the subject catalog, never synthetic grades or calculated diary means.
      if (!card) {
        const relevant = schedule.filter(slot => !period || id(slot.termId) === id(period._id));
        const unique = new Map(relevant.filter(slot => slot.subjectId?.name).map(slot => [id(slot.subjectId), slot]));
        for (const evaluation of evaluations.filter(e => e.subject?.name && belongsToPeriod(e, period, classId))) {
          if (!unique.has(id(evaluation.subject))) unique.set(id(evaluation.subject), { subjectId: evaluation.subject, teacherId: evaluation.teacher });
        }
        subjects = [...unique.values()].map(slot => ({ id: id(slot.subjectId), subjectId: id(slot.subjectId), name: slot.subjectId.name,
          teacherName: slot.teacherId?.fullName || slot.teacherId?.name || null, score: null, performance: null,
          status: 'Pendente', components: [], evaluations: gradingType === 'numeric'
            ? evaluationDetails(slot.subjectId, period, classId, selectedStudent.enrollment?.id) : [], criteria: [], observation: '' }));
      }
      subjects.sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR') || a.id.localeCompare(b.id));
      const scores = subjects.map(s => s.score).filter(s => s !== null);
      // Matches the informational mean already used by the teacher report-card
      // UI. Official subject scores are never recomposed from diary evaluations.
      const average = gradingType === 'numeric' && scores.length ? scores.reduce((sum, s) => sum + s, 0) / scores.length : null;
      const complete = scores.length > 0 && scores.length === subjects.length;
      return { number, id: period ? id(period._id) : null, title: period?.titulo || `${number}º Bimestre`,
        startDate: period?.dataInicio || null, endDate: period?.dataFim || null,
        state: card ? released(card) ? 'published' : 'in_progress' : period && new Date(period.dataInicio).getTime() > now ? 'not_started' : period ? 'awaiting_results' : 'not_configured',
        gradingType, reportCardStatus: card?.status || null, releasedAt: card?.releasedAt || null,
        minimumAverage: threshold, average, evaluatedCount: gradingType === 'developmental'
          ? subjects.filter(s => ['completed', 'Concluído', 'Concluido'].includes(s.completionStatus)).length : scores.length,
        totalCount: subjects.length, partial: gradingType === 'numeric' && scores.length > 0 && !complete,
        performance: complete && threshold !== null ? average >= threshold ? 'meets_criterion' : 'below_criterion' : null, subjects };
    });
    const active = terms.find(t => t.startDate && new Date(t.startDate).getTime() <= now && new Date(t.endDate).getTime() >= now);
    const withData = [...terms].reverse().find(t => t.evaluatedCount > 0);
    const next = terms.find(t => t.startDate && new Date(t.startDate).getTime() > now);
    return { ...base, supported: true, terms, initialTerm: (active || withData || next || terms[0]).number };
  }
}
module.exports = new GuardianAcademicService();
module.exports.GuardianAcademicService = GuardianAcademicService;
module.exports.termNumber = termNumber;
