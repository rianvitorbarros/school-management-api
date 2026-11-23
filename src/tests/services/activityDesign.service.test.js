const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  ActivityDesignService,
  sanitizePages,
  detectImageContentType,
} = require('../../api/services/activityDesign.service');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

function createHarness() {
  const schoolId = new mongoose.Types.ObjectId();
  const teacherId = new mongoose.Types.ObjectId();
  const otherTeacherId = new mongoose.Types.ObjectId();
  const state = {
    designs: [],
    books: [],
    pages: [],
    uploads: [],
    deletedKeys: [],
    mediaCreated: [],
    library: [],
  };

  class FakeActivityDesign {
    constructor(data = {}) {
      Object.assign(this, JSON.parse(JSON.stringify(data)));
      this._id = data._id || new mongoose.Types.ObjectId();
    }

    async save() {
      const index = state.designs.findIndex((item) => String(item._id) === String(this._id));
      if (index >= 0) state.designs[index] = this;
      else state.designs.push(this);
      return this;
    }

    markModified() {}

    static async findOne(query) {
      return state.designs.find((item) => String(item._id) === String(query._id)
        && String(item.schoolId) === String(query.schoolId)) || null;
    }
  }

  class FakeActivityBook {
    constructor(data = {}) {
      Object.assign(this, data);
      this._id = data._id || new mongoose.Types.ObjectId();
    }

    async save() {
      return this;
    }

    static async create(data) {
      const book = new FakeActivityBook(data);
      state.books.push(book);
      return book;
    }

    static async findOne(query) {
      return state.books.find((item) => String(item._id) === String(query._id)) || null;
    }

    static async updateOne(query, update) {
      const book = state.books.find((item) => String(item._id) === String(query._id));
      if (book) Object.assign(book, update.$set);
      return { modifiedCount: book ? 1 : 0 };
    }
  }

  const FakeActivityPage = {
    async findOneAndUpdate(query, update) {
      let page = state.pages.find((item) => String(item.bookId) === String(query.bookId)
        && item.pageNumber === query.pageNumber);
      if (!page) {
        page = { _id: new mongoose.Types.ObjectId(), bookId: query.bookId, pageNumber: query.pageNumber };
        state.pages.push(page);
      }
      Object.assign(page, update.$set);
      return page;
    },
    async updateMany(query, update) {
      state.pages
        .filter((item) => String(item.bookId) === String(query.bookId) && item.pageNumber > query.pageNumber.$gt)
        .forEach((item) => Object.assign(item, update.$set));
    },
    find(query) {
      const result = state.pages
        .filter((item) => String(item.bookId) === String(query.bookId) && item.enabled === true)
        .sort((a, b) => a.pageNumber - b.pageNumber);
      return {
        select() { return this; },
        sort() { return this; },
        lean() { return Promise.resolve(result); },
      };
    },
  };

  const r2StorageService = {
    async uploadBuffer({ key, buffer, contentType }) {
      state.uploads.push({ key, size: buffer.length, contentType });
      return { key };
    },
    async downloadBuffer() {
      return PNG_BYTES;
    },
    async deleteObjects(keys) {
      state.deletedKeys.push(...keys);
    },
    async getSignedDownloadUrl(key) {
      return { url: `https://signed/${key}` };
    },
  };

  const mediaAssetService = {
    async createFromUpload(actor, file, body) {
      const _id = new mongoose.Types.ObjectId();
      const key = `schools/${actor.school_id}/media/${_id}.png`;
      state.uploads.push({ key, size: file.buffer.length, contentType: 'image/png' });
      state.mediaCreated.push({ _id, key, visibility: body.visibility });
      return { asset: { _id, key, contentType: 'image/png' } };
    },
    async getForUse(id) {
      const media = state.library.find((item) => String(item._id) === String(id));
      if (!media) {
        const error = new Error('Imagem nao encontrada.');
        error.status = 404;
        throw error;
      }
      return media;
    },
  };

  const service = new ActivityDesignService({
    mediaAssetService,
    ActivityDesign: FakeActivityDesign,
    ActivityBook: FakeActivityBook,
    ActivityPage: FakeActivityPage,
    r2StorageService,
    thumbnailMaker: async () => ({ buffer: PNG_BYTES, width: 600, height: 848 }),
  });

  const teacher = { id: String(teacherId), school_id: String(schoolId), role: 'professor' };
  const otherTeacher = { id: String(otherTeacherId), school_id: String(schoolId), role: 'professor' };
  const manager = { id: String(new mongoose.Types.ObjectId()), school_id: String(schoolId), role: 'coordenador' };

  return { service, state, schoolId, teacher, otherTeacher, manager };
}

function textElement(id, overrides = {}) {
  return {
    id,
    type: 'text',
    x: 10,
    y: 5,
    w: 80,
    h: 8,
    rotation: 0,
    props: { text: 'Conte os elementos', fontSize: 18 },
    ...overrides,
  };
}

test('detectImageContentType identifica PNG e JPG pelos bytes', () => {
  assert.equal(detectImageContentType(PNG_BYTES), 'image/png');
  assert.equal(detectImageContentType(JPG_BYTES), 'image/jpeg');
  assert.equal(detectImageContentType(Buffer.from('nao e imagem')), '');
});

test('sanitizePages valida tipo, geometria e imagem sem arquivo', () => {
  const pages = sanitizePages([{ pageKey: 'p1', elements: [textElement('a', { rotation: -90 })] }], { assetIds: new Set() });
  assert.equal(pages[0].elements[0].rotation, 270);
  assert.equal(pages[0].background, '#FFFFFF');

  assert.throws(
    () => sanitizePages([{ pageKey: 'p1', elements: [textElement('a', { type: 'video' })] }], { assetIds: new Set() }),
    (error) => error.code === 'INVALID_DESIGN_ELEMENT_TYPE'
  );
  assert.throws(
    () => sanitizePages([{ pageKey: 'p1', elements: [textElement('a', { w: 0 })] }], { assetIds: new Set() }),
    (error) => error.code === 'INVALID_DESIGN_GEOMETRY'
  );
  assert.throws(
    () => sanitizePages([{
      pageKey: 'p1',
      elements: [{ ...textElement('img'), type: 'image', props: { assetId: 'nao-existe' } }],
    }], { assetIds: new Set() }),
    (error) => error.code === 'INVALID_DESIGN_ASSET'
  );
  assert.throws(
    () => sanitizePages([], { assetIds: new Set() }),
    (error) => error.code === 'INVALID_DESIGN_PAGES'
  );
  assert.throws(
    () => sanitizePages([{ pageKey: 'p1', elements: [textElement('a'), textElement('a')] }], { assetIds: new Set() }),
    (error) => error.code === 'INVALID_DESIGN_ELEMENT'
  );
});

test('sanitizePages aceita icone do pacote embutido sem arquivo e recusa icone inexistente', () => {
  const pages = sanitizePages([{
    pageKey: 'p1',
    elements: [{ ...textElement('ico'), type: 'image', props: { iconId: 'elephant', fit: 'contain' } }],
  }], { assetIds: new Set() });
  assert.equal(pages[0].elements[0].props.iconId, 'elephant');

  assert.throws(
    () => sanitizePages([{
      pageKey: 'p1',
      elements: [{ ...textElement('ico'), type: 'image', props: { iconId: 'nao-existe' } }],
    }], { assetIds: new Set() }),
    (error) => error.code === 'INVALID_DESIGN_ICON'
  );
  assert.throws(
    () => sanitizePages([{
      pageKey: 'p1',
      elements: [{ ...textElement('img'), type: 'image', props: {} }],
    }], { assetIds: new Set() }),
    (error) => error.code === 'INVALID_DESIGN_ASSET'
  );
});

test('createDesign comeca com uma pagina em branco e cabecalho reservado', async () => {
  const { service, teacher } = createHarness();
  const design = await service.createDesign(teacher, { title: 'Avaliacao de Matematica', subject: 'Matematica' });

  assert.equal(design.title, 'Avaliacao de Matematica');
  assert.equal(design.pages.length, 1);
  assert.equal(design.pages[0].elements.length, 0);
  assert.equal(design.headerHeightPct, 13);
  assert.equal(design.status, 'draft');
  assert.equal(design.revision, 0);
});

test('updateDesign incrementa revisao e recusa revisao desatualizada', async () => {
  const { service, teacher } = createHarness();
  const created = await service.createDesign(teacher, { title: 'Atividade' });

  const updated = await service.updateDesign(created.id, teacher, {
    revision: 0,
    pages: [{ pageKey: created.pages[0].pageKey, elements: [textElement('t1')] }],
  });
  assert.equal(updated.revision, 1);
  assert.equal(updated.pages[0].elements[0].props.text, 'Conte os elementos');

  await assert.rejects(
    service.updateDesign(created.id, teacher, { revision: 0, title: 'Outra' }),
    (error) => error.status === 409 && error.code === 'DESIGN_REVISION_CONFLICT'
  );
});

test('outro professor nao acessa, gestor acessa', async () => {
  const { service, teacher, otherTeacher, manager } = createHarness();
  const created = await service.createDesign(teacher, { title: 'Atividade' });

  await assert.rejects(
    service.getDesign(created.id, otherTeacher),
    (error) => error.status === 403
  );
  const viewed = await service.getDesign(created.id, manager);
  assert.equal(viewed.id, created.id);
});

test('uploadAsset aceita PNG e recusa arquivo que nao e imagem', async () => {
  const { service, state, teacher } = createHarness();
  const created = await service.createDesign(teacher, { title: 'Atividade' });

  const asset = await service.uploadAsset(created.id, teacher, { buffer: PNG_BYTES, originalname: 'elefante.png' });
  assert.equal(asset.contentType, 'image/png');
  assert.match(state.uploads[0].key, /^schools\/.+\/media\/.+\.png$/);
  assert.equal(state.mediaCreated[0].visibility, 'private', 'upload vai para o acervo privado do professor');
  assert.ok(asset.mediaAssetId);

  await assert.rejects(
    service.uploadAsset(created.id, teacher, { buffer: Buffer.from('<html>oi</html>'), originalname: 'x.png' }),
    (error) => error.code === 'DESIGN_ASSET_INVALID_TYPE'
  );

  const withImage = await service.updateDesign(created.id, teacher, {
    pages: [{
      pageKey: created.pages[0].pageKey,
      elements: [{ ...textElement('img'), type: 'image', props: { assetId: asset.assetId } }],
    }],
  });
  assert.equal(withImage.pages[0].elements[0].type, 'image');
});

test('publishDesign cria caderno da escola com paginas de imagem e cabecalho do design', async () => {
  const { service, state, teacher, schoolId } = createHarness();
  const created = await service.createDesign(teacher, { title: 'Avaliacao de Matematica', subject: 'Matematica' });
  const saved = await service.updateDesign(created.id, teacher, {
    pages: [
      { pageKey: 'p1', elements: [textElement('t1')] },
      { pageKey: 'p2', elements: [] },
    ],
  });

  const result = await service.publishDesign(created.id, teacher, {
    revision: saved.revision,
    files: [{ buffer: PNG_BYTES }, { buffer: JPG_BYTES }],
  });

  assert.equal(state.books.length, 1);
  const book = state.books[0];
  assert.equal(book.sourceType, 'school');
  assert.equal(book.visibility, 'restricted');
  assert.equal(book.status, 'published');
  assert.deepEqual(book.allowedSchoolIds.map(String), [String(schoolId)]);
  assert.equal(book.defaultHeaderOverlay.heightPct, 13);
  assert.equal(String(book.createdByUserId), teacher.id);

  assert.equal(state.pages.length, 2);
  assert.equal(state.pages[0].sourceKind, 'image');
  assert.equal(state.pages[0].status, 'published');
  assert.equal(state.pages[0].subject, 'Matematica');
  assert.equal(state.pages[1].sourceImageContentType, 'image/jpeg');
  assert.equal(state.pages[0].headerOverlay.heightPct, 13);

  assert.equal(result.activityPageIds.length, 2);
  assert.equal(result.design.status, 'published');
  assert.equal(result.design.hasUnpublishedChanges, false);
  // 2 paginas x (imagem + miniatura)
  assert.equal(state.uploads.length, 4);
});

test('republicar com menos paginas desativa as paginas que sairam e limpa imagens antigas', async () => {
  const { service, state, teacher } = createHarness();
  const created = await service.createDesign(teacher, { title: 'Atividade' });
  let saved = await service.updateDesign(created.id, teacher, {
    pages: [{ pageKey: 'p1', elements: [] }, { pageKey: 'p2', elements: [] }],
  });
  await service.publishDesign(created.id, teacher, { revision: saved.revision, files: [{ buffer: PNG_BYTES }, { buffer: PNG_BYTES }] });

  saved = await service.updateDesign(created.id, teacher, { pages: [{ pageKey: 'p1', elements: [textElement('t')] }] });
  assert.equal(saved.hasUnpublishedChanges, true);

  const result = await service.publishDesign(created.id, teacher, { revision: saved.revision, files: [{ buffer: PNG_BYTES }] });

  assert.equal(state.books.length, 1, 'reaproveita o mesmo caderno');
  assert.equal(state.pages.find((page) => page.pageNumber === 2).enabled, false);
  assert.equal(result.activityPageIds.length, 1);
  assert.ok(state.deletedKeys.length >= 2, 'remove as imagens da publicacao anterior');
});

test('publishDesign exige uma imagem por pagina e revisao atual', async () => {
  const { service, teacher } = createHarness();
  const created = await service.createDesign(teacher, { title: 'Atividade' });

  await assert.rejects(
    service.publishDesign(created.id, teacher, { revision: 0, files: [] }),
    (error) => error.code === 'DESIGN_RENDER_COUNT_MISMATCH'
  );
  await assert.rejects(
    service.publishDesign(created.id, teacher, { revision: 5, files: [{ buffer: PNG_BYTES }] }),
    (error) => error.code === 'DESIGN_REVISION_CONFLICT'
  );
  await assert.rejects(
    service.publishDesign(created.id, teacher, { revision: 0, files: [{ buffer: Buffer.from('texto qualquer') }] }),
    (error) => error.code === 'DESIGN_RENDER_INVALID'
  );
});

test('archiveDesign arquiva o caderno publicado', async () => {
  const { service, state, teacher } = createHarness();
  const created = await service.createDesign(teacher, { title: 'Atividade' });
  await service.publishDesign(created.id, teacher, { revision: 0, files: [{ buffer: PNG_BYTES }] });

  await service.archiveDesign(created.id, teacher);
  assert.equal(state.books[0].status, 'archived');
  await assert.rejects(
    service.updateDesign(created.id, teacher, { title: 'x' }),
    (error) => error.status === 404
  );
});

test('attachLibraryAsset reaproveita a imagem do acervo sem reenviar e nao duplica', async () => {
  const { service, state, teacher } = createHarness();
  const created = await service.createDesign(teacher, { title: 'Atividade' });
  const mediaId = new mongoose.Types.ObjectId();
  state.library.push({ _id: mediaId, key: 'schools/x/media/abc.png', contentType: 'image/png', title: 'Elefante', size: 10 });

  const first = await service.attachLibraryAsset(created.id, teacher, String(mediaId));
  const second = await service.attachLibraryAsset(created.id, teacher, String(mediaId));
  assert.equal(first.assetId, second.assetId);
  assert.equal(state.uploads.length, 0);

  const design = await service.getDesign(created.id, teacher);
  assert.equal(design.assets.length, 1);
  assert.equal(design.assets[0].mediaAssetId, String(mediaId));

  await assert.rejects(
    service.attachLibraryAsset(created.id, teacher, String(new mongoose.Types.ObjectId())),
    (error) => error.status === 404
  );
});

test('publishDesign publica so as paginas escolhidas, na ordem do design', async () => {
  const { service, state, teacher } = createHarness();
  const created = await service.createDesign(teacher, { title: 'Importada' });
  const saved = await service.updateDesign(created.id, teacher, {
    pages: [
      { pageKey: 'p1', elements: [] },
      { pageKey: 'p2', elements: [textElement('t2')] },
      { pageKey: 'p3', elements: [] },
    ],
  });

  const result = await service.publishDesign(created.id, teacher, {
    revision: saved.revision,
    pageKeys: JSON.stringify(['p3', 'p1']),
    files: [{ buffer: PNG_BYTES }, { buffer: JPG_BYTES }],
  });

  assert.equal(state.books[0].totalPages, 2);
  assert.equal(result.activityPageIds.length, 2);
  assert.deepEqual(result.design.publishedPageKeys, ['p1', 'p3']);
  assert.equal(result.design.pages.length, 3, 'o design continua com todas as paginas');
  assert.equal(result.design.pages[1].hasRenderedImage, false);
  assert.equal(state.pages.find((page) => page.pageNumber === 2).sourceImageContentType, 'image/jpeg');

  await assert.rejects(
    service.publishDesign(created.id, teacher, {
      revision: saved.revision,
      pageKeys: ['x'],
      files: [{ buffer: PNG_BYTES }],
    }),
    (error) => error.code === 'INVALID_PUBLISH_PAGES'
  );
  await assert.rejects(
    service.publishDesign(created.id, teacher, {
      revision: saved.revision,
      pageKeys: ['p1', 'p2'],
      files: [{ buffer: PNG_BYTES }],
    }),
    (error) => error.code === 'DESIGN_RENDER_COUNT_MISMATCH'
  );

  // Publicar tudo de novo limpa a escolha.
  const all = await service.publishDesign(created.id, teacher, {
    revision: saved.revision,
    files: [{ buffer: PNG_BYTES }, { buffer: PNG_BYTES }, { buffer: PNG_BYTES }],
  });
  assert.deepEqual(all.design.publishedPageKeys, []);
});

test('duplicateDesign com classId importa para outra turma com o mesmo titulo', async () => {
  const { service, teacher } = createHarness();
  const created = await service.createDesign(teacher, {
    title: 'Cores primarias',
    classId: '64b000000000000000000001',
  });
  await service.updateDesign(created.id, teacher, {
    pages: [{ pageKey: 'p1', elements: [textElement('t')] }, { pageKey: 'p2', elements: [] }],
  });

  const imported = await service.duplicateDesign(created.id, teacher, { classId: '64b000000000000000000002' });
  assert.equal(imported.title, 'Cores primarias');
  assert.equal(imported.classId, '64b000000000000000000002');
  assert.equal(imported.importedFromDesignId, created.id);
  assert.equal(imported.status, 'draft');
  assert.equal(imported.pages.length, 2);

  const copy = await service.duplicateDesign(created.id, teacher);
  assert.equal(copy.title, 'Cores primarias (copia)');
  assert.equal(copy.classId, '64b000000000000000000001');

  await assert.rejects(
    service.duplicateDesign(created.id, teacher, { classId: 'nao-e-id' }),
    (error) => error.code === 'INVALID_CLASS_ID'
  );
});

test('avaliacao Canva: cria a prova de notas uma vez e repassa o lancamento', async () => {
  const calls = { create: [], update: [], save: [] };
  const examId = new mongoose.Types.ObjectId();
  const fakeExamService = {
    async createExam(data) { calls.create.push(data); return { _id: examId }; },
    async updateExam(id, data) { calls.update.push([id, data]); return { _id: examId }; },
    async getDirectGrades(id) { return { examId: id, maxScore: 10, students: [] }; },
    async saveDirectGrades(id, _school, grades) { calls.save.push([id, grades]); return { saved: grades.length }; },
  };
  const { service, teacher } = createHarness();
  service.examServiceOverride = fakeExamService;
  const subjectId = String(new mongoose.Types.ObjectId());

  const activity = await service.createDesign(teacher, { title: 'Atividade', classId: '64b000000000000000000001' });
  await assert.rejects(
    service.ensureAssessmentExam(activity.id, teacher, { subjectId }),
    (error) => error.code === 'DESIGN_NOT_ASSESSMENT'
  );

  const created = await service.createDesign(teacher, {
    title: 'Avaliacao das cores',
    purpose: 'assessment',
    maxScore: 7,
    classId: '64b000000000000000000001',
  });
  assert.equal(created.purpose, 'assessment');
  assert.equal(created.maxScore, 7);

  await assert.rejects(
    service.saveAssessmentGrades(created.id, teacher, { grades: [] }),
    (error) => error.code === 'ASSESSMENT_EXAM_REQUIRED'
  );
  await assert.rejects(
    service.ensureAssessmentExam(created.id, teacher, {}),
    (error) => error.code === 'SUBJECT_REQUIRED'
  );

  const first = await service.ensureAssessmentExam(created.id, teacher, { subjectId });
  assert.equal(first.examId, String(examId));
  assert.equal(first.design.examId, String(examId));
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].correctionType, 'DIRECT_GRADE');
  assert.equal(calls.create[0].totalValue, 7);
  assert.equal(String(calls.create[0].activityDesignId), created.id);

  await service.ensureAssessmentExam(created.id, teacher, { subjectId, maxScore: 10 });
  assert.equal(calls.create.length, 1, 'nao cria outra prova');
  assert.equal(calls.update[0][1].totalValue, 10);

  const grades = [{ studentId: 's1', grade: 9 }];
  await service.saveAssessmentGrades(created.id, teacher, { grades });
  assert.deepEqual(calls.save[0], [String(examId), grades]);

  const copy = await service.duplicateDesign(created.id, teacher, { classId: '64b000000000000000000002' });
  assert.equal(copy.purpose, 'assessment');
  assert.equal(copy.examId, null, 'a copia ganha a propria prova de notas');
});

test('trocar so o tipo nao marca alteracoes a publicar', async () => {
  const { service, teacher } = createHarness();
  const created = await service.createDesign(teacher, { title: 'A' });
  const saved = await service.updateDesign(created.id, teacher, { pages: [{ pageKey: 'p1', elements: [] }] });
  await service.publishDesign(created.id, teacher, { revision: saved.revision, files: [{ buffer: PNG_BYTES }] });
  const changed = await service.updateDesign(created.id, teacher, { purpose: 'assessment' });
  assert.equal(changed.purpose, 'assessment');
  assert.equal(changed.revision, saved.revision);
  assert.equal(changed.hasUnpublishedChanges, false);
});

test('importar atividade compartilhada por outro professor: copia vira de quem importou', async () => {
  const { service, teacher, otherTeacher } = createHarness();
  const created = await service.createDesign(teacher, {
    title: 'Prova de ciencias 1B',
    classId: '64b000000000000000000001',
    purpose: 'assessment',
  });

  // Compartilhada (padrao): o colega importa para a turma dele.
  const imported = await service.duplicateDesign(created.id, otherTeacher, {
    classId: '64b000000000000000000002',
  });
  assert.equal(imported.createdByUserId, otherTeacher.id);
  assert.equal(imported.classId, '64b000000000000000000002');
  assert.equal(imported.importedFromDesignId, created.id);
  assert.equal(imported.purpose, 'assessment');
  assert.equal(imported.examId, null);

  // Sem turma de destino (duplicar) continua so para o dono.
  await assert.rejects(
    service.duplicateDesign(created.id, otherTeacher),
    (error) => error.status === 403
  );
  // E o colega nao pode editar a original.
  await assert.rejects(
    service.updateDesign(created.id, otherTeacher, { title: 'x' }),
    (error) => error.status === 403
  );
});

test('atividade privada nao pode ser importada por outro professor', async () => {
  const { service, teacher, otherTeacher, manager } = createHarness();
  const created = await service.createDesign(teacher, { title: 'Minha prova' });
  const updated = await service.updateDesign(created.id, teacher, { sharing: 'private' });
  assert.equal(updated.sharing, 'private');
  // Trocar o compartilhamento nao conta como alteracao a publicar.
  assert.equal(updated.revision, created.revision);

  await assert.rejects(
    service.duplicateDesign(created.id, otherTeacher, { classId: '64b000000000000000000002' }),
    (error) => error.status === 403
  );
  // Coordenacao continua podendo.
  const byManager = await service.duplicateDesign(created.id, manager, { classId: '64b000000000000000000002' });
  assert.equal(byManager.title, 'Minha prova');

  await assert.rejects(
    service.updateDesign(created.id, teacher, { sharing: 'todo-mundo' }),
    (error) => error.code === 'INVALID_SHARING'
  );
});

test('listDesigns scope=shared traz as proprias e as compartilhadas, com o nome do autor', async () => {
  const schoolId = new mongoose.Types.ObjectId();
  const me = new mongoose.Types.ObjectId();
  const colleague = new mongoose.Types.ObjectId();
  let lastQuery = null;
  const docs = [
    { _id: new mongoose.Types.ObjectId(), schoolId, createdByUserId: colleague, title: 'Da colega', status: 'draft', pages: [] },
  ];
  const FakeDesign = {
    find(query) {
      lastQuery = query;
      return {
        select() { return this; },
        sort() { return this; },
        skip() { return this; },
        limit() { return Promise.resolve(docs); },
      };
    },
    async countDocuments() { return docs.length; },
  };
  const FakeUser = {
    find() {
      return {
        select() { return this; },
        lean: async () => [{ _id: colleague, fullName: 'Maria Souza' }],
      };
    },
  };
  const service = new ActivityDesignService({ ActivityDesign: FakeDesign, User: FakeUser });
  const actor = { id: String(me), school_id: String(schoolId), role: 'professor' };

  const result = await service.listDesigns(actor, { scope: 'shared' });
  assert.deepEqual(lastQuery.$or, [
    { createdByUserId: String(me) },
    { sharing: { $ne: 'private' } },
  ]);
  assert.equal(lastQuery.createdByUserId, undefined);
  assert.equal(result.items[0].createdByName, 'Maria Souza');
  assert.equal(result.items[0].sharing, 'school');

  await service.listDesigns(actor, {});
  assert.equal(lastQuery.createdByUserId, String(me));
  assert.equal(lastQuery.$or, undefined);
});
