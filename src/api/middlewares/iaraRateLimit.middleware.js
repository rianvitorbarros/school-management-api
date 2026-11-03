// src/api/middlewares/iaraRateLimit.middleware.js
//
// Protege as rotas da Iara (cada chamada custa dinheiro):
// 1) bloqueia alunos e responsaveis;
// 2) limite curto por usuario em memoria (janela deslizante por minuto);
// 3) cota diaria por usuario, contada no IaraUsageLog (vale entre instancias).

const IaraUsageLog = require('../models/iaraUsageLog.model');

const BLOCKED_ROLES = new Set(['student', 'aluno', 'guardian', 'responsavel']);

function readLimit(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getUserId(user) {
  return String(user?.id || user?._id || '');
}

function startOfToday(now = new Date()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date;
}

function createIaraRateLimit({
  perMinute: perMinuteOption,
  perDay: perDayOption,
  countToday = (userId, since) => IaraUsageLog.countDocuments({ user_id: userId, createdAt: { $gte: since } }),
  now = () => Date.now(),
} = {}) {
  const windows = new Map();

  return async function iaraRateLimit(req, res, next) {
    // Lido a cada requisicao para respeitar o .env carregado depois do require.
    const perMinute = perMinuteOption ?? readLimit('IARA_RATE_LIMIT_PER_MINUTE', 6);
    const perDay = perDayOption ?? readLimit('IARA_DAILY_QUOTA', 80);
    const role = String(req.user?.role || '').toLowerCase();
    if (BLOCKED_ROLES.has(role) || req.user?.studentId) {
      return res.status(403).json({ success: false, message: 'A Iara esta disponivel apenas para professores e equipe escolar.' });
    }

    const userId = getUserId(req.user);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Sessao invalida.' });
    }

    if (perMinute > 0) {
      const current = now();
      const recent = (windows.get(userId) || []).filter((timestamp) => current - timestamp < 60000);
      if (recent.length >= perMinute) {
        const retryAfter = Math.max(1, Math.ceil((60000 - (current - recent[0])) / 1000));
        res.set('Retry-After', String(retryAfter));
        windows.set(userId, recent);
        return res.status(429).json({
          success: false,
          code: 'IARA_RATE_LIMIT',
          retryAfterSeconds: retryAfter,
          message: `Muitas solicitacoes seguidas. Aguarde ${retryAfter}s e tente novamente.`,
        });
      }
      recent.push(current);
      windows.set(userId, recent);
      if (windows.size > 5000) {
        for (const [key, timestamps] of windows) {
          if (!timestamps.length || current - timestamps[timestamps.length - 1] >= 60000) windows.delete(key);
        }
      }
    }

    if (perDay > 0) {
      try {
        const used = await countToday(userId, startOfToday(new Date(now())));
        if (used >= perDay) {
          return res.status(429).json({
            success: false,
            code: 'IARA_DAILY_QUOTA',
            message: `Voce atingiu o limite diario de ${perDay} usos da Iara. O limite renova amanha.`,
          });
        }
        res.locals.iaraQuota = { used, limit: perDay };
      } catch (error) {
        // Falha ao contar nao deve derrubar a funcionalidade.
        console.warn('[Iara] Nao foi possivel verificar a cota diaria', { message: error?.message });
      }
    }

    return next();
  };
}

module.exports = { createIaraRateLimit, iaraRateLimit: createIaraRateLimit() };
