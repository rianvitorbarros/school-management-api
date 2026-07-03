const mongoose = require('mongoose');
const {
  GUARDIAN_ACCESS_EVENT_TYPE_VALUES,
} = require('../constants/guardianAccessEventTypes');

const { Schema } = mongoose;

const guardianAccessEventSchema = new Schema(
  {
    school_id: {
      type: Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    accountId: {
      type: Schema.Types.ObjectId,
      ref: 'GuardianAccessAccount',
      default: null,
      index: true,
    },
    linkId: {
      type: Schema.Types.ObjectId,
      ref: 'GuardianAccessLink',
      default: null,
    },
    challengeId: {
      type: Schema.Types.ObjectId,
      ref: 'GuardianFirstAccessChallenge',
      default: null,
    },
    recoveryChallengeId: {
      type: Schema.Types.ObjectId,
      ref: 'GuardianPinRecoveryChallenge',
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
    actorType: {
      type: String,
      enum: ['public', 'guardian', 'staff', 'system'],
      required: true,
      index: true,
    },
    actorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    schemaVersion: {
      type: Number,
      default: 2,
      min: 1,
    },
    status: {
      type: String,
      enum: ['success', 'failed', 'blocked', 'expired', 'revoked', 'info'],
      default: 'info',
      index: true,
    },
    source: {
      type: String,
      enum: ['mobile', 'desktop', 'api', 'system', 'unknown'],
      default: 'unknown',
    },
    actorNameSnapshot: {
      type: String,
      default: null,
      maxlength: 160,
    },
    actorRoleSnapshot: {
      type: [String],
      default: [],
    },
    eventType: {
      type: String,
      enum: GUARDIAN_ACCESS_EVENT_TYPE_VALUES,
      required: true,
      index: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    reasonCode: {
      type: String,
      default: null,
      maxlength: 80,
    },
    reasonText: {
      type: String,
      default: null,
      maxlength: 500,
    },
    affectedFields: {
      type: [String],
      default: [],
    },
    tokenVersionBefore: {
      type: Number,
      default: null,
      min: 0,
    },
    tokenVersionAfter: {
      type: Number,
      default: null,
      min: 0,
    },
    sessionsRevoked: {
      type: Boolean,
      default: false,
    },
    ipHash: {
      type: String,
      default: null,
    },
    ipMasked: {
      type: String,
      default: null,
      maxlength: 80,
    },
    userAgentHash: {
      type: String,
      default: null,
    },
    userAgentSummary: {
      type: String,
      default: null,
      maxlength: 160,
    },
    devicePlatform: {
      type: String,
      enum: ['android', 'ios', 'web', 'windows', 'macos', 'linux', 'unknown'],
      default: 'unknown',
    },
    appVersion: {
      type: String,
      default: null,
      maxlength: 40,
    },
    cpfHash: {
      type: String,
      default: null,
    },
    cpfMasked: {
      type: String,
      default: null,
      maxlength: 24,
    },
    correlationId: {
      type: String,
      default: null,
      maxlength: 80,
    },
  },
  {
    timestamps: true,
  }
);

guardianAccessEventSchema.index(
  { school_id: 1, accountId: 1, createdAt: -1, _id: -1 },
  { name: 'idx_guardian_access_event_school_account_created' }
);

guardianAccessEventSchema.index(
  { school_id: 1, studentId: 1, createdAt: -1, _id: -1 },
  { name: 'idx_guardian_access_event_school_student_created' }
);

guardianAccessEventSchema.index(
  { school_id: 1, tutorId: 1, createdAt: -1, _id: -1 },
  { name: 'idx_guardian_access_event_school_tutor_created' }
);

guardianAccessEventSchema.index(
  { school_id: 1, eventType: 1, createdAt: -1, _id: -1 },
  { name: 'idx_guardian_access_event_school_type_created' }
);

guardianAccessEventSchema.index(
  { school_id: 1, status: 1, createdAt: -1, _id: -1 },
  { name: 'idx_guardian_access_event_school_status_created' }
);

guardianAccessEventSchema.index(
  { school_id: 1, actorUserId: 1, createdAt: -1, _id: -1 },
  { name: 'idx_guardian_access_event_school_actor_created' }
);

guardianAccessEventSchema.index(
  { school_id: 1, correlationId: 1, createdAt: -1, _id: -1 },
  {
    name: 'idx_guardian_access_event_school_correlation_created',
    partialFilterExpression: { correlationId: { $type: 'string' } },
  }
);

module.exports = mongoose.model('GuardianAccessEvent', guardianAccessEventSchema);
