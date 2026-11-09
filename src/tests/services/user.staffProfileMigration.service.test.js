const test = require('node:test');
const assert = require('node:assert/strict');

const UserService = require('../../api/services/user.service');
const SchoolUserMembership = require('../../api/models/schoolUserMembership.model');
const StaffProfile = require('../../api/models/staffProfile.model');

test('never resolves a legacy profile from another school', async (t) => {
  let query;
  t.mock.method(StaffProfile, 'findOne', async (value) => {
    query = value;
    return { _id: 'profile-batista' };
  });

  const membership = await UserService._legacyMembership(
    { _id: 'legacy-user', school_id: 'school-batista', staffProfiles: ['other-school-profile'] },
    'school-batista',
  );

  assert.deepEqual(query, {
    user: 'legacy-user',
    $or: [
      { school_id: 'school-batista' },
      { school_id: { $exists: false } },
    ],
  });
  assert.equal(membership.staffProfile, 'profile-batista');
});

test('creates a school-scoped membership only when a legacy profile is explicitly completed', async (t) => {
  const saved = [];
  let query;
  let update;
  let options;
  const user = {
    _id: 'legacy-user',
    school_id: 'school-batista',
    staffProfiles: [],
    save: async () => saved.push('user'),
  };

  t.mock.method(SchoolUserMembership, 'findOneAndUpdate', async (q, u, o) => {
    query = q;
    update = u;
    options = o;
    return { _id: 'membership-batista' };
  });

  await UserService._attachProfileToMembership(
    user,
    {
      legacy: true,
      roles: ['Professor'],
      status: 'Ativo',
    },
    'school-batista',
    { _id: 'staff-profile-batista' },
  );

  assert.deepEqual(query, { user: 'legacy-user', school_id: 'school-batista' });
  assert.deepEqual(update.$set, {
    roles: ['Professor'],
    status: 'Ativo',
    staffProfile: 'staff-profile-batista',
  });
  assert.equal(options.upsert, true);
  assert.equal(options.runValidators, true);
  assert.deepEqual(user.staffProfiles, ['staff-profile-batista']);
  assert.deepEqual(saved, ['user']);
});

test('never appends another school profile to the global legacy user', async (t) => {
  const user = {
    _id: 'shared-user',
    school_id: 'school-origin',
    staffProfiles: [],
    save: async () => assert.fail('the global user must not be changed'),
  };

  t.mock.method(SchoolUserMembership, 'findOneAndUpdate', async () => ({}));

  await UserService._attachProfileToMembership(
    user,
    { legacy: true, roles: ['Professor'], status: 'Ativo' },
    'school-batista',
    { _id: 'staff-profile-batista' },
  );

  assert.deepEqual(user.staffProfiles, []);
});

test('resolves a legacy membership whose staffProfile is a raw ObjectId', async (t) => {
  const mongoose = require('mongoose');
  const profileId = new mongoose.Types.ObjectId();
  const profileDoc = { _id: profileId, mainRole: 'Professor', employmentType: 'Efetivo (CLT)' };
  let requestedId;
  t.mock.method(StaffProfile, 'findById', (id) => {
    requestedId = id;
    return { populate: async () => profileDoc };
  });

  const result = await UserService._toSchoolUser(
    { _id: 'legacy-user', fullName: 'Legado', staffProfiles: [profileId] },
    { school_id: 'school-batista', roles: ['Professor'], status: 'Ativo', staffProfile: profileId, legacy: true },
  );

  assert.equal(requestedId, profileId);
  assert.deepEqual(result.staffProfiles, [profileDoc]);
});

test('keeps an already populated membership staffProfile without refetching', async (t) => {
  const profileDoc = { _id: 'profile-batista', mainRole: 'Coordenador' };
  t.mock.method(StaffProfile, 'findById', () => assert.fail('must not refetch a populated profile'));

  const result = await UserService._toSchoolUser(
    { _id: 'member-user', staffProfiles: [] },
    { school_id: 'school-batista', roles: ['Coordenador'], status: 'Ativo', staffProfile: profileDoc },
  );

  assert.deepEqual(result.staffProfiles, [profileDoc]);
});
