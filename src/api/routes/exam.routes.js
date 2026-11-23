const express = require('express');
const router = express.Router();
const examController = require('../controllers/exam.controller'); // Ajuste o nome se necessário
// const { authMiddleware } = require('../middlewares/auth.middleware'); // Puxando seu auth
const { verifyToken } = require('../middlewares/auth.middleware');


// Todas as rotas de exames precisam de autenticação (e portanto terão req.user.school_id)
router.use(verifyToken);

// Rotas Base da Prova
router.post('/', examController.create);
router.get('/', examController.getAll);
router.get('/reusable', examController.getReusable);
router.post('/:sourceExamId/reuse-for-class', examController.reuseForClass);
router.get('/:examId/results', examController.getResults);
router.get('/:examId/results/:sheetId', examController.getResultDetails);
router.get('/:id', examController.getById);

// Rotas de Operação (Gerar Lote de PDF e Escanear QR Code)
router.post('/:id/generate-sheets', examController.generateSheets);
router.post('/scan', examController.scanSheet);

// Removemos o "/exams" do começo destas duas linhas!
router.get('/sheet/:uuid/verify', verifyToken, examController.verifySheet);
router.post('/process-omr', verifyToken, examController.processOMRImage);

// Busca todos os alunos (folhas) de uma prova específica para correção manual
router.get('/:id/sheets', examController.getSheetsByExam);

router.put('/:id/sharing', examController.setSharing);
router.put('/:id', examController.update);
router.post('/:id/duplicate', examController.duplicate);

module.exports = router;
