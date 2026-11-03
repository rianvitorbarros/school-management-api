// src/api/services/gemini-exam.service.js
//
// Iara: assistente de criacao e revisao de provas.
// Orquestra prompt -> modelo -> validacao -> registro de uso.

const mongoose = require('mongoose');

const IaraUsageLog = require('../models/iaraUsageLog.model');
const { generateJson } = require('./iara/iaraModel.client');
const prompts = require('./iara/iaraPrompts');
const utils = require('./iara/iaraQuestion.utils');

const { IaraValidationError } = utils;

const ATTACHMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
]);
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

function toObjectIdOrNull(value) {
  if (!value) return null;
  const text = String(value);
  return mongoose.Types.ObjectId.isValid(text) ? new mongoose.Types.ObjectId(text) : null;
}

function readUsage(usage) {
  return {
    promptTokens: usage?.promptTokenCount || 0,
    outputTokens: usage?.candidatesTokenCount || 0,
    totalTokens: usage?.totalTokenCount || 0,
  };
}

class GeminiExamService {
  constructor({
    generate = generateJson,
    UsageLog = IaraUsageLog,
    loadExamModel = () => require('../models/exam.model'), // eslint-disable-line global-require
    loadExamService = () => require('./exam.service'), // eslint-disable-line global-require
    random = Math.random,
  } = {}) {
    this.generate = generate;
    this.UsageLog = UsageLog;
    this.loadExamModel = loadExamModel;
    this.loadExamService = loadExamService;
    this.random = random;
  }

  async _logUsage(entry) {
    try {
      await this.UsageLog.create(entry);
    } catch (error) {
      console.warn('[Iara] Falha ao registrar uso', { message: error?.message });
    }
  }

  /**
   * Executa uma acao da Iara medindo tempo/tokens e registrando o uso
   * (inclusive em caso de erro, para que a cota diaria seja respeitada).
   */
  async _run(action, actor, { requested = 0, meta = null }, executor) {
    const startedAt = Date.now();
    const base = {
      school_id: toObjectIdOrNull(actor?.school_id || actor?.schoolId),
      user_id: toObjectIdOrNull(actor?.id || actor?._id),
      action,
      requested,
      meta,
    };
    try {
      const outcome = await executor();
      const durationMs = Date.now() - startedAt;
      await this._logUsage({
        ...base,
        status: 'SUCCESS',
        model: outcome.model || null,
        attempts: outcome.attempts || 0,
        durationMs,
        ...readUsage(outcome.usage),
        returned: outcome.returned || 0,
        discarded: outcome.discarded || 0,
      });
      console.info('[Iara] Acao concluida', {
        action,
        userId: base.user_id ? String(base.user_id) : null,
        model: outcome.model,
        durationMs,
        requested,
        returned: outcome.returned || 0,
        discarded: outcome.discarded || 0,
        totalTokens: readUsage(outcome.usage).totalTokens,
      });
      return { ...outcome.result, meta: { model: outcome.model, durationMs, requested, returned: outcome.returned || 0, discarded: outcome.discarded || 0 } };
    } catch (error) {
      if (!(error instanceof IaraValidationError)) {
        await this._logUsage({
          ...base,
          status: 'ERROR',
          durationMs: Date.now() - startedAt,
          errorMessage: String(error?.cause?.message || error?.message || '').slice(0, 500),
        });
      }
      throw error;
    }
  }

  _buildAttachmentPart(attachment) {
    if (!attachment) return null;
    if (!ATTACHMENT_MIME_TYPES.has(attachment.mimetype)) {
      throw new IaraValidationError('Formato de arquivo nao suportado. Envie PDF, imagem (PNG, JPG, WEBP) ou texto.');
    }
    if (!attachment.buffer || attachment.size > ATTACHMENT_MAX_BYTES) {
      throw new IaraValidationError('O arquivo deve ter no maximo 10 MB.');
    }
    return { inlineData: { mimeType: attachment.mimetype, data: attachment.buffer.toString('base64') } };
  }

  /**
   * Busca enunciados de provas anteriores da mesma turma/disciplina para
   * evitar que a Iara repita questoes ja aplicadas.
   */
  async _loadPreviousQuestionTexts({ schoolId, classId, subjectId, examId }) {
    const schoolObjectId = toObjectIdOrNull(schoolId);
    const classObjectId = toObjectIdOrNull(classId);
    const subjectObjectId = toObjectIdOrNull(subjectId);
    if (!schoolObjectId || !classObjectId || !subjectObjectId) return [];
    try {
      const Exam = this.loadExamModel();
      const filter = { school_id: schoolObjectId, class_id: classObjectId, subject_id: subjectObjectId };
      const excludeId = toObjectIdOrNull(examId);
      if (excludeId) filter._id = { $ne: excludeId };
      const exams = await Exam.find(filter).sort({ createdAt: -1 }).limit(10).select('questions.text').lean();
      return exams
        .flatMap((exam) => (exam.questions || []).map((question) => utils.asTrimmedString(question.text, utils.LIMITS.avoidQuestionMaxLength)))
        .filter(Boolean)
        .slice(0, 40);
    } catch (error) {
      console.warn('[Iara] Nao foi possivel carregar provas anteriores', { message: error?.message });
      return [];
    }
  }

  async generateQuestions(body, { actor = null, attachment = null } = {}) {
    const request = utils.parseGenerateRequest(body);
    const attachmentPart = this._buildAttachmentPart(attachment);
    request.hasAttachment = Boolean(attachmentPart);

    return this._run('GENERATE', actor, {
      requested: request.count,
      meta: { type: request.type, difficulty: request.difficulty, subject: request.subject, hasSource: Boolean(request.sourceText || attachmentPart) },
    }, async () => {
      const previous = await this._loadPreviousQuestionTexts({
        schoolId: actor?.school_id || actor?.schoolId,
        classId: request.classId,
        subjectId: request.subjectId,
        examId: request.examId,
      });
      const avoidQuestions = [...request.avoidQuestions, ...previous].slice(0, utils.LIMITS.avoidQuestionsMax);

      const parts = [{ text: prompts.buildGeneratePrompt({ ...request, avoidQuestions }) }];
      if (attachmentPart) parts.push(attachmentPart);

      const response = await this.generate({
        parts,
        systemInstruction: prompts.SYSTEM_INSTRUCTION,
        responseSchema: prompts.QUESTIONS_RESPONSE_SCHEMA,
      });

      const { questions, discarded } = utils.sanitizeGeneratedQuestions(response.data, {
        avoidQuestions,
        expectedType: request.type,
        defaultDifficulty: request.difficulty === 'MIXED' ? null : request.difficulty,
        random: this.random,
      });

      // Respeita a quantidade pedida por tipo quando a IA entrega a mais.
      const objective = questions.filter((question) => question.type === 'OBJECTIVE').slice(0, request.objectiveCount);
      const dissertative = questions.filter((question) => question.type === 'DISSERTATIVE').slice(0, request.dissertativeCount);
      const finalQuestions = [...objective, ...dissertative];

      if (finalQuestions.length === 0) {
        const error = new Error('A Iara nao conseguiu gerar questoes validas para esse pedido. Tente detalhar melhor o tema.');
        error.statusCode = 422;
        error.cause = { message: JSON.stringify(discarded).slice(0, 400) };
        throw error;
      }

      return {
        result: { questions: finalQuestions, warnings: finalQuestions.length < request.count
          ? [`A Iara entregou ${finalQuestions.length} de ${request.count} questoes validas. Voce pode gerar novamente as que faltaram.`]
          : [] },
        model: response.model,
        usage: response.usage,
        attempts: response.attempts,
        returned: finalQuestions.length,
        discarded: discarded.length,
      };
    });
  }

  async regenerateQuestion(body, { actor = null } = {}) {
    const request = utils.parseRegenerateRequest(body);
    return this._run('REGENERATE', actor, { requested: 1, meta: { type: request.type, instruction: request.instruction } }, async () => {
      const avoidQuestions = [request.question.text, ...request.avoidQuestions];
      const response = await this.generate({
        parts: [{ text: prompts.buildRegeneratePrompt({ ...request, avoidQuestions }) }],
        systemInstruction: prompts.SYSTEM_INSTRUCTION,
        responseSchema: prompts.QUESTIONS_RESPONSE_SCHEMA,
        temperature: 0.9,
      });
      const { questions, discarded } = utils.sanitizeGeneratedQuestions(response.data, {
        avoidQuestions,
        expectedType: request.type,
        defaultDifficulty: request.difficulty,
        random: this.random,
      });
      if (!questions.length) {
        const error = new Error('A Iara nao conseguiu criar uma nova versao valida. Tente novamente.');
        error.statusCode = 422;
        throw error;
      }
      return {
        result: { question: questions[0] },
        model: response.model,
        usage: response.usage,
        attempts: response.attempts,
        returned: 1,
        discarded: discarded.length,
      };
    });
  }

  async reviewExam(body = {}, { actor = null } = {}) {
    const questions = utils.parseExamQuestions(body.questions);
    const deterministic = utils.runDeterministicReview(questions, {
      totalValue: body.totalValue,
      correctionType: body.correctionType,
    });
    const useAi = utils.toBoolean(body.useAi, true);

    const buildResult = (aiReview) => {
      const aiIssues = (aiReview?.issues || [])
        .map((issue) => {
          const number = Number.parseInt(issue.questionNumber, 10);
          return {
            questionIndex: Number.isFinite(number) && number >= 1 && number <= questions.length ? number - 1 : null,
            severity: ['INFO', 'WARNING', 'ERROR'].includes(issue.severity) ? issue.severity : 'INFO',
            category: utils.asTrimmedString(issue.category, 40).toUpperCase() || 'CONTEUDO',
            message: utils.asTrimmedString(issue.message, 600),
            suggestion: utils.asTrimmedString(issue.suggestion, 600) || null,
            source: 'IARA',
          };
        })
        .filter((issue) => issue.message);
      const severityOrder = { ERROR: 0, WARNING: 1, INFO: 2 };
      const issues = [...deterministic.issues, ...aiIssues].sort((left, right) =>
        severityOrder[left.severity] - severityOrder[right.severity]
        || (left.questionIndex ?? -1) - (right.questionIndex ?? -1));
      return {
        summary: utils.asTrimmedString(aiReview?.summary, 1200) || null,
        estimatedMinutes: Number.isFinite(Number(aiReview?.estimatedMinutes)) ? Number(aiReview.estimatedMinutes) : null,
        answerKeyDistribution: deterministic.answerKeyDistribution,
        weightSum: deterministic.weightSum,
        issues,
      };
    };

    const reviewable = questions.filter((question) => question.text.length >= 10);
    if (!useAi || reviewable.length === 0) {
      return { ...buildResult(null), meta: { model: null, durationMs: 0, requested: questions.length, returned: 0, discarded: 0 } };
    }

    return this._run('REVIEW', actor, { requested: questions.length }, async () => {
      const response = await this.generate({
        parts: [{ text: prompts.buildReviewPrompt({ subject: body.subject, gradeLevel: body.gradeLevel, title: body.title, questions: reviewable }) }],
        systemInstruction: prompts.SYSTEM_INSTRUCTION,
        responseSchema: prompts.REVIEW_RESPONSE_SCHEMA,
        temperature: 0.2,
      });
      return {
        result: buildResult(response.data),
        model: response.model,
        usage: response.usage,
        attempts: response.attempts,
        returned: questions.length,
      };
    });
  }

  async adaptQuestions(body = {}, { actor = null } = {}) {
    const questions = utils.parseExamQuestions(body.questions, { max: 30 });
    const needs = utils.asTrimmedString(body.needs, 500) || null;

    return this._run('ADAPT', actor, { requested: questions.length, meta: { needs } }, async () => {
      const response = await this.generate({
        parts: [{ text: prompts.buildAdaptPrompt({ subject: body.subject, gradeLevel: body.gradeLevel, needs, questions }) }],
        systemInstruction: prompts.SYSTEM_INSTRUCTION,
        responseSchema: prompts.QUESTIONS_RESPONSE_SCHEMA,
        temperature: 0.3,
      });
      const items = Array.isArray(response.data?.questions) ? response.data.questions : [];
      let discarded = 0;
      // Mantem o alinhamento com a lista original: item invalido vira null
      // (o app mantem a questao original nesse caso).
      const adapted = questions.map((original, index) => {
        const { question, error } = utils.normalizeQuestion(items[index]);
        if (error || question.type !== original.type) {
          discarded += 1;
          return null;
        }
        return { ...question, weight: original.weight > 0 ? original.weight : question.weight };
      });
      return {
        result: { questions: adapted },
        model: response.model,
        usage: response.usage,
        attempts: response.attempts,
        returned: adapted.filter(Boolean).length,
        discarded,
      };
    });
  }

  async buildRecoveryPlan(examId, body = {}, { actor = null, schoolId = null } = {}) {
    const count = Math.min(10, Math.max(1, Number.parseInt(body.count, 10) || 5));
    const difficulty = ['EASY', 'MEDIUM', 'HARD', 'MIXED'].includes(String(body.difficulty || '').toUpperCase())
      ? String(body.difficulty).toUpperCase()
      : 'MEDIUM';

    const examService = this.loadExamService();
    const results = await examService.getExamResults(examId, schoolId, actor);
    const insights = (results?.insights?.questions || []).filter((item) => item.responses > 0);
    if (!results?.insights?.available || insights.length === 0) {
      throw new IaraValidationError('A analise por questao fica disponivel depois que houver cartoes-resposta corrigidos nesta prova.');
    }

    return this._run('RECOVERY', actor, { requested: count, meta: { examId: String(examId) } }, async () => {
      const response = await this.generate({
        parts: [{ text: prompts.buildRecoveryPrompt({ exam: results.exam, insights, count, difficulty }) }],
        systemInstruction: prompts.SYSTEM_INSTRUCTION,
        responseSchema: prompts.RECOVERY_RESPONSE_SCHEMA,
        temperature: 0.6,
      });
      const { questions, discarded } = utils.sanitizeGeneratedQuestions(response.data?.questions, {
        avoidQuestions: insights.map((item) => item.questionText).filter(Boolean),
        expectedType: 'OBJECTIVE',
        defaultDifficulty: difficulty === 'MIXED' ? null : difficulty,
        random: this.random,
      });
      const listOfStrings = (value, max) => (Array.isArray(value) ? value : [])
        .map((item) => utils.asTrimmedString(item, 400))
        .filter(Boolean)
        .slice(0, max);
      const hardest = [...insights]
        .filter((item) => item.correctPercentage !== null)
        .sort((left, right) => left.correctPercentage - right.correctPercentage)
        .slice(0, 5)
        .map((item) => ({ questionNumber: item.questionNumber, questionText: item.questionText, correctPercentage: item.correctPercentage }));

      return {
        result: {
          exam: { id: results.exam.id, title: results.exam.title, subject: results.exam.subject, className: results.exam.className },
          averageAccuracy: results.insights.averageAccuracy,
          hardestQuestions: hardest,
          summary: utils.asTrimmedString(response.data?.summary, 1500),
          weakTopics: listOfStrings(response.data?.weakTopics, 8),
          recommendations: listOfStrings(response.data?.recommendations, 6),
          questions: questions.slice(0, count),
        },
        model: response.model,
        usage: response.usage,
        attempts: response.attempts,
        returned: Math.min(questions.length, count),
        discarded: discarded.length,
      };
    });
  }
}

module.exports = new GeminiExamService();
module.exports.GeminiExamService = GeminiExamService;
module.exports.ATTACHMENT_MAX_BYTES = ATTACHMENT_MAX_BYTES;
