// src/api/routes/student.routes.js
const express = require('express');
const router = express.Router();
const studentController = require('../controllers/student.controller');
const authMiddleware = require('../middlewares/auth.middleware');
const studentNoteController = require('../controllers/studentNote.controller');
// [NOVO] Importa o middleware de upload
const upload = require('../middlewares/upload');

// Criar Aluno (COM FOTO)
router.post('/', authMiddleware.verifyToken, upload.single('photo'), studentController.create);

// Aniversariantes
router.get('/birthdays', authMiddleware.verifyToken, studentController.getUpcomingBirthdays);

// Buscar Todos
router.get('/', authMiddleware.verifyToken, studentController.getAll);

// [NOVO] Buscar Foto do Aluno (Buffer)
router.get('/:id/photo', authMiddleware.verifyToken, studentController.getPhoto);

// Buscar por ID
router.get('/:id', authMiddleware.verifyToken, studentController.getById);

// Atualizar Aluno (COM FOTO)
// [MODIFICADO] Mudei para PUT para alinhar com o código Flutter (MultipartRequest('PUT'))
// Se preferir PATCH, apenas altere o método, mas mantenha o upload.single('photo')
router.put('/:id', authMiddleware.verifyToken, upload.single('photo'), studentController.update);

// Deletar Aluno
router.delete('/:id', authMiddleware.verifyToken, studentController.delete);

// --- Rotas de Histórico ---
router.get('/:studentId/history/context', authMiddleware.verifyToken, studentController.getAcademicHistoryContext);
router.post('/:studentId/history/import-preview', authMiddleware.verifyToken, studentController.previewAcademicHistoryImport);
router.post('/:studentId/history/import', authMiddleware.verifyToken, studentController.importAcademicHistory);
router.post('/:studentId/history', authMiddleware.verifyToken, studentController.addAcademicRecord);
router.put('/:studentId/history/:recordId', authMiddleware.verifyToken, studentController.updateAcademicRecord);
router.delete('/:studentId/history/:recordId', authMiddleware.verifyToken, studentController.deleteAcademicRecord);

// --- Rota de Tutor ---
router.put('/:studentId/tutors/:tutorId', authMiddleware.verifyToken, studentController.updateTutorRelationship);

// =========================================================================
// CORREÇÃO: Usando authMiddleware.verifyToken e ajustando os caminhos
// =========================================================================
// Rotas para anotações de um aluno específico
router.post('/:studentId/notes', authMiddleware.verifyToken, studentNoteController.create);
router.get('/:studentId/notes', authMiddleware.verifyToken, studentNoteController.listByStudent);
router.delete('/notes/:noteId', authMiddleware.verifyToken, studentNoteController.delete);

module.exports = router;
