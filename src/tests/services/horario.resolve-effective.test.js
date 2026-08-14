const test = require('node:test');
const assert = require('node:assert/strict');

const Horario = require('../../api/models/horario.model');
const Term = require('../../api/models/periodo.model');
const School = require('../../api/models/school.model');
const horarioService = require('../../api/services/horario.service');

const SCHOOL_ID = '507f1f77bcf86cd799439011';
const CURRENT_TERM_ID = '507f1f77bcf86cd799439012';
const PREVIOUS_TERM_ID = '507f1f77bcf86cd799439013';
const SCHOOL_YEAR_ID = '507f1f77bcf86cd799439014';

function queryResult(value) {
  const query = {
    populate() {
      return this;
    },
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean() {
      return Promise.resolve(value);
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
  return query;
}

function schedule(id, classId, termId) {
  return {
    _id: id,
    classId: { _id: classId, name: classId },
    termId: { _id: termId, titulo: termId },
    teacherId: { _id: 'teacher-1', fullName: 'Professor' },
    subjectId: { _id: 'subject-1', name: 'Disciplina' },
    dayOfWeek: 1,
    startTime: '08:00',
    endTime: '09:00',
  };
}

function installHarness(t, { mode, own, previous }) {
  const currentTerm = {
    _id: CURRENT_TERM_ID,
    anoLetivoId: SCHOOL_YEAR_ID,
    titulo: 'Periodo atual',
    dataInicio: new Date('2026-08-01T00:00:00.000Z'),
  };
  const previousTerm = {
    _id: PREVIOUS_TERM_ID,
    anoLetivoId: SCHOOL_YEAR_ID,
    titulo: 'Periodo anterior',
    dataInicio: new Date('2026-04-01T00:00:00.000Z'),
  };

  t.mock.method(Term, 'findOne', () => queryResult(currentTerm));
  t.mock.method(Term, 'find', () => queryResult([previousTerm, currentTerm]));
  t.mock.method(School, 'findById', () =>
    queryResult({ academicSettings: { regularWeeklyScheduleMode: mode } }),
  );
  t.mock.method(Horario, 'find', (query) => {
    const termId = String(query.termId || '');
    return queryResult(termId === CURRENT_TERM_ID ? own : previous);
  });
}

test('shared schedule merges inherited classes with current class overrides', async (t) => {
  const previous = Array.from({ length: 7 }, (_, index) =>
    schedule(`previous-${index + 1}`, `class-${index + 1}`, PREVIOUS_TERM_ID),
  );
  const own = [
    schedule('current-1', 'class-1', CURRENT_TERM_ID),
    schedule('current-2', 'class-2', CURRENT_TERM_ID),
  ];
  installHarness(t, {
    mode: 'shared_across_periods',
    own,
    previous,
  });

  const result = await horarioService.resolveEffectiveHorarios(
    { termId: CURRENT_TERM_ID, teacherId: 'teacher-1' },
    SCHOOL_ID,
  );

  assert.equal(result.length, 7);
  assert.deepEqual(
    new Set(result.map((item) => String(item.classId._id))),
    new Set(Array.from({ length: 7 }, (_, index) => `class-${index + 1}`)),
  );
  assert.equal(result.find((item) => item.classId._id === 'class-1').isInherited, false);
  assert.equal(result.find((item) => item.classId._id === 'class-3').isInherited, true);
});

test('period-specific schedule keeps only the requested period', async (t) => {
  const own = [schedule('current-1', 'class-1', CURRENT_TERM_ID)];
  installHarness(t, {
    mode: 'period_specific',
    own,
    previous: [schedule('previous-2', 'class-2', PREVIOUS_TERM_ID)],
  });

  const result = await horarioService.resolveEffectiveHorarios(
    { termId: CURRENT_TERM_ID, teacherId: 'teacher-1' },
    SCHOOL_ID,
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].classId._id, 'class-1');
  assert.equal(result[0].isInherited, false);
});
