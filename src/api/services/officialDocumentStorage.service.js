const {
  createHttpError,
  getOfficialDocumentMaxPdfBytes,
  hashBufferSha256,
  isPdfBuffer,
  sanitizeFileName,
  slugify,
} = require('../validators/officialDocument.validator');

const OFFICIAL_DOCUMENT_STORAGE_PROVIDER = 'mongodb_buffer';

// A visible signature box is only artwork. Official documents must contain a
// detached PDF/CMS signature that covers the complete file. The local Windows
// signer produces this PAdES-compatible shape. Keeping this validation at the
// API boundary also prevents the manual-upload fallback from registering an
// ordinary (unsigned) PDF as an official signed document.
const hasDetachedPdfSignature = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return false;

  const source = buffer.toString('latin1');
  const byteRange = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let match;

  while ((match = byteRange.exec(source)) !== null) {
    const [firstOffset, firstLength, secondOffset, secondLength] = match
      .slice(1)
      .map((value) => Number(value));
    if (
      !Number.isSafeInteger(firstOffset)
      || !Number.isSafeInteger(firstLength)
      || !Number.isSafeInteger(secondOffset)
      || !Number.isSafeInteger(secondLength)
      || firstOffset !== 0
      || firstLength <= 0
      || secondOffset <= firstLength
      || secondLength <= 0
      || secondOffset + secondLength !== buffer.length
    ) {
      continue;
    }

    const signatureDictionary = source.slice(match.index, secondOffset);
    const subFilter = /\/SubFilter\s*\/([^\s/>]+)/.exec(
      source.slice(Math.max(0, match.index - 4096), secondOffset)
    );
    const contents = /\/Contents\s*<([0-9A-Fa-f\s]+)>/.exec(signatureDictionary);
    if (!contents || !subFilter) continue;

    const normalizedSubFilter = subFilter[1].toLowerCase();
    if (!['adbe.pkcs7.detached', 'etsi.cades.detached'].includes(normalizedSubFilter)) {
      continue;
    }

    const hex = contents[1].replace(/\s/g, '');
    const cmsHex = hex.replace(/0+$/, '');
    if (
      hex.length % 2 !== 0
      || cmsHex.length < 256
      || !cmsHex.startsWith('30')
    ) {
      continue;
    }

    const contentStart = match.index + contents.index + contents[0].indexOf('<');
    const contentEnd = contentStart + hex.length + 2;
    if (contentStart !== firstLength || contentEnd !== secondOffset) {
      continue;
    }

    return true;
  }

  return false;
};

const buildStorageKey = ({
  schoolId,
  studentId,
  documentId = 'pending',
  version = 1,
  fileName = 'documento-assinado.pdf',
}) => {
  const safeName = slugify(fileName) || 'documento-assinado-pdf';
  return [
    'official-documents',
    String(schoolId || 'school'),
    String(studentId || 'student'),
    `v${version}`,
    `${String(documentId)}-${safeName}`,
  ].join('/');
};

const assertValidSignedPdf = (file) => {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw createHttpError('O PDF assinado final e obrigatorio.', 400, {
      code: 'signed_pdf_required',
    });
  }

  const fileSize = Number(file.size || file.buffer.length || 0);
  const maxBytes = getOfficialDocumentMaxPdfBytes();
  if (fileSize <= 0) {
    throw createHttpError('O arquivo enviado esta vazio.', 400, {
      code: 'empty_file',
    });
  }

  if (fileSize > maxBytes) {
    throw createHttpError(`O PDF assinado excede o limite configurado de ${maxBytes} bytes.`, 413, {
      code: 'file_too_large',
      maxBytes,
    });
  }

  if (String(file.mimetype || '').toLowerCase() !== 'application/pdf') {
    throw createHttpError('A API aceita apenas arquivos PDF assinados.', 400, {
      code: 'invalid_mimetype',
    });
  }

  if (!isPdfBuffer(file.buffer)) {
    throw createHttpError('O arquivo enviado nao possui cabecalho PDF valido.', 400, {
      code: 'invalid_pdf_header',
    });
  }

  if (!hasDetachedPdfSignature(file.buffer)) {
    throw createHttpError(
      'O arquivo enviado nao possui uma assinatura digital PDF valida. Assine o documento antes de registrá-lo como oficial.',
      400,
      { code: 'digital_signature_required' }
    );
  }
};

const storeSignedPdf = (file, context = {}) => {
  assertValidSignedPdf(file);

  const fileName = sanitizeFileName(
    file.originalname || context.fallbackFileName || 'documento-assinado.pdf'
  );
  const fileSize = Number(file.size || file.buffer.length || 0);

  return {
    storageProvider: OFFICIAL_DOCUMENT_STORAGE_PROVIDER,
    storageKey: buildStorageKey({
      schoolId: context.schoolId,
      studentId: context.studentId,
      documentId: context.documentId,
      version: context.version,
      fileName,
    }),
    fileName,
    mimeType: 'application/pdf',
    fileSize,
    fileHash: hashBufferSha256(file.buffer),
    fileData: file.buffer,
  };
};

const readStoredPdf = (document = {}) => {
  if (!document?.fileData) {
    throw createHttpError('Arquivo do documento nao encontrado.', 404, {
      code: 'document_file_not_found',
    });
  }

  return {
    fileName: document.fileName || 'documento-assinado.pdf',
    mimeType: document.mimeType || 'application/pdf',
    data: document.fileData,
  };
};

module.exports = {
  OFFICIAL_DOCUMENT_STORAGE_PROVIDER,
  buildStorageKey,
  hasDetachedPdfSignature,
  assertValidSignedPdf,
  storeSignedPdf,
  readStoredPdf,
};
