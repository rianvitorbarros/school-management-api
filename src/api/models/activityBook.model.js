const mongoose = require('mongoose');

const { Schema } = mongoose;

const ACTIVITY_BOOK_STATUSES = [
  'draft',
  'processing',
  'ready',
  'published',
  'archived',
];

const ACTIVITY_VISIBILITIES = ['global', 'restricted', 'private'];
const ACTIVITY_SOURCE_TYPES = ['global', 'school'];
const ACTIVITY_PRINT_LAYOUT_MODES = ['overlay', 'crop-and-recompose'];
const ACTIVITY_PRINT_SCALE_MODES = ['fit-width', 'fit-page'];
const ACTIVITY_THUMBNAILS_STATUSES = ['pending', 'processing', 'ready', 'partial', 'failed'];

const percentRectSchema = new Schema(
  {
    xPct: { type: Number, min: 0, max: 100, required: true },
    yPct: { type: Number, min: 0, max: 100, required: true },
    widthPct: { type: Number, min: 0, max: 100, required: true },
    heightPct: { type: Number, min: 0, max: 100, required: true },
  },
  { _id: false }
);

const printLayoutSchema = new Schema(
  {
    mode: {
      type: String,
      enum: ACTIVITY_PRINT_LAYOUT_MODES,
      default: undefined,
    },
    academyHeaderHeightPct: {
      type: Number,
      min: 0,
      max: 100,
      default: undefined,
    },
    preserveFooter: {
      type: Boolean,
      default: undefined,
    },
    scaleMode: {
      type: String,
      enum: ACTIVITY_PRINT_SCALE_MODES,
      default: undefined,
    },
  },
  { _id: false }
);

const criteriaTemplateSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    scale: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

const activityBookSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    subject: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },
    segment: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },
    grade: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    sourceType: {
      type: String,
      enum: ACTIVITY_SOURCE_TYPES,
      default: 'global',
      index: true,
    },
    schoolId: {
      type: Schema.Types.ObjectId,
      ref: 'School',
      default: null,
      index: true,
    },
    originalPdfKey: {
      type: String,
      trim: true,
      default: '',
    },
    originalPdfUrl: {
      type: String,
      trim: true,
      default: '',
    },
    totalPages: {
      type: Number,
      min: 0,
      default: 0,
    },
    status: {
      type: String,
      enum: ACTIVITY_BOOK_STATUSES,
      default: 'draft',
      index: true,
    },
    visibility: {
      type: String,
      enum: ACTIVITY_VISIBILITIES,
      default: 'private',
      index: true,
    },
    allowedSchoolIds: [{
      type: Schema.Types.ObjectId,
      ref: 'School',
    }],
    // Cadernos globais sao criados por PlatformAdmin. Cadernos da escola
    // (sourceType 'school', ex.: publicados pelo editor de atividades) sao
    // criados por um usuario da escola e usam createdByUserId.
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'PlatformAdmin',
      default: null,
      required() {
        return this.sourceType !== 'school';
      },
    },
    createdByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Design de origem quando o caderno foi publicado pelo editor.
    activityDesignId: {
      type: Schema.Types.ObjectId,
      ref: 'ActivityDesign',
      default: null,
      index: true,
    },
    processingError: {
      type: String,
      trim: true,
      default: '',
      select: false,
    },
    thumbnailsStatus: {
      type: String,
      enum: ACTIVITY_THUMBNAILS_STATUSES,
      default: 'pending',
      index: true,
    },
    thumbnailsGeneratedAt: {
      type: Date,
      default: null,
    },
    thumbnailsTotal: {
      type: Number,
      min: 0,
      default: 0,
    },
    thumbnailsReady: {
      type: Number,
      min: 0,
      default: 0,
    },
    thumbnailsFailed: {
      type: Number,
      min: 0,
      default: 0,
    },
    thumbnailsError: {
      type: String,
      trim: true,
      default: '',
    },
    defaultPrintLayout: {
      type: printLayoutSchema,
      default: undefined,
    },
    defaultHeaderOverlay: {
      type: percentRectSchema,
      default: undefined,
    },
    defaultContentCrop: {
      type: percentRectSchema,
      default: undefined,
    },
    defaultFooterCrop: {
      type: percentRectSchema,
      default: undefined,
    },
    defaultCriteriaTemplate: {
      type: [criteriaTemplateSchema],
      default: undefined,
    },
  },
  { timestamps: true }
);

activityBookSchema.index({ status: 1, visibility: 1, createdAt: -1 });
activityBookSchema.index({ allowedSchoolIds: 1, status: 1, visibility: 1 });

module.exports = mongoose.model('ActivityBook', activityBookSchema);
