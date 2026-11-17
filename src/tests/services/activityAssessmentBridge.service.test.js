const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { ActivityAssessmentBridge, numericScale } = require('../../api/services/activityAssessmentBridge.service');
const criteriaHelper = require('../../api/utils/earlyChildhoodCriteria.helper');
const modeHelper = require('../../api/utils/reportCardEvaluationMode.helper');

const oid = () => new mongoose.Types.ObjectId();
const lean = (value) => ({ select() { return this; }, sort() { return this; }, lean: async () => value });

function harness({ purpose = 'assessment', className = 'Maternal B', level = 'Educacao Infantil', grade = 'Maternal', reportCard = null, examId = null } = {}) {
  const schoolId = oid();
  const classId = oid();
  const studentId = oid();
  const design = { _id: oid(), purpose, subject: 'Natureza', maxScore: 10, examId };
  const classDoc = { _id: classId, name: className, level, grade, schoolYear: 2026 };
  const calls = { updates: [], grades: [], generated: 0, ensured: [] };
  let card = reportCard;
  const bridge = new ActivityAssessmentBridge({
    ActivityDesign: { findById: () => lean(design) },
    ClassModel: { findById: () => lean(classDoc) },
    ReportCard: { findOne: () => lean(card) },
    Periodo: { findOne: () => lean({ _id: oid() }) },
    Subject: { findOne: () => lean({ _id: oid() }) },
    criteriaHelper,
    modeHelper,
    reportCardService: {
      async generateClassReportCards() {
        calls.generated += 1;
        card = {
          _id: oid(),
          subjects: [{ subjectId: oid(), areaId: 'nature_area', subjectNameSnapshot: 'NATUREZA' }],
          developmentalAssessments: [],
        };
      },
      async updateTeacherSubjectDevelopmentalAssessment(args) { calls.updates.push(args); },
    },
    examService: { async saveDirectGrades(id, school, grades) { calls.grades.push([id, grades]); } },
    activityDesignService: {
      async ensureAssessmentExam(id, actor, payload) { calls.ensured.push(payload); return { examId: 'exam-new' }; },
    },
  });
  const printRun = { classId, termId: oid(), printDate: new Date('2026-11-17') };
  const activityBook = { activityDesignId: design._id };
  return { bridge, schoolId, studentId, printRun, activityBook, calls, design };
}

test('atividade livre nao vira avaliacao', async () => {
  const { bridge, printRun, activityBook } = harness({ purpose: 'activity' });
  assert.equal(await bridge.contextFor({ activityBook, printRun }), null);
  assert.equal(await bridge.contextFor({ activityBook: {}, printRun }), null);
});

test('Educacao Infantil: QR traz os criterios do boletim e grava os conceitos', async () => {
  const { bridge, schoolId, studentId, printRun, activityBook, calls } = harness();
  const context = await bridge.contextFor({ activityBook, printRun });
  assert.equal(context.mode, 'developmental');
  assert.ok(context.template.length > 0);
  assert.equal(context.template[0].scale[0], 'Realiza com autonomia');
  assert.equal(bridge.describe(context).destination, 'boletim');

  const first = context.template[0];
  const result = await bridge.sync({
    schoolId,
    actor: { id: String(oid()) },
    context,
    printRun,
    studentId,
    criteria: [{ key: first.key, value: 'Realiza com apoio' }],
  });

  assert.equal(result.ok, true);
  assert.equal(calls.generated, 1, 'cria o boletim do bimestre quando falta');
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].subjectId, 'nature_area');
  const marked = calls.updates[0].criteria.find((item) => item.criterionId === first.key);
  assert.equal(marked.status, 'support');
});

test('turma numerica: QR traz a nota e grava no Diario pela prova de notas', async () => {
  const { bridge, schoolId, studentId, printRun, activityBook, calls } = harness({
    className: '3 ANO B', level: 'Ensino Fundamental I', grade: '3 ANO',
  });
  const context = await bridge.contextFor({ activityBook, printRun });
  assert.equal(context.mode, 'numeric');
  assert.deepEqual(context.template.map((item) => item.key), ['nota']);
  assert.ok(context.template[0].scale.includes('7,5'));

  const result = await bridge.sync({
    schoolId, actor: { id: 'x' }, context, printRun, studentId,
    criteria: [{ key: 'nota', value: '7,5' }],
  });
  assert.equal(result.ok, true);
  assert.equal(calls.ensured.length, 1, 'prepara a prova de notas quando ainda nao existe');
  assert.deepEqual(calls.grades[0], ['exam-new', [{ studentId: String(studentId), grade: 7.5 }]]);
});

test('escala numerica vai de 0 ao valor da avaliacao', () => {
  assert.deepEqual(numericScale(2), ['0', '0,5', '1', '1,5', '2']);
  assert.equal(numericScale(10).at(-1), '10');
});
