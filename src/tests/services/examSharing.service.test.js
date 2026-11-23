const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const examService = require('../../api/services/exam.service');
const Exam = require('../../api/models/exam.model');

const oid = () => new mongoose.Types.ObjectId();

async function withStubs(stubs, run) {
  const originals = stubs.map(([target, key]) => [target, key, target[key]]);
  for (const [target, key, value] of stubs) target[key] = value;
  try {
    await run();
  } finally {
    for (const [target, key, value] of originals) target[key] = value;
  }
}

function leanQuery(value) {
  return {
    select() { return this; },
    lean: async () => value,
  };
}

function reuseStubs({ sourceExam, targetClassId, saved }) {
  return [
    [Exam, 'findOne', () => ({ lean: async () => sourceExam })],
    [examService, '_ensureClassBelongsToSchool', async () => ({ _id: targetClassId })],
    [examService, '_attachOmrLayoutToExamIfNeeded', async () => {}],
    [examService, '_ensureGradebookEvaluation', async () => {}],
    [examService, 'getExamByIdForResponse', async () => saved.at(-1)],
    [Exam.prototype, 'save', async function save() { saved.push(this); return this; }],
  ];
}

test('importar prova compartilhada de outra professora: a copia fica com quem importou', async () => {
  const schoolId = oid();
  const author = oid();
  const importer = oid();
  const sourceExam = {
    _id: oid(), school_id: schoolId, teacher_id: author, class_id: oid(), subject_id: oid(),
    title: 'Prova 1B', applicationDate: new Date(), totalValue: 10, questions: [], sharing: 'school',
  };
  const saved = [];
  const targetClassId = oid();

  await withStubs(reuseStubs({ sourceExam, targetClassId, saved }), async () => {
    const actor = { id: String(importer), school_id: String(schoolId), role: 'professor' };
    await examService.reuseExamForClass(
      String(sourceExam._id), String(targetClassId), schoolId, actor.id, true, actor
    );
  });

  assert.equal(saved.length, 1);
  assert.equal(String(saved[0].teacher_id), String(importer));
  assert.equal(String(saved[0].class_id), String(targetClassId));
  assert.equal(saved[0].status, 'DRAFT');
  assert.equal(String(saved[0].reusedFromExamId), String(sourceExam._id));
});

test('prova privada de outro professor nao pode ser importada; a propria sim', async () => {
  const schoolId = oid();
  const author = oid();
  const sourceExam = {
    _id: oid(), school_id: schoolId, teacher_id: author, class_id: oid(), subject_id: oid(),
    title: 'Privada', applicationDate: new Date(), totalValue: 10, questions: [], sharing: 'private',
  };
  const saved = [];
  const targetClassId = oid();

  await withStubs(reuseStubs({ sourceExam, targetClassId, saved }), async () => {
    const other = { id: String(oid()), school_id: String(schoolId), role: 'professor' };
    await assert.rejects(
      examService.reuseExamForClass(String(sourceExam._id), String(targetClassId), schoolId, other.id, true, other),
      (error) => error.statusCode === 403
    );

    const owner = { id: String(author), school_id: String(schoolId), role: 'professor' };
    await examService.reuseExamForClass(String(sourceExam._id), String(targetClassId), schoolId, owner.id, true, owner);
  });

  assert.equal(saved.length, 1);
  assert.equal(String(saved[0].teacher_id), String(author));
});

test('getReusableExams com includeShared traz as proprias e as compartilhadas', async () => {
  const schoolId = oid();
  const me = oid();
  let filter = null;
  const chain = {
    sort() { return this; },
    populate() { return this; },
    then(resolve) { resolve([]); },
  };

  await withStubs([
    [examService, '_ensureClassBelongsToSchool', async () => ({ _id: oid() })],
    [Exam, 'find', (value) => { filter = value; return chain; }],
  ], async () => {
    const actor = { id: String(me), school_id: String(schoolId), role: 'professor' };
    await examService.getReusableExams(
      { targetClassId: String(oid()), includeShared: 'true', teacher_id: String(me) },
      schoolId,
      actor
    );
    assert.deepEqual(filter.$or, [{ teacher_id: String(me) }, { sharing: { $ne: 'private' } }]);
    assert.equal(filter.teacher_id, undefined);

    // Sem includeShared continua como antes (so o professor informado).
    await examService.getReusableExams({ targetClassId: String(oid()), teacher_id: String(me) }, schoolId, actor);
    assert.equal(filter.$or, undefined);
    assert.equal(filter.teacher_id, String(me));
  });
});

test('setExamSharing: so o autor ou a coordenacao mudam', async () => {
  const schoolId = oid();
  const author = oid();
  const examId = oid();
  const updates = [];

  await withStubs([
    [Exam, 'findOne', () => leanQuery({ _id: examId, teacher_id: author, sharing: 'school' })],
    [Exam, 'updateOne', async (query, update) => { updates.push(update.$set); }],
  ], async () => {
    const owner = { id: String(author), role: 'professor' };
    const result = await examService.setExamSharing(String(examId), 'private', schoolId, owner);
    assert.equal(result.sharing, 'private');

    const other = { id: String(oid()), role: 'professor' };
    await assert.rejects(
      examService.setExamSharing(String(examId), 'school', schoolId, other),
      (error) => error.statusCode === 403
    );

    const coordinator = { id: String(oid()), role: 'coordenador' };
    await examService.setExamSharing(String(examId), 'school', schoolId, coordinator);

    await assert.rejects(
      examService.setExamSharing(String(examId), 'publica', schoolId, owner),
      (error) => error.statusCode === 400
    );
  });

  assert.deepEqual(updates, [{ sharing: 'private' }, { sharing: 'school' }]);
});
