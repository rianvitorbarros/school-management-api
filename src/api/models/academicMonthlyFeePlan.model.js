const mongoose = require('mongoose');

// A price belongs to an academic destination, never to an individual section
// ("2º Ano A"/"2º Ano B").  Shift is part of the key because schools can
// intentionally price the same grade differently by schedule.
const academicMonthlyFeePlanSchema = new mongoose.Schema({
  school_id: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  academicYear: { type: Number, required: true, index: true },
  level: { type: String, required: true, trim: true },
  grade: { type: String, required: true, trim: true },
  shift: { type: String, required: true, trim: true },
  // Integer cents keep persisted financial calculations deterministic.
  draftCents: { type: Number, min: 0, default: null },
  publishedCents: { type: Number, min: 0, default: null },
  publishedVersion: { type: Number, default: 0, min: 0 },
  publishedAt: { type: Date, default: null },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  draftUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, optimisticConcurrency: true });

academicMonthlyFeePlanSchema.index(
  { school_id: 1, academicYear: 1, level: 1, grade: 1, shift: 1 },
  { unique: true, name: 'uniq_school_academic_monthly_fee_destination' }
);

module.exports = mongoose.model('AcademicMonthlyFeePlan', academicMonthlyFeePlanSchema);
