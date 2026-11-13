const crypto = require('crypto');
const mongoose = require('mongoose');

const MediaAssetModel = require('../models/mediaAsset.model');
const r2StorageServiceInstance = require('./r2Storage.service');
const iaraImageClient = require('./iara/iaraImage.client');

const { MEDIA_ASSET_KINDS } = MediaAssetModel;

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const UPLOAD_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const THUMBNAIL_SIZE = 320;
const MAX_STORED_DIMENSION = 2048;
const MANAGER_ROLES = ['admin', 'coordenador', 'gestor', 'secretaria', 'diretor'];
const MAX_AI_IMAGES_PER_REQUEST = 4;
const DEFAULT_AI_DAILY_LIMIT = 60;
const PROMPT_MIN = 3;
// Professores colam a descricao de uma folha inteira (titulo, legenda,
// regras): cabe bem mais do que uma frase curta.
const PROMPT_MAX = 4000;
const STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na',
  'nos', 'nas', 'com', 'para', 'por', 'que', 'se', 'ao', 'aos', 'à', 'às', 'seu', 'sua', 'muito', 'bem',
]);

function createHttpError(message, status = 400, code = 'MEDIA_ASSET_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function extractId(value) {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getActorRoles(actor = {}) {
  const roles = [];
  if (Array.isArray(actor.roles)) roles.push(...actor.roles);
  if (actor.role) roles.push(actor.role);
  if (actor.profile) roles.push(actor.profile);
  return roles.map((role) => String(role || '').trim().toLowerCase()).filter(Boolean);
}

function detectImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function extensionFor(contentType) {
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/webp') return 'webp';
  return 'png';
}

function normalizeTags(value) {
  let list = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        list = JSON.parse(trimmed);
      } catch (_) {
        list = trimmed.split(',');
      }
    } else {
      list = trimmed.split(',');
    }
  }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((tag) => normalizeText(tag).toLowerCase()).filter(Boolean))]
    .map((tag) => tag.slice(0, 40))
    .slice(0, 20);
}

/** Palavras-chave simples a partir do pedido ("um elefante feliz" -> ["elefante", "feliz"]). */
function tagsFromPrompt(prompt) {
  return [...new Set(
    normalizeText(prompt)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word))
  )].slice(0, 8);
}

/**
 * Remove o fundo claro que encosta nas bordas da imagem (preenchimento a
 * partir das bordas). Diferente de apagar todo o branco, preserva o branco
 * DENTRO do desenho (olhos, reflexos, camisetas brancas).
 */
function isLightPixel(pixels, pixel) {
  const index = pixel * 4;
  const r = pixels[index];
  const g = pixels[index + 1];
  const b = pixels[index + 2];
  const min = Math.min(r, g, b);
  return min >= 225 && Math.max(r, g, b) - min <= 28;
}

function isDarkPixel(pixels, pixel, limit = 90) {
  const index = pixel * 4;
  return Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) < limit;
}

/**
 * Moldura escura (fundo da mesa numa foto da folha, borda de scanner):
 * se quase toda a borda e escura, remove o escuro ligado as bordas.
 * O traco preto do desenho, separado da borda por branco, fica.
 */
function removeDarkFrame(pixels, width, height) {
  let dark = 0;
  let total = 0;
  const count = (pixel) => {
    total += 1;
    if (isDarkPixel(pixels, pixel)) dark += 1;
  };
  for (let x = 0; x < width; x += 1) {
    count(x);
    count((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    count(y * width);
    count(y * width + width - 1);
  }
  if (!total || dark / total < 0.85) return false;
  const size = width * height;
  const marked = new Uint8Array(size);
  const stack = new Int32Array(size);
  let top = 0;
  // Inclui tons medios (sombra/linha da borda do papel) ligados a moldura.
  const push = (pixel) => {
    if (marked[pixel] || !isDarkPixel(pixels, pixel, 170)) return;
    marked[pixel] = 1;
    stack[top++] = pixel;
  };
  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (top > 0) {
    const pixel = stack[--top];
    const x = pixel % width;
    if (x > 0) push(pixel - 1);
    if (x < width - 1) push(pixel + 1);
    if (pixel >= width) push(pixel - width);
    if (pixel < size - width) push(pixel + width);
  }
  for (let pixel = 0; pixel < size; pixel += 1) {
    if (marked[pixel]) pixels[pixel * 4 + 3] = 0;
  }
  return true;
}

/** Fracao da borda da imagem que e branca/clara (1 = moldura toda branca). */
function lightBorderRatio(pixels, width, height) {
  let light = 0;
  let total = 0;
  const check = (pixel) => {
    total += 1;
    if (isLightPixel(pixels, pixel)) light += 1;
  };
  for (let x = 0; x < width; x += 1) {
    check(x);
    check((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    check(y * width);
    check(y * width + width - 1);
  }
  return total ? light / total : 0;
}

function removeEdgeBackground(pixels, width, height) {
  const total = width * height;
  const isBackground = (pixel) => isLightPixel(pixels, pixel);
  const marked = new Uint8Array(total);
  const stack = new Int32Array(total);
  let top = 0;
  const push = (pixel) => {
    if (marked[pixel] || !isBackground(pixel)) return;
    marked[pixel] = 1;
    stack[top++] = pixel;
  };
  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (top > 0) {
    const pixel = stack[--top];
    const x = pixel % width;
    if (x > 0) push(pixel - 1);
    if (x < width - 1) push(pixel + 1);
    if (pixel >= width) push(pixel - width);
    if (pixel < total - width) push(pixel + width);
  }
  for (let pixel = 0; pixel < total; pixel += 1) {
    const index = pixel * 4;
    if (marked[pixel]) {
      pixels[index + 3] = 0;
      continue;
    }
    // Borda suave: pixel claro encostado no fundo removido.
    const x = pixel % width;
    const touches = (x > 0 && marked[pixel - 1]) || (x < width - 1 && marked[pixel + 1])
      || (pixel >= width && marked[pixel - width]) || (pixel < total - width && marked[pixel + width]);
    if (!touches) continue;
    const lightness = Math.min(pixels[index], pixels[index + 1], pixels[index + 2]);
    if (lightness >= 200) {
      pixels[index + 3] = Math.round(pixels[index + 3] * Math.max(0, (255 - lightness) / 55));
    }
  }
}

/**
 * Retangulo que contem os pixels visiveis (alpha > 8), com uma pequena
 * margem. Null se a imagem ficou toda transparente.
 */
function visibleBounds(pixels, width, height, paddingRatio = 0.02) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = Math.round(Math.max(width, height) * paddingRatio);
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(width - 1, maxX + pad);
  const bottom = Math.min(height - 1, maxY + pad);
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Texto do professor com quebras de linha normalizadas (sem colapsar). */
function cleanMultiline(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Titulo curto para o acervo a partir de um pedido longo. */
function titleFromRequest(text) {
  const lines = cleanMultiline(text)
    .split('\n')
    .map((line) => line.replace(/[*#_>`]/g, '').trim())
    .filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^t[ií]tulo(?: da atividade)?\s*:?\s*(.*)$/i.exec(lines[index]);
    if (match) {
      const title = match[1] || lines[index + 1] || '';
      if (title) return title.slice(0, 120);
    }
  }
  return (lines[0] || 'Imagem da Iara').slice(0, 120);
}

function startOfToday(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Processamento de imagem com @napi-rs/canvas (ja dependencia do projeto).
 * Isolado para poder ser trocado nos testes.
 */
const defaultImageProcessor = {
  async inspect(buffer) {
    // eslint-disable-next-line global-require
    const { loadImage } = require('@napi-rs/canvas');
    const image = await loadImage(buffer);
    return { width: image.width, height: image.height };
  },

  async thumbnail(buffer) {
    // eslint-disable-next-line global-require
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const image = await loadImage(buffer);
    const scale = Math.min(1, THUMBNAIL_SIZE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    return canvas.toBuffer('image/png');
  },

  /**
   * Converte para PNG, limita o tamanho e (opcionalmente) troca o fundo
   * branco por transparente, para o desenho poder ficar por cima de formas.
   */
  /** Reduz a imagem de referencia antes de enviar ao modelo (menos custo). */
  async prepareReference(buffer, maxDimension = 1536) {
    // eslint-disable-next-line global-require
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const image = await loadImage(buffer);
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return { buffer: canvas.toBuffer('image/jpeg', 90), mimeType: 'image/jpeg', width, height };
  },

  async toPng(buffer, {
    transparentWhite = false,
    removeBackground = false,
    removeFrame = false,
    darkFrame = false,
    trim = false,
  } = {}) {
    // eslint-disable-next-line global-require
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const image = await loadImage(buffer);
    const scale = Math.min(1, MAX_STORED_DIMENSION / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, width, height);
    let cleared = false;
    if (darkFrame) {
      // Referencia fotografada: a IA as vezes copia a mesa/borda escura.
      const data = context.getImageData(0, 0, width, height);
      if (removeDarkFrame(data.data, width, height)) {
        context.putImageData(data, 0, 0);
        cleared = true;
      }
    }
    if (transparentWhite) {
      const data = context.getImageData(0, 0, width, height);
      const pixels = data.data;
      for (let index = 0; index < pixels.length; index += 4) {
        const lightness = Math.min(pixels[index], pixels[index + 1], pixels[index + 2]);
        if (lightness >= 245) {
          pixels[index + 3] = 0;
        } else if (lightness >= 215) {
          // Borda suave entre o traço e o fundo.
          pixels[index + 3] = Math.round(pixels[index + 3] * ((245 - lightness) / 30));
        }
      }
      context.putImageData(data, 0, 0);
    } else if (removeBackground || removeFrame) {
      const data = context.getImageData(0, 0, width, height);
      // Cena com fundo: so remove o branco se ele contorna quase toda a
      // borda (moldura ou "cartao"); nuvens claras tocando a borda ficam.
      cleared = removeBackground || lightBorderRatio(data.data, width, height) >= 0.9;
      if (cleared) {
        removeEdgeBackground(data.data, width, height);
        context.putImageData(data, 0, 0);
      }
    }
    if (trim && (transparentWhite || cleared)) {
      // Corta as margens vazias (ex.: o espaco do cabecalho removido ou a
      // moldura branca em volta de uma cena).
      const data = context.getImageData(0, 0, width, height);
      const bounds = visibleBounds(data.data, width, height);
      if (bounds && (bounds.width < width || bounds.height < height)) {
        const cropped = createCanvas(bounds.width, bounds.height);
        cropped.getContext('2d').drawImage(
          canvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height
        );
        return { buffer: cropped.toBuffer('image/png'), width: bounds.width, height: bounds.height };
      }
    }
    return { buffer: canvas.toBuffer('image/png'), width, height };
  },
};

class MediaAssetService {
  constructor({
    MediaAsset = MediaAssetModel,
    r2StorageService = r2StorageServiceInstance,
    imageClient = iaraImageClient,
    imageProcessor = defaultImageProcessor,
    now = () => new Date(),
    dailyAiLimit = null,
  } = {}) {
    this.MediaAsset = MediaAsset;
    this.r2StorageService = r2StorageService;
    this.imageClient = imageClient;
    this.imageProcessor = imageProcessor;
    this.now = now;
    this.dailyAiLimitOverride = dailyAiLimit;
  }

  get dailyAiLimit() {
    if (this.dailyAiLimitOverride !== null) return this.dailyAiLimitOverride;
    const value = Number.parseInt(process.env.IARA_IMAGE_DAILY_LIMIT_PER_SCHOOL, 10);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_AI_DAILY_LIMIT;
  }

  resolveContext(actor = {}) {
    const schoolId = extractId(actor.school_id || actor.schoolId);
    const actorId = extractId(actor.id || actor._id || actor.userId);
    if (!mongoose.Types.ObjectId.isValid(schoolId)) {
      throw createHttpError('Contexto da escola nao encontrado.', 403, 'SCHOOL_CONTEXT_REQUIRED');
    }
    if (!mongoose.Types.ObjectId.isValid(actorId)) {
      throw createHttpError('Usuario nao identificado.', 401, 'USER_REQUIRED');
    }
    const manager = getActorRoles(actor).some((role) => MANAGER_ROLES.includes(role));
    return { schoolId, actorId, manager };
  }

  canView(asset, { schoolId, actorId, manager }) {
    if (!asset || asset.status === 'archived') return false;
    if (asset.visibility === 'global') return true;
    if (extractId(asset.schoolId) !== schoolId) return false;
    if (asset.visibility === 'school') return true;
    return extractId(asset.createdByUserId) === actorId || manager;
  }

  canEdit(asset, { schoolId, actorId, manager }) {
    if (!asset || asset.visibility === 'global') return false;
    if (extractId(asset.schoolId) !== schoolId) return false;
    return extractId(asset.createdByUserId) === actorId || manager;
  }

  serialize(asset, context) {
    return {
      id: String(asset._id),
      title: asset.title || '',
      tags: asset.tags || [],
      kind: asset.kind || 'other',
      source: asset.source || 'upload',
      visibility: asset.visibility,
      contentType: asset.contentType || '',
      width: asset.width || 0,
      height: asset.height || 0,
      size: asset.size || 0,
      prompt: asset.prompt || '',
      style: asset.style || '',
      isMine: extractId(asset.createdByUserId) === context.actorId,
      canEdit: this.canEdit(asset, context),
      createdAt: asset.createdAt || null,
    };
  }

  async loadVisible(assetId, actor) {
    const context = this.resolveContext(actor);
    const id = normalizeText(assetId);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createHttpError('Imagem invalida.', 400, 'INVALID_MEDIA_ASSET_ID');
    }
    const asset = await this.MediaAsset.findById(id);
    if (!this.canView(asset, context)) {
      throw createHttpError('Imagem nao encontrada.', 404, 'MEDIA_ASSET_NOT_FOUND');
    }
    return { asset, context };
  }

  // ----------------------------------------------------------------- listar
  async listAssets(actor, filters = {}) {
    const context = this.resolveContext(actor);
    const { schoolId, actorId, manager } = context;
    const scope = normalizeText(filters.scope).toLowerCase() || 'all';

    const ownPrivate = manager
      ? { schoolId, visibility: 'private' }
      : { schoolId, visibility: 'private', createdByUserId: actorId };
    const scopes = {
      all: [{ visibility: 'global' }, { schoolId, visibility: 'school' }, ownPrivate],
      school: [{ schoolId, visibility: 'school' }],
      mine: [{ schoolId, createdByUserId: actorId }],
      global: [{ visibility: 'global' }],
    };
    const query = { status: 'active', $and: [{ $or: scopes[scope] || scopes.all }] };

    if (filters.kind && MEDIA_ASSET_KINDS.includes(String(filters.kind))) {
      query.kind = String(filters.kind);
    }
    if (filters.source && ['upload', 'ai-generated', 'ai-from-reference', 'curated'].includes(String(filters.source))) {
      query.source = String(filters.source);
    }
    // Icones do pacote integrado ficam na aba Icones do editor, nao no acervo.
    if (String(filters.includeIcons || '') !== 'true') query.iconKey = null;
    const search = normalizeText(filters.search);
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      query.$and.push({ $or: [{ title: regex }, { tags: regex }, { prompt: regex }] });
    }

    const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(filters.limit, 10) || 40));
    const [items, total] = await Promise.all([
      this.MediaAsset.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.MediaAsset.countDocuments(query),
    ]);

    return {
      items: items.map((item) => this.serialize(item, context)),
      page,
      limit,
      total,
    };
  }

  async getAsset(assetId, actor) {
    const { asset, context } = await this.loadVisible(assetId, actor);
    return this.serialize(asset, context);
  }

  async getContent(assetId, actor, { thumbnail = false } = {}) {
    const { asset } = await this.loadVisible(assetId, actor);
    const key = thumbnail && asset.thumbnailKey ? asset.thumbnailKey : asset.key;
    const buffer = await this.r2StorageService.downloadBuffer(key);
    return {
      buffer,
      contentType: thumbnail && asset.thumbnailKey ? 'image/png' : (asset.contentType || detectImageContentType(buffer)),
    };
  }

  /** Usado pelo editor ao colocar uma imagem do acervo numa atividade. */
  async getForUse(assetId, actor) {
    const { asset } = await this.loadVisible(assetId, actor);
    if (typeof this.MediaAsset.updateOne === 'function') {
      await this.MediaAsset.updateOne({ _id: asset._id }, { $inc: { usageCount: 1 } });
    }
    return asset;
  }

  // ----------------------------------------------------------------- salvar
  async storeImage({ context, buffer, contentType, fields }) {
    const assetId = new mongoose.Types.ObjectId();
    const base = `schools/${context.schoolId}/media/${String(assetId)}`;
    const key = `${base}.${extensionFor(contentType)}`;
    const thumbnailKey = `${base}.thumbnail.png`;
    const [dimensions, thumbnail] = await Promise.all([
      fields.width && fields.height
        ? { width: fields.width, height: fields.height }
        : this.imageProcessor.inspect(buffer),
      this.imageProcessor.thumbnail(buffer),
    ]);

    await this.r2StorageService.uploadBuffer({ key, buffer, contentType });
    await this.r2StorageService.uploadBuffer({ key: thumbnailKey, buffer: thumbnail, contentType: 'image/png' });

    return this.MediaAsset.create({
      _id: assetId,
      schoolId: context.schoolId,
      createdByUserId: context.actorId,
      key,
      thumbnailKey,
      contentType,
      size: buffer.length,
      width: dimensions.width || 0,
      height: dimensions.height || 0,
      status: 'active',
      ...fields,
    });
  }

  async uploadAsset(actor, file, body = {}) {
    const { asset, context } = await this.createFromUpload(actor, file, body);
    return this.serialize(asset, context);
  }

  /** Cria o MediaAsset de um upload e devolve o documento (com a chave no R2). */
  async createFromUpload(actor, file, body = {}) {
    const context = this.resolveContext(actor);
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw createHttpError('Envie um arquivo de imagem.', 400, 'MEDIA_ASSET_FILE_REQUIRED');
    }
    if (file.buffer.length > MAX_UPLOAD_BYTES) {
      throw createHttpError('Imagem acima de 8 MB.', 413, 'MEDIA_ASSET_TOO_LARGE');
    }
    const contentType = detectImageContentType(file.buffer);
    if (!UPLOAD_CONTENT_TYPES.includes(contentType)) {
      throw createHttpError('Formato nao suportado. Use PNG, JPG ou WEBP.', 400, 'MEDIA_ASSET_INVALID_TYPE');
    }
    const visibility = body.visibility === 'school' ? 'school' : 'private';
    const kind = MEDIA_ASSET_KINDS.includes(String(body.kind)) ? String(body.kind) : 'other';
    const originalName = normalizeText(file.originalname).replace(/\.[a-z0-9]+$/i, '');
    const title = (normalizeText(body.title) || originalName || 'Imagem').slice(0, 120);

    const asset = await this.storeImage({
      context,
      buffer: file.buffer,
      contentType,
      fields: {
        visibility,
        kind,
        source: 'upload',
        title,
        tags: normalizeTags(body.tags),
      },
    });
    return { asset, context };
  }

  async updateAsset(assetId, actor, payload = {}) {
    const { asset, context } = await this.loadVisible(assetId, actor);
    if (!this.canEdit(asset, context)) {
      throw createHttpError('Voce nao pode alterar esta imagem.', 403, 'MEDIA_ASSET_FORBIDDEN');
    }
    if (payload.title !== undefined) asset.title = normalizeText(payload.title).slice(0, 120);
    if (payload.tags !== undefined) asset.tags = normalizeTags(payload.tags);
    if (payload.visibility !== undefined) {
      if (!['school', 'private'].includes(String(payload.visibility))) {
        throw createHttpError('Visibilidade invalida.', 400, 'INVALID_MEDIA_ASSET_VISIBILITY');
      }
      asset.visibility = String(payload.visibility);
    }
    if (payload.kind !== undefined && MEDIA_ASSET_KINDS.includes(String(payload.kind))) {
      asset.kind = String(payload.kind);
    }
    await asset.save();
    return this.serialize(asset, context);
  }

  /**
   * Arquiva (nao apaga o arquivo): atividades que ja usam a imagem
   * continuam funcionando e imprimindo.
   */
  async archiveAsset(assetId, actor) {
    const { asset, context } = await this.loadVisible(assetId, actor);
    if (!this.canEdit(asset, context)) {
      throw createHttpError('Voce nao pode remover esta imagem.', 403, 'MEDIA_ASSET_FORBIDDEN');
    }
    asset.status = 'archived';
    asset.archivedAt = this.now();
    await asset.save();
    return { id: String(asset._id), status: asset.status };
  }

  // --------------------------------------------------------------- Iara
  async getAiQuota(actor) {
    const { schoolId } = this.resolveContext(actor);
    const used = await this.MediaAsset.countDocuments({
      schoolId,
      source: { $in: ['ai-generated', 'ai-from-reference'] },
      createdAt: { $gte: startOfToday(this.now()) },
    });
    const limit = this.dailyAiLimit;
    return {
      limit,
      used,
      remaining: Math.max(0, limit - used),
      styles: Object.entries(this.imageClient.IMAGE_STYLES).map(([id, style]) => ({ id, label: style.label })),
    };
  }

  _resolveStyle(payload) {
    return Object.prototype.hasOwnProperty.call(this.imageClient.IMAGE_STYLES, payload.style)
      ? payload.style
      : 'lineart';
  }

  /**
   * Como tratar o fundo da imagem gerada:
   * - para colorir: todo o branco vira transparente (o papel ja e branco);
   * - icone: idem;
   * - colorido: "sem fundo" remove o branco que encosta nas bordas
   *   (preserva o branco dentro do desenho); "com fundo" mantem tudo.
   * `transparentBackground` (versoes antigas do app) continua aceito.
   */
  _resolveBackground(style, payload) {
    if (payload.transparentBackground !== undefined && payload.background === undefined) {
      const transparent = payload.transparentBackground === true || payload.transparentBackground === 'true';
      return {
        background: transparent ? 'transparent' : 'scene',
        processing: transparent ? { transparentWhite: true } : { transparentWhite: false },
      };
    }
    if (style !== 'color') {
      return { background: 'transparent', processing: { transparentWhite: true, trim: true } };
    }
    const background = this.imageClient.normalizeBackground
      ? this.imageClient.normalizeBackground(payload.background)
      : (payload.background === 'scene' ? 'scene' : 'transparent');
    // Com cenario, uma moldura/cartao branco que o modelo as vezes desenha
    // em volta da cena sai e a imagem e recortada.
    return {
      background,
      processing: background === 'scene'
        ? { transparentWhite: false, removeFrame: true, trim: true }
        : { transparentWhite: false, removeBackground: true, trim: true },
    };
  }

  _resolveCount(payload) {
    return Math.min(MAX_AI_IMAGES_PER_REQUEST, Math.max(1, Number.parseInt(payload.count, 10) || 2));
  }

  async _ensureAiQuota(actor, count) {
    const quota = await this.getAiQuota(actor);
    if (quota.remaining < count) {
      throw createHttpError(
        quota.remaining === 0
          ? 'A escola atingiu o limite diario de imagens da Iara. Tente novamente amanha.'
          : `Restam ${quota.remaining} imagem(ns) da Iara hoje para a escola.`,
        429,
        'IARA_IMAGE_DAILY_LIMIT'
      );
    }
    return quota;
  }

  /** Gera `count` imagens com o mesmo pedido e guarda as que deram certo. */
  async _generateAndStore({ context, quota, count, request, processing, fields }) {
    const results = await Promise.allSettled(
      Array.from({ length: count }, () => this.imageClient.generateImage(request))
    );

    const items = [];
    let firstError = null;
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        firstError = firstError || result.reason;
        continue;
      }
      const png = await this.imageProcessor.toPng(result.value.buffer, processing);
      const asset = await this.storeImage({
        context,
        buffer: png.buffer,
        contentType: 'image/png',
        fields: {
          ...fields,
          model: result.value.model || '',
          attribution: 'Gerada pela Iara (AcademyHub)',
          width: png.width,
          height: png.height,
        },
      });
      items.push(this.serialize(asset, context));
    }

    if (items.length === 0) {
      throw firstError || createHttpError('Nao foi possivel gerar a imagem agora.', 502, 'IARA_IMAGE_FAILED');
    }

    return {
      items,
      failed: count - items.length,
      remainingToday: Math.max(0, quota.remaining - items.length),
    };
  }

  async generateWithAi(actor, payload = {}) {
    const context = this.resolveContext(actor);
    const raw = cleanMultiline(payload.prompt);
    const subject = raw.replace(/\s+/g, ' ');
    if (subject.length < PROMPT_MIN) {
      throw createHttpError('Descreva a imagem que voce quer (ex.: "um elefante feliz").', 400, 'IARA_IMAGE_PROMPT_REQUIRED');
    }
    if (subject.length > PROMPT_MAX) {
      throw createHttpError(`Descricao muito longa (maximo ${PROMPT_MAX} caracteres).`, 400, 'IARA_IMAGE_PROMPT_TOO_LONG');
    }
    const style = this._resolveStyle(payload);
    const count = this._resolveCount(payload);
    const quota = await this._ensureAiQuota(actor, count);
    const { background, processing } = this._resolveBackground(style, payload);
    // Descricao de uma folha inteira: o pedido do professor manda e a imagem
    // sai em pe (proporcao de pagina).
    const detailed = this.imageClient.isDetailedRequest
      ? this.imageClient.isDetailedRequest(raw)
      : false;
    // Os textos da folha (titulo, legendas) sao listados antes pelo modelo
    // de texto, para o de imagem escrever sem erros de digitacao.
    const requiredTexts = detailed && this.imageClient.extractRequiredTexts
      ? await this.imageClient.extractRequiredTexts({ request: raw })
      : [];
    const request = detailed
      ? {
        prompt: this.imageClient.buildDetailedPrompt(raw, style, { background, requiredTexts }),
        aspectRatio: '2:3',
        // Folha com titulo e legendas: modelo que escreve melhor.
        models: this.imageClient.getTextImageModelNames?.(),
      }
      : { prompt: this.imageClient.buildPrompt(subject, style, { background }) };

    return this._generateAndStore({
      context,
      quota,
      count,
      request,
      processing,
      fields: {
        visibility: 'school',
        kind: this.imageClient.IMAGE_STYLES[style].kind,
        source: 'ai-generated',
        title: detailed ? titleFromRequest(raw) : subject.slice(0, 120),
        tags: tagsFromPrompt(subject),
        prompt: detailed ? raw : subject,
        style,
      },
    });
  }

  /**
   * Recria o desenho de uma imagem de referencia (print de livro, foto ou
   * PDF de atividade), sem textos nem cabecalho, com ajustes opcionais
   * pedidos pelo professor. A referencia nao e guardada.
   */
  async generateFromReference(actor, file, payload = {}) {
    const context = this.resolveContext(actor);
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw createHttpError('Envie a imagem de referencia.', 400, 'IARA_REFERENCE_REQUIRED');
    }
    if (file.buffer.length > MAX_UPLOAD_BYTES) {
      throw createHttpError('Imagem acima de 8 MB.', 413, 'IARA_REFERENCE_TOO_LARGE');
    }
    const contentType = detectImageContentType(file.buffer);
    if (!UPLOAD_CONTENT_TYPES.includes(contentType)) {
      throw createHttpError('Formato nao suportado. Use PNG, JPG ou WEBP.', 400, 'IARA_REFERENCE_INVALID_TYPE');
    }
    const instructions = cleanMultiline(payload.instructions || payload.prompt);
    const keepText = payload.keepText === true || payload.keepText === 'true';
    if (instructions.length > PROMPT_MAX) {
      throw createHttpError(`Pedido muito longo (maximo ${PROMPT_MAX} caracteres).`, 400, 'IARA_IMAGE_PROMPT_TOO_LONG');
    }
    const style = this._resolveStyle(payload);
    const count = this._resolveCount(payload);
    const quota = await this._ensureAiQuota(actor, count);
    const { background, processing } = this._resolveBackground(style, payload);

    let reference;
    try {
      reference = await this.imageProcessor.prepareReference(file.buffer);
    } catch (error) {
      throw createHttpError('Nao foi possivel ler a imagem de referencia.', 400, 'IARA_REFERENCE_INVALID');
    }
    const referencePart = {
      inlineData: { mimeType: reference.mimeType, data: reference.buffer.toString('base64') },
    };
    // Manter o enunciado: o modelo de texto le o enunciado antes, para o de
    // imagem escrever as palavras certas.
    const transcribedText = keepText && this.imageClient.transcribeReferenceText
      ? await this.imageClient.transcribeReferenceText({ imagePart: referencePart })
      : '';
    const aspectRatio = style === 'icon'
      ? '1:1'
      : this.imageClient.closestAspectRatio(reference.width, reference.height);
    const title = instructions || 'Desenho a partir de referencia';

    return this._generateAndStore({
      context,
      quota,
      count,
      request: {
        prompt: this.imageClient.buildReferencePrompt({
          instructions, style, background, keepText, transcribedText,
        }),
        extraParts: [referencePart],
        ...(keepText ? { models: this.imageClient.getTextImageModelNames?.() } : {}),
        aspectRatio,
      },
      processing: { ...processing, darkFrame: true },
      fields: {
        visibility: 'school',
        kind: this.imageClient.IMAGE_STYLES[style].kind,
        source: 'ai-from-reference',
        title: title.slice(0, 120),
        tags: tagsFromPrompt(instructions),
        prompt: instructions,
        style,
      },
    });
  }

  // ------------------------------------------------------------ curadoria
  /** Upload de imagem global (curadoria do AcademyHub, via plataforma). */
  async uploadGlobalAsset(platformAdminId, file, body = {}) {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw createHttpError('Envie um arquivo de imagem.', 400, 'MEDIA_ASSET_FILE_REQUIRED');
    }
    const contentType = detectImageContentType(file.buffer);
    if (!UPLOAD_CONTENT_TYPES.includes(contentType)) {
      throw createHttpError('Formato nao suportado. Use PNG, JPG ou WEBP.', 400, 'MEDIA_ASSET_INVALID_TYPE');
    }
    const assetId = new mongoose.Types.ObjectId();
    const base = `platform/media/${String(assetId)}`;
    const key = `${base}.${extensionFor(contentType)}`;
    const thumbnailKey = `${base}.thumbnail.png`;
    const [dimensions, thumbnail] = await Promise.all([
      this.imageProcessor.inspect(file.buffer),
      this.imageProcessor.thumbnail(file.buffer),
    ]);
    await this.r2StorageService.uploadBuffer({ key, buffer: file.buffer, contentType });
    await this.r2StorageService.uploadBuffer({ key: thumbnailKey, buffer: thumbnail, contentType: 'image/png' });
    const asset = await this.MediaAsset.create({
      _id: assetId,
      schoolId: null,
      visibility: 'global',
      createdByPlatformAdminId: platformAdminId || null,
      key,
      thumbnailKey,
      contentType,
      size: file.buffer.length,
      width: dimensions.width || 0,
      height: dimensions.height || 0,
      title: (normalizeText(body.title) || normalizeText(file.originalname) || 'Imagem').slice(0, 120),
      tags: normalizeTags(body.tags),
      kind: MEDIA_ASSET_KINDS.includes(String(body.kind)) ? String(body.kind) : 'lineart',
      source: 'curated',
      attribution: normalizeText(body.attribution).slice(0, 300),
      status: 'active',
    });
    return { id: String(asset._id), title: asset.title, key: asset.key };
  }

  async archiveGlobalAsset(assetId) {
    const id = normalizeText(assetId);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw createHttpError('Imagem invalida.', 400, 'INVALID_MEDIA_ASSET_ID');
    }
    const asset = await this.MediaAsset.findById(id);
    if (!asset || asset.visibility !== 'global') {
      throw createHttpError('Imagem global nao encontrada.', 404, 'MEDIA_ASSET_NOT_FOUND');
    }
    asset.status = 'archived';
    asset.archivedAt = this.now();
    await asset.save();
    return { id, status: 'archived' };
  }
}

module.exports = new MediaAssetService();
module.exports.MediaAssetService = MediaAssetService;
module.exports.tagsFromPrompt = tagsFromPrompt;
module.exports.normalizeTags = normalizeTags;
module.exports.defaultImageProcessor = defaultImageProcessor;
module.exports.removeEdgeBackground = removeEdgeBackground;
module.exports.removeDarkFrame = removeDarkFrame;
