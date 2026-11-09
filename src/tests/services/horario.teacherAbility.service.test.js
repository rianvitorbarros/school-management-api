const test = require('node:test');
const assert = require('node:assert/strict');

const HorarioService = require('../../api/services/horario.service');
const UserService = require('../../api/services/user.service');

const subjectId = '6ac4dafde6b3f422e3e94000';

function mockTeacher(t, enabledSubjects) {
  t.mock.method(UserService, 'getUserById', async () => ({
    fullName: 'Professora Teste',
    staffProfiles: [{ enabledSubjects }],
  }));
}

test('accepts a teacher whose populated enabledSubjects contain the subject', async (t) => {
  mockTeacher(t, [{ _id: { toString: () => subjectId }, name: 'Historia' }]);
  assert.equal(await HorarioService._validateTeacherAbility('teacher', subjectId, 'school'), true);
});

test('accepts a teacher whose enabledSubjects are raw ids', async (t) => {
  mockTeacher(t, [subjectId]);
  assert.equal(await HorarioService._validateTeacherAbility('teacher', subjectId, 'school'), true);
});

test('rejects a teacher not enabled for the subject', async (t) => {
  mockTeacher(t, [{ _id: 'other-subject' }]);
  await assert.rejects(
    HorarioService._validateTeacherAbility('teacher', subjectId, 'school'),
    /não está habilitado/,
  );
});
