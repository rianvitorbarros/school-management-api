const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const service = require('../../api/services/reportCard.service');
const ReportCard = require('../../api/models/reportCard.model');

const id = () => new mongoose.Types.ObjectId().toString();

async function save(input, initial = {}, otherSubject = null) {
  const schoolId = id();
  const teacherId = id();
  const subjectId = id();
  const card = {
    _id: id(), school_id: schoolId, schoolYear: 2026,
    termId: id(), classId: id(), studentId: id(), minimumAverage: 6,
    evaluationMode: 'numeric', gradingType: 'numeric', status: 'Rascunho',
    subjects: [{ subjectId, teacherId, testScore: null, activityScore: null,
      participationScore: null, score: null, status: 'Pendente',
      observation: '', scoreHistory: [], ...initial }, ...(otherSubject ? [otherSubject] : [])],
    async save() { this.saved = true; return this; },
  };
  const original = ReportCard.findOne;
  ReportCard.findOne = () => Promise.resolve(card);
  try {
    await service.updateTeacherSubjectScore({ schoolId, reportCardId: card._id,
      subjectId, actor: { _id: teacherId, school_id: schoolId, roles: ['Professor'] },
      ...input });
    return card;
  } finally {
    ReportCard.findOne = original;
  }
}

test('atividade sem prova nem participação aceita notas válidas e mantém ausências', async () => {
  for (const value of [0, 5, 5.5, 6, 7, 7.5, 10, '7', '7,0', '7.0']) {
    const card = await save({ activityScore: value });
    assert.equal(card.subjects[0].activityScore, Number(String(value).replace(',', '.')));
    assert.equal(card.subjects[0].score, card.subjects[0].activityScore);
    assert.equal(card.subjects[0].testScore, null);
    assert.equal(card.subjects[0].participationScore, null);
    assert.equal(card.subjects[0].status,
      card.subjects[0].score < 6 ? 'Abaixo da Média' : 'Acima da Média');
    assert.equal(card.saved, true);
  }
});

test('PATCH parcial preserva outros componentes; null explícito limpa sem criar zero', async () => {
  const card = await save({ activityScore: 5.5 },
    { testScore: 1, activityScore: 2, participationScore: 1, score: 4 });
  assert.deepEqual(card.subjects[0].score, 7.5);
  assert.equal(card.subjects[0].testScore, 1);
  assert.equal(card.subjects[0].participationScore, 1);
  assert.equal(card.subjects[0].scoreHistory.length, 1);

  const cleared = await save({ testScore: null, activityScore: 7, participationScore: null },
    { testScore: 1, activityScore: 2, participationScore: 1, score: 4 });
  assert.equal(cleared.subjects[0].testScore, null);
  assert.equal(cleared.subjects[0].score, 7);
});

test('campo inválido é identificado e não persiste', async () => {
  for (const [field, value, label] of [
    ['testScore', '--', 'Prova'],
    ['activityScore', 'abc', 'Atividade'],
    ['participationScore', '', 'Participação'],
    ['activityScore', 11, 'Atividade'],
  ]) {
    await assert.rejects(save({ [field]: value }),
      (error) => error.statusCode === 400 && error.message.includes(label));
  }
  await assert.rejects(save({ activityScore: null }), /Informe ao menos uma nota/);
});

test('salvar uma disciplina não sobrescreve outra no mesmo boletim', async () => {
  const otherSubject = { subjectId: id(), teacherId: id(), testScore: 5,
    activityScore: 2, participationScore: null, score: 7,
    status: 'Preenchido', observation: 'Original', scoreHistory: [] };
  const card = await save({ activityScore: 5 }, {}, otherSubject);
  assert.deepEqual(card.subjects[1], otherSubject);
});
