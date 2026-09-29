const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  ActivityPrintService,
} = require('../../api/services/activityPrint.service');

function createQuery(value) {
  return {
    select() { return this; },
    populate() { return this; },
    sort() { return this; },
    lean() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function sameId(left, right) {
  return String(left) === String(right);
}

function createHarness(overrides = {}) {
  const schoolId = new mongoose.Types.ObjectId();
  const bookId = new mongoose.Types.ObjectId();
  const pageId = new mongoose.Types.ObjectId();
  const classId = new mongoose.Types.ObjectId();
  const teacherId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();
  const studentA = new mongoose.Types.ObjectId();
  const studentB = new mongoose.Types.ObjectId();
  const state = {
    uploads: [],
    savedRuns: [],
    saveHistory: [],
    generatedPdfCalls: 0,
  };

  class FakeActivityPrintRunModel {
    constructor(data = {}) {
      Object.assign(this, data);
      this._id = data._id || new mongoose.Types.ObjectId();
    }

    async save() {
      const plain = JSON.parse(JSON.stringify(this));
      state.saveHistory.push(plain);
      const index = state.savedRuns.findIndex((item) => sameId(item._id, this._id));
      if (index >= 0) state.savedRuns[index] = plain;
      else state.savedRuns.push(plain);
      return this;
    }
  }

  const page = {
    _id: pageId,
    bookId,
    pageNumber: 1,
    title: 'Pagina 01',
    subject: 'Portugues',
    enabled: true,
    printable: true,
    pageType: 'activity',
    status: 'published',
    headerOverlay: { xPct: 2, yPct: 2, widthPct: 96, heightPct: 18 },
    contentCrop: { xPct: 4, yPct: 18, widthPct: 92, heightPct: 70 },
    footerCrop: { xPct: 4, yPct: 92, widthPct: 92, heightPct: 6 },
    printLayout: { mode: 'crop-and-recompose', academyHeaderHeightPct: 18, preserveFooter: true, scaleMode: 'fit-width' },
  };

  const book = {
    _id: bookId,
    title: 'Caderno',
    subject: 'Portugues',
    originalPdfKey: 'platform/activity-books/book/original.pdf',
    status: 'published',
    visibility: 'global',
    allowedSchoolIds: [],
  };

  const school = {
    _id: schoolId,
    name: 'Escola Teste',
    logo: null,
  };

  const classDoc = {
    _id: classId,
    name: '3 B',
    school_id: schoolId,
    schoolYear: 2026,
  };

  const schoolYear = {
    _id: new mongoose.Types.ObjectId(),
    school_id: schoolId,
    year: 2026,
  };

  const term = {
    _id: new mongoose.Types.ObjectId(),
    school_id: schoolId,
    anoLetivoId: schoolYear._id,
    titulo: '2º Bimestre',
    tipo: 'Letivo',
    dataInicio: new Date('2026-04-01T00:00:00.000Z'),
    dataFim: new Date('2026-06-30T23:59:59.999Z'),
  };

  const teacher = {
    _id: teacherId,
    fullName: 'Edicelia',
    school_id: schoolId,
    status: 'Ativo',
  };

  const students = [
    { _id: studentA, fullName: 'Milena Brandao', school_id: schoolId },
    { _id: studentB, fullName: 'Joao Pedro', school_id: schoolId },
  ];

  const actor = {
    id: String(actorId),
    school_id: String(schoolId),
    roles: ['Professor'],
  };

  const service = new ActivityPrintService({
    ActivityPageModel: {
      findById(id) {
        return createQuery(sameId(id, pageId) ? { ...page, ...overrides.page } : null);
      },
    },
    ActivityBookModel: {
      findById(id) {
        return createQuery(sameId(id, bookId) ? { ...book, ...overrides.book } : null);
      },
    },
    ClassModelRef: {
      findOne(filter = {}) {
        const matchesClass = sameId(filter._id, classId);
        const matchesSchool = sameId(filter.school_id, schoolId);
        return createQuery(matchesClass && matchesSchool ? { ...classDoc, ...overrides.classDoc } : null);
      },
    },
    ActivityPrintRunModel: FakeActivityPrintRunModel,
    EnrollmentModel: {
      find(filter = {}) {
        const requestedIds = Array.isArray(filter.student?.$in) ? filter.student.$in.map(String) : [];
        const records = students
          .filter((student) => requestedIds.includes(String(student._id)))
          .map((student) => ({
            _id: new mongoose.Types.ObjectId(),
            school_id: schoolId,
            class: classId,
            student,
            status: 'Ativa',
          }));

        const finalRecords = overrides.enrollments || records;
        return {
          populate() { return this; },
          lean() { return Promise.resolve(finalRecords); },
          then(resolve, reject) { return Promise.resolve(finalRecords).then(resolve, reject); },
        };
      },
    },
    SchoolYearModel: {
      findOne(filter = {}) {
        const matches = sameId(filter.school_id, schoolId) && Number(filter.year) === 2026;
        return createQuery(matches ? { ...schoolYear } : null);
      },
    },
    PeriodoModel: {
      findOne(filter = {}) {
        const matchesSchool = sameId(filter.school_id, schoolId);
        const matchesYear = sameId(filter.anoLetivoId, schoolYear._id);
        const matchesType = filter.tipo === 'Letivo';
        const matchesRequested = !filter._id || sameId(filter._id, term._id);
        return createQuery(matchesSchool && matchesYear && matchesType && matchesRequested ? { ...term } : null);
      },
    },
    SchoolModel: {
      findById(id) {
        return createQuery(sameId(id, schoolId) ? { ...school, ...overrides.school } : null);
      },
    },
    UserModel: {
      findOne(filter = {}) {
        if (sameId(filter._id, actorId)) return createQuery({ ...teacher, _id: actorId, ...overrides.actorTeacher });
        if (sameId(filter._id, teacherId)) return createQuery({ ...teacher, ...overrides.teacher });
        return createQuery(null);
      },
    },
    activityPdfServiceRef: {
      async generateActivityPrintPdf(input) {
        state.generatedPdfCalls += 1;
        state.lastPdfInput = input;
        return overrides.generatedPdfBuffer || Buffer.from('%PDF-generated');
      },
    },
    r2StorageServiceRef: {
      async downloadBuffer() {
        if (overrides.downloadError) throw overrides.downloadError;
        return Buffer.from('%PDF-original');
      },
      async uploadBuffer(input) {
        if (overrides.uploadError) throw overrides.uploadError;
        state.uploads.push(input);
        return { key: input.key };
      },
      async getSignedDownloadUrl(key) {
        return { key, url: 'https://signed-url.example/test.pdf' };
      },
    },
    ensureClassAccessFn: async () => {
      if (overrides.classError) throw overrides.classError;
      return { ...classDoc, ...overrides.classDoc };
    },
    parseBusinessDateInputFn: () => overrides.printDate || new Date('2026-06-04T12:00:00.000Z'),
  });

  return {
    actor,
    service,
    state,
    ids: {
      schoolId: String(schoolId),
      pageId: String(pageId),
      classId: String(classId),
      teacherId: String(teacherId),
      termId: String(term._id),
      schoolYearId: String(schoolYear._id),
      studentA: String(studentA),
      studentB: String(studentB),
    },
  };
}

test('createPrintRun generates one opaque QR per student and saves PDF to R2', async () => {
  const harness = createHarness();

  const result = await harness.service.createPrintRun({
    activityPageId: harness.ids.pageId,
    actor: harness.actor,
    payload: {
      classId: harness.ids.classId,
      studentIds: [harness.ids.studentA, harness.ids.studentB, harness.ids.studentA],
      printDate: '2026-06-04',
    },
  });

  assert.equal(result.printRun.status, 'generated');
  assert.equal(result.printRun.studentCount, 2);
  assert.equal(harness.state.generatedPdfCalls, 1);
  assert.equal(harness.state.uploads.length, 1);
  assert.match(harness.state.uploads[0].key, /schools\/.*\/generated-activities\/.*\.pdf$/);
  assert.equal(harness.state.saveHistory[0].status, 'pending');
  assert.equal(harness.state.savedRuns[0].status, 'generated');
  assert.equal(harness.state.savedRuns[0].items.length, 2);
  assert.equal(String(harness.state.savedRuns[0].termId), harness.ids.termId);
  assert.equal(String(harness.state.savedRuns[0].academicYearId), harness.ids.schoolYearId);
  assert.equal(harness.state.savedRuns[0].items[0].qrCodePayload.startsWith('AH-ACTIVITY-1:'), true);
  assert.notEqual(
    harness.state.savedRuns[0].items[0].qrCodePayload,
    harness.state.savedRuns[0].items[1].qrCodePayload
  );
});

test('createPrintRun rejects activity page not published', async () => {
  const harness = createHarness({
    page: { status: 'draft' },
  });

  await assert.rejects(
    () => harness.service.createPrintRun({
      activityPageId: harness.ids.pageId,
      actor: harness.actor,
      payload: {
        classId: harness.ids.classId,
        studentIds: [harness.ids.studentA],
        printDate: '2026-06-04',
      },
    }),
    (error) => error.code === 'ACTIVITY_NOT_PUBLISHED'
  );
});

test('createPrintRun rejects pageType different from activity', async () => {
  const harness = createHarness({
    page: { pageType: 'support' },
  });

  await assert.rejects(
    () => harness.service.createPrintRun({
      activityPageId: harness.ids.pageId,
      actor: harness.actor,
      payload: {
        classId: harness.ids.classId,
        studentIds: [harness.ids.studentA],
        printDate: '2026-06-04',
      },
    }),
    (error) => error.code === 'ACTIVITY_PAGE_NOT_PRINTABLE'
  );
});

test('createPrintRun rejects printable=false', async () => {
  const harness = createHarness({
    page: { printable: false },
  });

  await assert.rejects(
    () => harness.service.createPrintRun({
      activityPageId: harness.ids.pageId,
      actor: harness.actor,
      payload: {
        classId: harness.ids.classId,
        studentIds: [harness.ids.studentA],
        printDate: '2026-06-04',
      },
    }),
    (error) => error.code === 'ACTIVITY_PAGE_NOT_PRINTABLE'
  );
});

test('createPrintRun rejects class from another school/access error', async () => {
  const harness = createHarness({
    classError: { message: 'Turma nao encontrada.', statusCode: 404 },
  });

  await assert.rejects(
    () => harness.service.createPrintRun({
      activityPageId: harness.ids.pageId,
      actor: harness.actor,
      payload: {
        classId: harness.ids.classId,
        studentIds: [harness.ids.studentA],
        printDate: '2026-06-04',
      },
    }),
    (error) => error.code === 'INVALID_CLASS'
  );
});

test('createPrintRun rejects students from another school/class', async () => {
  const harness = createHarness();
  harness.service.EnrollmentModel.find = () => ({
    populate() { return this; },
    lean() {
      return Promise.resolve([
        {
          _id: new mongoose.Types.ObjectId(),
          class: harness.ids.classId,
          student: { _id: harness.ids.studentA, fullName: 'Milena Brandao' },
          status: 'Ativa',
        },
      ]);
    },
    then(resolve, reject) {
      return this.lean().then(resolve, reject);
    },
  });

  await assert.rejects(
    () => harness.service.createPrintRun({
      activityPageId: harness.ids.pageId,
      actor: harness.actor,
      payload: {
        classId: harness.ids.classId,
        studentIds: [harness.ids.studentA, harness.ids.studentB],
        printDate: '2026-06-04',
      },
    }),
    (error) => error.code === 'INVALID_STUDENTS'
  );
});

test('createPrintRun marks print run as failed when R2 upload fails', async () => {
  const harness = createHarness({
    uploadError: new Error('upload failed'),
  });

  await assert.rejects(
    () => harness.service.createPrintRun({
      activityPageId: harness.ids.pageId,
      actor: harness.actor,
      payload: {
        classId: harness.ids.classId,
        studentIds: [harness.ids.studentA],
        printDate: '2026-06-04',
      },
    }),
    (error) => error.code === 'R2_UPLOAD_FAILED'
  );

  assert.equal(harness.state.saveHistory[0].status, 'pending');
  assert.equal(harness.state.savedRuns[0].status, 'failed');
});

test('createPlatformPrintTestRun reuses the same print pipeline for platform context', async () => {
  const harness = createHarness();
  const platformAdminId = new mongoose.Types.ObjectId();

  const result = await harness.service.createPlatformPrintTestRun({
    schoolId: harness.ids.schoolId,
    activityPageId: harness.ids.pageId,
    platformAdmin: {
      id: String(platformAdminId),
      role: 'superAdmin',
    },
    payload: {
      classId: harness.ids.classId,
      studentIds: [harness.ids.studentA, harness.ids.studentB],
      teacherId: harness.ids.teacherId,
      printDate: '2026-06-04',
    },
  });

  assert.equal(result.printRun.status, 'generated');
  assert.equal(result.printRun.studentCount, 2);
  assert.equal(harness.state.generatedPdfCalls, 1);
  assert.equal(harness.state.savedRuns[0].requestedByUserId, null);
  assert.equal(
    String(harness.state.savedRuns[0].requestedByPlatformAdminId),
    String(platformAdminId)
  );
});

test('createPlatformPrintTestRun rejects class from another school', async () => {
  const harness = createHarness({
    classDoc: null,
  });

  harness.service.ClassModel.findOne = () => createQuery(null);

  await assert.rejects(
    () => harness.service.createPlatformPrintTestRun({
      schoolId: harness.ids.schoolId,
      activityPageId: harness.ids.pageId,
      platformAdmin: {
        id: String(new mongoose.Types.ObjectId()),
        role: 'superAdmin',
      },
      payload: {
        classId: harness.ids.classId,
        studentIds: [harness.ids.studentA],
        printDate: '2026-06-04',
      },
    }),
    (error) => error.code === 'INVALID_CLASS'
  );
});

test('createPlatformPrintTestRun rejects teacher from another school', async () => {
  const harness = createHarness();
  harness.service.UserModel.findOne = (filter = {}) => {
    if (sameId(filter._id, harness.ids.teacherId)) return createQuery(null);
    return createQuery(null);
  };

  await assert.rejects(
    () => harness.service.createPlatformPrintTestRun({
      schoolId: harness.ids.schoolId,
      activityPageId: harness.ids.pageId,
      platformAdmin: {
        id: String(new mongoose.Types.ObjectId()),
        role: 'superAdmin',
      },
      payload: {
        classId: harness.ids.classId,
        studentIds: [harness.ids.studentA],
        teacherId: harness.ids.teacherId,
        printDate: '2026-06-04',
      },
    }),
    (error) => error.code === 'INVALID_TEACHER'
  );
});
