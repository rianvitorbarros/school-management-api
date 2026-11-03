const mongoose = require('mongoose');

// The account identifies a person globally.  This document is the tenant
// boundary: roles, status and the employment profile belong to a school, not
// to the person account.
const schoolUserMembershipSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  school_id: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  roles: [{ type: String, required: true, enum: ['Professor', 'Coordenador', 'Admin', 'Staff'] }],
  status: { type: String, enum: ['Ativo', 'Inativo'], default: 'Ativo', required: true },
  staffProfile: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffProfile', default: null },
}, { timestamps: true });

schoolUserMembershipSchema.index({ user: 1, school_id: 1 }, { unique: true });

module.exports = mongoose.model('SchoolUserMembership', schoolUserMembershipSchema);
