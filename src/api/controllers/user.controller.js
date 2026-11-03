// src/api/controllers/user.controller.js
const UserService = require('../services/user.service');
const User = require('../models/user.model');

// --- HELPER PARA LIMPEZA E PARSE DE DADOS ---
const parseAndCleanBody = (body) => {
    const cleaned = { ...body };

    const fieldsToNullify = ['email', 'cpf', 'rg', 'enrollmentNumber', 'birthDate', 'phoneNumber'];
    fieldsToNullify.forEach(field => {
        if (cleaned[field] === '' || cleaned[field] === 'null' || cleaned[field] === 'undefined') {
            cleaned[field] = null;
        }
    });

    const jsonFields = ['address', 'healthInfo', 'roles', 'documents']; 
    jsonFields.forEach(field => {
        if (cleaned[field] && typeof cleaned[field] === 'string') {
            try {
                if (cleaned[field] === 'null' || cleaned[field] === 'undefined') {
                    cleaned[field] = null;
                } else {
                    cleaned[field] = JSON.parse(cleaned[field]);
                }
            } catch (e) {
                console.error(`Erro ao fazer parse do campo ${field}:`, e.message);
            }
        }
    });

    if (cleaned.isActive === 'true') cleaned.isActive = true;
    if (cleaned.isActive === 'false') cleaned.isActive = false;

    return cleaned;
};

// --- HELPER DE TRATAMENTO DE ERROS (Adicionado) ---
const handleError = (res, error, context) => {
    console.error(`❌ ERRO [${context}]:`, error);

    if (error.statusCode && error.code) {
        return res.status(error.statusCode).json({
            message: error.message,
            code: error.code,
            ...(error.existingUser ? { existingUser: error.existingUser } : {}),
        });
    }

    // 1. Erro de Duplicidade (MongoDB E11000)
    if (error.code === 11000) {
        // Tenta identificar o campo pelo keyPattern ou pela mensagem
        const field = error.keyPattern ? Object.keys(error.keyPattern)[0] : '';
        let msg = 'Este registro já existe no sistema.';
        
        if (field === 'cpf') msg = 'Já existe um usuário cadastrado com este CPF.';
        if (field === 'email') msg = 'Este e-mail já está em uso por outro usuário.';
        if (field === 'username') msg = 'Este nome de usuário já está em uso.';
        
        return res.status(409).json({ message: msg });
    }

    // 2. Erro de Validação do Mongoose
    if (error.name === 'ValidationError') {
        const messages = Object.values(error.errors).map(val => val.message);
        const userFriendlyMessage = messages[0] || 'Erro de validação nos dados.';
        return res.status(400).json({ message: userFriendlyMessage });
    }

    // 3. Erros manuais (throw new Error)
    if (error.message && (error.message.includes('não encontrado') || error.message.includes('escola'))) {
        return res.status(404).json({ message: error.message });
    }

    // 4. Erro Genérico
    return res.status(500).json({ message: 'Erro interno no servidor. Tente novamente.' });
};

class UserController {

    async createFirstAdmin(req, res, next) {
        try {
            const cleanData = parseAndCleanBody(req.body);
            const { school_id, ...userData } = cleanData;

            if (!school_id) return res.status(400).json({ message: 'O ID da escola (school_id) é obrigatório.' });

            const existingUsers = await User.countDocuments({ school_id: school_id });
            if (existingUsers > 0) return res.status(403).json({ message: 'Esta escola já possui usuários. Faça login para criar novos.' });

            const adminPayload = {
                ...userData,
                school_id,
                roles: ['Admin', 'Coordenador'],
                status: 'Ativo'
            };

            const newUser = new User(adminPayload);
            await newUser.save();

            res.status(201).json({ message: 'Administrador inicial criado com sucesso!', user: newUser });
        } catch (error) {
            handleError(res, error, 'createFirstAdmin');
        }
    }
    
    async createStaff(req, res, next) {
        try {
            const schoolId = req.user.school_id;
            if (!schoolId) return res.status(403).json({ message: 'Usuário não está associado a uma escola.' });

            const userData = parseAndCleanBody(req.body);
            const newUser = await UserService.createStaff(userData, schoolId, req.file);
            
            res.status(201).json(newUser);
        } catch (error) {
            handleError(res, error, 'UserController.createStaff');
        }
    }

    async linkExistingStaff(req, res, next) {
        try {
            const schoolId = req.user.school_id;
            if (!schoolId) return res.status(403).json({ message: 'Usuário não está associado a uma escola.' });
            const existingUserId = req.params.id;
            const userData = parseAndCleanBody(req.body);
            const user = await UserService.linkExistingStaff(existingUserId, userData, schoolId);
            res.status(201).json(user);
        } catch (error) {
            handleError(res, error, 'UserController.linkExistingStaff');
        }
    }

    async create(req, res, next) {
        try {
            const schoolId = req.user.school_id;
            if (!schoolId) return res.status(403).json({ message: 'Usuário não está associado a uma escola.' });

            const userData = parseAndCleanBody(req.body);
            const user = await UserService.createUser(userData, schoolId);
            res.status(201).json(user);
        } catch (error) {
            handleError(res, error, 'UserController.create');
        }
    }

    async getAll(req, res, next) {
        try {
            const schoolId = req.user.school_id;
            if (!schoolId) return res.status(403).json({ message: 'Usuário não está associado a uma escola.' });

            const users = await UserService.getAllUsers(schoolId);
            res.status(200).json(users);
        } catch (error) {
            handleError(res, error, 'UserController.getAll');
        }
    }

    async getById(req, res, next) {
        try {
            const schoolId = req.user.school_id;
            const userId = req.params.id;
            if (!schoolId) return res.status(403).json({ message: 'Usuário não está associado a uma escola.' });

            const user = await UserService.getUserById(userId, schoolId);
            res.status(200).json(user);
        } catch (error) {
            handleError(res, error, 'UserController.getById');
        }
    }

    async update(req, res, next) { 
        try {
            const schoolId = req.user.school_id;
            const userId = req.params.id;
            if (!schoolId) return res.status(403).json({ message: 'Usuário não está associado a uma escola.' });

            const userData = parseAndCleanBody(req.body);
            const user = await UserService.updateStaff(userId, userData, schoolId, req.file);
            res.status(200).json(user);
        } catch (error) {
            handleError(res, error, 'UserController.update');
        }
    }

    async inactivate(req, res, next) { 
        try {
            const schoolId = req.user.school_id;
            const userId = req.params.id;
            if (!schoolId) return res.status(403).json({ message: 'Usuário não está associado a uma escola.' });

            const user = await UserService.inactivateUser(userId, schoolId);
            res.status(200).json({ message: 'Usuário inativado com sucesso', user });
        } catch (error) {
            handleError(res, error, 'UserController.inactivate');
        }
    }
    async reactivate(req, res, next) {
  try {
    const schoolId = req.user.school_id;
    const userId = req.params.id;
    if (!schoolId) return res.status(403).json({ message: 'Usuário não está associado a uma escola.' });

    const user = await UserService.reactivateUser(userId, schoolId);
    res.status(200).json({ message: 'Usuário reativado com sucesso', user });
  } catch (error) {
    handleError(res, error, 'UserController.reactivate');
  }
}


    async updateFcmToken(req, res, next) {
        try {
            const { fcmToken } = req.body;
            const userId = req.user.id;
            if (!fcmToken) return res.status(400).json({ message: 'Token FCM é obrigatório.' });

            await User.findByIdAndUpdate(userId, { $addToSet: { fcmToken: fcmToken } });
            return res.status(200).json({ message: 'Token de notificação atualizado com sucesso.' });
        } catch (error) {
            handleError(res, error, 'UserController.updateFcmToken');
        }
    }
}

module.exports = new UserController();

