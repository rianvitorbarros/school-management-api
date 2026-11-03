// src/api/models/iaraUsageLog.model.js
//
// Registro de uso da Iara: base para cota diaria, custo por escola e
// metricas de qualidade (questoes pedidas x devolvidas x descartadas).

const mongoose = require('mongoose');

const { Schema } = mongoose;

const iaraUsageLogSchema = new Schema(
  {
    school_id: { type: Schema.Types.ObjectId, ref: 'School', default: null, index: true },
    user_id: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    action: {
      type: String,
      enum: ['GENERATE', 'REGENERATE', 'REVIEW', 'ADAPT', 'RECOVERY'],
      required: true,
    },
    status: { type: String, enum: ['SUCCESS', 'ERROR'], required: true },
    model: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    requested: { type: Number, default: 0 },
    returned: { type: Number, default: 0 },
    discarded: { type: Number, default: 0 },
    meta: { type: Schema.Types.Mixed, default: null },
    errorMessage: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

iaraUsageLogSchema.index({ user_id: 1, createdAt: -1 });
// Mantem 180 dias de historico.
iaraUsageLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

module.exports = mongoose.models.IaraUsageLog || mongoose.model('IaraUsageLog', iaraUsageLogSchema);
