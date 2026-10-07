const mongoose = require('mongoose');

const { Schema } = mongoose;

const guardianAccessLinkSchema = new Schema(
  {
    school_id: {
      type: Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    guardianAccessAccountId: {
      type: Schema.Types.ObjectId,
      ref: 'GuardianAccessAccount',
      required: true,
      index: true,
    },
    studentId: {
      type: Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
      index: true,
    },
    tutorId: {
      type: Schema.Types.ObjectId,
      ref: 'Tutor',
      required: true,
      index: true,
    },
    relationshipSnapshot: {
      type: String,
      default: 'Responsavel',
      trim: true,
    },
    source: {
      type: String,
      enum: ['first_access', 'pin_recovery', 'sync', 'admin'],
      default: 'first_access',
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
    linkedAt: {
      type: Date,
      default: Date.now,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

guardianAccessLinkSchema.index(
  { school_id: 1, guardianAccessAccountId: 1, studentId: 1 },
  {
    unique: true,
    name: 'uniq_guardian_access_link_school_account_student',
  }
);

guardianAccessLinkSchema.index(
  { school_id: 1, studentId: 1, tutorId: 1 },
  { unique: true, name: 'uniq_guardian_access_link_school_student_tutor' }
);

module.exports = mongoose.model('GuardianAccessLink', guardianAccessLinkSchema);
