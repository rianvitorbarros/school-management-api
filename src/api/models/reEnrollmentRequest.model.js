const mongoose = require('mongoose');
const { Schema } = mongoose;

const classSnapshotSchema = new Schema({
  id: { type: String, default: null },
  name: { type: String, default: '' },
  level: { type: String, default: '' },
  grade: { type: String, default: '' },
  shift: { type: String, default: '' },
}, { _id: false });

const reEnrollmentRequestSchema = new Schema({
  school_id: { type: Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  studentId: { type: Schema.Types.ObjectId, ref: 'Student', required: true, index: true },
  studentNameSnapshot: { type: String, required: true, trim: true },
  guardianId: { type: Schema.Types.ObjectId, ref: 'Tutor', required: true, index: true },
  guardianNameSnapshot: { type: String, required: true, trim: true },
  currentEnrollmentId: { type: Schema.Types.ObjectId, ref: 'Enrollment', required: true, index: true },
  approvalEnrollmentId: { type: Schema.Types.ObjectId, ref: 'Enrollment', default: null },
  enrollmentCreatedAt: { type: Date, default: null },
  enrollmentCreatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  academicYearFrom: { type: Number, required: true },
  academicYearTo: { type: Number, required: true, index: true },
  currentClassId: { type: Schema.Types.ObjectId, ref: 'Class', required: true },
  currentClassSnapshot: { type: classSnapshotSchema, required: true },
  targetGradeName: { type: String, required: true, trim: true },
  targetLevelName: { type: String, required: true, trim: true },
  targetClassId: { type: Schema.Types.ObjectId, ref: 'Class', default: null },
  targetClassSnapshot: { type: classSnapshotSchema, default: null },
  periodId: { type: Schema.Types.ObjectId, ref: 'ReEnrollmentPeriod', required: true },
  financialStatusAtRequest: { type: String, enum: ['CLEAR', 'OVERDUE'], required: true },
  financialOverdueCountAtRequest: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'], default: 'PENDING', index: true },
  origin: { type: String, enum: ['GUARDIAN_PORTAL'], default: 'GUARDIAN_PORTAL' },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  rejectionReason: { type: String, trim: true, default: '' },
}, { timestamps: true });

// Makes retries and double-clicks safe while still allowing a new request after rejection/cancellation.
reEnrollmentRequestSchema.index(
  { school_id: 1, studentId: 1, academicYearTo: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' }, name: 'uniq_pending_reenrollment_per_student_year' }
);
reEnrollmentRequestSchema.index({ school_id: 1, status: 1, academicYearTo: 1, createdAt: -1 });

module.exports = mongoose.model('ReEnrollmentRequest', reEnrollmentRequestSchema);
