const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const examService = require('../../api/services/exam.service');
const SchoolYearService = require('../../api/services/schoolyear.service');
const Exam = require('../../api/models/exam.model');
const Evaluation = require('../../api/models/evaluation.model');
const Grade = require('../../api/models/grade.model');
const Enrollment = require('../../api/models/enrollment.model');

const oid = () => new mongoose.Types.ObjectId();

/** Troca métodos por versões falsas durante um teste e restaura no fim. */
async function withStubs(stubs, run) {
  const originals = stubs.map(([target, key]) => [target, key, target[key]]);
  for (const [target, key, value] of stubs) target[key] = value;
  try {
    await run();
  } finally {
    for (const [target, key, value] of originals) target[key] = value;
  }
}

function buildExam(overrides = {}) {
  const exam = new Exam({
    school_id: oid(),
    teacher_id: oid(),
    class_id: oid(),
    subject_id: oid(),
    title: 'Prova de Educação Física',
    applicationDate: new Date('2026-11-09T12:00:00.000Z'),
    totalValue: 10,
    questions: [],
    ...overrides,
  });
  exam.saveCalls = 0;
  exam.save = async function save() {
    this.saveCalls += 1;
    return this;
  };
  return exam;
}

const termInfo = { termName: '4º Bimestre', schoolYearId: oid() };

test('cria a avaliação do Diário com os campos que o modelo exige', async () => {
  const exam = buildExam();
  const schoolId = exam.school_id;
  const created = [];

  await withStubs([
    [SchoolYearService, 'findTermByDate', async () => termInfo],
    [Evaluation, 'create', async (doc) => {
      // Valida contra o schema real: era aqui que a criação falhava sempre.
      const evaluation = new Evaluation(doc);
      const error = evaluation.validateSync();
      if (error) throw error;
      created.push(evaluation);
      return evaluation;
    }],
  ], async () => {
    await examService._ensureGradebookEvaluation(exam, schoolId);
  });

  assert.equal(created.length, 1);
  const evaluation = created[0];
  assert.equal(String(evaluation.school), String(schoolId));
  assert.equal(String(evaluation.classInfo), String(exam.class_id));
  assert.equal(String(evaluation.teacher), String(exam.teacher_id));
  assert.equal(String(evaluation.subject), String(exam.subject_id));
  assert.equal(evaluation.type, 'EXAM');
  assert.equal(evaluation.maxScore, 10);
  assert.equal(evaluation.term, '4º Bimestre');
  assert.equal(evaluation.title, 'Prova de Educação Física');
  assert.equal(String(exam.settings.evaluationId), String(evaluation._id));
  assert.equal(exam.saveCalls, 1);
});

test('não cria outra avaliação quando a prova já tem uma', async () => {
  const existing = oid();
  const exam = buildExam({ settings: { evaluationId: existing } });
  let calls = 0;

  await withStubs([
    [SchoolYearService, 'findTermByDate', async () => termInfo],
    [Evaluation, 'create', async () => { calls += 1; return { _id: oid() }; }],
  ], async () => {
    await examService._ensureGradebookEvaluation(exam, exam.school_id);
  });

  assert.equal(calls, 0);
  assert.equal(String(exam.settings.evaluationId), String(existing));
});

test('falha ao criar a avaliação não impede salvar a prova', async () => {
  const exam = buildExam();

  await withStubs([
    [SchoolYearService, 'findTermByDate', async () => { throw new Error('sem ano letivo'); }],
  ], async () => {
    const result = await examService._ensureGradebookEvaluation(exam, exam.school_id);
    assert.equal(result, exam);
  });

  assert.equal(exam.settings?.evaluationId ?? null, null);
});

test('cópia de prova ganha a própria avaliação, sem herdar a da original', async () => {
  const originalEvaluation = oid();
  const newEvaluation = oid();
  const schoolId = oid();
  let savedExam = null;

  await withStubs([
    [examService, 'resolveExamTermContext', async () => ({ termId: null, termResolution: { status: 'missing', source: 'none' } })],
    [examService, '_attachOmrLayoutToExamIfNeeded', async (exam) => exam],
    [examService, 'getExamByIdForResponse', async () => savedExam],
    [Exam.prototype, 'save', async function save() { savedExam = this; return this; }],
    [SchoolYearService, 'findTermByDate', async () => termInfo],
    [Evaluation, 'create', async () => ({ _id: newEvaluation })],
  ], async () => {
    await examService.createExam({
      teacher_id: oid(),
      class_id: oid(),
      subject_id: oid(),
      title: 'Prova [Cópia]',
      applicationDate: new Date('2026-11-09T12:00:00.000Z'),
      totalValue: 10,
      questions: [],
      settings: { evaluationId: originalEvaluation, omrLayout: null },
    }, schoolId);
  });

  assert.equal(String(savedExam.settings.evaluationId), String(newEvaluation));
});

test('nota da folha corrigida é lançada no Diário com matrícula e aluno', async () => {
  const evaluationId = oid();
  const exam = buildExam({ settings: { evaluationId } });
  const studentId = oid();
  const enrollmentId = oid();
  const sheet = { _id: oid(), student_id: studentId };
  const upserts = [];

  await withStubs([
    [Enrollment, 'findOne', (query) => {
      assert.equal(String(query.student), String(studentId));
      assert.equal(String(query.class), String(exam.class_id));
      return { select() { return this; }, lean: async () => ({ _id: enrollmentId }) };
    }],
    [Grade, 'findOneAndUpdate', async (filter, update, options) => {
      upserts.push({ filter, update, options });
      const grade = new Grade({ ...filter, ...update.$set });
      const error = grade.validateSync();
      if (error) throw error;
      return grade;
    }],
  ], async () => {
    await examService._syncSheetGradeToGradebook(exam, sheet, exam.school_id, 7.5);
  });

  assert.equal(upserts.length, 1);
  const [{ filter, update, options }] = upserts;
  assert.equal(String(filter.evaluation), String(evaluationId));
  assert.equal(String(filter.student), String(studentId));
  assert.equal(String(update.$set.enrollment), String(enrollmentId));
  assert.equal(update.$set.value, 7.5);
  assert.equal(options.upsert, true);
});

test('sem avaliação vinculada ou sem matrícula ativa, nada é lançado', async () => {
  let upserts = 0;
  const sheet = { _id: oid(), student_id: oid() };

  await withStubs([
    [Enrollment, 'findOne', () => ({ select() { return this; }, lean: async () => null })],
    [Grade, 'findOneAndUpdate', async () => { upserts += 1; }],
  ], async () => {
    const legacy = buildExam();
    await examService._syncSheetGradeToGradebook(legacy, sheet, legacy.school_id, 8);
    const linked = buildExam({ settings: { evaluationId: oid() } });
    await examService._syncSheetGradeToGradebook(linked, sheet, linked.school_id, 8);
  });

  assert.equal(upserts, 0);
});

test('editar a prova atualiza título, data e valor da avaliação do Diário', async () => {
  const evaluationId = oid();
  const exam = buildExam({ settings: { evaluationId }, title: 'Novo título', totalValue: 8 });
  const updates = [];

  await withStubs([
    [SchoolYearService, 'findTermByDate', async () => termInfo],
    [Evaluation, 'updateOne', async (filter, update) => { updates.push({ filter, update }); }],
  ], async () => {
    await examService._syncGradebookEvaluation(exam, exam.school_id);
  });

  assert.equal(updates.length, 1);
  assert.equal(String(updates[0].filter._id), String(evaluationId));
  assert.equal(updates[0].update.$set.title, 'Novo título');
  assert.equal(updates[0].update.$set.maxScore, 8);
  assert.equal(updates[0].update.$set.term, '4º Bimestre');
});
