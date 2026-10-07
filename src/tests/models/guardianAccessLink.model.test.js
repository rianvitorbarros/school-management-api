const assert = require('node:assert/strict');
const test = require('node:test');
const mongoose = require('mongoose');

const GuardianAccessLink = require('../../api/models/guardianAccessLink.model');

test('guardian access link accepts the PIN recovery provenance', async () => {
  const link = new GuardianAccessLink({
    school_id: new mongoose.Types.ObjectId(),
    guardianAccessAccountId: new mongoose.Types.ObjectId(),
    studentId: new mongoose.Types.ObjectId(),
    tutorId: new mongoose.Types.ObjectId(),
    source: 'pin_recovery',
  });

  await link.validate();
  assert.equal(link.source, 'pin_recovery');
});
