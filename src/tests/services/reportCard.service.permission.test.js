const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const reportCardService = require('../../api/services/reportCard.service');
const ReportCard = require('../../api/models/reportCard.model');

function makeId() {
  return new mongoose.Types.ObjectId().toString();
}

function makeReportCard({
  schoolId = makeId(),
  termId = makeId(),
  classId = makeId(),
  studentId = makeId(),
  teacherId = makeId(),
  subjectId = makeId(),
} = {}) {
  return {
    _id: makeId(),
    school_id: schoolId,
    schoolYear: 2026,
    termId,
    classId,
    studentId,
    minimumAverage: 7,
    evaluationMode: 'numeric',
    gradingType: 'numeric',
    status: 'Rascunho',
    subjects: [
      {
        subjectId,
        teacherId,
        testScore: null,
        activityScore: null,
        participationScore: null,
        score: null,
        status: 'Pendente',
        observation: '',
        scoreHistory: [],
      },
    ],
    async save() {
      this.saved = true;
      return this;
    },
  };
}

async function withMockedReportCardFindOne(reportCard, action) {
  const originalFindOne = ReportCard.findOne;
  ReportCard.findOne = () => Promise.resolve(reportCard);

  try {
    return await action();
  } finally {
    ReportCard.findOne = originalFindOne;
  }
}

function actor({ id = makeId(), schoolId, roles }) {
  return {
    _id: id,
    fullName: 'Usuário de Teste',
    school_id: schoolId,
    roles,
  };
}

async function saveScore({ reportCard, actorUser, subjectId, expectedTermId }) {
  return reportCardService.updateTeacherSubjectScore({
    schoolId: reportCard.school_id,
    reportCardId: reportCard._id,
    subjectId,
    actor: actorUser,
    testScore: 6,
    activityScore: 2,
    participationScore: 1,
    observation: 'Lancamento manual',
    expectedContext: {
      expectedTermId,
      expectedSchoolYear: reportCard.schoolYear,
      expectedClassId: reportCard.classId,
      expectedStudentId: reportCard.studentId,
      expectedTeacherId: reportCard.subjects[0].teacherId,
    },
  });
}

test('professor vinculado edita somente sua disciplina', async () => {
  const schoolId = makeId();
  const teacherId = makeId();
  const reportCard = makeReportCard({ schoolId, teacherId });

  const result = await withMockedReportCardFindOne(reportCard, () =>
    saveScore({
      reportCard,
      actorUser: actor({ id: teacherId, schoolId, roles: ['Professor'] }),
      subjectId: reportCard.subjects[0].subjectId,
      expectedTermId: reportCard.termId,
    })
  );

  assert.equal(result.subjects[0].score, 9);
  assert.equal(String(result.subjects[0].filledBy), teacherId);
  assert.equal(result.subjects[0].lastEditedRole, 'Professor');
  assert.equal(result.subjects[0].scoreHistory.length, 1);
  assert.equal(result.subjects[0].scoreHistory[0].source, 'manual_report_card_edit');
  assert.equal(result.subjects[0].scoreHistory[0].actorNameSnapshot, 'Usuário de Teste');
  assert.equal(result.saved, true);
});

test('edicao direta preserva componentes de prova e exige motivo na sobrescrita', async () => {
  const schoolId = makeId();
  const teacherId = makeId();
  const reportCard = makeReportCard({ schoolId, teacherId });
  reportCard.subjects[0].testScore = 5;
  reportCard.subjects[0].activityScore = 2;
  reportCard.subjects[0].participationScore = 1;
  reportCard.subjects[0].score = 8;
  reportCard.subjects[0].observation = 'Registro original do professor.';

  await assert.rejects(
    () =>
      withMockedReportCardFindOne(reportCard, () =>
        reportCardService.updateTeacherSubjectScore({
          schoolId,
          reportCardId: reportCard._id,
          subjectId: reportCard.subjects[0].subjectId,
          actor: actor({ id: teacherId, schoolId, roles: ['Professor'] }),
          score: 9,
        })
      ),
    /motivo/
  );

  const result = await withMockedReportCardFindOne(reportCard, () =>
    reportCardService.updateTeacherSubjectScore({
      schoolId,
      reportCardId: reportCard._id,
      subjectId: reportCard.subjects[0].subjectId,
      actor: actor({ id: teacherId, schoolId, roles: ['Professor'] }),
      score: 9,
      reason: 'Correção conferida pela coordenação.',
    })
  );

  assert.equal(result.subjects[0].score, 9);
  assert.equal(result.subjects[0].testScore, 5);
  assert.equal(result.subjects[0].activityScore, 2);
  assert.equal(result.subjects[0].participationScore, 1);
  assert.equal(result.subjects[0].observation, 'Registro original do professor.');
  assert.equal(result.subjects[0].scoreHistory.length, 1);
  assert.equal(result.subjects[0].scoreHistory[0].previous.score, 8);
  assert.equal(result.subjects[0].scoreHistory[0].current.score, 9);
});

test('professor continua podendo recalcular componentes com autoria automatica', async () => {
  const schoolId = makeId();
  const teacherId = makeId();
  const reportCard = makeReportCard({ schoolId, teacherId });
  reportCard.subjects[0].testScore = 4;
  reportCard.subjects[0].activityScore = 2;
  reportCard.subjects[0].participationScore = 1;
  reportCard.subjects[0].score = 7;

  const result = await withMockedReportCardFindOne(reportCard, () =>
    reportCardService.updateTeacherSubjectScore({
      schoolId,
      reportCardId: reportCard._id,
      subjectId: reportCard.subjects[0].subjectId,
      actor: actor({ id: teacherId, schoolId, roles: ['Professor'] }),
      testScore: 5,
      activityScore: 2,
      participationScore: 1,
    })
  );

  assert.equal(result.subjects[0].score, 8);
  assert.equal(result.subjects[0].scoreHistory.length, 1);
  assert.equal(result.subjects[0].scoreHistory[0].actorRole, 'Professor');
});

test('professor nao vinculado nao edita disciplina de outro professor', async () => {
  const schoolId = makeId();
  const reportCard = makeReportCard({ schoolId, teacherId: makeId() });

  await assert.rejects(
    () =>
      withMockedReportCardFindOne(reportCard, () =>
        saveScore({
          reportCard,
          actorUser: actor({ id: makeId(), schoolId, roles: ['Professor'] }),
          subjectId: reportCard.subjects[0].subjectId,
          expectedTermId: reportCard.termId,
        })
      ),
    /permissão|permissao|permis/
  );
});

test('coordenador edita qualquer disciplina da propria escola', async () => {
  const schoolId = makeId();
  const reportCard = makeReportCard({ schoolId, teacherId: makeId() });
  const coordinatorId = makeId();

  const result = await withMockedReportCardFindOne(reportCard, () =>
    saveScore({
      reportCard,
      actorUser: actor({ id: coordinatorId, schoolId, roles: ['Coordenador'] }),
      subjectId: reportCard.subjects[0].subjectId,
      expectedTermId: reportCard.termId,
    })
  );

  assert.equal(result.subjects[0].score, 9);
  assert.equal(String(result.subjects[0].filledBy), coordinatorId);
  assert.equal(result.subjects[0].lastEditedRole, 'Coordenador');
});

test('admin edita qualquer disciplina da propria escola', async () => {
  const schoolId = makeId();
  const reportCard = makeReportCard({ schoolId, teacherId: makeId() });
  const adminId = makeId();

  const result = await withMockedReportCardFindOne(reportCard, () =>
    saveScore({
      reportCard,
      actorUser: actor({ id: adminId, schoolId, roles: ['Admin'] }),
      subjectId: reportCard.subjects[0].subjectId,
      expectedTermId: reportCard.termId,
    })
  );

  assert.equal(result.subjects[0].score, 9);
  assert.equal(String(result.subjects[0].filledBy), adminId);
  assert.equal(result.subjects[0].lastEditedRole, 'Admin');
});

test('staff continua sem permissao de edicao de boletim', async () => {
  const schoolId = makeId();
  const reportCard = makeReportCard({ schoolId, teacherId: makeId() });

  await assert.rejects(
    () =>
      withMockedReportCardFindOne(reportCard, () =>
        saveScore({
          reportCard,
          actorUser: actor({ id: makeId(), schoolId, roles: ['Staff'] }),
          subjectId: reportCard.subjects[0].subjectId,
          expectedTermId: reportCard.termId,
        })
      ),
    /permissão|permissao|permis/
  );
});

test('expectedTermId divergente bloqueia salvamento', async () => {
  const schoolId = makeId();
  const teacherId = makeId();
  const reportCard = makeReportCard({ schoolId, teacherId });

  await assert.rejects(
    () =>
      withMockedReportCardFindOne(reportCard, () =>
        saveScore({
          reportCard,
          actorUser: actor({ id: teacherId, schoolId, roles: ['Professor'] }),
          subjectId: reportCard.subjects[0].subjectId,
          expectedTermId: makeId(),
        })
      ),
    (error) => error.statusCode === 409
  );
});

test('usuario de outra escola nao edita boletim', async () => {
  const schoolId = makeId();
  const teacherId = makeId();
  const reportCard = makeReportCard({ schoolId, teacherId });

  await assert.rejects(
    () =>
      withMockedReportCardFindOne(reportCard, () =>
        saveScore({
          reportCard,
          actorUser: actor({ id: teacherId, schoolId: makeId(), roles: ['Professor'] }),
          subjectId: reportCard.subjects[0].subjectId,
          expectedTermId: reportCard.termId,
        })
      ),
    (error) => error.statusCode === 403
  );
});

test('subjectId inexistente no boletim retorna erro', async () => {
  const schoolId = makeId();
  const teacherId = makeId();
  const reportCard = makeReportCard({ schoolId, teacherId });

  await assert.rejects(
    () =>
      withMockedReportCardFindOne(reportCard, () =>
        saveScore({
          reportCard,
          actorUser: actor({ id: teacherId, schoolId, roles: ['Professor'] }),
          subjectId: makeId(),
          expectedTermId: reportCard.termId,
        })
      ),
    (error) => error.statusCode === 404
  );
});
