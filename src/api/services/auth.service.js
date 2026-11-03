const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/user.model');
const AuthSession = require('../models/authSession.model');
const SchoolUserMembership = require('../models/schoolUserMembership.model');

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
  _buildPayload(user, membership, sessionId) {
    return {
      id: user._id.toString(),
      fullName: user.fullName,
      roles: membership.roles,
      school_id: membership.school_id && membership.school_id._id
        ? membership.school_id._id.toString()
        : membership.school_id.toString(),
      tokenType: 'access',
      sessionId: String(sessionId),
    };
  }

  _signAccessToken(user, membership, sessionId) {
    if (!process.env.JWT_SECRET) throw authError('Erro interno do servidor ao gerar token.', 500);
    const token = jwt.sign(this._buildPayload(user, membership, sessionId), process.env.JWT_SECRET, {
      expiresIn: ACCESS_TOKEN_TTL,
    });
    const decoded = jwt.decode(token);
    return { token, accessTokenExpiresAt: new Date(decoded.exp * 1000).toISOString() };
  }

  async _createSession(user, membership, familyId = crypto.randomUUID()) {
    const refreshToken = createOpaqueToken();
    const session = await AuthSession.create({
      userId: user._id,
      schoolId: membership.school_id && membership.school_id._id
        ? membership.school_id._id
        : membership.school_id,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: refreshExpiry(),
    });
    return { session, refreshToken };
  }

  async _serializeUser(user, membership) {
    await user.populate({
      path: 'staffProfiles',
      populate: { path: 'enabledSubjects', model: 'Subject' },
    });
    const result = user.toObject();
    delete result.password;
    // Never return profiles or roles belonging to another institution.
    const profile = membership.staffProfile && membership.staffProfile._id
      ? membership.staffProfile
      : membership.staffProfile
        ? await require('../models/staffProfile.model').findById(membership.staffProfile).populate('enabledSubjects')
        : null;
    result.school_id = membership.school_id && membership.school_id._id
      ? String(membership.school_id._id)
      : String(membership.school_id);
    result.roles = membership.roles;
    result.status = membership.status;
    result.staffProfiles = profile ? [profile] : [];
    return result;
  }

  async _membershipsFor(user) {
    const memberships = await SchoolUserMembership.find({ user: user._id, status: 'Ativo' })
      .populate('school_id', 'name')
      .populate({ path: 'staffProfile', populate: { path: 'enabledSubjects', model: 'Subject' } });
    // Accounts created before this feature retain their original school as a
    // compatible, virtual membership until the controlled migration is run.
    if (!memberships.length && user.school_id && user.status === 'Ativo') {
      memberships.push({
        user: user._id,
        school_id: user.school_id,
        roles: user.roles || [],
        status: user.status,
        staffProfile: user.staffProfiles?.[0] || null,
        legacy: true,
      });
    }
    return memberships;
  }

  _schoolOption(membership) {
    const school = membership.school_id;
    return {
      schoolId: school && school._id ? String(school._id) : String(school),
      schoolName: school && school.name ? school.name : 'Escola',
      roles: membership.roles || [],
    };
  }

  async login(identifier, password, requestedSchoolId = null) {
    const user = await User.findOne({
      $or: [{ email: identifier }, { username: identifier }],
    }).select('+password');
    if (!user || !(await user.comparePassword(password))) throw authError('Credenciais inválidas.');
    const memberships = await this._membershipsFor(user);
    if (!memberships.length) throw authError('Esta conta não está vinculada a uma escola. Contate o suporte.');
    if (!requestedSchoolId && memberships.length > 1) {
      return { requiresSchoolSelection: true, schools: memberships.map((membership) => this._schoolOption(membership)) };
    }
    const membership = requestedSchoolId
      ? memberships.find((candidate) => String(candidate.school_id._id || candidate.school_id) === String(requestedSchoolId))
      : memberships[0];
    if (!membership) throw authError('A escola selecionada não está disponível para esta conta.', 403);

    const { session, refreshToken } = await this._createSession(user, membership);
    const access = this._signAccessToken(user, membership, session._id);
    return {
      user: await this._serializeUser(user, membership),
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

    const user = await User.findOne({ _id: current.userId, status: 'Ativo' });
    const memberships = user ? await this._membershipsFor(user) : [];
    const membership = memberships.find((candidate) => String(candidate.school_id._id || candidate.school_id) === String(current.schoolId));
    if (!user || !membership) {
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
    const access = this._signAccessToken(user, membership, nextSession._id);
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
