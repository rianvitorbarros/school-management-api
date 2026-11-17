const mongoose = require('mongoose');
const { Schema } = mongoose;

// Discount offered to families that pay a future monthly fee in advance
// (e.g. January/2027 paid in November/December/2026).
const earlyPaymentOfferSchema = new Schema({
  school_id: { type: Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  title: { type: String, required: [true, 'Informe o título da oferta.'], trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 600, default: '' },
  academicYear: { type: Number, required: true, min: 1900, max: 2200 },
  referenceMonth: { type: Number, required: true, min: 1, max: 12, default: 1 },
  discountType: { type: String, enum: ['PERCENTAGE', 'FIXED'], required: true, default: 'PERCENTAGE' },
  discountValue: { type: Number, required: true, min: 0 },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  paymentDeadline: { type: Date, default: null },
  audience: { type: String, enum: ['ALL', 'RE_ENROLLMENT', 'NEW_ENROLLMENT'], default: 'ALL' },
  status: { type: String, enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED'], default: 'DRAFT', index: true },
  maxAdhesions: { type: Number, min: 1, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

earlyPaymentOfferSchema.index({ school_id: 1, status: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.models.EarlyPaymentOffer || mongoose.model('EarlyPaymentOffer', earlyPaymentOfferSchema);
