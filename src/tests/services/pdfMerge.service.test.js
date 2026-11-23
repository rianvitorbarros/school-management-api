const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');

const { mergePdfs, normalizeLayout } = require('../../api/services/pdfMerge.service');

// Cada pagina ganha uma largura diferente para conferir a ordem final.
async function pdfWithPages(widths) {
  const doc = await PDFDocument.create();
  widths.forEach((width) => doc.addPage([width, 842]));
  return Buffer.from(await doc.save());
}

async function widthsOf(buffer) {
  const doc = await PDFDocument.load(buffer);
  return doc.getPages().map((page) => Math.round(page.getWidth()));
}

test('sem layout junta os PDFs na ordem enviada', async () => {
  const merged = await mergePdfs([await pdfWithPages([101, 102]), await pdfWithPages([201])]);
  assert.deepEqual(await widthsOf(merged), [101, 102, 201]);
});

test('intercala as paginas de uma atividade para cada aluno ficar com as suas juntas', async () => {
  // Prova (2 alunos x 2 paginas ja agrupadas) e atividade de 2 paginas,
  // uma folha por aluno em cada PDF.
  const exam = await pdfWithPages([301, 302, 311, 312]);
  const page1 = await pdfWithPages([401, 411]);
  const page2 = await pdfWithPages([402, 412]);
  const merged = await mergePdfs([exam, page1, page2], JSON.stringify([
    { files: [0] },
    { files: [1, 2], interleave: true },
  ]));
  assert.deepEqual(await widthsOf(merged), [301, 302, 311, 312, 401, 402, 411, 412]);
});

test('quantidades diferentes nao intercalam: junta em sequencia', async () => {
  const merged = await mergePdfs(
    [await pdfWithPages([501, 511]), await pdfWithPages([502])],
    [{ files: [0, 1], interleave: true }],
  );
  assert.deepEqual(await widthsOf(merged), [501, 511, 502]);
});

test('recusa layout invalido e arquivo que nao e PDF', async () => {
  assert.throws(() => normalizeLayout([{ files: [3] }], 2), (error) => error.code === 'INVALID_LAYOUT');
  assert.throws(() => normalizeLayout('{nao json', 1), (error) => error.code === 'INVALID_LAYOUT');
  await assert.rejects(mergePdfs([Buffer.from('oi')]), (error) => error.code === 'INVALID_PDF');
  await assert.rejects(mergePdfs([]), (error) => error.code === 'PDF_REQUIRED');
});
