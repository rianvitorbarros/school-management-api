const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'auth-refresh-test-secret';

const User = require('../../api/models/user.model');
const AuthSession = require('../../api/models/authSession.model');
const authService = require('../../api/services/auth.service');

function fakeUser() {
  return {
    _id: { toString: () => '507f1f77bcf86cd799439011' },
    school_id: { toString: () => '507f1f77bcf86cd799439012' },
    fullName: 'Professor Teste',
    roles: ['Professor'],
    status: 'Ativo',
    comparePassword: async () => true,
    populate: async () => {},
    toObject() {
      return {
        _id: '507f1f77bcf86cd799439011',
        school_id: '507f1f77bcf86cd799439012',
        fullName: this.fullName,
        roles: this.roles,
        password: 'must-not-leak',
      };
    },
  };
}

test('login emits short access token and opaque refresh token without password', async (t) => {
  const user = fakeUser();
  t.mock.method(User, 'findOne', () => ({ select: async () => user }));
  t.mock.method(AuthSession, 'create', async (data) => ({ _id: 'session-1', ...data }));

  const result = await authService.login('professor', 'secret');
  const payload = jwt.verify(result.token, process.env.JWT_SECRET);

  assert.equal(payload.tokenType, 'access');
  assert.equal(payload.sessionId, 'session-1');
  assert.ok(payload.exp - payload.iat <= 15 * 60);
  assert.ok(result.refreshToken.length >= 48);
  assert.equal(result.user.password, undefined);
});

test('refresh rotates the token and revokes the previous session atomically', async (t) => {
  const user = fakeUser();
  const current = {
    _id: 'session-1',
    userId: user._id,
    schoolId: user.school_id,
    familyId: 'family-1',
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
  };
  let rotatedUpdate;
  t.mock.method(AuthSession, 'findOne', async () => current);
  t.mock.method(User, 'findOne', async () => user);
  t.mock.method(AuthSession, 'findOneAndUpdate', async (_query, update) => {
    rotatedUpdate = update;
    return current;
  });
  t.mock.method(AuthSession, 'create', async (data) => ({ _id: 'session-2', ...data }));

  const result = await authService.refresh('old-refresh-token');
  const payload = jwt.verify(result.token, process.env.JWT_SECRET);

  assert.equal(payload.sessionId, 'session-2');
  assert.notEqual(result.refreshToken, 'old-refresh-token');
  assert.equal(rotatedUpdate.$set.revokeReason, 'rotated');
  assert.ok(rotatedUpdate.$set.replacedByTokenHash);
});
