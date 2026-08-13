const test = require('node:test');
const assert = require('node:assert/strict');

const Attendance = require('../../api/models/attendance.model');
const classAccess = require('../../api/services/classAccess.service');

classAccess.ensureClassAccess = async () => ({ _id: 'class-1' });
delete require.cache[require.resolve('../../api/services/attendance.service')];
const attendanceService = require('../../api/services/attendance.service');

function existingAttendance(overrides = {}) {
  return {
    _id: 'attendance-1',
    version: 3,
    appliedOperationIds: [],
    records: [],
    ...overrides,
  };
}

function mockFindOne(t, value) {
  t.mock.method(Attendance, 'findOne', () => ({ select: async () => value }));
}

test('replayed attendance operation is returned as duplicate without updating', async (t) => {
  mockFindOne(t, existingAttendance({ appliedOperationIds: ['operation-1'] }));
  t.mock.method(Attendance, 'findById', () => ({
    populate: async () => existingAttendance(),
  }));
  let updateCalls = 0;
  t.mock.method(Attendance, 'findOneAndUpdate', async () => {
    updateCalls++;
    return null;
  });

  const result = await attendanceService.createOrUpdate({
    schoolId: '507f1f77bcf86cd799439012',
    teacherId: '507f1f77bcf86cd799439011',
    classId: '507f1f77bcf86cd799439013',
    date: '2026-08-13',
    operationId: 'operation-1',
    baseVersion: 3,
    records: [],
  }, { roles: ['Professor'] });

  assert.equal(result.sync.status, 'duplicate');
  assert.equal(updateCalls, 0);
});

test('stale attendance operation receives version conflict before update', async (t) => {
  mockFindOne(t, existingAttendance());
  t.mock.method(Attendance, 'findById', () => ({
    populate: async () => existingAttendance(),
  }));

  await assert.rejects(
    attendanceService.createOrUpdate({
      schoolId: '507f1f77bcf86cd799439012',
      teacherId: '507f1f77bcf86cd799439011',
      classId: '507f1f77bcf86cd799439013',
      date: '2026-08-13',
      operationId: 'operation-stale',
      baseVersion: 2,
      records: [],
    }, { roles: ['Professor'] }),
    (error) => error.statusCode === 409 &&
      error.code === 'ATTENDANCE_VERSION_CONFLICT' &&
      error.serverVersion === 3
  );
});
