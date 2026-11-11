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
    if (condition === null) return value === null || value === undefined;
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
    buildReferencePrompt: iaraImageClient.buildReferencePrompt,
    closestAspectRatio: iaraImageClient.closestAspectRatio,
    normalizeBackground: iaraImageClient.normalizeBackground,
    async generateImage({ prompt, extraParts, aspectRatio }) {
      state.generateCalls += 1;
      state.lastPrompt = prompt;
      state.lastExtraParts = extraParts;
      state.lastAspectRatio = aspectRatio;
      if (generate) return generate(state.generateCalls);
      return { buffer: PNG_BYTES, mimeType: 'image/png', model: 'fake-image-model' };
    },
  };

  const imageProcessor = {
    async inspect() { return { width: 100, height: 80 }; },
    async thumbnail() { return PNG_BYTES; },
    async prepareReference(buffer) {
      state.preparedReference = buffer;
      return { buffer: Buffer.from('jpeg-reduzido'), mimeType: 'image/jpeg', width: 1240, height: 1754 };
    },
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

test('listAssets esconde os icones do pacote integrado e filtra uploads do professor', async () => {
  const { service, state, schoolId, teacher } = createHarness();
  const base = { status: 'active', key: 'k', kind: 'color', tags: [] };
  state.docs.push(
    { _id: new mongoose.Types.ObjectId(), ...base, visibility: 'global', schoolId: null, source: 'curated', title: 'Relogio', iconKey: 'fluent-flat:alarm-clock' },
    { _id: new mongoose.Types.ObjectId(), ...base, visibility: 'private', schoolId, createdByUserId: teacher.id, source: 'upload', title: 'Print do livro' },
    { _id: new mongoose.Types.ObjectId(), ...base, visibility: 'school', schoolId, createdByUserId: teacher.id, source: 'ai-generated', title: 'Elefante da Iara' },
  );

  const all = await service.listAssets(teacher);
  assert.deepEqual(all.items.map((item) => item.title).sort(), ['Elefante da Iara', 'Print do livro']);

  const uploads = await service.listAssets(teacher, { scope: 'mine', source: 'upload' });
  assert.deepEqual(uploads.items.map((item) => item.title), ['Print do livro']);

  const withIcons = await service.listAssets(teacher, { includeIcons: 'true', scope: 'global' });
  assert.deepEqual(withIcons.items.map((item) => item.title), ['Relogio']);
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

test('generateWithAi colorido: sem fundo por padrao e com cenario quando pedido', async () => {
  const { service, state, teacher } = createHarness();
  await service.generateWithAi(teacher, { prompt: 'uma criança no computador', style: 'color', count: 1 });
  assert.equal(state.lastToPngOptions.removeBackground, true, 'remove o branco das bordas');
  assert.equal(state.lastToPngOptions.transparentWhite, false, 'preserva o branco dentro do desenho');
  assert.match(state.lastPrompt, /no scenery/);

  await service.generateWithAi(teacher, {
    prompt: 'uma criança no computador', style: 'color', count: 1, background: 'scene',
  });
  assert.equal(state.lastToPngOptions.transparentWhite, false, 'o cenário fica');
  assert.equal(state.lastToPngOptions.removeFrame, true, 'só a moldura branca sai');
  assert.equal(state.lastToPngOptions.removeBackground, undefined);
  assert.equal(state.lastToPngOptions.trim, true, 'margem branca em volta sai');
  assert.match(state.lastPrompt, /background scene/);

  // App antigo (transparentBackground=false) continua mantendo o fundo.
  await service.generateWithAi(teacher, {
    prompt: 'uma maçã', style: 'color', count: 1, transparentBackground: false,
  });
  assert.equal(state.lastToPngOptions.transparentWhite, false);
  assert.equal(state.lastToPngOptions.removeBackground, undefined);
});

test('generateFromReference recria o desenho sem cabecalho e com o pedido do professor', async () => {
  const { service, state, teacher } = createHarness();
  const result = await service.generateFromReference(
    teacher,
    { buffer: PNG_BYTES, originalname: 'whatsapp.png' },
    { instructions: 'troque a bola por uma pipa', style: 'lineart', count: '2', keepText: 'true' }
  );
  assert.equal(result.items.length, 2);
  assert.equal(state.generateCalls, 2);
  assert.equal(result.items[0].source, 'ai-from-reference');
  assert.equal(result.items[0].title, 'troque a bola por uma pipa');
  // A referência reduzida vai junto do pedido.
  assert.equal(state.lastExtraParts[0].inlineData.mimeType, 'image/jpeg');
  assert.equal(state.lastExtraParts[0].inlineData.data, Buffer.from('jpeg-reduzido').toString('base64'));
  assert.equal(state.lastAspectRatio, '2:3', 'segue a proporção da folha de referência');
  assert.match(state.lastPrompt, /Keep the activity title/, 'manter o enunciado');
  assert.match(state.lastPrompt, /"Name:" lines/);
  assert.match(state.lastPrompt, /QR code\) is added later by our own system/);
  assert.equal(state.lastToPngOptions.darkFrame, true, 'moldura escura de foto sai');
  assert.match(state.lastPrompt, /troque a bola por uma pipa/);
  assert.match(state.lastPrompt, /coloring page/);
  assert.equal(state.lastToPngOptions.transparentWhite, true);

  // Conta no limite diário da escola.
  const quota = await service.getAiQuota(teacher);
  assert.equal(quota.used, 2);

  // Sem pedido extra também funciona.
  const plain = await service.generateFromReference(
    teacher, { buffer: PNG_BYTES }, { style: 'color', count: 1, background: 'scene' }
  );
  assert.equal(plain.items[0].title, 'Desenho a partir de referencia');
  assert.doesNotMatch(state.lastPrompt, /Changes requested/);
  assert.match(state.lastPrompt, /headings/, 'sem manter: tira títulos e textos');
  assert.match(state.lastPrompt, /Keep the background scene/);
});

test('generateFromReference recusa arquivo ausente ou que nao e imagem', async () => {
  const { service, teacher } = createHarness();
  await assert.rejects(
    () => service.generateFromReference(teacher, null, {}),
    (error) => error.code === 'IARA_REFERENCE_REQUIRED'
  );
  await assert.rejects(
    () => service.generateFromReference(teacher, { buffer: Buffer.from('%PDF-1.4') }, {}),
    (error) => error.code === 'IARA_REFERENCE_INVALID_TYPE'
  );
});

test('processador real: sem fundo remove so o branco das bordas e preserva o branco do desenho', async () => {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const canvas = createCanvas(60, 60);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fdfdfb';
  context.fillRect(0, 0, 60, 60);
  context.fillStyle = '#e53935';
  context.fillRect(10, 10, 40, 40);
  context.fillStyle = '#ffffff';
  context.fillRect(25, 25, 10, 10); // "olho" branco dentro do desenho
  const result = await defaultImageProcessor.toPng(canvas.toBuffer('image/png'), { removeBackground: true });
  const image = await loadImage(result.buffer);
  const check = createCanvas(60, 60).getContext('2d');
  check.drawImage(image, 0, 0);
  assert.equal(check.getImageData(2, 2, 1, 1).data[3], 0, 'fundo some');
  assert.equal(check.getImageData(15, 15, 1, 1).data[3], 255, 'cor fica');
  assert.equal(check.getImageData(30, 30, 1, 1).data[3], 255, 'branco de dentro fica');

  // Recorte: margens vazias saem (fica o quadrado de 40 px + margem).
  const trimmed = await defaultImageProcessor.toPng(canvas.toBuffer('image/png'), { removeBackground: true, trim: true });
  assert.ok(trimmed.width < 50 && trimmed.width >= 40, `largura recortada: ${trimmed.width}`);

  // Cena que vai até a borda: nada é removido nem recortado.
  const scene = createCanvas(60, 60);
  const sceneContext = scene.getContext('2d');
  sceneContext.fillStyle = '#87ceeb';
  sceneContext.fillRect(0, 0, 60, 60);
  sceneContext.fillStyle = '#ffffff';
  sceneContext.fillRect(0, 0, 15, 8); // nuvem branca encostando na borda
  const sceneResult = await defaultImageProcessor.toPng(scene.toBuffer('image/png'), { removeFrame: true, trim: true });
  assert.equal(sceneResult.width, 60);
  const sceneImage = await loadImage(sceneResult.buffer);
  const sceneCheck = createCanvas(60, 60).getContext('2d');
  sceneCheck.drawImage(sceneImage, 0, 0);
  assert.equal(sceneCheck.getImageData(2, 2, 1, 1).data[3], 255, 'nuvem continua');

  // Cena dentro de um "cartão" branco: a moldura sai e a imagem é recortada.
  const framed = await defaultImageProcessor.toPng(canvas.toBuffer('image/png'), { removeFrame: true, trim: true });
  assert.ok(framed.width < 50);

  const reference = await defaultImageProcessor.prepareReference(canvas.toBuffer('image/png'), 30);
  assert.equal(reference.mimeType, 'image/jpeg');
  assert.equal(reference.width, 30);
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

test('iaraImage: resposta sem imagem por motivo que nao e seguranca tenta de novo', async () => {
  const pngBase64 = PNG_BYTES.toString('base64');
  let calls = 0;
  const result = await iaraImageClient.generateImage({
    prompt: 'x',
    apiKey: 'k',
    sleepFn: async () => {},
    httpClient: {
      async post() {
        calls += 1;
        if (calls === 1) return { data: { candidates: [{ finishReason: 'IMAGE_OTHER', content: { parts: [] } }] } };
        return { data: { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { data: pngBase64, mimeType: 'image/png' } }] } }] } };
      },
    },
  });
  assert.equal(calls, 2);
  assert.ok(result.buffer.length > 0);

  // Parecida demais com a original o tempo todo: mensagem clara, sem "bloqueio".
  await assert.rejects(
    iaraImageClient.generateImage({
      prompt: 'x',
      apiKey: 'k',
      sleepFn: async () => {},
      httpClient: { async post() { return { data: { candidates: [{ finishReason: 'IMAGE_RECITATION' }] } }; } },
    }),
    (error) => error.code === 'IARA_IMAGE_TOO_SIMILAR' && /mudancas/.test(error.message)
  );

  // Seguranca continua sendo bloqueio direto, sem repetir.
  let safetyCalls = 0;
  await assert.rejects(
    iaraImageClient.generateImage({
      prompt: 'x',
      apiKey: 'k',
      httpClient: { async post() { safetyCalls += 1; return { data: { candidates: [{ finishReason: 'IMAGE_SAFETY' }] } }; } },
    }),
    (error) => error.code === 'IARA_IMAGE_BLOCKED'
  );
  assert.equal(safetyCalls, 1);
});

test('referencia: manter o enunciado muda o pedido e o pedido do professor tem prioridade', () => {
  const keep = iaraImageClient.buildReferencePrompt({ style: 'lineart', keepText: true, instructions: 'mantenha a frase' });
  assert.match(keep, /Keep the activity title and instructions text/);
  assert.doesNotMatch(keep, /Do not add any text/);
  assert.match(keep, /"Name:" lines/);
  assert.match(keep, /follow the teacher's request/);
  assert.match(keep, /photo or a scan/);

  const plain = iaraImageClient.buildReferencePrompt({ style: 'lineart' });
  assert.match(plain, /Do not add any text/);
});

test('processador real: moldura escura da foto da folha sai e o traco do desenho fica', async () => {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const canvas = createCanvas(80, 80);
  const context = canvas.getContext('2d');
  context.fillStyle = '#1e1e1e'; // mesa escura em volta da folha
  context.fillRect(0, 0, 80, 80);
  context.fillStyle = '#ffffff'; // folha
  context.fillRect(8, 8, 64, 64);
  context.fillStyle = '#000000'; // traco do desenho
  context.fillRect(30, 30, 20, 4);
  const result = await defaultImageProcessor.toPng(canvas.toBuffer('image/png'), {
    transparentWhite: true, darkFrame: true, trim: true,
  });
  assert.ok(result.width < 40, `recortado em volta do traco: ${result.width}`);
  const image = await loadImage(result.buffer);
  const check = createCanvas(result.width, result.height).getContext('2d');
  check.drawImage(image, 0, 0);
  let opaque = 0;
  const data = check.getImageData(0, 0, result.width, result.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] === 255) opaque += 1;
  assert.ok(opaque >= 70, 'o traco preto continua');
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

test('iaraImage: 429 por cota zerada (plano gratuito) vira mensagem clara e nao repete tentativas', async () => {
  let calls = 0;
  const quotaError = Object.assign(new Error('Request failed with status code 429'), {
    response: {
      status: 429,
      data: {
        error: {
          message: 'You exceeded your current quota... Quota exceeded for metric: '
            + 'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash-preview-image',
        },
      },
    },
  });
  await assert.rejects(
    iaraImageClient.generateImage({
      prompt: 'x',
      apiKey: 'k',
      sleepFn: async () => {},
      httpClient: { async post() { calls += 1; throw quotaError; } },
    }),
    (error) => error.code === 'IARA_IMAGE_BILLING_REQUIRED' && error.status === 503
  );
  assert.equal(calls, 1, 'nao insiste nem troca de modelo quando a cota e zero');
});

test('iaraImage: 429 momentaneo continua sendo tratado como demanda alta', async () => {
  const busy = Object.assign(new Error('429'), {
    response: { status: 429, data: { error: { message: 'Resource has been exhausted (e.g. check quota).' } } },
  });
  assert.equal(iaraImageClient.isBillingQuotaError(busy), false);
  await assert.rejects(
    iaraImageClient.generateImage({
      prompt: 'x',
      apiKey: 'k',
      sleepFn: async () => {},
      httpClient: { async post() { throw busy; } },
    }),
    (error) => error.code === 'IARA_IMAGE_BUSY'
  );
});

test('iaraImage: 402 de creditos pre-pagos esgotados tambem vira mensagem de faturamento', async () => {
  const depleted = Object.assign(new Error('402'), {
    response: { status: 402, data: { error: { message: 'Your prepayment credits are depleted. Please go to AI Studio...' } } },
  });
  assert.equal(iaraImageClient.isBillingQuotaError(depleted), true);
  await assert.rejects(
    iaraImageClient.generateImage({
      prompt: 'x',
      apiKey: 'k',
      sleepFn: async () => {},
      httpClient: { async post() { throw depleted; } },
    }),
    (error) => error.code === 'IARA_IMAGE_BILLING_REQUIRED'
  );
});

test('iaraImage: provedor vertex usa o endpoint da Agent Platform com a chave no cabecalho', async () => {
  const previous = { ...process.env };
  try {
    process.env.IARA_IMAGE_PROVIDER = 'vertex';
    process.env.VERTEX_API_KEY = 'chave-vertex';
    delete process.env.VERTEX_PROJECT_ID;
    assert.equal(iaraImageClient.getProvider(), 'vertex');
    assert.equal(
      iaraImageClient.buildEndpoint('gemini-2.5-flash-image'),
      'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash-image:generateContent'
    );
    process.env.VERTEX_PROJECT_ID = 'meu-projeto';
    assert.equal(
      iaraImageClient.buildEndpoint('gemini-2.5-flash-image'),
      'https://aiplatform.googleapis.com/v1/projects/meu-projeto/locations/global/publishers/google/models/gemini-2.5-flash-image:generateContent'
    );

    let seen = null;
    const result = await iaraImageClient.generateImage({
      prompt: 'x',
      sleepFn: async () => {},
      httpClient: {
        async post(url, body, config) {
          seen = { url, key: config.headers['x-goog-api-key'] };
          return { data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } }] } }] } };
        },
      },
    });
    assert.match(seen.url, /aiplatform\.googleapis\.com\/v1\/projects\/meu-projeto/);
    assert.equal(seen.key, 'chave-vertex');
    assert.ok(result.buffer.equals(PNG_BYTES));
  } finally {
    process.env = previous;
  }
});

test('iaraImage: 403 de permissao na Vertex vira mensagem clara sem repetir', async () => {
  let calls = 0;
  const denied = Object.assign(new Error('403'), {
    response: { status: 403, data: { error: { status: 'PERMISSION_DENIED', message: "Permission 'aiplatform.endpoints.predict' denied" } } },
  });
  await assert.rejects(
    iaraImageClient.generateImage({
      prompt: 'x',
      apiKey: 'k',
      provider: 'vertex',
      sleepFn: async () => {},
      httpClient: { async post() { calls += 1; throw denied; } },
    }),
    (error) => error.code === 'IARA_IMAGE_NOT_AUTHORIZED' && error.status === 503
  );
  assert.equal(calls, 1);
});

test('iaraImage: IARA_IMAGE_API_KEY tem prioridade e GEMINI_API_KEY fica como reserva', async () => {
  const previous = { ...process.env };
  try {
    delete process.env.IARA_IMAGE_PROVIDER;
    delete process.env.VERTEX_API_KEY;
    process.env.GEMINI_API_KEY = 'chave-texto';
    delete process.env.IARA_IMAGE_API_KEY;
    assert.equal(iaraImageClient.getApiKey(), 'chave-texto');
    assert.equal(iaraImageClient.getApiKeySource(), 'GEMINI_API_KEY');

    process.env.IARA_IMAGE_API_KEY = '  chave-imagens  ';
    assert.equal(iaraImageClient.getApiKey(), 'chave-imagens');
    assert.equal(iaraImageClient.getApiKeySource(), 'IARA_IMAGE_API_KEY');
    assert.equal(iaraImageClient.getApiKey('vertex'), 'chave-imagens');

    let usedKey = null;
    await iaraImageClient.generateImage({
      prompt: 'x',
      sleepFn: async () => {},
      httpClient: {
        async post(url, body, config) {
          usedKey = config.headers['x-goog-api-key'];
          return { data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } }] } }] } };
        },
      },
    });
    assert.equal(usedKey, 'chave-imagens', 'a geração de imagens usa a chave dedicada');
  } finally {
    process.env = previous;
  }
});

test('iaraImage: erros nunca carregam a chave da API (nada de vazar nos logs)', async () => {
  const util = require('node:util');
  const secret = 'AQ.chave-super-secreta-123';
  for (const status of [403, 402, 500]) {
    const axiosLike = Object.assign(new Error(`Request failed with status code ${status}`), {
      config: { headers: { 'x-goog-api-key': secret } },
      request: { _header: `POST / HTTP/1.1\r\nx-goog-api-key: ${secret}\r\n` },
      response: {
        status,
        data: { error: { status: 'X', message: status === 403 ? "Permission 'aiplatform.endpoints.predict' denied" : 'Your prepayment credits are depleted' } },
      },
    });
    let caught;
    try {
      await iaraImageClient.generateImage({
        prompt: 'x',
        apiKey: secret,
        provider: status === 403 ? 'vertex' : 'gemini',
        sleepFn: async () => {},
        httpClient: { async post() { throw axiosLike; } },
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, `status ${status} deve falhar`);
    const printed = util.inspect(caught, { depth: 10 }) + JSON.stringify(caught.cause);
    assert.equal(printed.includes(secret), false, `a chave vazou no erro do status ${status}`);
    assert.equal(caught.cause.status, status);
  }
});
