const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const service = require('../../api/services/reportCard.service');
const ReportCard = require('../../api/models/reportCard.model');
const Subject = require('../../api/models/subject.model');
const Enrollment = require('../../api/models/enrollment.model');
const Horario = require('../../api/models/horario.model');

const id = () => new mongoose.Types.ObjectId().toString();

function chain(value) {
  return {
    sort: () => Promise.resolve(value),
    populate: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
}

async function withMocks({ cards = [], enrollment = null, horarios = [], subject }, fn) {
  const originals = {
    rcFind: ReportCard.find,
    subjectFindOne: Subject.findOne,
    enrollmentFindOne: Enrollment.findOne,
    horarioFind: Horario.find,
  };
  ReportCard.find = () => chain(cards);
  Subject.findOne = () => Promise.resolve(subject);
  Enrollment.findOne = () => Promise.resolve(enrollment);
  Horario.find = () => chain(horarios);
  try {
    return await fn();
  } finally {
    ReportCard.find = originals.rcFind;
    Subject.findOne = originals.subjectFindOne;
    Enrollment.findOne = originals.enrollmentFindOne;
    Horario.find = originals.horarioFind;
  }
}

function card({ schoolId, classId, termId, subjects }) {
  return {
    _id: id(), school_id: schoolId, schoolYear: 2026, termId, classId,
    studentId: id(), minimumAverage: 6, status: 'Rascunho', subjects,
    async save() { this.saved = true; return this; },
  };
}

test('inclui disciplina ausente no boletim existente do bimestre sem tocar nas demais', async () => {
  const schoolId = id();
  const termId = id();
  const oldClass = id();
  const biologyId = id();
  const geographyId = id();
  const teacherId = id();
  const existing = card({
    schoolId, classId: oldClass, termId,
    subjects: [{ subjectId: biologyId, teacherId: id(), score: 8, testScore: 8,
      subjectNameSnapshot: 'BIOLOGIA', scoreHistory: [] }],
  });

  const result = await withMocks({
    cards: [existing],
    enrollment: { _id: id(), class: id() },
    horarios: [{ termId: id(), teacherId: { _id: teacherId, name: 'Prof. Geo' } }],
    subject: { _id: geographyId, name: 'GEOGRAFIA' },
  }, () => service.ensureStudentTermSubject({
    schoolId, studentId: id(), termId, schoolYear: 2026, subjectId: geographyId,
    actor: { _id: id(), school_id: schoolId, roles: ['Coordenador'] },
  }));

  assert.equal(result.created, true);
  assert.equal(result.reportCard, existing);
  assert.equal(existing.saved, true);
  assert.equal(existing.subjects.length, 2);
  assert.equal(existing.subjects[0].score, 8);
  assert.equal(String(existing.subjects[1].subjectId), geographyId);
  assert.equal(existing.subjects[1].teacherId, teacherId);
  assert.equal(existing.subjects[1].teacherNameSnapshot, 'Prof. Geo');
});

test('é idempotente quando a disciplina já existe em algum boletim do bimestre', async () => {
  const schoolId = id();
  const subjectId = id();
  const existing = card({ schoolId, classId: id(), termId: id(),
    subjects: [{ subjectId, teacherId: id(), score: null }] });
  const result = await withMocks({ cards: [existing], subject: { _id: subjectId, name: 'ARTE' } },
    () => service.ensureStudentTermSubject({
      schoolId, studentId: id(), termId: id(), schoolYear: 2026, subjectId,
      actor: { _id: id(), school_id: schoolId, roles: ['Admin'] },
    }));
  assert.equal(result.created, false);
  assert.equal(existing.saved, undefined);
});

test('professor não pode incluir disciplina no boletim', async () => {
  const schoolId = id();
  await assert.rejects(
    withMocks({ subject: { _id: id(), name: 'ARTE' } }, () => service.ensureStudentTermSubject({
      schoolId, studentId: id(), termId: id(), schoolYear: 2026, subjectId: id(),
      actor: { _id: id(), school_id: schoolId, roles: ['Professor'] },
    })),
    (error) => error.statusCode === 403
  );
});

test('sem boletim no bimestre e sem matrícula ativa retorna 404', async () => {
  const schoolId = id();
  await assert.rejects(
    withMocks({ subject: { _id: id(), name: 'ARTE' } }, () => service.ensureStudentTermSubject({
      schoolId, studentId: id(), termId: id(), schoolYear: 2026, subjectId: id(),
      actor: { _id: id(), school_id: schoolId, roles: ['Coordenador'] },
    })),
    (error) => error.statusCode === 404
  );
});

test('regerar boletim preserva disciplinas com notas que saíram do horário', () => {
  const kept = { subjectId: id(), teacherId: id(), subjectNameSnapshot: 'MATEMÁTICA',
    score: 7, testScore: 7, scoreHistory: [{}] };
  const emptyOld = { subjectId: id(), teacherId: id(), subjectNameSnapshot: 'ARTE', score: null };
  const generated = [{ subjectId: id(), teacherId: id(), subjectNameSnapshot: 'BIOLOGIA', score: null }];
  const merged = service._mergeSubjects([kept, emptyOld], generated, 6);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].subjectNameSnapshot, 'BIOLOGIA');
  assert.equal(merged[1], kept);
});

test('regerar boletim com troca de professor mantém as notas da disciplina', () => {
  const subjectId = id();
  const newTeacher = id();
  const existing = { subjectId, teacherId: id(), subjectNameSnapshot: 'ARTE',
    score: 9, testScore: 5, activityScore: 4, scoreHistory: [{}] };
  const merged = service._mergeSubjects([existing],
    [{ subjectId, teacherId: newTeacher, subjectNameSnapshot: 'ARTE', score: null }], 6);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].teacherId, newTeacher);
  assert.equal(merged[0].score, 9);
  assert.equal(merged[0].activityScore, 4);
});
