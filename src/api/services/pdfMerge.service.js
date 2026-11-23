const { PDFDocument } = require('pdf-lib');

const MAX_FILES = 80;

function createHttpError(message, status = 400, code = 'PDF_MERGE_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/**
 * Normaliza a ordem pedida pelo app. Cada grupo e uma avaliacao:
 * - `files`: indices dos PDFs enviados, na ordem;
 * - `interleave`: os PDFs sao paginas diferentes da mesma atividade, cada um
 *   com uma folha por aluno na mesma ordem. Intercalando, cada aluno fica com
 *   as suas paginas juntas (aluno 1: p1, p2; aluno 2: p1, p2...).
 * Sem layout, junta tudo na ordem enviada.
 */
function normalizeLayout(rawLayout, fileCount) {
  let layout = rawLayout;
  if (typeof layout === 'string' && layout.trim()) {
    try {
      layout = JSON.parse(layout);
    } catch (_) {
      throw createHttpError('Ordem dos arquivos invalida.', 400, 'INVALID_LAYOUT');
    }
  }
  if (!Array.isArray(layout) || layout.length === 0) {
    return Array.from({ length: fileCount }, (_, index) => ({ files: [index], interleave: false }));
  }
  return layout.map((group) => {
    const files = Array.isArray(group?.files) ? group.files.map(Number) : [];
    if (files.length === 0 || files.some((index) => !Number.isInteger(index) || index < 0 || index >= fileCount)) {
      throw createHttpError('Ordem dos arquivos invalida.', 400, 'INVALID_LAYOUT');
    }
    return { files, interleave: group.interleave === true };
  });
}

/** Junta PDFs sem rasterizar (QR Code e cartao-resposta seguem nitidos). */
async function mergePdfs(buffers = [], rawLayout = null) {
  if (!Array.isArray(buffers) || buffers.length === 0) {
    throw createHttpError('Envie ao menos um PDF.', 400, 'PDF_REQUIRED');
  }
  if (buffers.length > MAX_FILES) {
    throw createHttpError(`No maximo ${MAX_FILES} arquivos por vez.`, 400, 'TOO_MANY_FILES');
  }
  const layout = normalizeLayout(rawLayout, buffers.length);

  let documents;
  try {
    documents = await Promise.all(
      buffers.map((buffer) => PDFDocument.load(buffer, { ignoreEncryption: true }))
    );
  } catch (_) {
    throw createHttpError('Um dos arquivos nao e um PDF valido.', 400, 'INVALID_PDF');
  }

  const output = await PDFDocument.create();
  for (const group of layout) {
    const members = group.files.map((index) => documents[index]);
    const copied = [];
    for (const document of members) {
      copied.push(await output.copyPages(document, document.getPageIndices()));
    }
    const counts = copied.map((pages) => pages.length);
    const canInterleave = group.interleave
      && copied.length > 1
      && counts.every((count) => count === counts[0]);

    if (canInterleave) {
      for (let page = 0; page < counts[0]; page += 1) {
        for (const pages of copied) output.addPage(pages[page]);
      }
    } else {
      for (const pages of copied) pages.forEach((page) => output.addPage(page));
    }
  }

  return Buffer.from(await output.save());
}

module.exports = { mergePdfs, normalizeLayout, MAX_FILES };
