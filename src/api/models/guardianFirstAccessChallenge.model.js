const mongoose = require('mongoose');

const { Schema } = mongoose;

const challengeGuardianOptionSchema = new Schema(
  {
    optionId: {
      type: String,
      required: true,
      trim: true,
    },
    tutorId: {
      type: Schema.Types.ObjectId,
      ref: 'Tutor',
      required: true,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
    },
    relationship: {
      type: String,
      default: 'Responsavel',
      trim: true,
    },
  },
  { _id: false }
);

const guardianFirstAccessChallengeSchema = new Schema(
  {
    school_id: {
      type: Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    studentId: {
      type: Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
      index: true,
    },
    candidateGuardians: {
      type: [challengeGuardianOptionSchema],
      default: [],
    },
    selectedTutorId: {
      type: Schema.Types.ObjectId,
      ref: 'Tutor',
      default: null,
    },
    existingAccountId: {
      type: Schema.Types.ObjectId,
      ref: 'GuardianAccessAccount',
      default: null,
    },
    verificationTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    pinMode: {
      type: String,
      enum: ['create', 'link_existing'],
      default: 'create',
    },
    stage: {
      type: String,
      enum: ['awaiting_selection', 'awaiting_pin', 'completed', 'blocked', 'expired'],
      default: 'awaiting_selection',
      index: true,
    },
    failedCpfAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    ipHash: {
      type: String,
      default: null,
    },
    userAgentHash: {
      type: String,
      default: null,
    },
    cpfHash: { type: String, default: null },
    cpfMasked: { type: String, default: null, maxlength: 24 },
    ipMasked: { type: String, default: null, maxlength: 80 },
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

guardianFirstAccessChallengeSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_guardian_first_access_challenge' }
);

module.exports = mongoose.model(
  'GuardianFirstAccessChallenge',
  guardianFirstAccessChallengeSchema
);
