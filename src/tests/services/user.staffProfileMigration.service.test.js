const test = require('node:test');
const assert = require('node:assert/strict');

const UserService = require('../../api/services/user.service');
const SchoolUserMembership = require('../../api/models/schoolUserMembership.model');

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
