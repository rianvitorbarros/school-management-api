const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ReportCardHistoryService,
} = require('../../api/services/reportCardHistory.service');

let idSeq = 0;
function makeId(prefix = 'id') {
  idSeq += 1;
  return `${prefix}${idSeq}`;
}

function makeTerm({ id, label, startDate }) {
  return {
    _id: id,
    titulo: label,
    dataInicio: startDate,
  };
}

function makeClass({ id, name }) {
  return { _id: id, name };
}

function makeSubject({
  subjectId,
  name,
  score,
  status = 'Preenchido',
  teacherId = null,
  scoreHistory = [],
}) {
  return {
    subjectId,
    subjectNameSnapshot: name,
    teacherId,
    score,
    status,
    testScore: 1,
    activityScore: 2,
    participationScore: 3,
    scoreHistory,
  };
}

function makeReportCard({
  schoolId,
  studentId,
  schoolYear = 2026,
  term,
  classDoc,
  subjects,
  minimumAverage = 7,
}) {
  return {
    _id: makeId('rc'),
    school_id: schoolId,
    studentId,
    schoolYear,
    termId: term,
    classId: classDoc,
    minimumAverage,
    subjects,
  };
}

function queryResult(result) {
  return {
    select() {
      return Promise.resolve(result);
    },
    populate() {
      return this;
    },
    sort() {
      return Promise.resolve(result);
    },
  };
}

function makeService({
  student = null,
  school = null,
  reportCards = [],
  seenReportCardQueries = [],
} = {}) {
  return new ReportCardHistoryService({
    StudentModel: {
      findOne(query) {
        if (student && String(query._id) === String(student._id) && String(query.school_id) === String(student.school_id)) {
          return queryResult(student);
        }
        return queryResult(null);
      },
    },
    SchoolModel: {
      findOne(query) {
        if (school && String(query._id) === String(school._id)) {
          return queryResult(school);
        }
        return queryResult({ _id: query._id, name: '' });
      },
    },
    ReportCardModel: {
      find(query) {
        seenReportCardQueries.push(query);
        const filtered = reportCards.filter((card) =>
          String(card.school_id) === String(query.school_id) &&
          String(card.studentId) === String(query.studentId) &&
          Number(card.schoolYear) === Number(query.schoolYear)
        );
        return queryResult(filtered);
      },
    },
  });
}

test('consolida aluno com 1o e 2o bimestre por disciplina usando subjects.score', async () => {
  const schoolId = makeId('school');
  const studentId = makeId('student');
  const term1 = makeTerm({ id: makeId('term'), label: '1º Bimestre', startDate: '2026-02-01' });
  const term2 = makeTerm({ id: makeId('term'), label: '2º Bimestre', startDate: '2026-04-01' });
  const classDoc = makeClass({ id: makeId('class'), name: '6º Ano A' });
  const portugueseId = makeId('subject');
  const mathId = makeId('subject');

  const service = makeService({
    student: { _id: studentId, school_id: schoolId, fullName: 'Aluna Teste', enrollmentNumber: 'M001' },
    school: { _id: schoolId, name: 'Escola Teste' },
    reportCards: [
      makeReportCard({
        schoolId,
        studentId,
        term: term1,
        classDoc,
        subjects: [
          makeSubject({ subjectId: portugueseId, name: 'Português', score: 10 }),
          makeSubject({ subjectId: mathId, name: 'Matemática', score: 9.5 }),
        ],
      }),
      makeReportCard({
        schoolId,
        studentId,
        term: term2,
        classDoc,
        subjects: [
          makeSubject({ subjectId: portugueseId, name: 'Português', score: 9 }),
          makeSubject({ subjectId: mathId, name: 'Matemática', score: 8.5 }),
        ],
      }),
    ],
  });

  const result = await service.getStudentHistory({ schoolId, studentId, schoolYear: 2026 });
  const portuguese = result.subjects.find((item) => item.subjectName === 'Português');

  assert.equal(result.terms.length, 2);
  assert.equal(result.subjects.length, 2);
  assert.equal(portuguese.scoresByTerm[term1._id], 10);
  assert.equal(portuguese.scoresByTerm[term2._id], 9);
  assert.equal(portuguese.filledTermsCount, 2);
  assert.equal(portuguese.finalAverage, null);
  assert.equal(portuguese.situation, 'Em andamento');
});

test('retorna contexto editável e trilha de autoria por bimestre', async () => {
  const schoolId = makeId('school');
  const studentId = makeId('student');
  const teacherId = makeId('teacher');
  const actorId = makeId('actor');
  const term = makeTerm({
    id: makeId('term'),
    label: '1º Bimestre',
    startDate: '2026-02-01',
  });
  const classDoc = makeClass({ id: makeId('class'), name: '6º Ano A' });
  const subjectId = makeId('subject');
  const subject = makeSubject({
    subjectId,
    name: 'Português',
    score: 8,
    teacherId: { _id: teacherId, fullName: 'Professor Paulo' },
    scoreHistory: [
      {
        _id: makeId('history'),
        actorId: { _id: actorId, fullName: 'Gestora Ana', roles: ['Admin'] },
        actorNameSnapshot: 'Gestora Ana',
        actorRole: 'Admin',
        source: 'manual_report_card_edit',
        reason: 'Correção documental',
        changedAt: new Date('2026-08-17T14:30:00Z'),
        previous: { score: 7 },
        current: { score: 8 },
      },
    ],
  });
  subject.lastEditedBy = {
    _id: actorId,
    fullName: 'Gestora Ana',
    roles: ['Admin'],
  };
  subject.lastEditedAt = new Date('2026-08-17T14:30:00Z');
  subject.lastEditedRole = 'Admin';
  subject.lastEditedSource = 'manual_report_card_edit';

  const reportCard = makeReportCard({
    schoolId,
    studentId,
    term,
    classDoc,
    subjects: [subject],
  });
  const service = makeService({
    student: {
      _id: studentId,
      school_id: schoolId,
      fullName: 'Aluno',
      enrollmentNumber: 'M1',
    },
    school: { _id: schoolId, name: 'Escola' },
    reportCards: [reportCard],
  });

  const result = await service.getStudentHistory({
    schoolId,
    studentId,
    schoolYear: 2026,
  });
  const context = result.subjects[0].contextsByTerm[term._id];

  assert.equal(context.reportCardId, reportCard._id);
  assert.equal(context.classId, classDoc._id);
  assert.equal(context.teacherId, teacherId);
  assert.equal(context.teacherName, 'Professor Paulo');
  assert.equal(context.score, 8);
  assert.equal(context.testScore, 1);
  assert.equal(context.activityScore, 2);
  assert.equal(context.participationScore, 3);
  assert.equal(context.lastEditedBy.name, 'Gestora Ana');
  assert.equal(context.history.length, 1);
  assert.equal(context.history[0].reason, 'Correção documental');
  assert.equal(context.history[0].previous.score, 7);
  assert.equal(context.history[0].current.score, 8);
});

test('aluno com apenas 1o bimestre fica em andamento', async () => {
  const schoolId = makeId('school');
  const studentId = makeId('student');
  const term1 = makeTerm({ id: makeId('term'), label: '1º Bimestre', startDate: '2026-02-01' });

  const service = makeService({
    student: { _id: studentId, school_id: schoolId, fullName: 'Aluno', enrollmentNumber: '' },
    school: { _id: schoolId, name: 'Escola' },
    reportCards: [
      makeReportCard({
        schoolId,
        studentId,
        term: term1,
        classDoc: makeClass({ id: makeId('class'), name: '6º Ano A' }),
        subjects: [makeSubject({ subjectId: makeId('subject'), name: 'História', score: 8 })],
      }),
    ],
  });

  const result = await service.getStudentHistory({ schoolId, studentId, schoolYear: 2026 });

  assert.equal(result.subjects[0].filledTermsCount, 1);
  assert.equal(result.subjects[0].finalAverage, null);
  assert.equal(result.subjects[0].situation, 'Em andamento');
});

test('aluno sem boletins retorna DTO vazio sem erro', async () => {
  const schoolId = makeId('school');
  const studentId = makeId('student');
  const service = makeService({
    student: { _id: studentId, school_id: schoolId, fullName: 'Aluno', enrollmentNumber: '' },
    school: { _id: schoolId, name: 'Escola' },
    reportCards: [],
  });

  const result = await service.getStudentHistory({ schoolId, studentId, schoolYear: 2026 });

  assert.deepEqual(result.subjects, []);
  assert.deepEqual(result.terms, []);
});

test('aluno de outra escola e negado', async () => {
  const service = makeService({
    student: { _id: 'student1', school_id: 'schoolA', fullName: 'Aluno', enrollmentNumber: '' },
  });

  await assert.rejects(
    () => service.getStudentHistory({ schoolId: 'schoolB', studentId: 'student1', schoolYear: 2026 }),
    (error) => error.statusCode === 404
  );
});

test('disciplina presente em um bimestre e ausente em outro permanece consolidada', async () => {
  const schoolId = makeId('school');
  const studentId = makeId('student');
  const geographyId = makeId('subject');
  const term1 = makeTerm({ id: makeId('term'), label: '1º Bimestre', startDate: '2026-02-01' });
  const term2 = makeTerm({ id: makeId('term'), label: '2º Bimestre', startDate: '2026-04-01' });
  const classDoc = makeClass({ id: makeId('class'), name: '6º Ano A' });

  const service = makeService({
    student: { _id: studentId, school_id: schoolId, fullName: 'Aluno', enrollmentNumber: '' },
    school: { _id: schoolId, name: 'Escola' },
    reportCards: [
      makeReportCard({
        schoolId,
        studentId,
        term: term1,
        classDoc,
        subjects: [makeSubject({ subjectId: geographyId, name: 'Geografia', score: 7 })],
      }),
      makeReportCard({
        schoolId,
        studentId,
        term: term2,
        classDoc,
        subjects: [makeSubject({ subjectId: makeId('subject'), name: 'Ciências', score: 8 })],
      }),
    ],
  });

  const result = await service.getStudentHistory({ schoolId, studentId, schoolYear: 2026 });
  const geography = result.subjects.find((item) => item.subjectName === 'Geografia');

  assert.equal(result.subjects.length, 2);
  assert.equal(geography.scoresByTerm[term1._id], 7);
  assert.equal(geography.scoresByTerm[term2._id], undefined);
});

test('ordena bimestres por dataInicio e usa fallback por titulo', async () => {
  const schoolId = makeId('school');
  const studentId = makeId('student');
  const term1 = makeTerm({ id: makeId('term'), label: '1º Bimestre', startDate: '2026-02-01' });
  const term2 = makeTerm({ id: makeId('term'), label: '2º Bimestre', startDate: '2026-04-01' });
  const term3 = makeTerm({ id: makeId('term'), label: '3º Bimestre', startDate: null });

  const service = makeService({
    student: { _id: studentId, school_id: schoolId, fullName: 'Aluno', enrollmentNumber: '' },
    school: { _id: schoolId, name: 'Escola' },
    reportCards: [
      makeReportCard({
        schoolId,
        studentId,
        term: term2,
        classDoc: makeClass({ id: makeId('class'), name: '6º Ano A' }),
        subjects: [makeSubject({ subjectId: makeId('subject'), name: 'Português', score: 8 })],
      }),
      makeReportCard({
        schoolId,
        studentId,
        term: term3,
        classDoc: makeClass({ id: makeId('class'), name: '6º Ano A' }),
        subjects: [makeSubject({ subjectId: makeId('subject'), name: 'Matemática', score: 8 })],
      }),
      makeReportCard({
        schoolId,
        studentId,
        term: term1,
        classDoc: makeClass({ id: makeId('class'), name: '6º Ano A' }),
        subjects: [makeSubject({ subjectId: makeId('subject'), name: 'História', score: 8 })],
      }),
    ],
  });

  const result = await service.getStudentHistory({ schoolId, studentId, schoolYear: 2026 });

  assert.deepEqual(result.terms.map((term) => term.label), [
    '1º Bimestre',
    '2º Bimestre',
    '3º Bimestre',
  ]);
});

test('calcula media final apenas com 4 bimestres preenchidos', async () => {
  const schoolId = makeId('school');
  const studentId = makeId('student');
  const subjectId = makeId('subject');
  const classDoc = makeClass({ id: makeId('class'), name: '6º Ano A' });
  const scores = [10, 9, 8, 7];
  const reportCards = scores.map((score, index) =>
    makeReportCard({
      schoolId,
      studentId,
      term: makeTerm({
        id: makeId('term'),
        label: `${index + 1}º Bimestre`,
        startDate: `2026-0${index + 2}-01`,
      }),
      classDoc,
      subjects: [makeSubject({ subjectId, name: 'Português', score })],
      minimumAverage: 7,
    })
  );

  const service = makeService({
    student: { _id: studentId, school_id: schoolId, fullName: 'Aluno', enrollmentNumber: '' },
    school: { _id: schoolId, name: 'Escola' },
    reportCards,
  });

  const result = await service.getStudentHistory({ schoolId, studentId, schoolYear: 2026 });

  assert.equal(result.subjects[0].filledTermsCount, 4);
  assert.equal(result.subjects[0].finalAverage, 8.5);
  assert.equal(result.subjects[0].situation, 'Aprovado');
});

test('endpoint de historico nao altera boletins', async () => {
  const schoolId = makeId('school');
  const studentId = makeId('student');
  const reportCard = makeReportCard({
    schoolId,
    studentId,
    term: makeTerm({ id: makeId('term'), label: '1º Bimestre', startDate: '2026-02-01' }),
    classDoc: makeClass({ id: makeId('class'), name: '6º Ano A' }),
    subjects: [makeSubject({ subjectId: makeId('subject'), name: 'Português', score: 8 })],
  });
  const before = JSON.stringify(reportCard);

  const service = makeService({
    student: { _id: studentId, school_id: schoolId, fullName: 'Aluno', enrollmentNumber: '' },
    school: { _id: schoolId, name: 'Escola' },
    reportCards: [reportCard],
  });

  await service.getStudentHistory({ schoolId, studentId, schoolYear: 2026 });

  assert.equal(JSON.stringify(reportCard), before);
});
