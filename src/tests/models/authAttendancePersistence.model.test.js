const test = require('node:test');
const assert = require('node:assert/strict');

const AuthSession = require('../../api/models/authSession.model');
const Attendance = require('../../api/models/attendance.model');

test('refresh sessions store only token hashes and expire automatically', () => {
  const paths = AuthSession.schema.paths;
  assert.ok(paths.tokenHash);
  assert.equal(paths.refreshToken, undefined);
  assert.equal(paths.tokenHash.options.unique, true);
  assert.equal(paths.expiresAt.options.required, true);
});

test('attendance schema carries version and idempotency operation ids', () => {
  const paths = Attendance.schema.paths;
  assert.equal(paths.version.options.default, 1);
  assert.ok(paths.appliedOperationIds);
  const indexes = Attendance.schema.indexes();
  assert.ok(indexes.some(([fields]) => fields.schoolId === 1 && fields.appliedOperationIds === 1));
});
