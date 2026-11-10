const express = require('express');
const router = express.Router();

const reportCardController = require('../controllers/reportCard.controller');
// const authMiddleware = require('../middlewares/auth.middleware');
const { verifyToken } = require('../middlewares/auth.middleware');

// Gerar boletins de uma turma para um período
router.post(
  '/generate',
  verifyToken,
  reportCardController.generateClassReportCards
);

// Buscar boletim consolidado de um aluno
router.get(
  '/student',
  verifyToken,
  reportCardController.getStudentReportCard
);

// Historico escolar anual/bimestral consolidado por boletins do aluno
router.get(
  '/student-history',
  verifyToken,
  reportCardController.getStudentHistory
);

// Coordenacao: garante a disciplina no boletim do aluno em um bimestre
router.post(
  '/student-term-subject',
  verifyToken,
  reportCardController.ensureStudentTermSubject
);

// Provas corrigidas disponiveis para importar no boletim
router.get(
  '/import/exams',
  verifyToken,
  reportCardController.listImportableExams
);

// Preview aluno a aluno antes de importar notas de prova
router.get(
  '/import/exams/:examId/preview',
  verifyToken,
  reportCardController.previewExamImport
);

// Commit da importacao de notas da prova para o boletim
router.post(
  '/import/exams/:examId/commit',
  verifyToken,
  reportCardController.commitExamImport
);

// Buscar boletim por ID
router.get(
  '/:reportCardId',
  verifyToken,
  reportCardController.getReportCardById
);

// Professor lança/atualiza a nota da sua disciplina no boletim
router.patch(
  '/:reportCardId/subjects/:subjectId/score',
  verifyToken,
  reportCardController.updateTeacherSubjectScore
);

// Professor salva/atualiza a avaliacao descritiva infantil da sua area
router.patch(
  '/:reportCardId/subjects/:subjectId/developmental-assessment',
  verifyToken,
  reportCardController.updateTeacherSubjectDevelopmentalAssessment
);

// Recalcular status geral do boletim
router.patch(
  '/:reportCardId/recalculate-status',
  verifyToken,
  reportCardController.recalculateReportCardStatus
);

module.exports = router;
