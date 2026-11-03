const User = require('../models/user.model');
const StaffProfile = require('../models/staffProfile.model');
const SchoolUserMembership = require('../models/schoolUserMembership.model');
const appEmitter = require('../../loaders/eventEmitter');

const identityFields = ['fullName', 'email', 'cpf', 'birthDate', 'gender', 'phoneNumber', 'phoneFixed', 'address', 'profilePictureUrl', 'username', 'password'];
const membershipFields = ['roles', 'status'];
const profileFields = ['nationality', 'maritalStatus', 'documents', 'admissionDate', 'terminationDate', 'employmentType', 'mainRole', 'remunerationModel', 'salaryAmount', 'hourlyRate', 'weeklyWorkload', 'academicFormation', 'enabledLevels', 'enabledSubjects'];
const idOf = (value) => value && value._id ? String(value._id) : String(value || '');
const pick = (source, fields) => Object.fromEntries(Object.entries(source || {}).filter(([key]) => fields.includes(key)));

function domainError(message, code, statusCode = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

class UserService {
  async _findMatchingIdentity(data) {
    const clauses = ['cpf', 'email', 'username'].map((field) => {
      const value = typeof data[field] === 'string' ? data[field].trim() : data[field];
      if (!value) return null;
      return { [field]: field === 'email' || field === 'username' ? value.toLowerCase() : value };
    }).filter(Boolean);
    if (!clauses.length) return null;
    const users = await User.find({ $or: clauses });
    if (!users.length) return null;
    if (new Set(users.map(idOf)).size > 1) throw domainError('Os identificadores informados pertencem a contas diferentes.', 'IDENTITY_CONFLICT', 409);
    return users[0];
  }

  async _legacyMembership(user, schoolId) {
    if (idOf(user.school_id) !== idOf(schoolId)) return null;
    const profile = user.staffProfiles?.[0] || await StaffProfile.findOne({ user: user._id });
    return { user: user._id, school_id: schoolId, roles: user.roles || [], status: user.status || 'Inativo', staffProfile: profile?._id || null, legacy: true };
  }

  async _membershipFor(user, schoolId) {
    const membership = await SchoolUserMembership.findOne({ user: user._id, school_id: schoolId }).populate({ path: 'staffProfile', populate: { path: 'enabledSubjects', model: 'Subject' } });
    return membership || this._legacyMembership(user, schoolId);
  }

  async _toSchoolUser(user, membership) {
    const plain = user.toObject ? user.toObject() : { ...user };
    delete plain.password;
    const profile = membership.staffProfile && typeof membership.staffProfile === 'object'
      ? membership.staffProfile
      : membership.staffProfile ? await StaffProfile.findById(membership.staffProfile).populate('enabledSubjects') : null;
    return { ...plain, school_id: idOf(membership.school_id), roles: membership.roles || [], status: membership.status || 'Inativo', staffProfiles: profile ? [profile] : [] };
  }

  async _createProfile(data, userId, schoolId) {
    const profile = new StaffProfile({ ...pick(data, profileFields), user: userId, school_id: schoolId });
    await profile.save();
    return profile;
  }

  async _createMembership(data, user, schoolId, { allowPrimaryLegacy = false } = {}) {
    const existing = await SchoolUserMembership.findOne({ user: user._id, school_id: schoolId });
    if (existing || (!allowPrimaryLegacy && await this._legacyMembership(user, schoolId))) throw domainError('Este professor já está vinculado à escola atual.', 'STAFF_ALREADY_LINKED_TO_CURRENT_SCHOOL', 409);
    const profile = await this._createProfile(data, user._id, schoolId);
    try {
      return await SchoolUserMembership.create({ user: user._id, school_id: schoolId, roles: Array.isArray(data.roles) && data.roles.length ? data.roles : ['Professor'], status: data.status || 'Ativo', staffProfile: profile._id });
    } catch (error) {
      await StaffProfile.findByIdAndDelete(profile._id);
      throw error;
    }
  }

  async createStaff(data, schoolId) {
    const existing = await this._findMatchingIdentity(data);
    if (existing) {
      if (await this._membershipFor(existing, schoolId)) throw domainError('Este professor já está vinculado à escola atual.', 'STAFF_ALREADY_LINKED_TO_CURRENT_SCHOOL', 409);
      throw domainError('Já existe uma conta para estes dados. Confirme para vinculá-la à escola atual.', 'STAFF_EXISTS_AT_ANOTHER_SCHOOL', 409, { existingUser: { id: idOf(existing), fullName: existing.fullName } });
    }
    const user = new User({ ...pick(data, identityFields), school_id: schoolId, roles: data.roles || ['Professor'], status: data.status || 'Ativo' });
    await user.save();
    try {
      const membership = await this._createMembership(data, user, schoolId, { allowPrimaryLegacy: true });
      // Legacy readers retain the primary profile only. Linked profiles live
      // exclusively in the membership to avoid data leakage between schools.
      user.staffProfiles.push(membership.staffProfile);
      await user.save();
      const scoped = await this._toSchoolUser(user, membership);
      appEmitter.emit('user:created', scoped);
      return scoped;
    } catch (error) {
      await User.findByIdAndDelete(user._id);
      throw error;
    }
  }

  async linkExistingStaff(existingUserId, data, schoolId) {
    const user = await User.findById(existingUserId);
    if (!user) throw domainError('Conta de professor não encontrada.', 'USER_NOT_FOUND', 404);
    const membership = await this._createMembership(data, user, schoolId);
    const scoped = await this._toSchoolUser(user, membership);
    appEmitter.emit('user:created', scoped);
    return scoped;
  }

  async createUser(data, schoolId) {
    if (await this._findMatchingIdentity(data)) throw domainError('Já existe uma conta para estes dados.', 'USER_ALREADY_EXISTS', 409);
    const user = new User({ ...pick(data, identityFields), school_id: schoolId, roles: data.roles || [], status: data.status || 'Ativo' });
    await user.save();
    const membership = await SchoolUserMembership.create({ user: user._id, school_id: schoolId, roles: user.roles, status: user.status });
    const scoped = await this._toSchoolUser(user, membership);
    appEmitter.emit('user:created', scoped);
    return scoped;
  }

  async getAllUsers(schoolId) {
    const memberships = await SchoolUserMembership.find({ school_id: schoolId }).populate({ path: 'staffProfile', populate: { path: 'enabledSubjects', model: 'Subject' } });
    const memberIds = memberships.map((membership) => membership.user);
    const [memberUsers, legacyUsers] = await Promise.all([
      memberIds.length ? User.find({ _id: { $in: memberIds } }).select('-password') : [],
      User.find({ school_id: schoolId, _id: { $nin: memberIds } }).select('-password').populate({ path: 'staffProfiles', populate: { path: 'enabledSubjects', model: 'Subject' } }),
    ]);
    const byId = new Map(memberUsers.map((user) => [idOf(user), user]));
    const scoped = await Promise.all(memberships.map((membership) => this._toSchoolUser(byId.get(idOf(membership.user)), membership)));
    for (const user of legacyUsers) scoped.push(await this._toSchoolUser(user, await this._legacyMembership(user, schoolId)));
    return scoped;
  }

  async getUserById(id, schoolId) {
    const user = await User.findById(id).select('-password').populate({ path: 'staffProfiles', populate: { path: 'enabledSubjects', model: 'Subject' } });
    const membership = user && await this._membershipFor(user, schoolId);
    if (!membership) throw domainError('Usuário não encontrado ou não pertence a esta escola.', 'USER_NOT_FOUND', 404);
    return this._toSchoolUser(user, membership);
  }

  async getMembershipByUserId(id, schoolId) {
    const user = await User.findById(id).populate('staffProfiles');
    return user ? this._membershipFor(user, schoolId) : null;
  }

  async updateStaff(id, data, schoolId) {
    const user = await User.findById(id);
    const membership = user && await this._membershipFor(user, schoolId);
    if (!membership) throw domainError('Usuário não encontrado ou não pertence a esta escola.', 'USER_NOT_FOUND', 404);
    const storedMemberships = await SchoolUserMembership.countDocuments({ user: user._id });
    const primaryCovered = user.school_id && await SchoolUserMembership.exists({ user: user._id, school_id: user.school_id });
    const memberships = storedMemberships + (user.school_id && !primaryCovered ? 1 : 0);
    const hasIdentityEdit = Object.keys(pick(data, identityFields)).some((key) => key !== 'password');
    if (memberships > 1 && hasIdentityEdit) throw domainError('Dados pessoais da conta compartilhada só podem ser alterados pelo próprio titular.', 'SHARED_IDENTITY_READ_ONLY', 403);
    const localData = pick(data, membershipFields);
    if (Object.keys(localData).length) {
      if (membership.legacy) Object.assign(user, localData);
      else await SchoolUserMembership.findByIdAndUpdate(membership._id, localData, { runValidators: true });
    }
    if (memberships <= 1) { Object.assign(user, pick(data, identityFields)); delete user.password; await user.save(); }
    const profileData = pick(data, profileFields);
    if (Object.keys(profileData).length && membership.staffProfile) await StaffProfile.findByIdAndUpdate(membership.staffProfile, profileData, { runValidators: true });
    const scoped = await this.getUserById(id, schoolId);
    appEmitter.emit('user:updated', scoped);
    return scoped;
  }

  async _changeLocalStatus(id, schoolId, status) {
    const user = await User.findById(id);
    const membership = user && await this._membershipFor(user, schoolId);
    if (!membership) throw domainError('Usuário não encontrado ou não pertence a esta escola.', 'USER_NOT_FOUND', 404);
    if (membership.legacy) { user.status = status; await user.save(); }
    else await SchoolUserMembership.findByIdAndUpdate(membership._id, { status }, { runValidators: true });
    const scoped = await this.getUserById(id, schoolId);
    appEmitter.emit('user:updated', scoped);
    return scoped;
  }

  inactivateUser(id, schoolId) { return this._changeLocalStatus(id, schoolId, 'Inativo'); }
  reactivateUser(id, schoolId) { return this._changeLocalStatus(id, schoolId, 'Ativo'); }
}

module.exports = new UserService();
