const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const { ActivityPdfService } = require('../../api/services/activityPdf.service');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnRkKQAAAAASUVORK5CYII=',
  'base64'
);

async function createSourcePdfBuffer() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([220, 320]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  page.drawText('NOME: ____________', { x: 18, y: 290, size: 11, font });
  page.drawText('DATA: __/__/____', { x: 18, y: 274, size: 11, font });
  page.drawText('Conteudo da atividade', { x: 24, y: 200, size: 16, font });
  page.drawText('Rodape do fornecedor', { x: 40, y: 18, size: 10, font });

  return Buffer.from(await pdfDoc.save());
}

function createPrintRun(studentCount) {
  return {
    items: Array.from({ length: studentCount }, (_, index) => ({
      studentId: `student_${index + 1}`,
      studentName: `Aluno ${index + 1}`,
      qrCodePayload: `AH-ACTIVITY-1:token-${index + 1}`,
      pageNumber: index + 1,
      status: 'pending',
    })),
  };
}

test('pctRectToPdfRect converts top-left percent coordinates using CropBox', async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([200, 300]);
  page.setCropBox(10, 20, 180, 260);

  const service = new ActivityPdfService();
  const rect = service.pctRectToPdfRect(page, {
    xPct: 10,
    yPct: 20,
    widthPct: 50,
    heightPct: 25,
  });

  assert.deepEqual(rect, {
    x: 28,
    y: 163,
    width: 90,
    height: 65,
  });
});

test('generateActivityPrintPdf produces one page per student without logo', async () => {
  const service = new ActivityPdfService();
  const pdfBuffer = await createSourcePdfBuffer();

  const result = await service.generateActivityPrintPdf({
    originalPdfBuffer: pdfBuffer,
    activityBook: { title: 'Caderno de Alfabetizacao', subject: 'Portugues' },
    activityPage: {
      title: 'Pagina Vogais',
      pageNumber: 1,
      headerOverlay: { xPct: 2, yPct: 2, widthPct: 96, heightPct: 18 },
      contentCrop: { xPct: 4, yPct: 18, widthPct: 92, heightPct: 70 },
      footerCrop: { xPct: 4, yPct: 92, widthPct: 92, heightPct: 6 },
      printLayout: { mode: 'crop-and-recompose', academyHeaderHeightPct: 18, preserveFooter: true, scaleMode: 'fit-width' },
      subject: 'Portugues',
    },
    school: { name: 'Escola Teste' },
    classDoc: { name: '3 B' },
    teacher: { fullName: 'Edicelia' },
    students: [
      { _id: 'student_1', fullName: 'Milena Brandao' },
      { _id: 'student_2', fullName: 'Joao Pedro' },
    ],
    printRun: createPrintRun(2),
    printDate: new Date('2026-06-04T12:00:00.000Z'),
  });

  const generated = await PDFDocument.load(result);
  assert.equal(generated.getPageCount(), 2);
});

test('generateActivityPrintPdf accepts an image activity and preserves one sheet per student', async () => {
  const service = new ActivityPdfService();
  const result = await service.generateActivityPrintPdf({
    sourceImageBuffer: PNG_1X1,
    sourceImageContentType: 'image/png',
    activityBook: { title: 'Pack Roseane' },
    activityPage: { sourceKind: 'image', title: 'Atividade 01', pageNumber: 1, headerOverlay: { heightPct: 18 } },
    school: { name: 'Escola Teste' },
    classDoc: { name: 'Maternal I' },
    teacher: { fullName: 'Roseane' },
    students: [{ fullName: 'Aluno teste' }],
    printRun: createPrintRun(1),
    printDate: new Date('2026-06-04T12:00:00.000Z'),
  });
  const generated = await PDFDocument.load(result);
  assert.equal(generated.getPageCount(), 1);
  assert.deepEqual(generated.getPage(0).getSize(), { width: 595.28, height: 841.89 });
});

test('embedSchoolLogo supports PNG and JPEG buffers', async () => {
  const service = new ActivityPdfService();
  let pngCalled = false;
  let jpgCalled = false;
  const fakePdfDoc = {
    async embedPng() {
      pngCalled = true;
      return { kind: 'png' };
    },
    async embedJpg() {
      jpgCalled = true;
      return { kind: 'jpg' };
    },
  };

  const pngLogo = await service.embedSchoolLogo(fakePdfDoc, {
    logo: { data: PNG_1X1, contentType: 'image/png' },
  });
  const jpgLogo = await service.embedSchoolLogo(fakePdfDoc, {
    logo: { data: Buffer.from('jpeg-binary'), contentType: 'image/jpeg' },
  });

  assert.ok(pngLogo);
  assert.equal(pngCalled, true);
  assert.ok(jpgLogo);
  assert.equal(jpgCalled, true);
});

test('embedSchoolLogo normalizes buffer-like values from persistence layers', async () => {
  const service = new ActivityPdfService();
  let pngCalled = false;
  const fakePdfDoc = {
    async embedPng(buffer) {
      pngCalled = Buffer.isBuffer(buffer) && buffer.length > 0;
      return { kind: 'png' };
    },
    async embedJpg() {
      throw new Error('should not call jpg');
    },
  };

  const logo = await service.embedSchoolLogo(fakePdfDoc, {
    logo: {
      data: { type: 'Buffer', data: [...PNG_1X1] },
      contentType: 'image/png',
    },
  });

  assert.ok(logo);
  assert.equal(pngCalled, true);
});
