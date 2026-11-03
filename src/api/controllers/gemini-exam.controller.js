// src/api/controllers/gemini-exam.controller.js
//
// Endpoints da Iara. As mensagens de erro devolvidas ao app sao sempre
// amigaveis; o detalhe tecnico fica apenas no log do servidor.

const geminiExamService = require('../services/gemini-exam.service');

function sendError(res, error, context) {
  const statusCode = Number(error?.statusCode) || 500;
  if (statusCode >= 500) {
    console.error(`[Iara] Erro em ${context}`, {
      name: error?.name,
      message: error?.message,
      cause: error?.cause?.message || null,
    });
  }
  const message = statusCode >= 500 && !error?.name?.startsWith('Iara')
    ? 'Ocorreu um erro interno ao falar com a Iara. Tente novamente.'
    : error.message;
  return res.status(statusCode).json({ success: false, message });
}

function getSchoolId(req) {
  return req.user?.school_id || req.user?.schoolId || null;
}

exports.generateQuestions = async (req, res) => {
  try {
    const result = await geminiExamService.generateQuestions(req.body || {}, {
      actor: req.user,
      attachment: req.file || null,
    });
    // `data` continua sendo a lista de questoes (compatibilidade com versoes antigas do app).
    return res.status(200).json({
      success: true,
      data: result.questions,
      warnings: result.warnings,
      meta: result.meta,
      quota: res.locals.iaraQuota || null,
    });
  } catch (error) {
    return sendError(res, error, 'generateQuestions');
  }
};

exports.regenerateQuestion = async (req, res) => {
  try {
    const result = await geminiExamService.regenerateQuestion(req.body || {}, { actor: req.user });
    return res.status(200).json({ success: true, data: result.question, meta: result.meta });
  } catch (error) {
    return sendError(res, error, 'regenerateQuestion');
  }
};

exports.reviewExam = async (req, res) => {
  try {
    const result = await geminiExamService.reviewExam(req.body || {}, { actor: req.user });
    const { meta, ...data } = result;
    return res.status(200).json({ success: true, data, meta });
  } catch (error) {
    return sendError(res, error, 'reviewExam');
  }
};

exports.adaptQuestions = async (req, res) => {
  try {
    const result = await geminiExamService.adaptQuestions(req.body || {}, { actor: req.user });
    return res.status(200).json({ success: true, data: result.questions, meta: result.meta });
  } catch (error) {
    return sendError(res, error, 'adaptQuestions');
  }
};

exports.buildRecoveryPlan = async (req, res) => {
  try {
    const result = await geminiExamService.buildRecoveryPlan(req.params.examId, req.body || {}, {
      actor: req.user,
      schoolId: getSchoolId(req),
    });
    const { meta, ...data } = result;
    return res.status(200).json({ success: true, data, meta });
  } catch (error) {
    return sendError(res, error, 'buildRecoveryPlan');
  }
};
