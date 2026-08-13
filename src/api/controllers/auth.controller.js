const AuthService = require('../services/auth.service');

class AuthController {
    async login(req, res) {
        try {
            const { identifier, password } = req.body; // 'identifier' pode ser email ou username
            if (!identifier || !password) {
                return res.status(400).json({ message: 'Email/usuário e senha são obrigatórios.' });
            }

            const result = await AuthService.login(identifier.toLowerCase(), password);
            res.status(200).json(result);

        } catch (error) {
            res.status(error.statusCode || 401).json({ message: error.message });
        }
    }

    async refresh(req, res) {
        try {
            const result = await AuthService.refresh(req.body?.refreshToken);
            return res.status(200).json(result);
        } catch (error) {
            return res.status(error.statusCode || 401).json({ message: error.message });
        }
    }

    async logout(req, res) {
        try {
            await AuthService.logout(req.body?.refreshToken, req.user?.id);
            return res.status(204).send();
        } catch (_) {
            return res.status(500).json({ message: 'Nao foi possivel encerrar a sessao.' });
        }
    }
}

module.exports = new AuthController();
