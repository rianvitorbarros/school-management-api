const mongoose = require('mongoose');

const { Schema } = mongoose;

/*
 * ActivityDesign: atividade montada pelo professor no editor livre (estilo
 * Canva) do AcademyHub.
 *
 * - `pages[].elements` guarda o JSON editavel da pagina. As coordenadas dos
 *   elementos sao percentuais da AREA UTIL da folha (abaixo do cabecalho e
 *   acima do rodape reservados), entao o cabecalho nunca e invadido.
 * - Ao publicar, o app envia o PNG A4 de cada pagina; o design vira um
 *   ActivityBook (sourceType 'school') com ActivityPages `sourceKind: 'image'`
 *   e passa a usar o fluxo existente de impressao em lote (cabecalho + QR) e
 *   de correcao por criterios.
 */

const ACTIVITY_DESIGN_STATUSES = ['draft', 'published', 'archived'];
const ACTIVITY_DESIGN_ELEMENT_TYPES = [
  'text',
  'image',
  'shape',
  'line',
  'answerBox',
  'writingLines',
];

// Proporcoes reservadas da folha A4. O cabecalho precisa caber o bloco
// desenhado por ActivityPdfService.drawAcademyHeader (logo, 5 linhas e QR).
const ACTIVITY_DESIGN_HEADER_HEIGHT_PCT = 13;
const ACTIVITY_DESIGN_FOOTER_HEIGHT_PCT = 4;
const ACTIVITY_DESIGN_MAX_PAGES = 20;
const ACTIVITY_DESIGN_MAX_ELEMENTS_PER_PAGE = 200;

const activityDesignAssetSchema = new Schema(
  {
    assetId: { type: String, required: true, trim: true },
    key: { type: String, required: true, trim: true },
    contentType: { type: String, trim: true, default: '' },
    originalName: { type: String, trim: true, default: '' },
    size: { type: Number, min: 0, default: 0 },
    uploadedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const activityDesignPageSchema = new Schema(
  {
    pageKey: { type: String, required: true, trim: true },
    background: { type: String, trim: true, default: '#FFFFFF' },
    elements: { type: [Schema.Types.Mixed], default: [] },
    renderedImageKey: { type: String, trim: true, default: '' },
    renderedImageContentType: { type: String, trim: true, default: '' },
    renderedThumbnailKey: { type: String, trim: true, default: '' },
    renderedAt: { type: Date, default: null },
  },
  { _id: false, minimize: false }
);

const activityDesignSchema = new Schema(
  {
    schoolId: {
      type: Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    createdByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    updatedByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    classId: {
      type: Schema.Types.ObjectId,
      ref: 'Class',
      default: null,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    subject: { type: String, trim: true, default: '' },
    segment: { type: String, trim: true, default: '' },
    grade: { type: String, trim: true, default: '' },
    tags: { type: [String], default: [] },
    headerHeightPct: {
      type: Number,
      min: 5,
      max: 30,
      default: ACTIVITY_DESIGN_HEADER_HEIGHT_PCT,
    },
    footerHeightPct: {
      type: Number,
      min: 0,
      max: 15,
      default: ACTIVITY_DESIGN_FOOTER_HEIGHT_PCT,
    },
    pages: {
      type: [activityDesignPageSchema],
      default: [],
    },
    assets: {
      type: [activityDesignAssetSchema],
      default: [],
    },
    status: {
      type: String,
      enum: ACTIVITY_DESIGN_STATUSES,
      default: 'draft',
      index: true,
    },
    // Incrementado a cada salvamento; usado para concorrencia otimista e
    // para saber se ha alteracoes ainda nao publicadas.
    revision: { type: Number, min: 0, default: 0 },
    publishedRevision: { type: Number, min: 0, default: null },
    publishedBookId: {
      type: Schema.Types.ObjectId,
      ref: 'ActivityBook',
      default: null,
      index: true,
    },
    publishedAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);

activityDesignSchema.index({ schoolId: 1, status: 1, updatedAt: -1 });
activityDesignSchema.index({ schoolId: 1, createdByUserId: 1, updatedAt: -1 });

module.exports = mongoose.model('ActivityDesign', activityDesignSchema);
module.exports.ACTIVITY_DESIGN_STATUSES = ACTIVITY_DESIGN_STATUSES;
module.exports.ACTIVITY_DESIGN_ELEMENT_TYPES = ACTIVITY_DESIGN_ELEMENT_TYPES;
module.exports.ACTIVITY_DESIGN_HEADER_HEIGHT_PCT = ACTIVITY_DESIGN_HEADER_HEIGHT_PCT;
module.exports.ACTIVITY_DESIGN_FOOTER_HEIGHT_PCT = ACTIVITY_DESIGN_FOOTER_HEIGHT_PCT;
module.exports.ACTIVITY_DESIGN_MAX_PAGES = ACTIVITY_DESIGN_MAX_PAGES;
module.exports.ACTIVITY_DESIGN_MAX_ELEMENTS_PER_PAGE = ACTIVITY_DESIGN_MAX_ELEMENTS_PER_PAGE;
