const mongoose = require('mongoose');
const { Schema } = mongoose;

const earlyPaymentAdhesionSchema = new Schema({
  school_id: { type: Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  offerId: { type: Schema.Types.ObjectId, ref: 'EarlyPaymentOffer', required: true, index: true },
  source: { type: String, enum: ['reEnrollment', 'web', 'manual'], required: true },
  studentId: { type: Schema.Types.ObjectId, ref: 'Student', default: null },
  studentName: { type: String, trim: true, required: true, maxlength: 160 },
  guardianName: { type: String, trim: true, default: '', maxlength: 160 },
  guardianPhone: { type: String, trim: true, default: '', maxlength: 40 },
  guardianEmail: { type: String, trim: true, default: '', maxlength: 160 },
  guardianTutorId: { type: Schema.Types.ObjectId, ref: 'Tutor', default: null },
  targetGrade: { type: String, trim: true, default: '' },
  targetLevel: { type: String, trim: true, default: '' },
  reEnrollmentRequestId: { type: Schema.Types.ObjectId, ref: 'ReEnrollmentRequest', default: null },
  registrationRequestId: { type: Schema.Types.ObjectId, ref: 'RegistrationRequest', default: null },
  originalAmountCents: { type: Number, min: 0, default: null },
  discountCents: { type: Number, min: 0, default: null },
  finalAmountCents: { type: Number, min: 0, default: null },
  status: { type: String, enum: ['INTERESTED', 'CONFIRMED', 'PAID', 'CANCELLED'], default: 'INTERESTED', index: true },
  paidAt: { type: Date, default: null },
  notes: { type: String, trim: true, default: '', maxlength: 500 },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// One live adhesion per student per offer.
earlyPaymentAdhesionSchema.index(
  { offerId: 1, studentId: 1 },
  { unique: true, partialFilterExpression: { studentId: { $type: 'objectId' }, status: { $in: ['INTERESTED', 'CONFIRMED', 'PAID'] } }, name: 'unique_live_adhesion_by_student' }
);

module.exports = mongoose.models.EarlyPaymentAdhesion || mongoose.model('EarlyPaymentAdhesion', earlyPaymentAdhesionSchema);
