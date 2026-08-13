const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const AuthSession = require('../../api/models/authSession.model');

function responseRecorder() {
  return {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('access token is rejected immediately after its server session is revoked', async (t) => {
  process.env.JWT_SECRET = 'middleware-session-test-secret';
  delete require.cache[require.resolve('../../api/middlewares/auth.middleware')];
  const { verifyToken } = require('../../api/middlewares/auth.middleware');
  t.mock.method(AuthSession, 'exists', async () => null);
  const token = jwt.sign({
    id: '507f1f77bcf86cd799439011',
    school_id: '507f1f77bcf86cd799439012',
    roles: ['Professor'],
    tokenType: 'access',
    sessionId: '507f1f77bcf86cd799439013',
  }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = responseRecorder();

  await new Promise((resolve, reject) => {
    verifyToken(req, res, (error) => error ? reject(error) : resolve());
    setImmediate(resolve);
  });

  assert.equal(res.statusCode, 401);
  assert.match(res.payload.message, /Sessao encerrada/i);
});
