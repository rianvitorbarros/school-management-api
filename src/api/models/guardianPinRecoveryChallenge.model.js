const mongoose = require('mongoose');

const { Schema } = mongoose;

const guardianPinRecoveryChallengeSchema = new Schema(
  {
    school_id: {
      type: Schema.Types.ObjectId,
      ref: 'School',
      default: null,
      index: true,
    },
    guardianAccessAccountId: {
      type: Schema.Types.ObjectId,
      ref: 'GuardianAccessAccount',
      default: null,
      index: true,
    },
    studentId: {
      type: Schema.Types.ObjectId,
      ref: 'Student',
      default: null,
      index: true,
    },
    tutorId: {
      type: Schema.Types.ObjectId,
      ref: 'Tutor',
      default: null,
      index: true,
    },
    verificationTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    stage: {
      type: String,
      enum: [
        'attempted',
        'awaiting_pin',
        'processing',
        'completed',
        'failed',
        'blocked',
        'expired',
      ],
      default: 'attempted',
      index: true,
    },
    failedAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    ipHash: {
      type: String,
      default: null,
      index: true,
    },
    cpfHash: {
      type: String,
      required: true,
      index: true,
    },
    userAgentHash: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

guardianPinRecoveryChallengeSchema.index(
  { cpfHash: 1, createdAt: -1 },
  { name: 'idx_guardian_pin_recovery_cpf_created' }
);

guardianPinRecoveryChallengeSchema.index(
  { ipHash: 1, createdAt: -1 },
  { name: 'idx_guardian_pin_recovery_ip_created' }
);

guardianPinRecoveryChallengeSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_guardian_pin_recovery_challenge' }
);

module.exports = mongoose.model(
  'GuardianPinRecoveryChallenge',
  guardianPinRecoveryChallengeSchema
);
