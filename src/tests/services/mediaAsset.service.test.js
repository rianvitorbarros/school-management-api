const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  MediaAssetService,
  tagsFromPrompt,
  normalizeTags,
  defaultImageProcessor,
} = require('../../api/services/mediaAsset.service');
const iaraImageClient = require('../../api/services/iara/iaraImage.client');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);

function matches(doc, query) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$and') return condition.every((part) => matches(doc, part));
    if (key === '$or') return condition.some((part) => matches(doc, part));
    const value = doc[key];
    if (condition instanceof RegExp) {
      return Array.isArray(value) ? value.some((item) => condition.test(item)) : condition.test(value || '');
    }
    if (condition && typeof condition === 'object' && !(condition instanceof mongoose.Types.ObjectId)) {
      if (condition.$in) return condition.$in.includes(value);
      if (condition.$gte) return value >= condition.$gte;
      return false;
    }
    return String(value) === String(condition);
  });
}

function createHarness({ dailyAiLimit = 10, generate } = {}) {
  const schoolId = new mongoose.Types.ObjectId();
  const otherSchoolId = new mongoose.Types.ObjectId();
  const state = { docs: [], uploads: [], generateCalls: 0 };
  let clock = new Date('2026-11-06T12:00:00Z');

  class FakeMediaAsset {
    constructor(data) {
      Object.assign(this, data);
      this.createdAt = this.createdAt || clock;
    }

    async save() {
      return this;
    }

    static async create(data) {
      const doc = new FakeMediaAsset({ _id: data._id || new mongoose.Types.ObjectId(), ...data });
      state.docs.push(doc);
      return doc;
    }

    static async findById(id) {
      return state.docs.find((doc) => String(doc._id) === String(id)) || null;
    }

    static find(query) {
      const result = state.docs.filter((doc) => matches(doc, query));
      const chain = {
        sort() { return chain; },
        skip() { return chain; },
        limit() { return chain; },
        lean() { return Promise.resolve(result); },
      };
      return chain;
    }

    static async countDocuments(query) {
      return state.docs.filter((doc) => matches(doc, query)).length;
    }

    static async updateOne(query, update) {
      const doc = state.docs.find((item) => String(item._id) === String(query._id));
      if (doc && update.$inc) doc.usageCount = (doc.usageCount || 0) + update.$inc.usageCount;
    }
  }

  const imageClient = {
    IMAGE_STYLES: iaraImageClient.IMAGE_STYLES,
    buildPrompt: iaraImageClient.buildPrompt,
    async generateImage({ prompt }) {
      state.generateCalls += 1;
      state.lastPrompt = prompt;
      if (generate) return generate(state.generateCalls);
      return { buffer: PNG_BYTES, mimeType: 'image/png', model: 'fake-image-model' };
    },
  };

  const imageProcessor = {
    async inspect() { return { width: 100, height: 80 }; },
    async thumbnail() { return PNG_BYTES; },
    async toPng(buffer, options) {
      state.lastToPngOptions = options;
      return { buffer: PNG_BYTES, width: 1024, height: 1024 };
    },
  };

  const service = new MediaAssetService({
    MediaAsset: FakeMediaAsset,
    r2StorageService: {
      async uploadBuffer({ key, contentType }) { state.uploads.push({ key, contentType }); return { key }; },
      async downloadBuffer() { return PNG_BYTES; },
    },
    imageClient,
    imageProcessor,
    now: () => clock,
    dailyAiLimit,
  });

  const actor = (role = 'professor', school = schoolId) => ({
    id: String(new mongoose.Types.ObjectId()),
    school_id: String(school),
    role,
  });

  return {
    service,
    state,
    schoolId,
    otherSchoolId,
    teacher: actor(),
    otherTeacher: actor(),
    manager: actor('coordenador'),
    otherSchoolTeacher: actor('professor', otherSchoolId),
    setClock(value) { clock = value; },
  };
}

test('tagsFromPrompt e normalizeTags geram palavras-chave limpas', () => {
  assert.deepEqual(tagsFromPrompt('Um elefante feliz com balões!'), ['elefante', 'feliz', 'balões']);
  assert.deepEqual(normalizeTags('Animais, ANIMAIS, fazenda'), ['animais', 'fazenda']);
  assert.deepEqual(normalizeTags('["a","b"]'), ['a', 'b']);
});

test('buildPrompt aplica o estilo para colorir com o pedido do professor', () => {
  const prompt = iaraImageClient.buildPrompt('um elefante', 'lineart');
  assert.match(prompt, /coloring page/);
  assert.match(prompt, /um elefante/);
  assert.match(prompt, /no text/);
});

test('upload vai para o acervo privado e respeita quem pode ver', async () => {
  const { service, state, teacher, otherTeacher, manager, otherSchoolTeacher } = createHarness();
  const asset = await service.uploadAsset(teacher, { buffer: PNG_BYTES, originalname: 'elefante.png' }, { tags: 'animais' });

  assert.equal(asset.visibility, 'private');
  assert.equal(asset.title, 'elefante');
  assert.equal(asset.isMine, true);
  assert.equal(asset.width, 100);
  assert.equal(state.uploads.length, 2, 'imagem + miniatura');

  await assert.rejects(service.getAsset(asset.id, otherTeacher), (error) => error.status === 404);
  await assert.rejects(service.getAsset(asset.id, otherSchoolTeacher), (error) => error.status === 404);
  const seenByManager = await service.getAsset(asset.id, manager);
  assert.equal(seenByManager.canEdit, true);

  await service.updateAsset(asset.id, teacher, { visibility: 'school' });
  const seenByColleague = await service.getAsset(asset.id, otherTeacher);
  assert.equal(seenByColleague.canEdit, false);
  await assert.rejects(service.archiveAsset(asset.id, otherTeacher), (error) => error.status === 403);
});

test('upload recusa arquivo que nao e imagem', async () => {
  const { service, teacher } = createHarness();
  await assert.rejects(
    service.uploadAsset(teacher, { buffer: Buffer.from('<script>alert(1)</script>'), originalname: 'x.png' }),
    (error) => error.code === 'MEDIA_ASSET_INVALID_TYPE'
  );
});

test('listAssets mostra global + escola + minhas privadas e filtra por busca e escopo', async () => {
  const { service, state, schoolId, otherSchoolId, teacher, otherTeacher } = createHarness();
  const base = { status: 'active', key: 'k', kind: 'lineart', tags: [] };
  state.docs.push(
    { _id: new mongoose.Types.ObjectId(), ...base, visibility: 'global', schoolId: null, title: 'Estrela' },
    { _id: new mongoose.Types.ObjectId(), ...base, visibility: 'school', schoolId, title: 'Elefante', tags: ['animais'] },
    { _id: new mongoose.Types.ObjectId(), ...base, visibility: 'private', schoolId, createdByUserId: teacher.id, title: 'Minha girafa' },
    { _id: new mongoose.Types.ObjectId(), ...base, visibility: 'private', schoolId, createdByUserId: otherTeacher.id, title: 'Privada de outro' },
    { _id: new mongoose.Types.ObjectId(), ...base, visibility: 'school', schoolId: otherSchoolId, title: 'Outra escola' },
    { _id: new mongoose.Types.ObjectId(), ...base, visibility: 'school', schoolId, title: 'Arquivada', status: 'archived' },
  );

  const all = await service.listAssets(teacher);
  assert.deepEqual(all.items.map((item) => item.title).sort(), ['Elefante', 'Estrela', 'Minha girafa']);

  const animals = await service.listAssets(teacher, { search: 'animais' });
  assert.deepEqual(animals.items.map((item) => item.title), ['Elefante']);

  const mine = await service.listAssets(teacher, { scope: 'mine' });
  assert.deepEqual(mine.items.map((item) => item.title), ['Minha girafa']);

  const global = await service.listAssets(teacher, { scope: 'global' });
  assert.deepEqual(global.items.map((item) => item.title), ['Estrela']);
});

test('generateWithAi salva as imagens no acervo da escola com o pedido e o estilo', async () => {
  const { service, state, teacher, otherTeacher } = createHarness();
  const result = await service.generateWithAi(teacher, { prompt: 'um elefante feliz', style: 'lineart', count: 2 });

  assert.equal(result.items.length, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.remainingToday, 8);
  assert.equal(state.generateCalls, 2);
  assert.match(state.lastPrompt, /coloring page/);
  assert.equal(state.lastToPngOptions.transparentWhite, true, 'desenho para colorir fica com fundo transparente');

  const [first] = result.items;
  assert.equal(first.visibility, 'school');
  assert.equal(first.source, 'ai-generated');
  assert.equal(first.kind, 'lineart');
  assert.equal(first.prompt, 'um elefante feliz');
  assert.deepEqual(first.tags, ['elefante', 'feliz']);

  // Outro professor da mesma escola encontra a imagem para reaproveitar.
  const found = await service.listAssets(otherTeacher, { search: 'elefante' });
  assert.equal(found.items.length, 2);
});

test('generateWithAi colorido mantem o fundo branco', async () => {
  const { service, state, teacher } = createHarness();
  await service.generateWithAi(teacher, { prompt: 'uma maçã', style: 'color', count: 1 });
  assert.equal(state.lastToPngOptions.transparentWhite, false);
});

test('generateWithAi respeita o limite diario da escola', async () => {
  const { service, teacher, manager } = createHarness({ dailyAiLimit: 3 });
  await service.generateWithAi(teacher, { prompt: 'um gato', count: 2 });

  await assert.rejects(
    service.generateWithAi(manager, { prompt: 'um cachorro', count: 2 }),
    (error) => error.status === 429 && error.code === 'IARA_IMAGE_DAILY_LIMIT'
  );
  const quota = await service.getAiQuota(teacher);
  assert.equal(quota.used, 2);
  assert.equal(quota.remaining, 1);
  assert.ok(quota.styles.some((style) => style.id === 'lineart'));
});

test('generateWithAi valida o pedido e entrega o que deu certo quando parte falha', async () => {
  const { service, teacher } = createHarness({
    generate: (call) => {
      if (call === 1) throw Object.assign(new Error('falhou'), { status: 502 });
      return { buffer: PNG_BYTES, model: 'fake' };
    },
  });
  await assert.rejects(service.generateWithAi(teacher, { prompt: 'a' }), (error) => error.code === 'IARA_IMAGE_PROMPT_REQUIRED');

  const result = await service.generateWithAi(teacher, { prompt: 'um sapo', count: 2 });
  assert.equal(result.items.length, 1);
  assert.equal(result.failed, 1);
});

test('generateWithAi propaga o erro quando nenhuma imagem foi gerada', async () => {
  const { service, teacher } = createHarness({
    generate: () => {
      throw new iaraImageClient.IaraImageError('bloqueado', { statusCode: 422, code: 'IARA_IMAGE_BLOCKED' });
    },
  });
  await assert.rejects(
    service.generateWithAi(teacher, { prompt: 'algo', count: 1 }),
    (error) => error.code === 'IARA_IMAGE_BLOCKED' && error.status === 422
  );
});

test('getForUse incrementa o uso e nao libera imagem privada de outro professor', async () => {
  const { service, teacher, otherTeacher } = createHarness();
  const asset = await service.uploadAsset(teacher, { buffer: PNG_BYTES, originalname: 'a.png' });
  const doc = await service.getForUse(asset.id, teacher);
  assert.equal(doc.usageCount, 1);
  await assert.rejects(service.getForUse(asset.id, otherTeacher), (error) => error.status === 404);
});

test('iaraImage.generateImage extrai a imagem da resposta do Gemini e tenta de novo em erro temporario', async () => {
  let calls = 0;
  const httpClient = {
    async post(url, body, config) {
      calls += 1;
      assert.match(url, /gemini-2\.5-flash-image:generateContent$/);
      assert.deepEqual(body.generationConfig.responseModalities, ['IMAGE']);
      assert.equal(config.headers['x-goog-api-key'], 'chave-teste');
      if (calls === 1) throw Object.assign(new Error('busy'), { response: { status: 503 } });
      return {
        data: {
          candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } }] } }],
        },
      };
    },
  };
  const result = await iaraImageClient.generateImage({
    prompt: 'teste',
    httpClient,
    apiKey: 'chave-teste',
    sleepFn: async () => {},
  });
  assert.equal(calls, 2);
  assert.equal(result.mimeType, 'image/png');
  assert.ok(result.buffer.equals(PNG_BYTES));
});

test('iaraImage.generateImage informa bloqueio de conteudo e falta de configuracao', async () => {
  await assert.rejects(
    iaraImageClient.generateImage({
      prompt: 'x',
      apiKey: 'k',
      httpClient: { async post() { return { data: { promptFeedback: { blockReason: 'SAFETY' } } }; } },
    }),
    (error) => error.code === 'IARA_IMAGE_BLOCKED'
  );
  await assert.rejects(
    iaraImageClient.generateImage({ prompt: 'x', apiKey: '' }),
    (error) => error.code === 'IARA_IMAGE_NOT_CONFIGURED' && error.status === 503
  );
});

test('processador real: fundo branco vira transparente e o traço preto continua', async () => {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const canvas = createCanvas(40, 40);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, 40, 40);
  context.fillStyle = '#000000';
  context.fillRect(10, 10, 20, 20);
  const source = canvas.toBuffer('image/png');

  const result = await defaultImageProcessor.toPng(source, { transparentWhite: true });
  assert.equal(result.width, 40);
  const image = await loadImage(result.buffer);
  const check = createCanvas(40, 40).getContext('2d');
  check.drawImage(image, 0, 0);
  const corner = check.getImageData(1, 1, 1, 1).data;
  const center = check.getImageData(20, 20, 1, 1).data;
  assert.equal(corner[3], 0, 'fundo transparente');
  assert.equal(center[3], 255, 'traço opaco');
  assert.equal(center[0], 0);

  const thumbnail = await defaultImageProcessor.thumbnail(source);
  const info = await defaultImageProcessor.inspect(thumbnail);
  assert.equal(info.width, 40, 'imagem pequena nao e ampliada');
});
