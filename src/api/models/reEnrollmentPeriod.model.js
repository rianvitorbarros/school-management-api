const mongoose = require('mongoose');

const reEnrollmentPeriodSchema = new mongoose.Schema({
  school_id: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  academicYearFrom: { type: Number, required: true, index: true },
  academicYearTo: { type: Number, required: true, index: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  status: { type: String, enum: ['DRAFT', 'OPEN', 'CLOSED'], default: 'DRAFT', index: true },
  notes: { type: String, trim: true, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

reEnrollmentPeriodSchema.index(
  { school_id: 1, academicYearFrom: 1, academicYearTo: 1 },
  { unique: true, name: 'uniq_school_reenrollment_period' }
);
reEnrollmentPeriodSchema.index(
  { school_id: 1, academicYearTo: 1 },
  { unique: true, partialFilterExpression: { status: 'OPEN' }, name: 'uniq_open_reenrollment_period_per_target_year' }
);

reEnrollmentPeriodSchema.pre('validate', function validatePeriod(next) {
  if (this.academicYearTo !== this.academicYearFrom + 1) {
    return next(new Error('O ano letivo de destino deve ser o ano seguinte ao de origem.'));
  }
  if (this.startDate && this.endDate && new Date(this.startDate) >= new Date(this.endDate)) {
    return next(new Error('A data final deve ser posterior à data inicial.'));
  }
  return next();
});

module.exports = mongoose.model('ReEnrollmentPeriod', reEnrollmentPeriodSchema);
