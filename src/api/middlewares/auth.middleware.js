const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const appEmitter = require('../../loaders/eventEmitter');
const AuthSession = require('../models/authSession.model');

function readToken(req) {
  const authHeader = req.headers.authorization;
  return authHeader && authHeader.split(' ')[1];
}

function normalizeUser(payload) {
  const user = { ...payload };
  if (payload.school_id && !user.schoolId) user.schoolId = payload.school_id;
  if (payload.role === 'student') user.studentId = payload.id;
  return user;
}

function isWrongPrincipal(payload) {
  return payload?.principalType === 'guardian' || payload?.tokenType === 'guardian_auth';
}

function logAuthRejection(req, { reason, payload = null, error = null } = {}) {
  // Deliberately never log the Authorization header or token itself.
  console.warn('[Auth] Requisicao rejeitada', {
    requestId: req.headers['x-request-id'] || crypto.randomUUID(),
    route: `${req.method || 'UNKNOWN'} ${req.originalUrl || req.url || ''}`,
    reason,
    jwtError: error?.name || null,
    userId: payload?.id || null,
    schoolId: payload?.school_id || payload?.schoolId || null,
  });
}

const verifyToken = (req, res, next) => {
  const token = readToken(req);
  if (!token) {
    logAuthRejection(req, { reason: 'missing_token' });
    return res.status(401).json({ message: 'Autenticacao obrigatoria.' });
  }

  return jwt.verify(token, process.env.JWT_SECRET, async (error, payload) => {
    if (error) {
      logAuthRejection(req, { reason: 'invalid_or_expired_token', error });
      return res.status(401).json({ message: 'Sessao invalida ou expirada.' });
    }
    if (isWrongPrincipal(payload)) {
      logAuthRejection(req, { reason: 'wrong_principal', payload });
      return res.status(401).json({ message: 'Token nao autorizado neste fluxo.' });
    }
    if (payload.sessionId) {
      try {
        const activeSession = await AuthSession.exists({
          _id: payload.sessionId,
          revokedAt: null,
          expiresAt: { $gt: new Date() },
        });
        if (!activeSession) {
          logAuthRejection(req, { reason: 'inactive_session', payload });
          return res.status(401).json({ message: 'Sessao encerrada ou expirada.' });
        }
      } catch (sessionError) {
        return next(sessionError);
      }
    }
    req.user = normalizeUser(payload);
    req.emitEvent = (eventName, data) => {
      const eventPayload = typeof data === 'object' ? data : { id: data };
      if (!eventPayload.school_id && req.user.school_id) eventPayload.school_id = req.user.school_id;
      appEmitter.emit(eventName, eventPayload);
    };
    return next();
  });
};

const verifyTokenOptional = (req, _res, next) => {
  const token = readToken(req);
  if (!token) return next();
  return jwt.verify(token, process.env.JWT_SECRET, (error, payload) => {
    if (!error && !isWrongPrincipal(payload)) req.user = normalizeUser(payload);
    return next();
  });
};

module.exports = { verifyToken, verifyTokenOptional };
