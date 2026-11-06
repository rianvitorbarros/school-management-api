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
const PROMPT_MAX = 300;
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
  async toPng(buffer, { transparentWhite = false } = {}) {
    // eslint-disable-next-line global-require
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const image = await loadImage(buffer);
    const scale = Math.min(1, MAX_STORED_DIMENSION / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, width, height);
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

  async generateWithAi(actor, payload = {}) {
    const context = this.resolveContext(actor);
    const subject = normalizeText(payload.prompt).replace(/\s+/g, ' ');
    if (subject.length < PROMPT_MIN) {
      throw createHttpError('Descreva a imagem que voce quer (ex.: "um elefante feliz").', 400, 'IARA_IMAGE_PROMPT_REQUIRED');
    }
    if (subject.length > PROMPT_MAX) {
      throw createHttpError(`Descricao muito longa (maximo ${PROMPT_MAX} caracteres).`, 400, 'IARA_IMAGE_PROMPT_TOO_LONG');
    }
    const style = Object.prototype.hasOwnProperty.call(this.imageClient.IMAGE_STYLES, payload.style)
      ? payload.style
      : 'lineart';
    const count = Math.min(MAX_AI_IMAGES_PER_REQUEST, Math.max(1, Number.parseInt(payload.count, 10) || 2));

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

    const prompt = this.imageClient.buildPrompt(subject, style);
    const transparentWhite = payload.transparentBackground !== undefined
      ? payload.transparentBackground === true || payload.transparentBackground === 'true'
      : style !== 'color';

    const results = await Promise.allSettled(
      Array.from({ length: count }, () => this.imageClient.generateImage({ prompt }))
    );

    const items = [];
    let firstError = null;
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        firstError = firstError || result.reason;
        continue;
      }
      const png = await this.imageProcessor.toPng(result.value.buffer, { transparentWhite });
      const asset = await this.storeImage({
        context,
        buffer: png.buffer,
        contentType: 'image/png',
        fields: {
          visibility: 'school',
          kind: this.imageClient.IMAGE_STYLES[style].kind,
          source: 'ai-generated',
          title: subject.slice(0, 120),
          tags: tagsFromPrompt(subject),
          prompt: subject,
          style,
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
