const mongoose = require('mongoose');

const { Schema } = mongoose;

/*
 * MediaAsset: acervo de imagens usado pelo editor de atividades.
 *
 * - `global`: curadoria do AcademyHub, visivel para todas as escolas.
 * - `school`: visivel para todos os usuarios da escola (padrao das imagens
 *   geradas pela Iara, para a escola inteira reaproveitar).
 * - `private`: so quem enviou (e a gestao da escola). Padrao dos uploads,
 *   porque costumam ser prints de sites/livros com direitos de terceiros.
 */

const MEDIA_ASSET_VISIBILITIES = ['global', 'school', 'private'];
const MEDIA_ASSET_KINDS = ['lineart', 'color', 'icon', 'photo', 'other'];
const MEDIA_ASSET_SOURCES = ['upload', 'ai-generated', 'ai-from-reference', 'curated'];
const MEDIA_ASSET_STATUSES = ['active', 'archived'];

const mediaAssetSchema = new Schema(
  {
    schoolId: {
      type: Schema.Types.ObjectId,
      ref: 'School',
      default: null,
      index: true,
    },
    visibility: {
      type: String,
      enum: MEDIA_ASSET_VISIBILITIES,
      default: 'private',
      index: true,
    },
    createdByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    createdByPlatformAdminId: {
      type: Schema.Types.ObjectId,
      ref: 'PlatformAdmin',
      default: null,
    },
    title: { type: String, trim: true, default: '' },
    tags: { type: [String], default: [], index: true },
    kind: { type: String, enum: MEDIA_ASSET_KINDS, default: 'other', index: true },
    source: { type: String, enum: MEDIA_ASSET_SOURCES, default: 'upload', index: true },
    key: { type: String, required: true, trim: true },
    contentType: { type: String, trim: true, default: '' },
    size: { type: Number, min: 0, default: 0 },
    width: { type: Number, min: 0, default: 0 },
    height: { type: Number, min: 0, default: 0 },
    thumbnailKey: { type: String, trim: true, default: '' },
    // Geracao por IA: o pedido do professor e o estilo usado.
    prompt: { type: String, trim: true, default: '' },
    style: { type: String, trim: true, default: '' },
    model: { type: String, trim: true, default: '' },
    attribution: { type: String, trim: true, default: '' },
    usageCount: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: MEDIA_ASSET_STATUSES, default: 'active', index: true },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

mediaAssetSchema.index({ schoolId: 1, status: 1, visibility: 1, createdAt: -1 });
mediaAssetSchema.index({ visibility: 1, status: 1, createdAt: -1 });
mediaAssetSchema.index({ schoolId: 1, source: 1, createdAt: -1 });

module.exports = mongoose.model('MediaAsset', mediaAssetSchema);
module.exports.MEDIA_ASSET_VISIBILITIES = MEDIA_ASSET_VISIBILITIES;
module.exports.MEDIA_ASSET_KINDS = MEDIA_ASSET_KINDS;
module.exports.MEDIA_ASSET_SOURCES = MEDIA_ASSET_SOURCES;
