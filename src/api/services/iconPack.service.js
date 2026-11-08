const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');

const MediaAssetModel = require('../models/mediaAsset.model');
const r2StorageServiceInstance = require('./r2Storage.service');

const DEFAULT_PACK_PATH = path.resolve(__dirname, '../../../assets/icon-packs/fluent-emoji-flat.json.gz');
const PACK_KEY_PREFIX = 'fluent-flat';
const RENDER_SIZE = 512;
const THUMBNAIL_SIZE = 256;
const ATTRIBUTION = 'Fluent Emoji (Microsoft, licença MIT)';

function createHttpError(message, status = 400, code = 'ICON_PACK_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/** Minúsculas e sem acentos, para a busca aceitar "maca" e "maçã". */
function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** SVG com largura/altura explícitas para rasterizar nítido (o original é 32x32). */
function sizedSvg(svg, size) {
  return String(svg)
    .replace(/<svg([^>]*?)\swidth="[^"]*"/, `<svg$1 width="${size}"`)
    .replace(/<svg([^>]*?)\sheight="[^"]*"/, `<svg$1 height="${size}"`);
}

const defaultRenderer = {
  async svgToPng(svg, size) {
    // eslint-disable-next-line global-require
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(sizedSvg(svg, size)));
    const canvas = createCanvas(size, size);
    canvas.getContext('2d').drawImage(image, 0, 0, size, size);
    return canvas.toBuffer('image/png');
  },
};

/**
 * Pacote de ícones integrado ao editor (Fluent Emoji Flat, MIT, com nomes em
 * português do Unicode CLDR). O catálogo fica em memória; ao colocar um ícone
 * numa atividade, ele vira um MediaAsset global (criado só no primeiro uso).
 */
class IconPackService {
  constructor({
    packPath = DEFAULT_PACK_PATH,
    MediaAsset = MediaAssetModel,
    r2StorageService = r2StorageServiceInstance,
    renderer = defaultRenderer,
  } = {}) {
    this.packPath = packPath;
    this.MediaAsset = MediaAsset;
    this.r2StorageService = r2StorageService;
    this.renderer = renderer;
    this.pack = null;
  }

  load() {
    if (this.pack) return this.pack;
    const raw = zlib.gunzipSync(fs.readFileSync(this.packPath)).toString('utf8');
    const data = JSON.parse(raw);
    const items = data.items.map((item, index) => {
      // "tecla: 1" (nome do CLDR) -> "número 1", que é como a professora busca.
      const keycap = /^tecla: (\d+)$/.exec(item.name);
      return keycap
        ? { ...item, name: `número ${keycap[1]}`, keywords: [...(item.keywords || []), 'número', keycap[1]] }
        : item;
    }).map((item, index) => ({
      ...item,
      order: index,
      nameNorm: normalize(item.name),
      haystack: normalize([item.name, ...(item.keywords || []), item.id.replace(/-/g, ' ')].join(' ')),
    }));
    this.pack = {
      source: data.source,
      license: data.license,
      categories: data.categories,
      items,
      byId: new Map(items.map((item) => [item.id, item])),
    };
    return this.pack;
  }

  getInfo() {
    const pack = this.load();
    const counts = new Map();
    for (const item of pack.items) counts.set(item.category, (counts.get(item.category) || 0) + 1);
    return {
      source: pack.source,
      license: pack.license,
      total: pack.items.length,
      categories: pack.categories.map((category) => ({
        ...category,
        count: counts.get(category.id) || 0,
      })),
    };
  }

  list(filters = {}) {
    const pack = this.load();
    const terms = normalize(filters.search).split(/\s+/).filter(Boolean);
    const category = String(filters.category || '').trim();
    const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, Number.parseInt(filters.limit, 10) || 80));

    let matches = pack.items.filter((item) => (!category || item.category === category)
      && terms.every((term) => item.haystack.includes(term)));

    if (terms.length > 0) {
      const query = terms.join(' ');
      const score = (item) => {
        if (item.nameNorm === query) return 0;
        if (item.nameNorm.startsWith(query)) return 1;
        if (item.nameNorm.includes(query)) return 2;
        return 3;
      };
      matches = [...matches].sort((a, b) => score(a) - score(b) || a.order - b.order);
    }

    const total = matches.length;
    const items = matches.slice((page - 1) * limit, page * limit).map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      keywords: item.keywords,
    }));
    return { items, page, limit, total };
  }

  getSvg(iconId) {
    const item = this.load().byId.get(String(iconId || ''));
    if (!item) throw createHttpError('Ícone não encontrado.', 404, 'ICON_NOT_FOUND');
    return item.svg;
  }

  /**
   * Garante o MediaAsset global do ícone (PNG nítido no R2) e o devolve.
   * Na primeira vez renderiza e envia; depois só reaproveita.
   */
  async ensureMediaAsset(iconId) {
    const item = this.load().byId.get(String(iconId || ''));
    if (!item) throw createHttpError('Ícone não encontrado.', 404, 'ICON_NOT_FOUND');
    const iconKey = `${PACK_KEY_PREFIX}:${item.id}`;

    const existing = await this.MediaAsset.findOne({ iconKey });
    if (existing) {
      if (existing.status !== 'active') {
        existing.status = 'active';
        existing.archivedAt = null;
        await existing.save();
      }
      return existing;
    }

    const [png, thumbnail] = await Promise.all([
      this.renderer.svgToPng(item.svg, RENDER_SIZE),
      this.renderer.svgToPng(item.svg, THUMBNAIL_SIZE),
    ]);
    const base = `platform/icons/${PACK_KEY_PREFIX}/${item.id}`;
    const key = `${base}.png`;
    const thumbnailKey = `${base}.thumbnail.png`;
    await this.r2StorageService.uploadBuffer({ key, buffer: png, contentType: 'image/png' });
    await this.r2StorageService.uploadBuffer({ key: thumbnailKey, buffer: thumbnail, contentType: 'image/png' });

    try {
      return await this.MediaAsset.create({
        _id: new mongoose.Types.ObjectId(),
        schoolId: null,
        visibility: 'global',
        source: 'curated',
        kind: 'color',
        title: item.name,
        tags: [...new Set([...(item.keywords || []), item.category])].slice(0, 20),
        key,
        thumbnailKey,
        contentType: 'image/png',
        size: png.length,
        width: RENDER_SIZE,
        height: RENDER_SIZE,
        attribution: ATTRIBUTION,
        iconKey,
        status: 'active',
      });
    } catch (error) {
      // Dois professores colocando o mesmo ícone ao mesmo tempo: o índice
      // único garante um só registro; o segundo reaproveita o primeiro.
      if (error && error.code === 11000) {
        const created = await this.MediaAsset.findOne({ iconKey });
        if (created) return created;
      }
      throw error;
    }
  }
}

module.exports = new IconPackService();
module.exports.IconPackService = IconPackService;
module.exports.normalize = normalize;
module.exports.sizedSvg = sizedSvg;
