const mongoose = require('mongoose');

const { Schema } = mongoose;

const guardianPinRecoveryRateLimitSchema = new Schema(
  {
    scope: {
      type: String,
      enum: ['cpf', 'ip'],
      required: true,
    },
    keyHash: {
      type: String,
      required: true,
    },
    windowStartedAt: {
      type: Date,
      required: true,
    },
    count: {
      type: Number,
      default: 0,
      min: 0,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

guardianPinRecoveryRateLimitSchema.index(
  { scope: 1, keyHash: 1, windowStartedAt: 1 },
  { unique: true, name: 'uniq_guardian_pin_recovery_rate_window' }
);

guardianPinRecoveryRateLimitSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_guardian_pin_recovery_rate_limit' }
);

module.exports = mongoose.model(
  'GuardianPinRecoveryRateLimit',
  guardianPinRecoveryRateLimitSchema
);
