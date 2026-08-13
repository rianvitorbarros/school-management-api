const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/user.model');
const AuthSession = require('../models/authSession.model');

const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TOKEN_TTL_DAYS = Math.max(
  1,
  Number.parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10) || 30
);

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createOpaqueToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function refreshExpiry() {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function authError(message, statusCode = 401) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

class AuthService {
  _buildPayload(user, sessionId) {
    return {
      id: user._id.toString(),
      fullName: user.fullName,
      roles: user.roles,
      school_id: user.school_id.toString(),
      tokenType: 'access',
      sessionId: String(sessionId),
    };
  }

  _signAccessToken(user, sessionId) {
    if (!process.env.JWT_SECRET) throw authError('Erro interno do servidor ao gerar token.', 500);
    const token = jwt.sign(this._buildPayload(user, sessionId), process.env.JWT_SECRET, {
      expiresIn: ACCESS_TOKEN_TTL,
    });
    const decoded = jwt.decode(token);
    return { token, accessTokenExpiresAt: new Date(decoded.exp * 1000).toISOString() };
  }

  async _createSession(user, familyId = crypto.randomUUID()) {
    const refreshToken = createOpaqueToken();
    const session = await AuthSession.create({
      userId: user._id,
      schoolId: user.school_id,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: refreshExpiry(),
    });
    return { session, refreshToken };
  }

  async _serializeUser(user) {
    await user.populate({
      path: 'staffProfiles',
      populate: { path: 'enabledSubjects', model: 'Subject' },
    });
    const result = user.toObject();
    delete result.password;
    return result;
  }

  async login(identifier, password) {
    const user = await User.findOne({
      $or: [{ email: identifier }, { username: identifier }],
    }).select('+password');
    if (!user || !(await user.comparePassword(password))) throw authError('Credenciais inválidas.');
    if (user.status === 'Inativo') throw authError('Esta conta de usuário está inativa.');
    if (!user.school_id) throw authError('Esta conta não está vinculada a uma escola. Contate o suporte.');

    const { session, refreshToken } = await this._createSession(user);
    const access = this._signAccessToken(user, session._id);
    return {
      user: await this._serializeUser(user),
      token: access.token,
      refreshToken,
      accessTokenExpiresAt: access.accessTokenExpiresAt,
    };
  }

  async refresh(refreshToken) {
    if (!refreshToken) throw authError('Refresh token obrigatório.', 400);
    const current = await AuthSession.findOne({ tokenHash: hashToken(refreshToken) });
    if (!current || current.expiresAt <= new Date()) throw authError('Sessão expirada ou inválida.');

    if (current.revokedAt) {
      if (current.replacedByTokenHash) {
        await AuthSession.updateMany(
          { familyId: current.familyId, revokedAt: null },
          { $set: { revokedAt: new Date(), revokeReason: 'refresh_token_reuse' } }
        );
      }
      throw authError('Sessão revogada.');
    }

    const user = await User.findOne({
      _id: current.userId,
      school_id: current.schoolId,
      status: 'Ativo',
    });
    if (!user) {
      await AuthSession.updateMany(
        { familyId: current.familyId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokeReason: 'user_unavailable' } }
      );
      throw authError('Usuário indisponível.');
    }

    const nextRefreshToken = createOpaqueToken();
    const nextHash = hashToken(nextRefreshToken);
    const rotated = await AuthSession.findOneAndUpdate(
      { _id: current._id, revokedAt: null },
      { $set: {
        revokedAt: new Date(),
        revokeReason: 'rotated',
        replacedByTokenHash: nextHash,
        lastUsedAt: new Date(),
      } },
      { new: true }
    );
    if (!rotated) throw authError('Sessão já renovada.');

    const nextSession = await AuthSession.create({
      userId: current.userId,
      schoolId: current.schoolId,
      familyId: current.familyId,
      tokenHash: nextHash,
      expiresAt: refreshExpiry(),
    });
    const access = this._signAccessToken(user, nextSession._id);
    return {
      token: access.token,
      refreshToken: nextRefreshToken,
      accessTokenExpiresAt: access.accessTokenExpiresAt,
    };
  }

  async logout(refreshToken, userId = null) {
    let familyId = null;
    if (refreshToken) {
      const session = await AuthSession.findOne({ tokenHash: hashToken(refreshToken) });
      familyId = session?.familyId || null;
    }
    const query = familyId ? { familyId, revokedAt: null } : { userId, revokedAt: null };
    if (familyId || userId) {
      await AuthSession.updateMany(query, {
        $set: { revokedAt: new Date(), revokeReason: 'logout' },
      });
    }
  }
}

module.exports = new AuthService();
