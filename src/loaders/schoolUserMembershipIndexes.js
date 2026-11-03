const StaffProfile = require('../api/models/staffProfile.model');
const SchoolUserMembership = require('../api/models/schoolUserMembership.model');

// No records are changed here. The old index made a second employment profile
// with the same role impossible even when it belonged to another school.
async function ensureSchoolUserMembershipIndexes() {
  const indexes = await StaffProfile.collection.indexes();
  if (indexes.some((index) => index.name === 'user_1_mainRole_1')) {
    await StaffProfile.collection.dropIndex('user_1_mainRole_1');
    console.log('[Membership] índice legado user_1_mainRole_1 removido.');
  }
  await StaffProfile.collection.createIndex(
    { user: 1, school_id: 1, mainRole: 1 },
    { unique: true, name: 'user_1_school_id_1_mainRole_1' },
  );
  await SchoolUserMembership.syncIndexes();
}

module.exports = { ensureSchoolUserMembershipIndexes };
