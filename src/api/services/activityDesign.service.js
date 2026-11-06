const crypto = require('crypto');
const mongoose = require('mongoose');

const ActivityDesignModel = require('../models/activityDesign.model');
const ActivityBookModel = require('../models/activityBook.model');
const ActivityPageModel = require('../models/activityPage.model');
const r2StorageServiceInstance = require('./r2Storage.service');

const {
  ACTIVITY_DESIGN_ELEMENT_TYPES,
  ACTIVITY_DESIGN_HEADER_HEIGHT_PCT,
  ACTIVITY_DESIGN_FOOTER_HEIGHT_PCT,
  ACTIVITY_DESIGN_MAX_PAGES,
  ACTIVITY_DESIGN_MAX_ELEMENTS_PER_PAGE,
} = ActivityDesignModel;

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const MAX_ELEMENT_JSON_BYTES = 64 * 1024;
const MAX_PAGES_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_RENDERED_PAGE_BYTES = 15 * 1024 * 1024;
const MAX_ASSETS_PER_DESIGN = 300;
const THUMBNAIL_WIDTH = 600;
const ASSET_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const RENDERED_PAGE_CONTENT_TYPES = ['image/png', 'image/jpeg'];
const MANAGER_ROLES = ['admin', 'coordenador', 'gestor', 'secretaria', 'diretor'];
const STORAGE_BASE_PREFIX = 'schools';

function createHttpError(message, status = 400, code = 'ACTIVITY_DESIGN_ERROR') {
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

function sameId(left, right) {
  return extractId(left) !== '' && extractId(left) === extractId(right);
}

function ensureObjectId(id, code, message) {
  const normalized = normalizeText(id);
  if (!mongoose.Types.ObjectId.isValid(normalized)) {
    throw createHttpError(message, 400, code);
  }
  return normalized;
}

function getActorId(actor = {}) {
  return extractId(actor.id || actor._id || actor.userId);
}

function getSchoolId(actor = {}) {
  return extractId(actor.school_id || actor.schoolId);
}

function getActorRoles(actor = {}) {
  const roles = [];
  if (Array.isArray(actor.roles)) roles.push(...actor.roles);
  if (actor.role) roles.push(actor.role);
  if (actor.profile) roles.push(actor.profile);
  return roles.map((role) => String(role || '').trim().toLowerCase()).filter(Boolean);
}

function isManager(actor = {}) {
  return getActorRoles(actor).some((role) => MANAGER_ROLES.includes(role));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseJsonMaybe(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    throw createHttpError('JSON invalido no payload.', 400, 'INVALID_JSON');
  }
}

function normalizeTags(value) {
  const parsed = parseJsonMaybe(value);
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'string'
      ? parsed.split(',')
      : [];
  return [...new Set(list.map((tag) => normalizeText(tag).toLowerCase()).filter(Boolean))].slice(0, 30);
}

function extensionForContentType(contentType) {
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/webp') return 'webp';
  return 'png';
}

function detectImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

/**
 * Valida um elemento do editor. O formato e propositalmente aberto em `props`
 * (cada tipo tem suas propriedades visuais), mas a geometria e o tipo sao
 * estritos para que o documento continue renderizavel.
 */
function sanitizeElement(rawElement, { pageIndex, elementIndex, assetIds }) {
  const where = `pagina ${pageIndex + 1}, elemento ${elementIndex + 1}`;
  if (!rawElement || typeof rawElement !== 'object' || Array.isArray(rawElement)) {
    throw createHttpError(`Elemento invalido (${where}).`, 400, 'INVALID_DESIGN_ELEMENT');
  }

  const id = normalizeText(rawElement.id);
  if (!id || id.length > 64) {
    throw createHttpError(`Elemento sem id valido (${where}).`, 400, 'INVALID_DESIGN_ELEMENT');
  }

  const type = normalizeText(rawElement.type);
  if (!ACTIVITY_DESIGN_ELEMENT_TYPES.includes(type)) {
    throw createHttpError(`Tipo de elemento nao suportado: "${type}" (${where}).`, 400, 'INVALID_DESIGN_ELEMENT_TYPE');
  }

  const geometry = {};
  for (const field of ['x', 'y', 'w', 'h']) {
    const value = rawElement[field];
    // Coordenadas percentuais da area util. Permitimos sair um pouco da area
    // durante a edicao; o que estiver fora e cortado na exportacao.
    if (!isFiniteNumber(value) || value < -100 || value > 200) {
      throw createHttpError(`Geometria invalida em "${field}" (${where}).`, 400, 'INVALID_DESIGN_GEOMETRY');
    }
    geometry[field] = value;
  }
  if (geometry.w <= 0 || geometry.h <= 0) {
    throw createHttpError(`Largura e altura precisam ser positivas (${where}).`, 400, 'INVALID_DESIGN_GEOMETRY');
  }

  const rotation = rawElement.rotation === undefined ? 0 : rawElement.rotation;
  if (!isFiniteNumber(rotation)) {
    throw createHttpError(`Rotacao invalida (${where}).`, 400, 'INVALID_DESIGN_GEOMETRY');
  }

  const props = rawElement.props === undefined ? {} : rawElement.props;
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    throw createHttpError(`Propriedades invalidas (${where}).`, 400, 'INVALID_DESIGN_ELEMENT');
  }

  if (type === 'image') {
    const assetId = normalizeText(props.assetId);
    if (!assetId || !assetIds.has(assetId)) {
      throw createHttpError(`Imagem sem arquivo enviado (${where}).`, 400, 'INVALID_DESIGN_ASSET');
    }
  }

  const element = {
    id,
    type,
    ...geometry,
    rotation: ((rotation % 360) + 360) % 360,
    locked: rawElement.locked === true,
    props,
  };

  if (Buffer.byteLength(JSON.stringify(element), 'utf8') > MAX_ELEMENT_JSON_BYTES) {
    throw createHttpError(`Elemento muito grande (${where}).`, 400, 'DESIGN_ELEMENT_TOO_LARGE');
  }

  return element;
}

function sanitizePages(rawPages, { assetIds }) {
  const parsed = parseJsonMaybe(rawPages);
  if (!Array.isArray(parsed)) {
    throw createHttpError('pages deve ser uma lista.', 400, 'INVALID_DESIGN_PAGES');
  }
  if (parsed.length === 0) {
    throw createHttpError('A atividade precisa ter ao menos uma pagina.', 400, 'INVALID_DESIGN_PAGES');
  }
  if (parsed.length > ACTIVITY_DESIGN_MAX_PAGES) {
    throw createHttpError(`Limite de ${ACTIVITY_DESIGN_MAX_PAGES} paginas por atividade.`, 400, 'DESIGN_TOO_MANY_PAGES');
  }
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_PAGES_JSON_BYTES) {
    throw createHttpError('Atividade muito grande para salvar.', 413, 'DESIGN_TOO_LARGE');
  }

  const seenPageKeys = new Set();
  return parsed.map((rawPage, pageIndex) => {
    if (!rawPage || typeof rawPage !== 'object') {
      throw createHttpError(`Pagina ${pageIndex + 1} invalida.`, 400, 'INVALID_DESIGN_PAGES');
    }
    const pageKey = normalizeText(rawPage.pageKey) || crypto.randomUUID();
    if (seenPageKeys.has(pageKey) || pageKey.length > 64) {
      throw createHttpError(`Identificador da pagina ${pageIndex + 1} invalido.`, 400, 'INVALID_DESIGN_PAGES');
    }
    seenPageKeys.add(pageKey);

    const elements = Array.isArray(rawPage.elements) ? rawPage.elements : [];
    if (elements.length > ACTIVITY_DESIGN_MAX_ELEMENTS_PER_PAGE) {
      throw createHttpError(
        `Limite de ${ACTIVITY_DESIGN_MAX_ELEMENTS_PER_PAGE} elementos por pagina (pagina ${pageIndex + 1}).`,
        400,
        'DESIGN_TOO_MANY_ELEMENTS'
      );
    }

    const seenElementIds = new Set();
    const sanitizedElements = elements.map((element, elementIndex) => {
      const sanitized = sanitizeElement(element, { pageIndex, elementIndex, assetIds });
      if (seenElementIds.has(sanitized.id)) {
        throw createHttpError(`Elemento duplicado na pagina ${pageIndex + 1}.`, 400, 'INVALID_DESIGN_ELEMENT');
      }
      seenElementIds.add(sanitized.id);
      return sanitized;
    });

    const background = normalizeText(rawPage.background) || '#FFFFFF';
    if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(background)) {
      throw createHttpError(`Cor de fundo invalida (pagina ${pageIndex + 1}).`, 400, 'INVALID_DESIGN_PAGES');
    }

    return {
      pageKey,
      background,
      elements: sanitizedElements,
    };
  });
}

function blankPage() {
  return { pageKey: crypto.randomUUID(), background: '#FFFFFF', elements: [] };
}

class ActivityDesignService {
  constructor({
    ActivityDesign = ActivityDesignModel,
    ActivityBook = ActivityBookModel,
    ActivityPage = ActivityPageModel,
    r2StorageService = r2StorageServiceInstance,
    mediaAssetService = null,
    thumbnailMaker = null,
    now = () => new Date(),
  } = {}) {
    this.ActivityDesign = ActivityDesign;
    this.ActivityBook = ActivityBook;
    this.ActivityPage = ActivityPage;
    this.r2StorageService = r2StorageService;
    this.mediaAssetServiceOverride = mediaAssetService;
    this.thumbnailMaker = thumbnailMaker || ((buffer) => this.makeThumbnail(buffer));
    this.now = now;
  }

  get mediaAssetService() {
    // Carregado sob demanda para evitar dependencia circular nos testes.
    // eslint-disable-next-line global-require
    return this.mediaAssetServiceOverride || require('./mediaAsset.service');
  }

  getEditorConfig() {
    return {
      page: {
        format: 'A4',
        widthPt: A4_WIDTH_PT,
        heightPt: A4_HEIGHT_PT,
        headerHeightPct: ACTIVITY_DESIGN_HEADER_HEIGHT_PCT,
        footerHeightPct: ACTIVITY_DESIGN_FOOTER_HEIGHT_PCT,
      },
      limits: {
        maxPages: ACTIVITY_DESIGN_MAX_PAGES,
        maxElementsPerPage: ACTIVITY_DESIGN_MAX_ELEMENTS_PER_PAGE,
        maxAssetBytes: MAX_ASSET_BYTES,
        maxRenderedPageBytes: MAX_RENDERED_PAGE_BYTES,
        assetContentTypes: ASSET_CONTENT_TYPES,
      },
      elementTypes: ACTIVITY_DESIGN_ELEMENT_TYPES,
    };
  }

  resolveContext(actor) {
    const schoolId = getSchoolId(actor);
    const actorId = getActorId(actor);
    if (!mongoose.Types.ObjectId.isValid(schoolId)) {
      throw createHttpError('Contexto da escola nao encontrado.', 403, 'SCHOOL_CONTEXT_REQUIRED');
    }
    if (!mongoose.Types.ObjectId.isValid(actorId)) {
      throw createHttpError('Usuario nao identificado.', 401, 'USER_REQUIRED');
    }
    return { schoolId, actorId, manager: isManager(actor) };
  }

  async loadDesign(designId, actor, { forWrite = false } = {}) {
    const { schoolId, actorId, manager } = this.resolveContext(actor);
    const normalizedId = ensureObjectId(designId, 'INVALID_DESIGN_ID', 'Atividade invalida.');
    const design = await this.ActivityDesign.findOne({ _id: normalizedId, schoolId });
    if (!design || (design.status === 'archived' && forWrite)) {
      throw createHttpError('Atividade nao encontrada.', 404, 'DESIGN_NOT_FOUND');
    }
    const isOwner = sameId(design.createdByUserId, actorId);
    if (!isOwner && !manager) {
      throw createHttpError('Voce nao tem acesso a esta atividade.', 403, 'DESIGN_FORBIDDEN');
    }
    return { design, schoolId, actorId, manager };
  }

  serialize(design) {
    const plain = typeof design.toObject === 'function'
      ? design.toObject({ minimize: false })
      : { ...design };
    const revision = Number(plain.revision || 0);
    const publishedRevision = plain.publishedRevision === null || plain.publishedRevision === undefined
      ? null
      : Number(plain.publishedRevision);

    return {
      id: String(plain._id),
      schoolId: String(plain.schoolId),
      createdByUserId: plain.createdByUserId ? String(plain.createdByUserId) : null,
      classId: plain.classId ? String(plain.classId) : null,
      title: plain.title,
      description: plain.description || '',
      subject: plain.subject || '',
      segment: plain.segment || '',
      grade: plain.grade || '',
      tags: plain.tags || [],
      headerHeightPct: Number(plain.headerHeightPct || ACTIVITY_DESIGN_HEADER_HEIGHT_PCT),
      footerHeightPct: Number(plain.footerHeightPct ?? ACTIVITY_DESIGN_FOOTER_HEIGHT_PCT),
      pages: (plain.pages || []).map((page) => ({
        pageKey: page.pageKey,
        background: page.background || '#FFFFFF',
        elements: page.elements || [],
        hasRenderedImage: Boolean(page.renderedImageKey),
      })),
      assets: (plain.assets || []).map((asset) => ({
        assetId: asset.assetId,
        mediaAssetId: asset.mediaAssetId ? String(asset.mediaAssetId) : null,
        contentType: asset.contentType || '',
        originalName: asset.originalName || '',
        size: asset.size || 0,
      })),
      status: plain.status,
      revision,
      publishedRevision,
      hasUnpublishedChanges: plain.status === 'published' && publishedRevision !== revision,
      publishedBookId: plain.publishedBookId ? String(plain.publishedBookId) : null,
      publishedAt: plain.publishedAt || null,
      createdAt: plain.createdAt || null,
      updatedAt: plain.updatedAt || null,
    };
  }

  serializeSummary(design) {
    const full = this.serialize(design);
    const { pages, assets, ...summary } = full;
    return {
      ...summary,
      pageCount: pages.length,
      firstPageThumbnailKey: design.pages?.[0]?.renderedThumbnailKey || '',
    };
  }

  async listDesigns(actor, filters = {}) {
    const { schoolId, actorId, manager } = this.resolveContext(actor);
    const query = { schoolId, status: { $ne: 'archived' } };

    const scope = normalizeText(filters.scope).toLowerCase();
    if (!(manager && scope === 'school')) {
      query.createdByUserId = actorId;
    }
    if (filters.status && ['draft', 'published'].includes(String(filters.status))) {
      query.status = String(filters.status);
    }
    if (filters.classId && mongoose.Types.ObjectId.isValid(String(filters.classId))) {
      query.classId = String(filters.classId);
    }
    if (filters.search) {
      const escaped = String(filters.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.title = new RegExp(escaped, 'i');
    }

    const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(filters.limit, 10) || 30));

    const [items, total] = await Promise.all([
      this.ActivityDesign.find(query)
        .select('-pages.elements -assets')
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      this.ActivityDesign.countDocuments(query),
    ]);

    const summaries = await Promise.all(items.map(async (item) => {
      const summary = this.serializeSummary(item);
      let thumbnailUrl = '';
      if (summary.firstPageThumbnailKey) {
        try {
          const signed = await this.r2StorageService.getSignedDownloadUrl(summary.firstPageThumbnailKey, 900);
          thumbnailUrl = signed?.url || '';
        } catch (_) {
          thumbnailUrl = '';
        }
      }
      const { firstPageThumbnailKey, ...rest } = summary;
      return { ...rest, thumbnailUrl };
    }));

    return { items: summaries, page, limit, total };
  }

  async getDesign(designId, actor) {
    const { design } = await this.loadDesign(designId, actor);
    return this.serialize(design);
  }

  applyMetadata(design, payload = {}) {
    if (payload.title !== undefined) {
      const title = normalizeText(payload.title);
      if (!title) throw createHttpError('Informe o titulo da atividade.', 400, 'DESIGN_TITLE_REQUIRED');
      design.title = title.slice(0, 160);
    }
    for (const field of ['description', 'subject', 'segment', 'grade']) {
      if (payload[field] !== undefined) {
        design[field] = normalizeText(payload[field]).slice(0, field === 'description' ? 1000 : 120);
      }
    }
    if (payload.tags !== undefined) design.tags = normalizeTags(payload.tags);
    if (payload.classId !== undefined) {
      const classId = normalizeText(payload.classId);
      design.classId = classId && mongoose.Types.ObjectId.isValid(classId) ? classId : null;
    }
  }

  async createDesign(actor, payload = {}) {
    const { schoolId, actorId } = this.resolveContext(actor);
    const title = normalizeText(payload.title) || 'Nova atividade';
    const design = new this.ActivityDesign({
      schoolId,
      createdByUserId: actorId,
      updatedByUserId: actorId,
      title,
      headerHeightPct: ACTIVITY_DESIGN_HEADER_HEIGHT_PCT,
      footerHeightPct: ACTIVITY_DESIGN_FOOTER_HEIGHT_PCT,
      pages: [blankPage()],
      assets: [],
      status: 'draft',
      revision: 0,
    });
    this.applyMetadata(design, { ...payload, title });

    if (payload.pages !== undefined) {
      design.pages = sanitizePages(payload.pages, { assetIds: new Set() });
    }

    await design.save();
    return this.serialize(design);
  }

  async updateDesign(designId, actor, payload = {}) {
    const { design, actorId } = await this.loadDesign(designId, actor, { forWrite: true });

    if (payload.revision !== undefined && payload.revision !== null) {
      const expected = Number(payload.revision);
      if (!Number.isInteger(expected) || expected !== Number(design.revision || 0)) {
        throw createHttpError(
          'Esta atividade foi alterada em outra janela. Recarregue para continuar.',
          409,
          'DESIGN_REVISION_CONFLICT'
        );
      }
    }

    this.applyMetadata(design, payload);

    if (payload.pages !== undefined) {
      const assetIds = new Set((design.assets || []).map((asset) => asset.assetId));
      const sanitized = sanitizePages(payload.pages, { assetIds });
      const previousByKey = new Map((design.pages || []).map((page) => [page.pageKey, page]));
      design.pages = sanitized.map((page) => {
        const previous = previousByKey.get(page.pageKey);
        return {
          ...page,
          renderedImageKey: previous?.renderedImageKey || '',
          renderedImageContentType: previous?.renderedImageContentType || '',
          renderedThumbnailKey: previous?.renderedThumbnailKey || '',
          renderedAt: previous?.renderedAt || null,
        };
      });
      if (typeof design.markModified === 'function') design.markModified('pages');
    }

    design.revision = Number(design.revision || 0) + 1;
    design.updatedByUserId = actorId;
    await design.save();
    return this.serialize(design);
  }

  async duplicateDesign(designId, actor) {
    const { design, schoolId, actorId } = await this.loadDesign(designId, actor);
    const source = typeof design.toObject === 'function' ? design.toObject({ minimize: false }) : design;
    const copy = new this.ActivityDesign({
      schoolId,
      createdByUserId: actorId,
      updatedByUserId: actorId,
      classId: source.classId || null,
      title: `${source.title} (copia)`.slice(0, 160),
      description: source.description || '',
      subject: source.subject || '',
      segment: source.segment || '',
      grade: source.grade || '',
      tags: source.tags || [],
      headerHeightPct: source.headerHeightPct,
      footerHeightPct: source.footerHeightPct,
      // A copia reaproveita os mesmos arquivos de imagem (as chaves no R2
      // sao imutaveis), mas comeca sem publicacao propria.
      pages: (source.pages || []).map((page) => ({
        pageKey: page.pageKey,
        background: page.background || '#FFFFFF',
        elements: JSON.parse(JSON.stringify(page.elements || [])),
      })),
      assets: (source.assets || []).map((asset) => ({ ...asset })),
      status: 'draft',
      revision: 0,
    });
    await copy.save();
    return this.serialize(copy);
  }

  async archiveDesign(designId, actor) {
    const { design, actorId } = await this.loadDesign(designId, actor, { forWrite: true });
    design.status = 'archived';
    design.archivedAt = this.now();
    design.updatedByUserId = actorId;
    await design.save();

    if (design.publishedBookId) {
      await this.ActivityBook.updateOne(
        { _id: design.publishedBookId, sourceType: 'school' },
        { $set: { status: 'archived' } }
      );
    }
    return { id: String(design._id), status: design.status };
  }

  async uploadAsset(designId, actor, file) {
    const { design, actorId } = await this.loadDesign(designId, actor, { forWrite: true });
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw createHttpError('Envie um arquivo de imagem.', 400, 'DESIGN_ASSET_REQUIRED');
    }
    if (file.buffer.length > MAX_ASSET_BYTES) {
      throw createHttpError('Imagem acima de 8 MB.', 413, 'DESIGN_ASSET_TOO_LARGE');
    }
    const contentType = detectImageContentType(file.buffer);
    if (!ASSET_CONTENT_TYPES.includes(contentType)) {
      throw createHttpError('Formato nao suportado. Use PNG, JPG ou WEBP.', 400, 'DESIGN_ASSET_INVALID_TYPE');
    }
    if ((design.assets || []).length >= MAX_ASSETS_PER_DESIGN) {
      throw createHttpError('Limite de imagens desta atividade atingido.', 400, 'DESIGN_TOO_MANY_ASSETS');
    }

    // O arquivo vai para o acervo da escola (privado do professor) e a
    // atividade guarda uma referencia, para ele reaproveitar depois.
    const { asset: media } = await this.mediaAssetService.createFromUpload(actor, file, {
      visibility: 'private',
    });
    return this.appendDesignAsset(design, {
      key: media.key,
      contentType: media.contentType || contentType,
      originalName: normalizeText(file.originalname).slice(0, 200),
      size: file.buffer.length,
      uploadedByUserId: actorId,
      mediaAssetId: media._id,
    });
  }

  /** Coloca uma imagem do acervo (MediaAsset) na atividade, sem reenviar o arquivo. */
  async attachLibraryAsset(designId, actor, mediaAssetId) {
    const { design, actorId } = await this.loadDesign(designId, actor, { forWrite: true });
    const existing = (design.assets || []).find(
      (item) => item.mediaAssetId && String(item.mediaAssetId) === normalizeText(mediaAssetId)
    );
    if (existing) {
      return {
        assetId: existing.assetId,
        contentType: existing.contentType || '',
        originalName: existing.originalName || '',
        size: existing.size || 0,
        mediaAssetId: String(existing.mediaAssetId),
      };
    }
    if ((design.assets || []).length >= MAX_ASSETS_PER_DESIGN) {
      throw createHttpError('Limite de imagens desta atividade atingido.', 400, 'DESIGN_TOO_MANY_ASSETS');
    }
    const media = await this.mediaAssetService.getForUse(mediaAssetId, actor);
    return this.appendDesignAsset(design, {
      key: media.key,
      contentType: media.contentType || '',
      originalName: normalizeText(media.title).slice(0, 200),
      size: media.size || 0,
      uploadedByUserId: actorId,
      mediaAssetId: media._id,
    });
  }

  async appendDesignAsset(design, fields) {
    const asset = {
      assetId: crypto.randomUUID(),
      ...fields,
      createdAt: this.now(),
    };
    design.assets = [...(design.assets || []), asset];
    if (typeof design.markModified === 'function') design.markModified('assets');
    await design.save();

    return {
      assetId: asset.assetId,
      contentType: asset.contentType,
      originalName: asset.originalName,
      size: asset.size,
      mediaAssetId: asset.mediaAssetId ? String(asset.mediaAssetId) : null,
    };
  }

  async getAssetContent(designId, assetId, actor) {
    const { design } = await this.loadDesign(designId, actor);
    const asset = (design.assets || []).find((item) => item.assetId === normalizeText(assetId));
    if (!asset) {
      throw createHttpError('Imagem nao encontrada.', 404, 'DESIGN_ASSET_NOT_FOUND');
    }
    const buffer = await this.r2StorageService.downloadBuffer(asset.key);
    return { buffer, contentType: asset.contentType || detectImageContentType(buffer) || 'application/octet-stream' };
  }

  async makeThumbnail(buffer) {
    // eslint-disable-next-line global-require
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const image = await loadImage(buffer);
    const width = THUMBNAIL_WIDTH;
    const height = Math.max(1, Math.round((image.height / image.width) * width));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return { buffer: canvas.toBuffer('image/png'), width, height };
  }

  /**
   * Publica o design: recebe um PNG/JPG A4 por pagina (na mesma ordem de
   * `design.pages`), sobe para o R2 e cria/atualiza o ActivityBook da escola
   * com uma ActivityPage `sourceKind: 'image'` por pagina.
   */
  async publishDesign(designId, actor, { files = [], revision } = {}) {
    const { design, schoolId, actorId } = await this.loadDesign(designId, actor, { forWrite: true });

    if (revision !== undefined && revision !== null && revision !== '') {
      if (Number(revision) !== Number(design.revision || 0)) {
        throw createHttpError(
          'A atividade mudou desde a ultima exportacao. Salve e publique novamente.',
          409,
          'DESIGN_REVISION_CONFLICT'
        );
      }
    }

    const pages = design.pages || [];
    if (pages.length === 0) {
      throw createHttpError('A atividade nao tem paginas.', 400, 'INVALID_DESIGN_PAGES');
    }
    if (!Array.isArray(files) || files.length !== pages.length) {
      throw createHttpError(
        `Envie uma imagem para cada pagina (${pages.length}).`,
        400,
        'DESIGN_RENDER_COUNT_MISMATCH'
      );
    }

    const rendered = files.map((file, index) => {
      if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
        throw createHttpError(`Imagem da pagina ${index + 1} vazia.`, 400, 'DESIGN_RENDER_INVALID');
      }
      if (file.buffer.length > MAX_RENDERED_PAGE_BYTES) {
        throw createHttpError(`Imagem da pagina ${index + 1} muito grande.`, 413, 'DESIGN_RENDER_TOO_LARGE');
      }
      const contentType = detectImageContentType(file.buffer);
      if (!RENDERED_PAGE_CONTENT_TYPES.includes(contentType)) {
        throw createHttpError(`Imagem da pagina ${index + 1} deve ser PNG ou JPG.`, 400, 'DESIGN_RENDER_INVALID');
      }
      return { buffer: file.buffer, contentType };
    });

    const nextRevision = Number(design.revision || 0);
    const designIdText = String(design._id);
    const basePrefix = `${STORAGE_BASE_PREFIX}/${schoolId}/activity-designs/${designIdText}/published/r${nextRevision}`;
    const previousKeys = pages
      .flatMap((page) => [page.renderedImageKey, page.renderedThumbnailKey])
      .filter(Boolean);

    const uploaded = [];
    for (let index = 0; index < rendered.length; index += 1) {
      const { buffer, contentType } = rendered[index];
      const pageLabel = String(index + 1).padStart(3, '0');
      const imageKey = `${basePrefix}/page-${pageLabel}.${extensionForContentType(contentType)}`;
      const thumbnailKey = `${basePrefix}/page-${pageLabel}.thumbnail.png`;
      await this.r2StorageService.uploadBuffer({ key: imageKey, buffer, contentType });
      const thumbnail = await this.thumbnailMaker(buffer);
      await this.r2StorageService.uploadBuffer({
        key: thumbnailKey,
        buffer: thumbnail.buffer,
        contentType: 'image/png',
      });
      uploaded.push({ imageKey, thumbnailKey, contentType, thumbnail });
    }

    const headerOverlay = {
      xPct: 0,
      yPct: 0,
      widthPct: 100,
      heightPct: Number(design.headerHeightPct || ACTIVITY_DESIGN_HEADER_HEIGHT_PCT),
    };

    let book = design.publishedBookId
      ? await this.ActivityBook.findOne({ _id: design.publishedBookId, schoolId, sourceType: 'school' })
      : null;

    const bookFields = {
      title: design.title,
      description: design.description || '',
      subject: design.subject || '',
      segment: design.segment || '',
      grade: design.grade || '',
      sourceType: 'school',
      schoolId,
      visibility: 'restricted',
      allowedSchoolIds: [schoolId],
      status: 'published',
      totalPages: pages.length,
      createdByUserId: book?.createdByUserId || actorId,
      activityDesignId: design._id,
      thumbnailsStatus: 'ready',
      thumbnailsGeneratedAt: this.now(),
      thumbnailsTotal: pages.length,
      thumbnailsReady: pages.length,
      thumbnailsFailed: 0,
      defaultHeaderOverlay: headerOverlay,
    };

    if (book) {
      Object.assign(book, bookFields);
      await book.save();
    } else {
      book = await this.ActivityBook.create(bookFields);
    }

    for (let index = 0; index < uploaded.length; index += 1) {
      const item = uploaded[index];
      await this.ActivityPage.findOneAndUpdate(
        { bookId: book._id, pageNumber: index + 1 },
        {
          $set: {
            title: design.title,
            description: design.description || '',
            subject: design.subject || '',
            segment: design.segment || '',
            grade: design.grade || '',
            tags: design.tags || [],
            sourceKind: 'image',
            sourceImageKey: item.imageKey,
            sourceImageContentType: item.contentType,
            thumbnailKey: item.thumbnailKey,
            thumbnailStatus: 'ready',
            thumbnailError: '',
            thumbnailErrorCode: '',
            thumbnailErrorStage: '',
            thumbnailGeneratedAt: this.now(),
            thumbnailContentType: 'image/png',
            thumbnailWidth: item.thumbnail.width || 0,
            thumbnailHeight: item.thumbnail.height || 0,
            enabled: true,
            printable: true,
            pageType: 'activity',
            status: 'published',
            headerOverlay,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
    }

    // Paginas removidas do design: desativadas (nao apagadas) porque
    // impressoes antigas referenciam o activityPageId.
    await this.ActivityPage.updateMany(
      { bookId: book._id, pageNumber: { $gt: uploaded.length } },
      { $set: { enabled: false, printable: false, status: 'archived' } }
    );

    design.pages = pages.map((page, index) => {
      const plainPage = typeof page.toObject === 'function' ? page.toObject({ minimize: false }) : page;
      return {
        ...plainPage,
        renderedImageKey: uploaded[index].imageKey,
        renderedImageContentType: uploaded[index].contentType,
        renderedThumbnailKey: uploaded[index].thumbnailKey,
        renderedAt: this.now(),
      };
    });
    if (typeof design.markModified === 'function') design.markModified('pages');
    design.status = 'published';
    design.publishedRevision = nextRevision;
    design.publishedBookId = book._id;
    design.publishedAt = this.now();
    design.updatedByUserId = actorId;
    await design.save();

    const newKeys = new Set(uploaded.flatMap((item) => [item.imageKey, item.thumbnailKey]));
    const staleKeys = previousKeys.filter((key) => !newKeys.has(key));
    if (staleKeys.length > 0 && typeof this.r2StorageService.deleteObjects === 'function') {
      try {
        await this.r2StorageService.deleteObjects(staleKeys);
      } catch (error) {
        console.warn('[ActivityDesign] Falha ao remover imagens antigas', {
          designId: designIdText,
          message: error?.message,
        });
      }
    }

    const activityPages = await this.ActivityPage.find({
      bookId: book._id,
      enabled: true,
      status: 'published',
    })
      .select('_id pageNumber')
      .sort({ pageNumber: 1 })
      .lean();

    return {
      design: this.serialize(design),
      bookId: String(book._id),
      activityPageIds: activityPages.map((page) => String(page._id)),
    };
  }
}

module.exports = new ActivityDesignService();
module.exports.ActivityDesignService = ActivityDesignService;
module.exports.sanitizePages = sanitizePages;
module.exports.detectImageContentType = detectImageContentType;
module.exports.createHttpError = createHttpError;
