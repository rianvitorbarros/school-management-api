const mongoose = require('mongoose');
const { PDFDocument } = require('pdf-lib');

const ActivityBook = require('../models/activityBook.model');
const ActivityPage = require('../models/activityPage.model');
const ActivityPrintRun = require('../models/activityPrintRun.model');
const r2StorageService = require('./r2Storage.service');

const PDF_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const ACTIVITY_PAGE_TYPES = new Set(['cover', 'index', 'activity', 'support']);
const PRINT_LAYOUT_MODES = new Set(['overlay', 'crop-and-recompose']);
const PRINT_SCALE_MODES = new Set(['fit-width', 'fit-page']);
const ACTIVITY_BOOK_STORAGE_BASE_PREFIX = 'platform/activity-books';

function createHttpError(message, status = 400, code = 'ACTIVITY_LIBRARY_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function escapeRegex(value) {
  return normalizeText(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseJsonMaybe(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return value;
  }
}

function parseStringArray(value) {
  const parsed = parseJsonMaybe(value);
  if (Array.isArray(parsed)) {
    return parsed.map((item) => normalizeText(item)).filter(Boolean);
  }

  if (typeof parsed === 'string') {
    return parsed.split(',').map((item) => normalizeText(item)).filter(Boolean);
  }

  return [];
}

function parseObjectIdArray(value, fieldName = 'ids') {
  const ids = parseStringArray(value);
  const invalid = ids.find((id) => !mongoose.Types.ObjectId.isValid(id));
  if (invalid) {
    throw createHttpError(`${fieldName} contem um id invalido.`, 400, 'INVALID_OBJECT_ID');
  }

  return ids;
}

function normalizePagination(query = {}) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

function normalizeVisibility(value) {
  const visibility = normalizeText(value || 'private').toLowerCase();
  if (!['global', 'restricted', 'private'].includes(visibility)) {
    throw createHttpError('Visibility invalida.', 400, 'INVALID_VISIBILITY');
  }
  return visibility;
}

function normalizeTags(value) {
  return [...new Set(parseStringArray(value).map((tag) => tag.toLowerCase()))];
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return defaultValue;
}

function isBookVisibleToSchool(activityBook, schoolId) {
  if (!activityBook) return false;
  if (activityBook.status !== 'published') return false;
  if (activityBook.visibility === 'global') return true;
  if (activityBook.visibility !== 'restricted') return false;

  return Array.isArray(activityBook.allowedSchoolIds)
    && activityBook.allowedSchoolIds.some((allowedId) => String(allowedId) === String(schoolId));
}

function buildActivityBookStoragePrefix(bookId) {
  return `${ACTIVITY_BOOK_STORAGE_BASE_PREFIX}/${String(bookId)}/`;
}

function ensureSafeActivityBookStoragePrefix(bookId, prefix) {
  const normalizedBookId = normalizeText(bookId);
  if (!mongoose.Types.ObjectId.isValid(normalizedBookId)) {
    throw createHttpError('bookId invalido.', 400, 'INVALID_OBJECT_ID');
  }

  const expectedPrefix = buildActivityBookStoragePrefix(normalizedBookId);
  const normalizedPrefix = normalizeText(prefix);

  if (!normalizedPrefix || normalizedPrefix !== expectedPrefix || !normalizedPrefix.startsWith(`${ACTIVITY_BOOK_STORAGE_BASE_PREFIX}/`)) {
    throw createHttpError('Prefixo de storage inseguro.', 400, 'UNSAFE_ACTIVITY_BOOK_PREFIX');
  }

  return normalizedPrefix;
}

function validatePctRect(rawValue, code = 'INVALID_PERCENT_RECT') {
  const payload = parseJsonMaybe(rawValue);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createHttpError('A configuracao percentual precisa ser um objeto.', 400, code);
  }

  const fields = ['xPct', 'yPct', 'widthPct', 'heightPct'];
  const normalized = {};

  fields.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      throw createHttpError(`${field} e obrigatorio.`, 400, code);
    }

    const value = Number(payload[field]);
    if (!Number.isFinite(value)) {
      throw createHttpError(`${field} precisa ser numerico.`, 400, code);
    }

    normalized[field] = value;
  });

  if (normalized.xPct < 0 || normalized.yPct < 0) {
    throw createHttpError('xPct e yPct precisam ser maiores ou iguais a zero.', 400, code);
  }

  if (normalized.widthPct <= 0 || normalized.heightPct <= 0) {
    throw createHttpError('widthPct e heightPct precisam ser maiores que zero.', 400, code);
  }

  if (normalized.xPct + normalized.widthPct > 100) {
    throw createHttpError('xPct + widthPct nao pode ultrapassar 100.', 400, code);
  }

  if (normalized.yPct + normalized.heightPct > 100) {
    throw createHttpError('yPct + heightPct nao pode ultrapassar 100.', 400, code);
  }

  return normalized;
}

function validatePartialPctRectPayload(rawValue, code = 'INVALID_PERCENT_RECT') {
  const payload = parseJsonMaybe(rawValue);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createHttpError('A configuracao percentual precisa ser um objeto.', 400, code);
  }

  const fields = ['xPct', 'yPct', 'widthPct', 'heightPct'];
  const presentFields = fields.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
  if (presentFields.length === 0) {
    throw createHttpError('Payload vazio nao e permitido.', 400, code);
  }

  const normalized = {};
  presentFields.forEach((field) => {
    const value = Number(payload[field]);
    if (!Number.isFinite(value)) {
      throw createHttpError(`${field} precisa ser numerico.`, 400, code);
    }
    normalized[field] = value;
  });

  return normalized;
}

function validatePrintLayout(rawValue, code = 'INVALID_PRINT_LAYOUT') {
  const payload = parseJsonMaybe(rawValue);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createHttpError('printLayout precisa ser um objeto.', 400, code);
  }

  const normalized = {};
  let hasAnyField = false;

  if (Object.prototype.hasOwnProperty.call(payload, 'mode')) {
    const mode = normalizeText(payload.mode).toLowerCase();
    if (!PRINT_LAYOUT_MODES.has(mode)) {
      throw createHttpError('printLayout.mode invalido.', 400, code);
    }
    normalized.mode = mode;
    hasAnyField = true;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'academyHeaderHeightPct')) {
    const value = Number(payload.academyHeaderHeightPct);
    if (!Number.isFinite(value) || value <= 0 || value > 100) {
      throw createHttpError('printLayout.academyHeaderHeightPct precisa ser um numero entre 0 e 100.', 400, code);
    }
    normalized.academyHeaderHeightPct = value;
    hasAnyField = true;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'preserveFooter')) {
    normalized.preserveFooter = parseBoolean(payload.preserveFooter);
    hasAnyField = true;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'scaleMode')) {
    const scaleMode = normalizeText(payload.scaleMode).toLowerCase();
    if (!PRINT_SCALE_MODES.has(scaleMode)) {
      throw createHttpError('printLayout.scaleMode invalido.', 400, code);
    }
    normalized.scaleMode = scaleMode;
    hasAnyField = true;
  }

  if (!hasAnyField) {
    throw createHttpError('Payload vazio nao e permitido.', 400, code);
  }

  return normalized;
}

function normalizePageType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!ACTIVITY_PAGE_TYPES.has(normalized)) {
    throw createHttpError('pageType invalido.', 400, 'INVALID_PAGE_TYPE');
  }
  return normalized;
}

function assertValidPdfFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw createHttpError('Arquivo PDF e obrigatorio.', 400, 'PDF_REQUIRED');
  }

  const fileSize = Number(file.size || file.buffer.length || 0);
  if (fileSize <= 0) {
    throw createHttpError('O PDF enviado esta vazio.', 400, 'EMPTY_PDF');
  }

  if (fileSize > PDF_UPLOAD_LIMIT_BYTES) {
    throw createHttpError('O PDF excede o limite de 25MB.', 413, 'PDF_TOO_LARGE');
  }

  if (String(file.mimetype || '').toLowerCase() !== 'application/pdf') {
    throw createHttpError('Apenas arquivos PDF sao permitidos.', 400, 'INVALID_PDF_MIMETYPE');
  }

  if (!String(file.originalname || '').toLowerCase().endsWith('.pdf')) {
    throw createHttpError('O arquivo deve usar extensao .pdf.', 400, 'INVALID_PDF_EXTENSION');
  }

  const header = file.buffer.subarray(0, 5).toString('ascii');
  if (header !== '%PDF-') {
    throw createHttpError('O arquivo enviado nao possui assinatura PDF valida.', 400, 'INVALID_PDF_SIGNATURE');
  }
}

async function countPdfPages(file) {
  assertValidPdfFile(file);

  try {
    const document = await PDFDocument.load(file.buffer);
    return document.getPageCount();
  } catch (error) {
    throw createHttpError(
      'Nao foi possivel ler o PDF. Verifique se o arquivo nao esta corrompido, protegido ou criptografado.',
      400,
      'INVALID_OR_ENCRYPTED_PDF'
    );
  }
}

function publicPdfUrlFromUpload(uploadResult) {
  return uploadResult?.publicUrl || '';
}

function shouldExposeThumbnailUrl(thumbnailKey, thumbnailStatus) {
  const key = normalizeText(thumbnailKey);
  if (!key) return false;

  const status = normalizeText(thumbnailStatus).toLowerCase();
  // Object availability is authoritative. Older imports can leave the status
  // as pending after successfully uploading the thumbnail to R2.
  return status !== 'failed';
}

async function buildSignedThumbnailUrl(thumbnailKey, expiresIn = 900, thumbnailStatus = 'ready') {
  const key = normalizeText(thumbnailKey);
  if (!shouldExposeThumbnailUrl(key, thumbnailStatus)) return null;

  try {
    const result = await r2StorageService.getSignedDownloadUrl(key, expiresIn);
    return result.url || null;
  } catch (error) {
    return null;
  }
}

class ActivityLibraryService {
  getPdfUploadLimitBytes() {
    return PDF_UPLOAD_LIMIT_BYTES;
  }

  async createActivityBook({ body = {}, file, adminId }) {
    const title = normalizeText(body.title);
    if (!title) {
      throw createHttpError('title e obrigatorio.', 400, 'TITLE_REQUIRED');
    }

    const totalPages = await countPdfPages(file);
    if (!totalPages) {
      throw createHttpError('O PDF precisa conter pelo menos uma pagina.', 400, 'PDF_WITHOUT_PAGES');
    }

    const visibility = normalizeVisibility(body.visibility);
    const allowedSchoolIds = parseObjectIdArray(body.allowedSchoolIds, 'allowedSchoolIds');
    if (visibility === 'restricted' && allowedSchoolIds.length === 0) {
      throw createHttpError('allowedSchoolIds e obrigatorio quando visibility=restricted.', 400, 'ALLOWED_SCHOOLS_REQUIRED');
    }

    const book = new ActivityBook({
      title,
      subject: normalizeText(body.subject),
      segment: normalizeText(body.segment),
      grade: normalizeText(body.grade),
      description: normalizeText(body.description),
      visibility,
      allowedSchoolIds,
      defaultPrintLayout: Object.prototype.hasOwnProperty.call(body, 'defaultPrintLayout')
        ? validatePrintLayout(body.defaultPrintLayout, 'INVALID_DEFAULT_PRINT_LAYOUT')
        : undefined,
      defaultHeaderOverlay: Object.prototype.hasOwnProperty.call(body, 'defaultHeaderOverlay')
        ? validatePctRect(body.defaultHeaderOverlay, 'INVALID_DEFAULT_HEADER_OVERLAY')
        : undefined,
      defaultContentCrop: Object.prototype.hasOwnProperty.call(body, 'defaultContentCrop')
        ? validatePctRect(body.defaultContentCrop, 'INVALID_DEFAULT_CONTENT_CROP')
        : undefined,
      defaultFooterCrop: Object.prototype.hasOwnProperty.call(body, 'defaultFooterCrop')
        ? validatePctRect(body.defaultFooterCrop, 'INVALID_DEFAULT_FOOTER_CROP')
        : undefined,
      status: 'processing',
      createdBy: adminId,
    });

    await book.save();

    const originalPdfKey = `${buildActivityBookStoragePrefix(book._id)}original.pdf`;

    try {
      const uploadResult = await r2StorageService.uploadBuffer({
        key: originalPdfKey,
        buffer: file.buffer,
        contentType: 'application/pdf',
      });

      const pages = Array.from({ length: totalPages }, (_, index) => ({
        bookId: book._id,
        pageNumber: index + 1,
        title: `${title} - Pagina ${index + 1}`,
        description: normalizeText(body.description),
        subject: normalizeText(body.subject),
        segment: normalizeText(body.segment),
        grade: normalizeText(body.grade),
        tags: normalizeTags(body.tags),
        enabled: true,
        status: 'draft',
      }));

      await ActivityPage.insertMany(pages);

      book.originalPdfKey = originalPdfKey;
      book.originalPdfUrl = publicPdfUrlFromUpload(uploadResult);
      book.totalPages = totalPages;
      book.status = 'ready';
      await book.save();

      return {
        book,
        pagesCreated: totalPages,
      };
    } catch (error) {
      await ActivityPage.deleteMany({ bookId: book._id }).catch(() => {});
      await ActivityBook.findByIdAndUpdate(book._id, {
        $set: {
          status: 'draft',
          processingError: error.message || 'Falha ao processar PDF.',
        },
      }).catch(() => {});
      throw error;
    }
  }

  async listActivityBooks(filters = {}) {
    const { page, limit, skip } = normalizePagination(filters);
    const query = {};

    if (filters.status) {
      query.status = normalizeText(filters.status);
    } else {
      query.status = { $ne: 'archived' };
    }

    if (filters.visibility) query.visibility = normalizeVisibility(filters.visibility);
    if (filters.subject) query.subject = normalizeText(filters.subject);
    if (filters.segment) query.segment = normalizeText(filters.segment);
    if (filters.grade) query.grade = normalizeText(filters.grade);

    if (filters.search) {
      const regex = new RegExp(escapeRegex(filters.search), 'i');
      query.$or = [
        { title: regex },
        { description: regex },
        { subject: regex },
        { segment: regex },
        { grade: regex },
      ];
    }

    const [items, total] = await Promise.all([
      ActivityBook.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ActivityBook.countDocuments(query),
    ]);

    return { items, page, limit, total };
  }

  async getActivityBook(bookId) {
    const book = await ActivityBook.findById(bookId).lean();
    if (!book || book.status === 'archived') {
      throw createHttpError('ActivityBook nao encontrado.', 404, 'BOOK_NOT_FOUND');
    }
    return book;
  }

  async updateActivityBook(bookId, payload = {}) {
    const allowedFields = [
      'title',
      'subject',
      'segment',
      'grade',
      'description',
      'sourceType',
      'visibility',
      'allowedSchoolIds',
      'defaultPrintLayout',
      'defaultHeaderOverlay',
      'defaultContentCrop',
      'defaultFooterCrop',
    ];

    const update = {};
    for (const field of allowedFields) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;

      if (field === 'allowedSchoolIds') {
        update.allowedSchoolIds = parseObjectIdArray(payload.allowedSchoolIds, 'allowedSchoolIds');
      } else if (field === 'visibility') {
        update.visibility = normalizeVisibility(payload.visibility);
      } else if (field === 'defaultPrintLayout') {
        update.defaultPrintLayout = validatePrintLayout(payload.defaultPrintLayout, 'INVALID_DEFAULT_PRINT_LAYOUT');
      } else if (field === 'defaultHeaderOverlay') {
        update.defaultHeaderOverlay = validatePctRect(payload.defaultHeaderOverlay, 'INVALID_DEFAULT_HEADER_OVERLAY');
      } else if (field === 'defaultContentCrop') {
        update.defaultContentCrop = validatePctRect(payload.defaultContentCrop, 'INVALID_DEFAULT_CONTENT_CROP');
      } else if (field === 'defaultFooterCrop') {
        update.defaultFooterCrop = validatePctRect(payload.defaultFooterCrop, 'INVALID_DEFAULT_FOOTER_CROP');
      } else {
        update[field] = normalizeText(payload[field]);
      }
    }

    if (update.visibility === 'restricted' && (!update.allowedSchoolIds || update.allowedSchoolIds.length === 0)) {
      const current = await ActivityBook.findById(bookId).select('allowedSchoolIds').lean();
      if (!current?.allowedSchoolIds?.length) {
        throw createHttpError('allowedSchoolIds e obrigatorio quando visibility=restricted.', 400, 'ALLOWED_SCHOOLS_REQUIRED');
      }
    }

    const book = await ActivityBook.findOneAndUpdate(
      { _id: bookId, status: { $ne: 'archived' } },
      { $set: update },
      { new: true, runValidators: true }
    ).lean();

    if (!book) {
      throw createHttpError('ActivityBook nao encontrado.', 404, 'BOOK_NOT_FOUND');
    }

    return book;
  }

  async archiveActivityBook(bookId) {
    const book = await ActivityBook.findOneAndUpdate(
      { _id: bookId, status: { $ne: 'archived' } },
      { $set: { status: 'archived' } },
      { new: true }
    ).lean();

    if (!book) {
      throw createHttpError('ActivityBook nao encontrado.', 404, 'BOOK_NOT_FOUND');
    }

    await ActivityPage.updateMany({ bookId }, { $set: { status: 'archived', enabled: false } });
    return book;
  }

  async deleteActivityBookPermanently(bookId, payload = {}) {
    if (!mongoose.Types.ObjectId.isValid(bookId)) {
      throw createHttpError('bookId invalido.', 400, 'INVALID_OBJECT_ID');
    }

    const book = await ActivityBook.findById(bookId).lean();
    if (!book) {
      throw createHttpError('ActivityBook nao encontrado.', 404, 'BOOK_NOT_FOUND');
    }

    const pages = await ActivityPage.find({ bookId })
      .select('_id thumbnailKey')
      .lean();

    const deleteFiles = parseBoolean(payload.deleteFiles, true);
    const deleteGeneratedPrints = parseBoolean(payload.deleteGeneratedPrints, false);
    const safePrefix = ensureSafeActivityBookStoragePrefix(bookId, buildActivityBookStoragePrefix(bookId));
    const errors = [];
    let deletedR2Objects = 0;

    if (deleteGeneratedPrints) {
      errors.push({
        code: 'GENERATED_PRINTS_DELETE_NOT_SUPPORTED',
        message: 'Os PDFs gerados por escolas nao sao apagados por esta rota.',
      });
    }

    if (deleteFiles) {
      const explicitKeys = [
        normalizeText(book.originalPdfKey),
        ...pages.map((page) => normalizeText(page.thumbnailKey)),
      ].filter(Boolean);

      let prefixedKeys = [];
      try {
        prefixedKeys = await r2StorageService.listObjectsByPrefix(safePrefix);
      } catch (error) {
        errors.push({
          code: error.code || 'R2_LIST_FAILED',
          message: error.message || 'Falha ao listar arquivos do caderno no R2.',
        });
      }

      const safeKeys = [...new Set([...explicitKeys, ...prefixedKeys])].filter(Boolean);
      const keysWithinPrefix = [];

      safeKeys.forEach((key) => {
        if (key.startsWith(safePrefix)) {
          keysWithinPrefix.push(key);
          return;
        }

        errors.push({
          code: 'UNSAFE_STORAGE_KEY_SKIPPED',
          key,
          message: 'Arquivo fora do prefixo seguro do caderno foi preservado.',
        });
      });

      if (keysWithinPrefix.length > 0) {
        try {
          const deleteResult = await r2StorageService.deleteObjects(keysWithinPrefix);
          deletedR2Objects += deleteResult.deletedCount || 0;
          if (Array.isArray(deleteResult.errors) && deleteResult.errors.length > 0) {
            errors.push(...deleteResult.errors);
          }
        } catch (error) {
          errors.push({
            code: error.code || 'R2_DELETE_FAILED',
            message: error.message || 'Falha ao remover arquivos do R2.',
          });
        }
      }
    }

    const [pageDeleteResult, bookDeleteResult, preservedPrintRuns] = await Promise.all([
      ActivityPage.deleteMany({ bookId }),
      ActivityBook.deleteOne({ _id: bookId }),
      ActivityPrintRun.countDocuments({ bookId }).catch(() => 0),
    ]);

    return {
      success: bookDeleteResult.deletedCount === 1,
      bookId: String(bookId),
      deleted: {
        activityBook: bookDeleteResult.deletedCount === 1,
        activityPages: pageDeleteResult.deletedCount || 0,
        r2Objects: deletedR2Objects,
      },
      skipped: {
        generatedPrints: true,
        printRunsPreserved: preservedPrintRuns,
      },
      errors,
      reason: normalizeText(payload.reason),
    };
  }

  async listPages(bookId) {
    await this.getActivityBook(bookId);
    const pages = await ActivityPage.find({ bookId })
      .sort({ pageNumber: 1 })
      .lean();

    return Promise.all(pages.map(async (page) => ({
      ...page,
      thumbnailUrl: await buildSignedThumbnailUrl(page.thumbnailKey, 900, page.thumbnailStatus),
      thumbnailError: page.thumbnailError || null,
      thumbnailErrorCode: page.thumbnailErrorCode || null,
      thumbnailErrorStage: page.thumbnailErrorStage || null,
    })));
  }

  async updatePage(pageId, payload = {}) {
    const allowedFields = [
      'title',
      'description',
      'subject',
      'segment',
      'grade',
      'tags',
      'enabled',
      'status',
      'pageType',
      'printable',
    ];

    const update = {};
    for (const field of allowedFields) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;

      if (field === 'tags') update.tags = normalizeTags(payload.tags);
      else if (field === 'enabled') update.enabled = payload.enabled === true || payload.enabled === 'true';
      else if (field === 'printable') update.printable = parseBoolean(payload.printable, true);
      else if (field === 'pageType') update.pageType = normalizePageType(payload.pageType);
      else update[field] = normalizeText(payload[field]);
    }

    const page = await ActivityPage.findByIdAndUpdate(
      pageId,
      { $set: update },
      { new: true, runValidators: true }
    ).lean();

    if (!page) {
      throw createHttpError('ActivityPage nao encontrada.', 404, 'PAGE_NOT_FOUND');
    }

    return page;
  }

  async updateHeaderOverlay(pageId, payload = {}) {
    return this.updatePageRectField(pageId, 'headerOverlay', payload, 'INVALID_HEADER_OVERLAY');
  }

  async updateContentCrop(pageId, payload = {}) {
    return this.updatePageRectField(pageId, 'contentCrop', payload, 'INVALID_CONTENT_CROP');
  }

  async updateFooterCrop(pageId, payload = {}) {
    return this.updatePageRectField(pageId, 'footerCrop', payload, 'INVALID_FOOTER_CROP');
  }

  async updatePrintLayout(pageId, payload = {}) {
    const normalized = validatePrintLayout(payload, 'INVALID_PRINT_LAYOUT');
    const update = {};
    Object.entries(normalized).forEach(([key, value]) => {
      update[`printLayout.${key}`] = value;
    });

    const page = await ActivityPage.findByIdAndUpdate(
      pageId,
      { $set: update },
      { new: true, runValidators: true }
    ).lean();

    if (!page) {
      throw createHttpError('ActivityPage nao encontrada.', 404, 'PAGE_NOT_FOUND');
    }

    return page;
  }

  async updatePageRectField(pageId, fieldName, payload = {}, code) {
    const partial = validatePartialPctRectPayload(payload, code);
    const current = await ActivityPage.findById(pageId).select(fieldName).lean();
    if (!current) {
      throw createHttpError('ActivityPage nao encontrada.', 404, 'PAGE_NOT_FOUND');
    }

    const merged = {
      ...(current[fieldName] || {}),
      ...partial,
    };

    const normalized = validatePctRect(merged, code);
    const page = await ActivityPage.findByIdAndUpdate(
      pageId,
      { $set: { [fieldName]: normalized } },
      { new: true, runValidators: true }
    ).lean();

    if (!page) {
      throw createHttpError('ActivityPage nao encontrada.', 404, 'PAGE_NOT_FOUND');
    }

    return page;
  }

  async updateVisibility(bookId, payload = {}) {
    const visibility = normalizeVisibility(payload.visibility);
    const allowedSchoolIds = parseObjectIdArray(payload.allowedSchoolIds, 'allowedSchoolIds');

    if (visibility === 'restricted' && allowedSchoolIds.length === 0) {
      throw createHttpError('allowedSchoolIds e obrigatorio quando visibility=restricted.', 400, 'ALLOWED_SCHOOLS_REQUIRED');
    }

    const book = await ActivityBook.findOneAndUpdate(
      { _id: bookId, status: { $ne: 'archived' } },
      { $set: { visibility, allowedSchoolIds } },
      { new: true, runValidators: true }
    ).lean();

    if (!book) {
      throw createHttpError('ActivityBook nao encontrado.', 404, 'BOOK_NOT_FOUND');
    }

    return book;
  }

  async publishBook(bookId) {
    const book = await ActivityBook.findOneAndUpdate(
      { _id: bookId, status: { $in: ['ready', 'published'] } },
      { $set: { status: 'published' } },
      { new: true, runValidators: true }
    ).lean();

    if (!book) {
      throw createHttpError('ActivityBook precisa estar ready para publicar.', 409, 'BOOK_NOT_READY');
    }

    await ActivityPage.updateMany(
      { bookId, enabled: true, status: { $ne: 'archived' } },
      { $set: { status: 'published' } }
    );
    await ActivityPage.updateMany(
      { bookId, enabled: false, status: 'published' },
      { $set: { status: 'draft' } }
    );

    return book;
  }

  async unpublishBook(bookId) {
    const book = await ActivityBook.findOneAndUpdate(
      { _id: bookId, status: 'published' },
      { $set: { status: 'ready' } },
      { new: true, runValidators: true }
    ).lean();

    if (!book) {
      throw createHttpError('ActivityBook publicado nao encontrado.', 404, 'BOOK_NOT_FOUND');
    }

    await ActivityPage.updateMany(
      { bookId, status: 'published' },
      { $set: { status: 'ready' } }
    );

    return book;
  }

  async listSchoolLibrary(schoolId, filters = {}) {
    if (!mongoose.Types.ObjectId.isValid(schoolId)) {
      throw createHttpError('Escola invalida.', 400, 'INVALID_SCHOOL_ID');
    }

    const { page, limit, skip } = normalizePagination(filters);
    const visibleBookQuery = {
      status: 'published',
      $or: [
        { visibility: 'global' },
        { visibility: 'restricted', allowedSchoolIds: schoolId },
      ],
    };

    const visibleBooks = await ActivityBook.find(visibleBookQuery)
      .select('_id title subject segment grade visibility originalPdfKey')
      .lean();

    const visibleBookIds = visibleBooks.map((book) => book._id);
    if (visibleBookIds.length === 0) {
      return { items: [], page, limit, total: 0 };
    }

    const bookById = new Map(visibleBooks.map((book) => [String(book._id), book]));
    const pageQuery = {
      bookId: { $in: visibleBookIds },
      enabled: true,
      status: 'published',
      printable: { $ne: false },
      $and: [
        {
          $or: [
            { pageType: 'activity' },
            { pageType: { $exists: false } },
          ],
        },
      ],
    };

    if (filters.subject) pageQuery.subject = normalizeText(filters.subject);
    if (filters.segment) pageQuery.segment = normalizeText(filters.segment);
    if (filters.grade) pageQuery.grade = normalizeText(filters.grade);

    const tags = normalizeTags(filters.tags);
    if (tags.length > 0) pageQuery.tags = { $in: tags };

    if (filters.search) {
      const regex = new RegExp(escapeRegex(filters.search), 'i');
      const matchingBookIds = visibleBooks
        .filter((book) => regex.test(book.title || ''))
        .map((book) => book._id);

      pageQuery.$and.push({
        $or: [
          { title: regex },
          { description: regex },
          { subject: regex },
          { segment: regex },
          { grade: regex },
        ],
      });

      if (matchingBookIds.length > 0) {
        pageQuery.$and[pageQuery.$and.length - 1].$or.push({ bookId: { $in: matchingBookIds } });
      }
    }

    const [pages, total] = await Promise.all([
      ActivityPage.find(pageQuery)
        .sort({ updatedAt: -1, pageNumber: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ActivityPage.countDocuments(pageQuery),
    ]);

    const items = pages.map((activityPage) => {
      const book = bookById.get(String(activityPage.bookId)) || {};
      return {
        activityPageId: String(activityPage._id),
        bookId: String(activityPage.bookId),
        title: activityPage.title || `${book.title || 'Atividade'} - Pagina ${activityPage.pageNumber}`,
        description: activityPage.description || '',
        subject: activityPage.subject || book.subject || '',
        segment: activityPage.segment || book.segment || '',
        grade: activityPage.grade || book.grade || '',
        pageNumber: activityPage.pageNumber,
        sourceKind: activityPage.sourceKind || 'pdf-page',
        hasOriginalPdf: Boolean(normalizeText(book.originalPdfKey)),
        thumbnailKey: activityPage.thumbnailKey || '',
        thumbnailStatus: activityPage.thumbnailStatus || 'pending',
        thumbnailError: activityPage.thumbnailError || null,
        thumbnailErrorCode: activityPage.thumbnailErrorCode || null,
        thumbnailErrorStage: activityPage.thumbnailErrorStage || null,
        tags: activityPage.tags || [],
        bookTitle: book.title || '',
      };
    });

    const itemsWithUrls = await Promise.all(items.map(async (item) => ({
      ...item,
      thumbnailUrl: await buildSignedThumbnailUrl(item.thumbnailKey, 900, item.thumbnailStatus),
    })));

    return { items: itemsWithUrls, page, limit, total };
  }

  async getSchoolBookDownloadUrl(schoolId, bookId, expiresIn = 300) {
    if (!mongoose.Types.ObjectId.isValid(schoolId)) {
      throw createHttpError('Escola invalida.', 400, 'INVALID_SCHOOL_ID');
    }

    if (!mongoose.Types.ObjectId.isValid(bookId)) {
      throw createHttpError('Caderno invalido.', 400, 'BOOK_NOT_FOUND');
    }

    const book = await ActivityBook.findById(bookId)
      .select('_id title status visibility allowedSchoolIds originalPdfKey')
      .lean();

    if (!book || book.status === 'archived') {
      throw createHttpError('Caderno de atividades nao encontrado.', 404, 'BOOK_NOT_FOUND');
    }

    if (!isBookVisibleToSchool(book, schoolId)) {
      throw createHttpError(
        'Caderno de atividades nao disponivel para esta escola.',
        403,
        'BOOK_NOT_AVAILABLE_FOR_SCHOOL'
      );
    }

    const originalPdfKey = normalizeText(book.originalPdfKey);
    if (!originalPdfKey) {
      throw createHttpError(
        'PDF original do caderno nao esta disponivel.',
        404,
        'BOOK_PDF_NOT_FOUND'
      );
    }

    try {
      const result = await r2StorageService.getSignedDownloadUrl(
        originalPdfKey,
        expiresIn
      );

      return {
        bookId: String(book._id),
        url: result.url || '',
        expiresIn,
      };
    } catch (error) {
      if (error.code === 'R2_OBJECT_NOT_FOUND') {
        throw createHttpError(
          'PDF original do caderno nao foi encontrado no R2.',
          404,
          'BOOK_PDF_NOT_FOUND'
        );
      }

      throw createHttpError(
        error.message || 'Nao foi possivel obter a URL do PDF original.',
        error.status || 502,
        error.code || 'BOOK_DOWNLOAD_URL_FAILED'
      );
    }
  }

  async listSchoolLibraryForPlatform(schoolId, filters = {}) {
    if (!mongoose.Types.ObjectId.isValid(schoolId)) {
      throw createHttpError('Escola invalida.', 400, 'INVALID_SCHOOL_ID');
    }

    const { page, limit, skip } = normalizePagination(filters);
    const visibleBookQuery = {
      status: 'published',
      $or: [
        { visibility: 'global' },
        { visibility: 'restricted', allowedSchoolIds: schoolId },
      ],
    };

    const visibleBooks = await ActivityBook.find(visibleBookQuery)
      .select('_id title subject segment grade visibility defaultPrintLayout defaultHeaderOverlay defaultContentCrop defaultFooterCrop')
      .lean();

    const visibleBookIds = visibleBooks.map((book) => book._id);
    if (visibleBookIds.length === 0) {
      return { items: [], page, limit, total: 0 };
    }

    const bookById = new Map(visibleBooks.map((book) => [String(book._id), book]));
    const pageQuery = {
      bookId: { $in: visibleBookIds },
      enabled: true,
      status: 'published',
      printable: { $ne: false },
      $and: [
        {
          $or: [
            { pageType: 'activity' },
            { pageType: { $exists: false } },
          ],
        },
      ],
    };

    if (filters.subject) pageQuery.subject = normalizeText(filters.subject);
    if (filters.segment) pageQuery.segment = normalizeText(filters.segment);
    if (filters.grade) pageQuery.grade = normalizeText(filters.grade);

    const tags = normalizeTags(filters.tags);
    if (tags.length > 0) pageQuery.tags = { $in: tags };

    if (filters.search) {
      const regex = new RegExp(escapeRegex(filters.search), 'i');
      const matchingBookIds = visibleBooks
        .filter((book) => regex.test(book.title || ''))
        .map((book) => book._id);

      pageQuery.$and.push({
        $or: [
          { title: regex },
          { description: regex },
          { subject: regex },
          { segment: regex },
          { grade: regex },
        ],
      });

      if (matchingBookIds.length > 0) {
        pageQuery.$and[pageQuery.$and.length - 1].$or.push({ bookId: { $in: matchingBookIds } });
      }
    }

    const [pages, total] = await Promise.all([
      ActivityPage.find(pageQuery)
        .sort({ updatedAt: -1, pageNumber: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ActivityPage.countDocuments(pageQuery),
    ]);

    const items = pages.map((activityPage) => {
      const book = bookById.get(String(activityPage.bookId)) || {};
      const pageTitle = activityPage.title || `${book.title || 'Atividade'} - Pagina ${activityPage.pageNumber}`;

      return {
        activityPageId: String(activityPage._id),
        bookId: String(activityPage.bookId),
        bookTitle: book.title || '',
        pageTitle,
        pageNumber: activityPage.pageNumber,
        subject: activityPage.subject || book.subject || '',
        segment: activityPage.segment || book.segment || '',
        grade: activityPage.grade || book.grade || '',
        pageType: activityPage.pageType || 'activity',
        printable: activityPage.printable !== false,
        enabled: activityPage.enabled === true,
        printLayout: activityPage.printLayout || book.defaultPrintLayout || null,
        contentCrop: activityPage.contentCrop || book.defaultContentCrop || null,
        footerCrop: activityPage.footerCrop || book.defaultFooterCrop || null,
        headerOverlay: activityPage.headerOverlay || book.defaultHeaderOverlay || null,
      };
    });

    return { items, page, limit, total };
  }
}

module.exports = new ActivityLibraryService();
module.exports.ActivityLibraryService = ActivityLibraryService;
module.exports.createHttpError = createHttpError;
module.exports.normalizeText = normalizeText;
module.exports.validatePctRect = validatePctRect;
module.exports.validatePrintLayout = validatePrintLayout;
module.exports.buildSignedThumbnailUrl = buildSignedThumbnailUrl;
module.exports.buildActivityBookStoragePrefix = buildActivityBookStoragePrefix;
module.exports.ensureSafeActivityBookStoragePrefix = ensureSafeActivityBookStoragePrefix;
