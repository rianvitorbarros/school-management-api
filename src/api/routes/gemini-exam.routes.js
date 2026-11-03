// src/api/routes/gemini-exam.routes.js
//
// Rotas da Iara (assistente de provas). Todas exigem login de professor ou
// equipe escolar e passam pelo limite de uso (por minuto e diario).

const express = require('express');
const multer = require('multer');

const geminiExamController = require('../controllers/gemini-exam.controller');
const { verifyToken } = require('../middlewares/auth.middleware');
const { iaraRateLimit } = require('../middlewares/iaraRateLimit.middleware');
const { ATTACHMENT_MAX_BYTES } = require('../services/gemini-exam.service');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1 },
});

// Material de apoio opcional (PDF, imagem ou texto) no campo "attachment".
function optionalAttachment(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  return upload.single('attachment')(req, res, (error) => {
    if (!error) return next();
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      success: false,
      message: tooLarge ? 'O arquivo deve ter no maximo 10 MB.' : 'Nao foi possivel ler o arquivo enviado.',
    });
  });
}

router.use(verifyToken, iaraRateLimit);

router.post('/generate', optionalAttachment, geminiExamController.generateQuestions);
router.post('/regenerate-question', geminiExamController.regenerateQuestion);
router.post('/review', geminiExamController.reviewExam);
router.post('/adapt', geminiExamController.adaptQuestions);
router.post('/exams/:examId/recovery', geminiExamController.buildRecoveryPlan);

module.exports = router;
