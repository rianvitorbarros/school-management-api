const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  ActivityCorrectionService,
  DEFAULT_CRITERIA_SCALE,
} = require('../../api/services/activityCorrection.service');

function sameId(left, right) {
  return String(left) === String(right);
}

function createQuery(value) {
  return {
    select() { return this; },
    populate() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function matchesValue(value, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (Object.prototype.hasOwnProperty.call(expected, '$in')) {
      return expected.$in.some((item) => sameId(item, value));
    }
    if (Object.prototype.hasOwnProperty.call(expected, '$gte') || Object.prototype.hasOwnProperty.call(expected, '$lt')) {
      const comparable = new Date(value).getTime();
      if (Object.prototype.hasOwnProperty.call(expected, '$gte') && comparable < new Date(expected.$gte).getTime()) {
        return false;
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$lt') && comparable >= new Date(expected.$lt).getTime()) {
        return false;
      }
      return true;
    }
    if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
      return expected.$exists ? value !== undefined : value === undefined;
    }
  }

  return sameId(value, expected);
}

function matchesQuery(doc, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '_id' && expected?.$exists === false) return false;
    if (key.includes('.')) {
      const [root, child] = key.split('.');
      const value = doc[root];
      if (Array.isArray(value)) {
        return value.some((item) => matchesValue(item?.[child], expected));
      }
      return matchesValue(value?.[child], expected);
    }

    return matchesValue(doc[key], expected);
  });
}

function createArrayQuery(items) {
  return {
    select() { return this; },
    sort() { return this; },
    skip(value) {
      this._skip = value;
      return this;
    },
    limit(value) {
      this._limit = value;
      return this;
    },
    lean() {
      const skip = this._skip || 0;
      const limit = this._limit ?? items.length;
      return Promise.resolve(items.slice(skip, skip + limit));
    },
    then(resolve, reject) {
      return this.lean().then(resolve, reject);
    },
  };
}

function createHarness(overrides = {}) {
  const schoolId = new mongoose.Types.ObjectId();
  const otherSchoolId = new mongoose.Types.ObjectId();
  const classId = new mongoose.Types.ObjectId();
  const otherClassId = new mongoose.Types.ObjectId();
  const studentId = new mongoose.Types.ObjectId();
  const secondStudentId = new mongoose.Types.ObjectId();
  const teacherId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();
  const pageId = new mongoose.Types.ObjectId();
  const bookId = new mongoose.Types.ObjectId();
  const termId = new mongoose.Types.ObjectId();
  const printRunId = new mongoose.Types.ObjectId();
  const correctionId = new mongoose.Types.ObjectId();

  const page = {
    _id: pageId,
    title: 'Atividade de Vogais',
    subject: 'Portugues',
    criteriaTemplate: overrides.pageCriteriaTemplate,
  };

  const book = {
    _id: bookId,
    title: 'Caderno de Alfabetizacao',
    subject: 'Portugues',
    defaultCriteriaTemplate: overrides.bookCriteriaTemplate,
  };

  const printRun = {
    _id: printRunId,
    schoolId,
    classId,
    teacherId,
    termId,
    activityPageId: pageId,
    bookId,
    printDate: new Date('2026-06-08T12:00:00.000Z'),
    status: 'generated',
    snapshot: {
      schoolName: 'Escola Teste',
      className: '1 B',
      teacherName: 'Professora Ana',
      subject: 'Portugues',
      bookTitle: 'Caderno de Alfabetizacao',
      activityTitle: 'Atividade de Vogais',
      pageNumber: 4,
      segment: 'Educacao Infantil',
      grade: 'Pre-escola',
    },
    items: [
      {
        itemId: 'item-1',
        studentId,
        studentName: 'Lara Sophia Sanches',
        qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
        pageNumber: 1,
        status: 'generated',
      },
      {
        itemId: 'item-2',
        studentId: secondStudentId,
        studentName: 'Milena Brandao',
        qrCodePayload: 'AH-ACTIVITY-1:uuid-2',
        pageNumber: 2,
        status: 'generated',
      },
    ],
  };

  const foreignPrintRun = {
    ...printRun,
    _id: new mongoose.Types.ObjectId(),
    schoolId: otherSchoolId,
    items: [
      {
        itemId: 'item-foreign',
        studentId,
        studentName: 'Aluno Externo',
        qrCodePayload: 'AH-ACTIVITY-1:foreign',
        pageNumber: 1,
        status: 'generated',
      },
    ],
  };

  const state = {
    corrections: overrides.corrections
      ? overrides.corrections.map((item) => ({ ...item }))
      : [],
  };

  class FakeActivityCorrectionModel {
    constructor(data = {}) {
      Object.assign(this, JSON.parse(JSON.stringify(data)));
      this._id = data._id || new mongoose.Types.ObjectId();
    }

    async save() {
      const plain = JSON.parse(JSON.stringify(this));
      const index = state.corrections.findIndex((item) => sameId(item._id, this._id));
      if (index >= 0) state.corrections[index] = plain;
      else state.corrections.push(plain);
      return this;
    }

    static async create(data = {}) {
      if (overrides.createError) throw overrides.createError;
      const duplicate = state.corrections.find((item) => item.qrCodePayload === data.qrCodePayload);
      if (duplicate) {
        const error = new Error('duplicate');
        error.code = 11000;
        throw error;
      }
      const doc = new FakeActivityCorrectionModel(data);
      await doc.save();
      return doc;
    }

    static findOne(query = {}) {
      const found = state.corrections.find((item) => matchesQuery(item, query)) || null;
      return createQuery(found ? new FakeActivityCorrectionModel(found) : null);
    }

    static find(query = {}) {
      const items = state.corrections
        .filter((item) => matchesQuery(item, query))
        .map((item) => ({ ...item }));
      return createArrayQuery(items);
    }

    static countDocuments(query = {}) {
      return Promise.resolve(state.corrections.filter((item) => matchesQuery(item, query)).length);
    }
  }

  const service = new ActivityCorrectionService({
    ActivityCorrectionModel: FakeActivityCorrectionModel,
    ActivityPrintRunModel: {
      findOne(query = {}) {
        if (query.schoolId && sameId(query.schoolId, schoolId) && query['items.qrCodePayload'] === 'AH-ACTIVITY-1:uuid-1') {
          return createQuery({ ...printRun });
        }
        if (query.schoolId && sameId(query.schoolId, schoolId) && query['items.qrCodePayload'] === 'AH-ACTIVITY-1:uuid-2') {
          return createQuery({ ...printRun });
        }
        if (!query.schoolId && query['items.qrCodePayload'] === 'AH-ACTIVITY-1:foreign') {
          return createQuery({ ...foreignPrintRun });
        }
        if (!query.schoolId && (query['items.qrCodePayload'] === 'AH-ACTIVITY-1:uuid-1' || query['items.qrCodePayload'] === 'AH-ACTIVITY-1:uuid-2')) {
          return createQuery({ ...printRun });
        }
        return createQuery(null);
      },
      find(query = {}) {
        const runs = [{ ...printRun }].filter((item) => matchesQuery(item, query));
        return createArrayQuery(runs);
      },
    },
    ActivityPageModel: {
      findById(id) {
        return createQuery(sameId(id, pageId) ? { ...page } : null);
      },
    },
    ActivityBookModel: {
      findById(id) {
        return createQuery(sameId(id, bookId) ? { ...book } : null);
      },
    },
    ensureClassAccessFn: async (actor, school, requestedClassId) => {
      if (overrides.classAccessError) throw overrides.classAccessError;
      if (!sameId(school, schoolId) || !sameId(requestedClassId, classId)) {
        const error = new Error('Turma nao encontrada.');
        error.statusCode = 404;
        throw error;
      }
      return { _id: classId, name: '1 B' };
    },
    ensureStudentAccessInAnyOwnedClassFn: async () => {
      if (overrides.studentAccessError) throw overrides.studentAccessError;
      return { enrollment: { _id: new mongoose.Types.ObjectId(), student: studentId, class: classId } };
    },
    getAccessibleClassIdsFn: async () => {
      if (overrides.accessibleClassIds !== undefined) return overrides.accessibleClassIds;
      return [String(classId)];
    },
    isPrivilegedActorFn: (actor) => Array.isArray(actor.roles) && actor.roles.includes('ADMIN'),
    getActorRolesFn: (actor) => (actor.roles || (actor.role ? [actor.role] : []))
      .map((role) => String(role || '').trim().toUpperCase())
      .filter(Boolean),
  });

  return {
    state,
    service,
    ids: {
      schoolId: String(schoolId),
      otherSchoolId: String(otherSchoolId),
      classId: String(classId),
      otherClassId: String(otherClassId),
      studentId: String(studentId),
      secondStudentId: String(secondStudentId),
      teacherId: String(teacherId),
      pageId: String(pageId),
      bookId: String(bookId),
      termId: String(termId),
      printRunId: String(printRunId),
      correctionId: String(correctionId),
    },
    actors: {
      teacher: {
        id: String(actorId),
        school_id: String(schoolId),
        roles: ['Professor'],
      },
      admin: {
        id: String(new mongoose.Types.ObjectId()),
        school_id: String(schoolId),
        roles: ['ADMIN'],
      },
      student: {
        id: String(new mongoose.Types.ObjectId()),
        school_id: String(schoolId),
        roles: ['student'],
      },
    },
  };
}

test('resolveQr resolves a valid activity QR from the same school', async () => {
  const harness = createHarness();

  const result = await harness.service.resolveQr({
    schoolId: harness.ids.schoolId,
    actor: harness.actors.teacher,
    qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
  });

  assert.equal(result.type, 'activity');
  assert.equal(result.activity.bookTitle, 'Caderno de Alfabetizacao');
  assert.equal(result.student.name, 'Lara Sophia Sanches');
  assert.equal(result.correction.exists, false);
  assert.equal(result.criteriaTemplate[0].key, 'coordenacao_motora');
});

test('resolveQr rejects payload without the activity prefix', async () => {
  const harness = createHarness();

  await assert.rejects(
    () => harness.service.resolveQr({
      schoolId: harness.ids.schoolId,
      actor: harness.actors.teacher,
      qrCodePayload: 'uuid-1',
    }),
    (error) => error.code === 'INVALID_ACTIVITY_QR'
  );
});

test('resolveQr rejects nonexistent payloads', async () => {
  const harness = createHarness();

  await assert.rejects(
    () => harness.service.resolveQr({
      schoolId: harness.ids.schoolId,
      actor: harness.actors.teacher,
      qrCodePayload: 'AH-ACTIVITY-1:missing',
    }),
    (error) => error.code === 'ACTIVITY_QR_NOT_FOUND'
  );
});

test('resolveQr rejects activity QR from another school', async () => {
  const harness = createHarness();

  await assert.rejects(
    () => harness.service.resolveQr({
      schoolId: harness.ids.schoolId,
      actor: harness.actors.teacher,
      qrCodePayload: 'AH-ACTIVITY-1:foreign',
    }),
    (error) => error.code === 'ACTIVITY_QR_SCHOOL_MISMATCH'
  );
});

test('createCorrection saves a qualitative correction and snapshots the template', async () => {
  const harness = createHarness();

  const result = await harness.service.createCorrection({
    schoolId: harness.ids.schoolId,
    actor: harness.actors.teacher,
    payload: {
      qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
      criteria: [
        {
          key: 'coordenacao_motora',
          value: 'realizou_com_apoio',
          note: '',
        },
      ],
      generalObservation: 'Realizou a atividade com apoio.',
    },
  });

  assert.equal(result.correction.status, 'corrected');
  assert.equal(result.correction.qrCodePayload, 'AH-ACTIVITY-1:uuid-1');
  assert.equal(harness.state.corrections.length, 1);
  assert.equal(harness.state.corrections[0].criteriaTemplateSnapshot[0].scale[0], DEFAULT_CRITERIA_SCALE[0]);
});

test('createCorrection prevents duplicate corrections for the same QR', async () => {
  const harness = createHarness();

  harness.state.corrections = [
    {
      _id: new mongoose.Types.ObjectId(),
      schoolId: new mongoose.Types.ObjectId(harness.ids.schoolId),
      classId: new mongoose.Types.ObjectId(harness.ids.classId),
      studentId: new mongoose.Types.ObjectId(harness.ids.studentId),
      correctedByUserId: new mongoose.Types.ObjectId(),
      activityPrintRunId: new mongoose.Types.ObjectId(harness.ids.printRunId),
      qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
      activityPageId: new mongoose.Types.ObjectId(harness.ids.pageId),
      activityBookId: new mongoose.Types.ObjectId(harness.ids.bookId),
      status: 'corrected',
      criteria: [],
      criteriaTemplateSnapshot: [],
      snapshot: {},
    },
  ];

  await assert.rejects(
    () => harness.service.createCorrection({
      schoolId: harness.ids.schoolId,
      actor: harness.actors.teacher,
      payload: {
        qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
        criteria: [
          { key: 'coordenacao_motora', value: 'realizou_com_apoio', note: '' },
        ],
      },
    }),
    (error) => error.code === 'ACTIVITY_CORRECTION_ALREADY_EXISTS'
  );
});

test('updateCorrection updates an existing correction', async () => {
  const harness = createHarness();

  const existingId = new mongoose.Types.ObjectId();
  harness.state.corrections = [
    {
      _id: existingId,
      schoolId: new mongoose.Types.ObjectId(harness.ids.schoolId),
      classId: new mongoose.Types.ObjectId(harness.ids.classId),
      studentId: new mongoose.Types.ObjectId(harness.ids.studentId),
      teacherId: new mongoose.Types.ObjectId(harness.ids.teacherId),
      correctedByUserId: new mongoose.Types.ObjectId(harness.actors.teacher.id),
      activityPrintRunId: new mongoose.Types.ObjectId(harness.ids.printRunId),
      qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
      activityPrintRunItemId: 'item-1',
      activityPageId: new mongoose.Types.ObjectId(harness.ids.pageId),
      activityBookId: new mongoose.Types.ObjectId(harness.ids.bookId),
      status: 'corrected',
      criteria: [{ key: 'coordenacao_motora', label: 'Coordenação motora', value: 'realizou_com_apoio', note: '' }],
      generalObservation: 'Antes',
      criteriaTemplateSnapshot: [{ key: 'coordenacao_motora', label: 'Coordenação motora', scale: DEFAULT_CRITERIA_SCALE }],
      snapshot: {},
    },
  ];

  const result = await harness.service.updateCorrection({
    schoolId: harness.ids.schoolId,
    actor: harness.actors.teacher,
    correctionId: String(existingId),
    payload: {
      criteria: [
        {
          key: 'coordenacao_motora',
          value: 'realizou_parcialmente',
          note: 'Evoluiu',
        },
      ],
      generalObservation: 'Depois',
    },
  });

  assert.equal(result.correction.generalObservation, 'Depois');
  assert.equal(result.correction.criteria[0].value, 'realizou_parcialmente');
});

test('resolveQr blocks professor without access to the class', async () => {
  const harness = createHarness({
    classAccessError: Object.assign(new Error('sem acesso'), { statusCode: 404 }),
  });

  await assert.rejects(
    () => harness.service.resolveQr({
      schoolId: harness.ids.schoolId,
      actor: harness.actors.teacher,
      qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
    }),
    (error) => error.code === 'ACTIVITY_CORRECTION_FORBIDDEN'
  );
});

test('privileged actors can resolve and list corrections', async () => {
  const harness = createHarness();

  harness.state.corrections = [
    {
      _id: new mongoose.Types.ObjectId(),
      schoolId: new mongoose.Types.ObjectId(harness.ids.schoolId),
      classId: new mongoose.Types.ObjectId(harness.ids.classId),
      studentId: new mongoose.Types.ObjectId(harness.ids.studentId),
      teacherId: new mongoose.Types.ObjectId(harness.ids.teacherId),
      correctedByUserId: new mongoose.Types.ObjectId(),
      activityPrintRunId: new mongoose.Types.ObjectId(harness.ids.printRunId),
      qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
      activityPageId: new mongoose.Types.ObjectId(harness.ids.pageId),
      activityBookId: new mongoose.Types.ObjectId(harness.ids.bookId),
      correctionDate: new Date('2026-06-08T12:00:00.000Z'),
      status: 'corrected',
      criteria: [],
      criteriaTemplateSnapshot: [],
      snapshot: { className: '1 B' },
    },
  ];

  const result = await harness.service.listCorrections({
    schoolId: harness.ids.schoolId,
    actor: harness.actors.admin,
    filters: {},
  });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].qrCodePayload, 'AH-ACTIVITY-1:uuid-1');
});

test('listCorrections filters by classId', async () => {
  const harness = createHarness();
  harness.state.corrections = [
    {
      _id: new mongoose.Types.ObjectId(),
      schoolId: new mongoose.Types.ObjectId(harness.ids.schoolId),
      classId: new mongoose.Types.ObjectId(harness.ids.classId),
      studentId: new mongoose.Types.ObjectId(harness.ids.studentId),
      teacherId: new mongoose.Types.ObjectId(harness.ids.teacherId),
      correctedByUserId: new mongoose.Types.ObjectId(),
      activityPrintRunId: new mongoose.Types.ObjectId(harness.ids.printRunId),
      qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
      activityPageId: new mongoose.Types.ObjectId(harness.ids.pageId),
      activityBookId: new mongoose.Types.ObjectId(harness.ids.bookId),
      correctionDate: new Date('2026-06-08T12:00:00.000Z'),
      status: 'corrected',
      criteria: [],
      criteriaTemplateSnapshot: [],
      snapshot: { className: '1 B' },
    },
  ];

  const result = await harness.service.listCorrections({
    schoolId: harness.ids.schoolId,
    actor: harness.actors.teacher,
    filters: { classId: harness.ids.classId },
  });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].classId, harness.ids.classId);
});

test('listPrintRunsForCorrection keeps pending and corrected sheets in one activity run', async () => {
  const harness = createHarness();
  harness.state.corrections = [
    {
      _id: new mongoose.Types.ObjectId(),
      schoolId: new mongoose.Types.ObjectId(harness.ids.schoolId),
      classId: new mongoose.Types.ObjectId(harness.ids.classId),
      studentId: new mongoose.Types.ObjectId(harness.ids.studentId),
      teacherId: new mongoose.Types.ObjectId(harness.ids.teacherId),
      correctedByUserId: new mongoose.Types.ObjectId(),
      activityPrintRunId: new mongoose.Types.ObjectId(harness.ids.printRunId),
      qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
      activityPageId: new mongoose.Types.ObjectId(harness.ids.pageId),
      activityBookId: new mongoose.Types.ObjectId(harness.ids.bookId),
      status: 'corrected',
      correctedAt: new Date('2026-06-09T12:00:00.000Z'),
    },
  ];

  const result = await harness.service.listPrintRunsForCorrection({
    schoolId: harness.ids.schoolId,
    actor: { ...harness.actors.teacher, id: harness.ids.teacherId },
    filters: {
      classId: harness.ids.classId,
      termId: harness.ids.termId,
    },
  });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].totalStudents, 2);
  assert.equal(result.items[0].pendingCount, 1);
  assert.equal(result.items[0].correctedCount, 1);
  assert.equal(result.items[0].students[0].status, 'corrected');
  assert.equal(result.items[0].students[1].status, 'pending');
});

test('listPrintRunsForCorrection does not cross academic terms or teachers', async () => {
  const harness = createHarness();

  const anotherTerm = String(new mongoose.Types.ObjectId());
  const otherTermResult = await harness.service.listPrintRunsForCorrection({
    schoolId: harness.ids.schoolId,
    actor: { ...harness.actors.teacher, id: harness.ids.teacherId },
    filters: { classId: harness.ids.classId, termId: anotherTerm },
  });
  assert.equal(otherTermResult.total, 0);

  const anotherTeacher = String(new mongoose.Types.ObjectId());
  const otherTeacherResult = await harness.service.listPrintRunsForCorrection({
    schoolId: harness.ids.schoolId,
    actor: { ...harness.actors.teacher, id: anotherTeacher },
    filters: { classId: harness.ids.classId, termId: harness.ids.termId },
  });
  assert.equal(otherTeacherResult.total, 0);
});

test('listStudentCorrections returns only corrections for the requested student', async () => {
  const harness = createHarness();
  harness.state.corrections = [
    {
      _id: new mongoose.Types.ObjectId(),
      schoolId: new mongoose.Types.ObjectId(harness.ids.schoolId),
      classId: new mongoose.Types.ObjectId(harness.ids.classId),
      studentId: new mongoose.Types.ObjectId(harness.ids.studentId),
      teacherId: new mongoose.Types.ObjectId(harness.ids.teacherId),
      correctedByUserId: new mongoose.Types.ObjectId(),
      activityPrintRunId: new mongoose.Types.ObjectId(harness.ids.printRunId),
      qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
      activityPageId: new mongoose.Types.ObjectId(harness.ids.pageId),
      activityBookId: new mongoose.Types.ObjectId(harness.ids.bookId),
      correctionDate: new Date('2026-06-08T12:00:00.000Z'),
      status: 'corrected',
      criteria: [],
      criteriaTemplateSnapshot: [],
      snapshot: {},
    },
  ];

  const result = await harness.service.listStudentCorrections({
    schoolId: harness.ids.schoolId,
    actor: harness.actors.teacher,
    studentId: harness.ids.studentId,
    filters: {},
  });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].studentId, harness.ids.studentId);
});

test('listPendingCorrections returns print items without a saved correction', async () => {
  const harness = createHarness();
  harness.state.corrections = [
    {
      _id: new mongoose.Types.ObjectId(),
      schoolId: new mongoose.Types.ObjectId(harness.ids.schoolId),
      classId: new mongoose.Types.ObjectId(harness.ids.classId),
      studentId: new mongoose.Types.ObjectId(harness.ids.studentId),
      teacherId: new mongoose.Types.ObjectId(harness.ids.teacherId),
      correctedByUserId: new mongoose.Types.ObjectId(),
      activityPrintRunId: new mongoose.Types.ObjectId(harness.ids.printRunId),
      qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
      activityPageId: new mongoose.Types.ObjectId(harness.ids.pageId),
      activityBookId: new mongoose.Types.ObjectId(harness.ids.bookId),
      correctionDate: new Date('2026-06-08T12:00:00.000Z'),
      status: 'corrected',
      criteria: [],
      criteriaTemplateSnapshot: [],
      snapshot: {},
    },
  ];

  const result = await harness.service.listPendingCorrections({
    schoolId: harness.ids.schoolId,
    actor: harness.actors.teacher,
    filters: {},
  });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].qrCodePayload, 'AH-ACTIVITY-1:uuid-2');
});

test('student actors are forbidden from using activity corrections', async () => {
  const harness = createHarness();

  await assert.rejects(
    () => harness.service.listCorrections({
      schoolId: harness.ids.schoolId,
      actor: harness.actors.student,
      filters: {},
    }),
    (error) => error.code === 'ACTIVITY_CORRECTION_FORBIDDEN'
  );
});
