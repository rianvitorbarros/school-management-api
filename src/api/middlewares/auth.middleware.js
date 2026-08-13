const jwt = require('jsonwebtoken');
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

const verifyToken = (req, res, next) => {
  const token = readToken(req);
  if (!token) return res.status(403).json({ message: 'Nenhum token fornecido!' });

  return jwt.verify(token, process.env.JWT_SECRET, async (error, payload) => {
    if (error) return res.status(401).json({ message: 'Nao autorizado! Token invalido ou expirado.' });
    if (isWrongPrincipal(payload)) {
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
