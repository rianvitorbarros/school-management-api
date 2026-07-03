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
    purgeAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
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
    ipMasked: { type: String, default: null, maxlength: 80 },
    cpfMasked: { type: String, default: null, maxlength: 24 },
    userAgentSummary: { type: String, default: null, maxlength: 160 },
    devicePlatform: {
      type: String,
      enum: ['android', 'ios', 'web', 'windows', 'macos', 'linux', 'unknown'],
      default: 'unknown',
    },
    appVersion: { type: String, default: null, maxlength: 40 },
    source: {
      type: String,
      enum: ['mobile', 'desktop', 'api', 'system', 'unknown'],
      default: 'unknown',
    },
    correlationId: { type: String, default: null, maxlength: 80 },
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
  { purgeAt: 1 },
  {
    expireAfterSeconds: 0,
    name: 'ttl_guardian_pin_recovery_challenge_purge',
  }
);

module.exports = mongoose.model(
  'GuardianPinRecoveryChallenge',
  guardianPinRecoveryChallengeSchema
);
