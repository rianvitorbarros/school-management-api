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

test('grade unica: turma com grade so num bimestre mais antigo nao some para o professor', async (t) => {
  // 1o bim: grade das duas turmas. 3o bim: so a 5B foi refeita.
  // 4o bim (atual): nenhuma grade propria.
  const terms = [
    { _id: 'term-1', anoLetivoId: SCHOOL_YEAR_ID, titulo: '1o', dataInicio: new Date('2026-02-01') },
    { _id: 'term-3', anoLetivoId: SCHOOL_YEAR_ID, titulo: '3o', dataInicio: new Date('2026-08-01') },
    { _id: 'term-4', anoLetivoId: SCHOOL_YEAR_ID, titulo: '4o', dataInicio: new Date('2026-10-01') },
  ];
  const slot = (id, classId, termId, teacherId) => ({
    ...schedule(id, classId, termId),
    teacherId: { _id: teacherId, fullName: teacherId },
  });
  const all = [
    slot('a1', '5A', 'term-1', 'juliana'),
    slot('b1', '5B', 'term-1', 'juliana'),
    slot('b3', '5B', 'term-3', 'juliana'),
    slot('b3-outra', '5B', 'term-3', 'outra'),
  ];
  const idOf = (value) => String(value?._id ?? value);
  const matches = (doc, query) => Object.entries(query).every(([key, value]) => {
    if (key === 'school_id') return true;
    if (value && typeof value === 'object' && Array.isArray(value.$in)) {
      return value.$in.map(String).includes(idOf(doc[key]));
    }
    return idOf(doc[key]) === String(value);
  });

  t.mock.method(Term, 'findOne', () => queryResult(terms[2]));
  t.mock.method(Term, 'find', () => queryResult(terms));
  t.mock.method(School, 'findById', () =>
    queryResult({ academicSettings: { regularWeeklyScheduleMode: 'shared_across_periods' } }),
  );
  t.mock.method(Horario, 'find', (query) => queryResult(all.filter((doc) => matches(doc, query))));

  const result = await horarioService.resolveEffectiveHorarios(
    { termId: 'term-4', teacherId: 'juliana' },
    SCHOOL_ID,
  );

  const byClass = Object.fromEntries(result.map((item) => [item.classId._id, item]));
  assert.deepEqual(Object.keys(byClass).sort(), ['5A', '5B']);
  assert.equal(byClass['5A'].resolvedFromTermId, 'term-1');
  assert.equal(byClass['5B'].resolvedFromTermId, 'term-3');
  assert.ok(result.every((item) => item.teacherId._id === 'juliana'));
  assert.ok(result.every((item) => item.isInherited));
});

test('grade unica: aula avulsa num bimestre mais novo nao esconde o resto da grade da turma', async (t) => {
  // Caso real (2o ANO A): grade inteira no 1o bim; no 2o bim alguem lancou
  // so 1 aula de outra professora. No 4o bim (atual) nada foi lancado.
  const terms = [
    { _id: 'term-1', anoLetivoId: SCHOOL_YEAR_ID, titulo: '1o', dataInicio: new Date('2026-03-16') },
    { _id: 'term-2', anoLetivoId: SCHOOL_YEAR_ID, titulo: '2o', dataInicio: new Date('2026-04-01') },
    { _id: 'term-4', anoLetivoId: SCHOOL_YEAR_ID, titulo: '4o', dataInicio: new Date('2026-11-01') },
  ];
  const slot = (id, classId, termId, teacherId, dayOfWeek, startTime, endTime) => ({
    ...schedule(id, classId, termId),
    teacherId: { _id: teacherId, fullName: teacherId },
    dayOfWeek,
    startTime,
    endTime,
  });
  const all = [
    slot('a-seg-1', '2A', 'term-1', 'edicelia', 1, '07:00', '07:50'),
    slot('a-seg-2', '2A', 'term-1', 'edicelia', 1, '07:50', '08:40'),
    slot('a-ter-1', '2A', 'term-1', 'outro', 2, '09:00', '09:50'),
    // Aula avulsa do 2o bim: substitui so a terca 09:00.
    slot('a-ter-2bim', '2A', 'term-2', 'elisangela', 2, '09:10', '10:00'),
    slot('b-seg-1', '2B', 'term-1', 'edicelia', 1, '07:00', '07:50'),
  ];
  const idOf = (value) => String(value?._id ?? value);
  const matches = (doc, query) => Object.entries(query).every(([key, value]) => {
    if (key === 'school_id') return true;
    if (value && typeof value === 'object' && Array.isArray(value.$in)) {
      return value.$in.map(String).includes(idOf(doc[key]));
    }
    return idOf(doc[key]) === String(value);
  });

  t.mock.method(Term, 'findOne', () => queryResult(terms[2]));
  t.mock.method(Term, 'find', () => queryResult(terms));
  t.mock.method(School, 'findById', () =>
    queryResult({ academicSettings: { regularWeeklyScheduleMode: 'shared_across_periods' } }),
  );
  t.mock.method(Horario, 'find', (query) => queryResult(all.filter((doc) => matches(doc, query))));

  const mine = await horarioService.resolveEffectiveHorarios(
    { termId: 'term-4', teacherId: 'edicelia' },
    SCHOOL_ID,
  );
  assert.deepEqual(mine.map((item) => item._id).sort(), ['a-seg-1', 'a-seg-2', 'b-seg-1']);
  assert.deepEqual([...new Set(mine.map((item) => item.classId._id))].sort(), ['2A', '2B']);
  assert.ok(mine.every((item) => item.isInherited && item.resolvedFromTermId === 'term-1'));

  // A turma inteira: a aula do 2o bim substitui a de terca do 1o bim.
  const turma = await horarioService.resolveEffectiveHorarios(
    { termId: 'term-4', classId: '2A' },
    SCHOOL_ID,
  );
  assert.deepEqual(turma.map((item) => item._id).sort(), ['a-seg-1', 'a-seg-2', 'a-ter-2bim']);
  assert.equal(turma.find((item) => item._id === 'a-ter-2bim').resolvedFromTermId, 'term-2');
});
