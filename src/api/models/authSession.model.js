const mongoose = require('mongoose');

const authSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  familyId: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  replacedByTokenHash: { type: String, default: null },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  lastUsedAt: { type: Date, default: Date.now },
  revokedAt: { type: Date, default: null },
  revokeReason: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.model('AuthSession', authSessionSchema);
