const QRCode = require('qrcode');
const {
  PDFDocument,
  StandardFonts,
  rgb,
} = require('pdf-lib');

class ActivityPdfService {
  constructor({ qrCodeLib = QRCode } = {}) {
    this.qrCodeLib = qrCodeLib;
  }

  async generateActivityPrintPdf({
    originalPdfBuffer,
    sourceImageBuffer,
    sourceImageContentType,
    activityBook,
    activityPage,
    school,
    classDoc,
    teacher,
    students,
    printRun,
    printDate,
  }) {
    if (String(activityPage?.sourceKind || 'pdf-page') === 'image') {
      return this.generateImageActivityPrintPdf({
        sourceImageBuffer,
        sourceImageContentType,
        activityBook,
        activityPage,
        school,
        classDoc,
        teacher,
        students,
        printRun,
        printDate,
      });
    }
    if (!Buffer.isBuffer(originalPdfBuffer) || originalPdfBuffer.length === 0) {
      throw this.createPdfError('PDF original invalido.', 'INVALID_SOURCE_PDF');
    }

    const sourcePdf = await PDFDocument.load(originalPdfBuffer);
    const sourcePageIndex = Number(activityPage?.pageNumber || 1) - 1;
    const sourcePage = sourcePdf.getPage(sourcePageIndex);

    if (!sourcePage) {
      throw this.createPdfError('Pagina da atividade nao encontrada no PDF original.', 'SOURCE_PAGE_NOT_FOUND');
    }

    const outputPdf = await PDFDocument.create();
    const fonts = {
      regular: await outputPdf.embedFont(StandardFonts.Helvetica),
      bold: await outputPdf.embedFont(StandardFonts.HelveticaBold),
    };

    const logoImage = await this.embedSchoolLogo(outputPdf, school);
    const layout = this.resolveLayout(activityBook, activityPage);
    const printDateLabel = this.formatBusinessDate(printDate);
    const cropBox = sourcePage.getCropBox();
    const visiblePageBox = {
      left: cropBox.x,
      right: cropBox.x + cropBox.width,
      bottom: cropBox.y,
      top: cropBox.y + cropBox.height,
    };

    for (let index = 0; index < students.length; index += 1) {
      const student = students[index];
      const item = printRun.items[index];
      const qrPng = await this.generateQrPng(item.qrCodePayload);
      const qrImage = await outputPdf.embedPng(qrPng);

      const mode = layout.mode === 'crop-and-recompose' && layout.contentCrop
        ? 'crop-and-recompose'
        : 'overlay';

      if (mode === 'crop-and-recompose') {
        try {
          await this.drawCropAndRecomposeMode({
            outputPdf,
            sourcePage,
            visiblePageBox,
            cropBox,
            headerOverlay: layout.headerOverlay,
            contentCrop: layout.contentCrop,
            footerCrop: layout.footerCrop,
            printLayout: layout.printLayout,
            fonts,
            logoImage,
            qrImage,
            school,
            classDoc,
            teacher,
            student,
            activityBook,
            activityPage,
            printDateLabel,
          });
          continue;
        } catch (error) {
          if (layout.overlayFallback !== true) {
            throw error;
          }
        }
      }

      await this.drawOverlayMode({
        outputPdf,
        sourcePage,
        visiblePageBox,
        cropBox,
        headerOverlay: layout.headerOverlay,
        fonts,
        logoImage,
        qrImage,
        school,
        classDoc,
        teacher,
        student,
        activityBook,
        activityPage,
        printDateLabel,
      });
    }

    return Buffer.from(await outputPdf.save());
  }

  async generateImageActivityPrintPdf({
    sourceImageBuffer, sourceImageContentType, activityBook, activityPage,
    school, classDoc, teacher, students, printRun, printDate,
  }) {
    if (!Buffer.isBuffer(sourceImageBuffer) || sourceImageBuffer.length === 0) {
      throw this.createPdfError('Imagem original invalida.', 'INVALID_SOURCE_IMAGE');
    }
    const outputPdf = await PDFDocument.create();
    const fonts = {
      regular: await outputPdf.embedFont(StandardFonts.Helvetica),
      bold: await outputPdf.embedFont(StandardFonts.HelveticaBold),
    };
    const image = /jpe?g/i.test(String(sourceImageContentType || ''))
      ? await outputPdf.embedJpg(sourceImageBuffer)
      : await outputPdf.embedPng(sourceImageBuffer);
    const logoImage = await this.embedSchoolLogo(outputPdf, school);
    const layout = this.resolveLayout(activityBook, activityPage);
    const printDateLabel = this.formatBusinessDate(printDate);
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const headerHeight = pageHeight * (Number(layout.headerOverlay?.heightPct || 18) / 100);
    for (let index = 0; index < students.length; index += 1) {
      const page = outputPdf.addPage([pageWidth, pageHeight]);
      const scale = Math.min(pageWidth / image.width, pageHeight / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      page.drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
      const rect = { x: 0, y: pageHeight - headerHeight, width: pageWidth, height: headerHeight };
      page.drawRectangle({ ...rect, color: rgb(1, 1, 1), opacity: 1 });
      const qrImage = await outputPdf.embedPng(await this.generateQrPng(printRun.items[index].qrCodePayload));
      this.drawAcademyHeader(page, {
        rect, fonts, logoImage, qrImage, school, classDoc, teacher,
        student: students[index], activityBook, activityPage, printDateLabel,
      });
    }
    return Buffer.from(await outputPdf.save());
  }

  resolveLayout(activityBook = {}, activityPage = {}) {
    const defaultHeaderOverlay = activityBook.defaultHeaderOverlay || null;
    const defaultContentCrop = activityBook.defaultContentCrop || null;
    const defaultFooterCrop = activityBook.defaultFooterCrop || null;
    const defaultPrintLayout = activityBook.defaultPrintLayout || {};
    const pagePrintLayout = activityPage.printLayout || {};

    const printLayout = {
      mode: pagePrintLayout.mode || defaultPrintLayout.mode || 'overlay',
      academyHeaderHeightPct: Number(
        pagePrintLayout.academyHeaderHeightPct
        || defaultPrintLayout.academyHeaderHeightPct
        || 18
      ),
      preserveFooter: pagePrintLayout.preserveFooter !== undefined
        ? pagePrintLayout.preserveFooter === true
        : defaultPrintLayout.preserveFooter !== undefined
          ? defaultPrintLayout.preserveFooter === true
          : true,
      scaleMode: pagePrintLayout.scaleMode || defaultPrintLayout.scaleMode || 'fit-width',
    };

    return {
      mode: printLayout.mode,
      printLayout,
      headerOverlay: activityPage.headerOverlay || defaultHeaderOverlay || {
        xPct: 0,
        yPct: 0,
        widthPct: 100,
        heightPct: 12,
      },
      contentCrop: activityPage.contentCrop || defaultContentCrop || null,
      footerCrop: activityPage.footerCrop || defaultFooterCrop || null,
      overlayFallback: true,
    };
  }

  async drawOverlayMode({
    outputPdf,
    sourcePage,
    visiblePageBox,
    cropBox,
    headerOverlay,
    fonts,
    logoImage,
    qrImage,
    school,
    classDoc,
    teacher,
    student,
    activityBook,
    activityPage,
    printDateLabel,
  }) {
    const basePage = await outputPdf.embedPage(sourcePage, visiblePageBox);
    const pageWidth = visiblePageBox.right - visiblePageBox.left;
    const pageHeight = visiblePageBox.top - visiblePageBox.bottom;
    const page = outputPdf.addPage([pageWidth, pageHeight]);

    page.drawPage(basePage, {
      x: 0,
      y: 0,
      width: pageWidth,
      height: pageHeight,
    });

    const sourceOverlayRect = this.pctRectToPdfRect(sourcePage, headerOverlay);
    const overlayRect = {
      x: sourceOverlayRect.x - cropBox.x,
      y: sourceOverlayRect.y - cropBox.y,
      width: sourceOverlayRect.width,
      height: sourceOverlayRect.height,
    };

    page.drawRectangle({
      x: overlayRect.x,
      y: overlayRect.y,
      width: overlayRect.width,
      height: overlayRect.height,
      color: rgb(1, 1, 1),
      opacity: 1,
    });

    this.drawAcademyHeader(page, {
      rect: overlayRect,
      fonts,
      logoImage,
      qrImage,
      school,
      classDoc,
      teacher,
      student,
      activityBook,
      activityPage,
      printDateLabel,
    });
  }

  async drawCropAndRecomposeMode({
    outputPdf,
    sourcePage,
    visiblePageBox,
    cropBox,
    contentCrop,
    footerCrop,
    printLayout,
    fonts,
    logoImage,
    qrImage,
    school,
    classDoc,
    teacher,
    student,
    activityBook,
    activityPage,
    printDateLabel,
  }) {
    const pageWidth = visiblePageBox.right - visiblePageBox.left;
    const pageHeight = visiblePageBox.top - visiblePageBox.bottom;
    const headerHeight = pageHeight * (printLayout.academyHeaderHeightPct / 100);
    if (headerHeight <= 0 || headerHeight >= pageHeight) {
      throw this.createPdfError('academyHeaderHeightPct invalido para a pagina.', 'INVALID_HEADER_LAYOUT');
    }

    const contentRect = this.pctRectToPdfRect(sourcePage, contentCrop);
    const footerRect = printLayout.preserveFooter && footerCrop
      ? this.pctRectToPdfRect(sourcePage, footerCrop)
      : null;

    const targetPage = outputPdf.addPage([pageWidth, pageHeight]);
    const headerRect = {
      x: 0,
      y: pageHeight - headerHeight,
      width: pageWidth,
      height: headerHeight,
    };

    this.drawAcademyHeader(targetPage, {
      rect: headerRect,
      fonts,
      logoImage,
      qrImage,
      school,
      classDoc,
      teacher,
      student,
      activityBook,
      activityPage,
      printDateLabel,
    });

    const footerPadding = 8;
    let reservedFooterHeight = 0;

    if (footerRect) {
      const embeddedFooter = await outputPdf.embedPage(sourcePage, {
        left: footerRect.x,
        right: footerRect.x + footerRect.width,
        bottom: footerRect.y,
        top: footerRect.y + footerRect.height,
      });
      const maxFooterWidth = pageWidth - 24;
      const footerScale = Math.min(maxFooterWidth / footerRect.width, 1);
      const footerWidth = footerRect.width * footerScale;
      const footerHeight = footerRect.height * footerScale;
      reservedFooterHeight = footerHeight + footerPadding;

      targetPage.drawPage(embeddedFooter, {
        x: (pageWidth - footerWidth) / 2,
        y: footerPadding,
        width: footerWidth,
        height: footerHeight,
      });
    }

    const contentTop = headerRect.y - 8;
    const contentBottom = reservedFooterHeight + 8;
    const availableHeight = contentTop - contentBottom;
    const availableWidth = pageWidth - 24;

    if (availableHeight <= 0 || availableWidth <= 0) {
      throw this.createPdfError('Nao ha espaco util para recompor a atividade.', 'INVALID_CONTENT_LAYOUT');
    }

    const embeddedContent = await outputPdf.embedPage(sourcePage, {
      left: contentRect.x,
      right: contentRect.x + contentRect.width,
      bottom: contentRect.y,
      top: contentRect.y + contentRect.height,
    });

    const widthScale = availableWidth / contentRect.width;
    const heightScale = availableHeight / contentRect.height;
    let scale = printLayout.scaleMode === 'fit-page'
      ? Math.min(widthScale, heightScale)
      : widthScale;

    if ((contentRect.height * scale) > availableHeight) {
      scale = heightScale;
    }

    if (!Number.isFinite(scale) || scale <= 0) {
      throw this.createPdfError('Escala invalida para recompor a atividade.', 'INVALID_CONTENT_SCALE');
    }

    const drawWidth = contentRect.width * scale;
    const drawHeight = contentRect.height * scale;
    const drawX = (pageWidth - drawWidth) / 2;
    const drawY = contentTop - drawHeight;

    targetPage.drawPage(embeddedContent, {
      x: drawX,
      y: drawY,
      width: drawWidth,
      height: drawHeight,
    });

    if (cropBox.x !== 0 || cropBox.y !== 0) {
      targetPage.drawRectangle({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        color: rgb(1, 1, 1),
        opacity: 0,
      });
    }
  }

  drawAcademyHeader(page, {
    rect,
    fonts,
    logoImage,
    qrImage,
    school,
    classDoc,
    teacher,
    student,
    activityBook,
    activityPage,
    printDateLabel,
  }) {
    const padding = Math.max(8, Math.min(14, rect.height * 0.08));
    const qrSize = Math.max(42, Math.min(64, rect.height - (padding * 2)));
    const logoLayout = logoImage
      ? this.scaleEmbeddedImage(
          logoImage,
          Math.max(40, Math.min(72, rect.width * 0.14)),
          Math.max(34, Math.min(54, rect.height * 0.36))
        )
      : null;
    const textStartX = rect.x + padding + (logoLayout ? logoLayout.width + 10 : 0);
    const textEndX = rect.x + rect.width - padding - qrSize - 10;
    const maxTextWidth = Math.max(120, textEndX - textStartX);
    const topY = rect.y + rect.height - padding;
    const titleSize = Math.max(11, Math.min(16, rect.height * 0.16));
    const metaSize = Math.max(8, Math.min(10.5, rect.height * 0.1));
    const studentSize = Math.max(9, Math.min(11.5, rect.height * 0.11));
    const lineGap = Math.max(11, rect.height * 0.13);
    const schoolName = this.fitText(
      this.normalizePdfText(school?.name || school?.legalName || 'Academy Hub'),
      fonts.bold,
      titleSize,
      maxTextWidth
    );
    const disciplineLabel = this.fitText(
      `Disciplina: ${this.normalizePdfText(activityPage?.subject || activityBook?.subject || '')} - Prof: ${this.normalizePdfText(teacher?.fullName || '')}`,
      fonts.regular,
      metaSize,
      maxTextWidth
    );
    const activityLabel = this.fitText(
      `Atividade: ${this.normalizePdfText(activityPage?.title || activityBook?.title || 'Atividade')} - Pagina ${String(activityPage?.pageNumber || '').padStart(2, '0')} - ${printDateLabel}`,
      fonts.regular,
      metaSize,
      maxTextWidth
    );
    const studentLabel = this.fitText(
      `Aluno(a): ${this.normalizePdfText(student?.fullName || student?.name || '')}`,
      fonts.bold,
      studentSize,
      maxTextWidth
    );
    const classLabel = this.fitText(
      `Turma: ${this.normalizePdfText(classDoc?.name || '')}`,
      fonts.regular,
      metaSize,
      maxTextWidth
    );

    if (logoImage && logoLayout) {
      page.drawImage(logoImage, {
        x: rect.x + padding,
        y: rect.y + rect.height - padding - logoLayout.height,
        width: logoLayout.width,
        height: logoLayout.height,
      });
    }

    page.drawText(schoolName, {
      x: textStartX,
      y: topY - titleSize,
      size: titleSize,
      font: fonts.bold,
      color: rgb(0.12, 0.16, 0.22),
    });

    page.drawText(disciplineLabel, {
      x: textStartX,
      y: topY - titleSize - lineGap,
      size: metaSize,
      font: fonts.regular,
      color: rgb(0.18, 0.22, 0.29),
    });

    page.drawText(activityLabel, {
      x: textStartX,
      y: topY - titleSize - (lineGap * 2),
      size: metaSize,
      font: fonts.regular,
      color: rgb(0.18, 0.22, 0.29),
    });

    page.drawText(studentLabel, {
      x: textStartX,
      y: topY - titleSize - (lineGap * 3.2),
      size: studentSize,
      font: fonts.bold,
      color: rgb(0.1, 0.13, 0.18),
    });

    page.drawText(classLabel, {
      x: textStartX,
      y: topY - titleSize - (lineGap * 4.2),
      size: metaSize,
      font: fonts.regular,
      color: rgb(0.18, 0.22, 0.29),
    });

    page.drawImage(qrImage, {
      x: rect.x + rect.width - padding - qrSize,
      y: rect.y + rect.height - padding - qrSize,
      width: qrSize,
      height: qrSize,
    });

    page.drawLine({
      start: { x: rect.x + padding, y: rect.y + 4 },
      end: { x: rect.x + rect.width - padding, y: rect.y + 4 },
      thickness: 1,
      color: rgb(0.76, 0.8, 0.86),
    });
  }

  pctRectToPdfRect(page, pctRect) {
    if (!pctRect) {
      throw this.createPdfError('Configuracao percentual ausente.', 'INVALID_PERCENT_RECT');
    }

    const cropBox = page.getCropBox();
    const xPct = Number(pctRect.xPct);
    const yPct = Number(pctRect.yPct);
    const widthPct = Number(pctRect.widthPct);
    const heightPct = Number(pctRect.heightPct);

    if (
      !Number.isFinite(xPct)
      || !Number.isFinite(yPct)
      || !Number.isFinite(widthPct)
      || !Number.isFinite(heightPct)
      || xPct < 0
      || yPct < 0
      || widthPct <= 0
      || heightPct <= 0
      || xPct + widthPct > 100
      || yPct + heightPct > 100
    ) {
      throw this.createPdfError('Configuracao percentual invalida para o PDF.', 'INVALID_PERCENT_RECT');
    }

    const width = cropBox.width * (widthPct / 100);
    const height = cropBox.height * (heightPct / 100);
    const x = cropBox.x + (cropBox.width * (xPct / 100));

    // xPct/yPct usam origem visual no topo esquerdo; o PDF usa origem no canto inferior esquerdo.
    const y = cropBox.y + cropBox.height - (cropBox.height * (yPct / 100)) - height;

    return { x, y, width, height };
  }

  async embedSchoolLogo(pdfDoc, school = {}) {
    const { buffer: logoBuffer, contentType } = await this.resolveSchoolLogoBuffer(school);
    if (!logoBuffer?.length) return null;

    try {
      if (contentType.includes('png')) return await pdfDoc.embedPng(logoBuffer);
      if (contentType.includes('jpg') || contentType.includes('jpeg')) return await pdfDoc.embedJpg(logoBuffer);

      try {
        return await pdfDoc.embedPng(logoBuffer);
      } catch (pngError) {
        return await pdfDoc.embedJpg(logoBuffer);
      }
    } catch (error) {
      return null;
    }
  }

  async resolveSchoolLogoBuffer(school = {}) {
    const embeddedBuffer = this.normalizeBinaryBuffer(school?.logo?.data);
    if (embeddedBuffer?.length) {
      return {
        buffer: embeddedBuffer,
        contentType: String(school?.logo?.contentType || '').toLowerCase(),
      };
    }

    const logoUrl = String(school?.logoUrl || '').trim();
    if (!logoUrl) {
      return { buffer: null, contentType: '' };
    }

    const dataUrlMatch = logoUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (dataUrlMatch) {
      try {
        return {
          buffer: Buffer.from(dataUrlMatch[2], 'base64'),
          contentType: String(dataUrlMatch[1] || '').toLowerCase(),
        };
      } catch (error) {
        return { buffer: null, contentType: '' };
      }
    }

    if (!/^https?:\/\//i.test(logoUrl)) {
      return { buffer: null, contentType: '' };
    }

    try {
      const response = await fetch(logoUrl);
      if (!response.ok) {
        return { buffer: null, contentType: '' };
      }

      const arrayBuffer = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: String(response.headers.get('content-type') || '').toLowerCase(),
      };
    } catch (error) {
      return { buffer: null, contentType: '' };
    }
  }

  normalizeBinaryBuffer(value) {
    if (!value) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (Array.isArray(value)) return Buffer.from(value);
    if (value?.type === 'Buffer' && Array.isArray(value?.data)) {
      return Buffer.from(value.data);
    }
    if (value?.buffer && Buffer.isBuffer(value.buffer)) {
      return Buffer.from(value.buffer);
    }
    if (value?.buffer instanceof Uint8Array) {
      return Buffer.from(value.buffer);
    }
    return null;
  }

  scaleEmbeddedImage(image, maxWidth, maxHeight) {
    if (!image || typeof image.scaleToFit !== 'function') {
      return { width: maxWidth, height: maxHeight };
    }

    const layout = image.scaleToFit(maxWidth, maxHeight);
    return {
      width: layout.width,
      height: layout.height,
    };
  }

  async generateQrPng(payload) {
    return this.qrCodeLib.toBuffer(payload, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
    });
  }

  fitText(text, font, size, maxWidth) {
    const normalized = this.normalizePdfText(text);
    if (!normalized) return '';
    if (font.widthOfTextAtSize(normalized, size) <= maxWidth) return normalized;

    const ellipsis = '...';
    let value = normalized;
    while (value.length > 1 && font.widthOfTextAtSize(`${value}${ellipsis}`, size) > maxWidth) {
      value = value.slice(0, -1).trimEnd();
    }

    return `${value}${ellipsis}`;
  }

  normalizePdfText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  formatBusinessDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }

  createPdfError(message, code = 'PDF_GENERATION_FAILED') {
    const error = new Error(message);
    error.code = code;
    error.status = 400;
    return error;
  }
}

module.exports = new ActivityPdfService();
module.exports.ActivityPdfService = ActivityPdfService;
