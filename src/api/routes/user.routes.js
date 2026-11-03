// src/api/routes/user.routes.js
const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const authMiddleware = require('../middlewares/auth.middleware'); 

// ==============================================================================
// 🔓 ROTAS PÚBLICAS (Setup Inicial)
// ==============================================================================

// Rota para criar o PRIMEIRO administrador de uma escola.
// Permite criar o usuário inicial sem ter token (pois ainda não existe usuário).
router.post('/setup-admin', userController.createFirstAdmin);


// ==============================================================================
// 🔒 ROTAS PROTEGIDAS (Requer Token + School ID)
// ==============================================================================

// Aplica o middleware de verificação de token para TODAS as rotas abaixo
router.use(authMiddleware.verifyToken);

// Rota de Criação de Funcionário (User + StaffProfile)
router.post(
    '/staff', 
    userController.createStaff
);
// Explicit confirmation is required before associating an existing account.
router.post('/staff/:id/link', userController.linkExistingStaff);

// Rota de Criação de Usuário Simples (sem perfil de staff)
router.post(
    '/', 
    userController.create
);

// --- [NOVO] ATUALIZAÇÃO DO TOKEN FCM (NOTIFICAÇÕES) ---
// O App Mobile chama isso ao logar
router.post('/refresh-token', userController.updateFcmToken);

// --- Rotas de Gerenciamento ---
router.get('/', userController.getAll);
router.get('/:id', userController.getById);
router.patch('/:id', userController.update);
router.patch('/:id/inactivate', userController.inactivate);
router.patch('/:id/reactivate', userController.reactivate);


module.exports = router;
