const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { IconPackService, normalize, sizedSvg } = require('../../api/services/iconPack.service');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);

function harness() {
  const state = { docs: [], uploads: [], renders: 0 };
  const MediaAsset = {
    async findOne(query) {
      return state.docs.find((doc) => doc.iconKey === query.iconKey) || null;
    },
    async create(data) {
      if (state.docs.some((doc) => doc.iconKey === data.iconKey)) {
        throw Object.assign(new Error('duplicate'), { code: 11000 });
      }
      const doc = { ...data, async save() { return this; } };
      state.docs.push(doc);
      return doc;
    },
  };
  const service = new IconPackService({
    MediaAsset,
    r2StorageService: { async uploadBuffer({ key }) { state.uploads.push(key); return { key }; } },
    renderer: { async svgToPng() { state.renders += 1; return PNG; } },
  });
  return { service, state };
}

test('normalize remove acentos e caixa', () => {
  assert.equal(normalize('Maçã Ônibus'), 'maca onibus');
});

test('sizedSvg troca largura e altura para rasterizar nítido', () => {
  const out = sizedSvg('<svg width="32" height="32" viewBox="0 0 32 32"><path/></svg>', 512);
  assert.match(out, /width="512"/);
  assert.match(out, /height="512"/);
  assert.match(out, /viewBox="0 0 32 32"/);
});

test('catálogo real: categorias, contagem e busca em português sem acento', () => {
  const { service } = harness();
  const info = service.getInfo();
  assert.ok(info.total > 1500);
  assert.equal(info.license, 'MIT');
  assert.ok(info.categories.find((category) => category.id === 'animais').count > 100);

  assert.equal(service.list({ search: 'elefante' }).items[0].name, 'elefante');
  assert.ok(service.list({ search: 'maca' }).items.some((item) => item.name === 'maçã vermelha'));
  assert.equal(service.list({ search: 'onibus' }).items[0].name, 'ônibus');
  assert.ok(service.list({ search: 'numero 3' }).items.some((item) => item.name === 'número 3'));

  const animals = service.list({ category: 'animais', limit: 500 });
  assert.ok(animals.items.every((item) => item.category === 'animais'));
  assert.equal(animals.total, info.categories.find((category) => category.id === 'animais').count);

  const page2 = service.list({ limit: 10, page: 2 });
  assert.equal(page2.items.length, 10);
  assert.equal(page2.page, 2);
});

test('getSvg devolve o desenho e recusa id desconhecido', () => {
  const { service } = harness();
  assert.match(service.getSvg('elephant'), /^<svg/);
  assert.throws(() => service.getSvg('nao-existe'), (error) => error.status === 404);
});

test('ensureMediaAsset cria o asset global só no primeiro uso e depois reaproveita', async () => {
  const { service, state } = harness();
  const first = await service.ensureMediaAsset('elephant');
  assert.equal(first.visibility, 'global');
  assert.equal(first.source, 'curated');
  assert.equal(first.title, 'elefante');
  assert.equal(first.iconKey, 'fluent-flat:elephant');
  assert.match(first.attribution, /MIT/);
  assert.deepEqual(state.uploads, [
    'platform/icons/fluent-flat/elephant.png',
    'platform/icons/fluent-flat/elephant.thumbnail.png',
  ]);

  const again = await service.ensureMediaAsset('elephant');
  assert.equal(again, first);
  assert.equal(state.uploads.length, 2, 'não renderiza nem envia de novo');
  await assert.rejects(service.ensureMediaAsset('nao-existe'), (error) => error.status === 404);
});

test('ensureMediaAsset resolve corrida de dois usos simultâneos', async () => {
  const { service, state } = harness();
  const id = new mongoose.Types.ObjectId();
  // Simula outra instância criando o registro entre o findOne e o create.
  const originalFind = service.MediaAsset.findOne;
  let calls = 0;
  service.MediaAsset.findOne = async (query) => {
    calls += 1;
    if (calls === 1) {
      state.docs.push({ _id: id, iconKey: query.iconKey, status: 'active' });
      return null;
    }
    return originalFind(query);
  };
  const result = await service.ensureMediaAsset('red-apple');
  assert.equal(String(result._id), String(id));
});

test('renderizador real gera PNG nítido de 512px a partir do SVG', async () => {
  const service = new IconPackService();
  const { loadImage } = require('@napi-rs/canvas');
  const png = await service.renderer.svgToPng(service.getSvg('elephant'), 512);
  const image = await loadImage(png);
  assert.equal(image.width, 512);
  assert.equal(image.height, 512);
});
