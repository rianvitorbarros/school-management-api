/* eslint-disable global-require */
const mongoose = require('mongoose');

/**
 * Liga a correção por QR Code (scanner do AcademyHub mobile) das avaliações
 * feitas no modo Canva ao Diário e ao boletim:
 * - Educação Infantil: os critérios da disciplina no boletim (conceitos);
 * - demais turmas: a nota da prova de lançamento direto (Diário -> boletim).
 *
 * Atividades livres continuam com os critérios de sempre e não mexem em nota.
 */

const CONCEPT_SCALE = [
  'Realiza com autonomia',
  'Realiza com apoio',
  'Em desenvolvimento',
  'Nao trabalhado no bimestre',
];
const CONCEPT_STATUS = {
  'Realiza com autonomia': 'autonomy',
  'Realiza com apoio': 'support',
  'Em desenvolvimento': 'developing',
  'Nao trabalhado no bimestre': 'not_worked',
};
const NUMERIC_KEY = 'nota';

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function formatScore(value) {
  return Number.isInteger(value) ? String(value) : String(value).replace('.', ',');
}

function numericScale(maxScore) {
  const max = Math.max(1, Math.min(100, Number(maxScore) || 10));
  const step = max <= 20 ? 0.5 : 1;
  const values = [];
  for (let value = 0; value <= max + 1e-9; value += step) {
    values.push(formatScore(Math.round(value * 10) / 10));
  }
  return values;
}

function parseScore(value) {
  const number = Number(String(value || '').replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

class ActivityAssessmentBridge {
  constructor(deps = {}) {
    this.deps = deps;
  }

  get ActivityDesign() { return this.deps.ActivityDesign || require('../models/activityDesign.model'); }
  get ClassModel() { return this.deps.ClassModel || require('../models/class.model'); }
  get ReportCard() { return this.deps.ReportCard || require('../models/reportCard.model'); }
  get Periodo() { return this.deps.Periodo || require('../models/periodo.model'); }
  get Subject() { return this.deps.Subject || require('../models/subject.model'); }
  get reportCardService() { return this.deps.reportCardService || require('./reportCard.service'); }
  get examService() { return this.deps.examService || require('./exam.service'); }
  get activityDesignService() { return this.deps.activityDesignService || require('./activityDesign.service'); }
  get criteriaHelper() { return this.deps.criteriaHelper || require('../utils/earlyChildhoodCriteria.helper'); }
  get modeHelper() { return this.deps.modeHelper || require('../utils/reportCardEvaluationMode.helper'); }

  /** Contexto da avaliação (ou null quando é atividade livre). */
  async contextFor({ activityBook, printRun }) {
    const designId = activityBook?.activityDesignId;
    if (!designId || !mongoose.Types.ObjectId.isValid(String(designId))) return null;
    const design = await this.ActivityDesign.findById(designId).lean();
    if (!design || design.purpose !== 'assessment') return null;

    const classDoc = printRun?.classId
      ? await this.ClassModel.findById(printRun.classId).lean()
      : null;
    const mode = classDoc && this.modeHelper.evaluationModeForClass(classDoc) === 'developmental'
      ? 'developmental'
      : 'numeric';
    const maxScore = Number(design.maxScore) || 10;

    const template = mode === 'developmental'
      ? this.criteriaHelper.getCriteriaForSubjectName(design.subject || '')
        .map((criterion) => ({
          key: criterion.criterionId,
          label: criterion.description,
          scale: [...CONCEPT_SCALE],
        }))
      : [{ key: NUMERIC_KEY, label: `Nota (0 a ${formatScore(maxScore)})`, scale: numericScale(maxScore) }];

    return { design, classDoc, mode, maxScore, template };
  }

  describe(context) {
    if (!context) return null;
    return {
      designId: String(context.design._id),
      mode: context.mode,
      maxScore: context.maxScore,
      subject: context.design.subject || '',
      destination: context.mode === 'developmental' ? 'boletim' : 'diario',
    };
  }

  async resolveTermId({ schoolId, printRun }) {
    if (printRun?.termId) return String(printRun.termId);
    const date = printRun?.printDate ? new Date(printRun.printDate) : new Date();
    const period = await this.Periodo.findOne({
      school_id: schoolId,
      tipo: 'Letivo',
      dataInicio: { $lte: date },
      dataFim: { $gte: date },
    }).select('_id').lean();
    if (period) return String(period._id);
    const latest = await this.Periodo.findOne({ school_id: schoolId, tipo: 'Letivo', dataInicio: { $lte: date } })
      .sort({ dataInicio: -1 })
      .select('_id')
      .lean();
    return latest ? String(latest._id) : null;
  }

  /**
   * Leva a correção para o boletim (conceitos) ou para o Diário (nota).
   * Devolve { ok, destination, message }.
   */
  async sync({ schoolId, actor, context, printRun, studentId, criteria = [] }) {
    if (!context) return null;
    const termId = await this.resolveTermId({ schoolId, printRun });
    if (!termId) {
      return { ok: false, destination: context.mode, message: 'Bimestre nao encontrado para esta impressao.' };
    }
    if (context.mode === 'developmental') {
      return this.syncConcepts({ schoolId, actor, context, termId, studentId, criteria });
    }
    return this.syncGrade({ schoolId, actor, context, termId, studentId, criteria });
  }

  async syncConcepts({ schoolId, actor, context, termId, studentId, criteria }) {
    const classDoc = context.classDoc;
    const query = { school_id: schoolId, classId: classDoc._id, studentId, termId };
    let reportCard = await this.ReportCard.findOne(query).lean();
    if (!reportCard) {
      await this.reportCardService.generateClassReportCards({
        schoolId,
        classId: String(classDoc._id),
        termId,
        schoolYear: classDoc.schoolYear,
      });
      reportCard = await this.ReportCard.findOne(query).lean();
    }
    if (!reportCard) {
      return { ok: false, destination: 'boletim', message: 'Boletim do aluno nao encontrado neste bimestre.' };
    }

    const wanted = normalize(context.design.subject);
    const subject = (reportCard.subjects || []).find(
      (item) => normalize(item.subjectNameSnapshot) === wanted
    );
    if (!subject) {
      return { ok: false, destination: 'boletim', message: `Disciplina "${context.design.subject}" nao esta no boletim.` };
    }
    const key = String(subject.areaId || subject.subjectId || '');
    const existing = (reportCard.developmentalAssessments || []).find(
      (item) => String(item.areaId || '') === key || String(item.subjectId || '') === key
    );
    const statusById = new Map(
      criteria
        .filter((entry) => CONCEPT_STATUS[entry.value])
        .map((entry) => [entry.key, CONCEPT_STATUS[entry.value]])
    );
    const base = existing?.criteria?.length
      ? existing.criteria.map((item) => ({
        criterionId: item.criterionId,
        description: item.description,
        status: item.status || null,
      }))
      : context.template.map((item) => ({ criterionId: item.key, description: item.label, status: null }));
    const merged = base.map((item) => (
      statusById.has(item.criterionId) ? { ...item, status: statusById.get(item.criterionId) } : item
    ));

    await this.reportCardService.updateTeacherSubjectDevelopmentalAssessment({
      schoolId,
      reportCardId: String(reportCard._id),
      subjectId: key,
      actor,
      criteria: merged,
      generalObservation: existing?.generalObservation || '',
    });
    return { ok: true, destination: 'boletim', message: 'Conceitos lancados no boletim.' };
  }

  async syncGrade({ schoolId, actor, context, termId, studentId, criteria }) {
    const entry = criteria.find((item) => item.key === NUMERIC_KEY);
    const grade = parseScore(entry?.value);
    if (grade === null) return { ok: false, destination: 'diario', message: 'Nota nao informada.' };

    let examId = context.design.examId ? String(context.design.examId) : null;
    if (!examId) {
      const escaped = String(context.design.subject || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const subject = escaped
        ? await this.Subject.findOne({ school_id: schoolId, name: new RegExp(`^${escaped}$`, 'i') }).select('_id').lean()
        : null;
      if (!subject) {
        return { ok: false, destination: 'diario', message: 'Informe a disciplina da avaliacao no editor.' };
      }
      const prepared = await this.activityDesignService.ensureAssessmentExam(
        String(context.design._id),
        actor,
        { subjectId: String(subject._id), termId }
      );
      examId = prepared.examId;
    }
    await this.examService.saveDirectGrades(examId, schoolId, [{ studentId: String(studentId), grade }]);
    return { ok: true, destination: 'diario', message: 'Nota lancada no Diario.' };
  }
}

module.exports = new ActivityAssessmentBridge();
module.exports.ActivityAssessmentBridge = ActivityAssessmentBridge;
module.exports.CONCEPT_SCALE = CONCEPT_SCALE;
module.exports.numericScale = numericScale;
