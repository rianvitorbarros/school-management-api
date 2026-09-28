const mongoose = require('mongoose');

const { Schema } = mongoose;

const guardianAccessAccountSchema = new Schema(
  {
    school_id: {
      type: Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    tutorId: {
      type: Schema.Types.ObjectId,
      ref: 'Tutor',
      required: true,
      index: true,
    },
    identifierType: {
      type: String,
      enum: ['cpf'],
      default: 'cpf',
      required: true,
    },
    identifierNormalized: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    identifierMasked: {
      type: String,
      required: true,
      trim: true,
    },
    pinHash: {
      type: String,
      default: null,
      select: false,
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'inactive'],
      default: 'pending',
      index: true,
    },
    activatedAt: {
      type: Date,
      default: null,
    },
    pinUpdatedAt: {
      type: Date,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    failedLoginCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastFailedAt: {
      type: Date,
      default: null,
    },
    blockedUntil: {
      type: Date,
      default: null,
      index: true,
    },
    tokenVersion: {
      type: Number,
      default: 0,
      min: 0,
    },
    temporaryAccess: {
      credentialId: { type: String, default: null, select: false },
      passwordHash: { type: String, default: null, select: false },
      expiresAt: { type: Date, default: null },
      usedAt: { type: Date, default: null },
      revokedAt: { type: Date, default: null },
      createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      createdAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
  }
);

guardianAccessAccountSchema.index(
  { school_id: 1, tutorId: 1 },
  { unique: true, name: 'uniq_guardian_access_account_school_tutor' }
);

guardianAccessAccountSchema.index(
  { school_id: 1, identifierNormalized: 1 },
  { unique: true, name: 'uniq_guardian_access_account_school_identifier' }
);

module.exports = mongoose.model(
  'GuardianAccessAccount',
  guardianAccessAccountSchema
);
