const test = require('node:test');
const assert = require('node:assert/strict');
const Registration = require('../../api/models/registration-request.model');
const service = require('../../api/services/registration-request.service');

test('public registration stores explicit year or real selected-class year, never creation year', async () => {
  const originals = [service._assertSchoolExists, service._getSelectableClassOrThrow, service._resolveDestination, Registration.prototype.save];
  service._assertSchoolExists = async () => ({});
  service._getSelectableClassOrThrow = async () => ({ classDoc: { _id: '507f1f77bcf86cd799439012', schoolYear: 2026 }, snapshot: { schoolYear: 2026 } });
  service._resolveDestination = async (_, year) => { if (year !== 2026) throw Object.assign(new Error('year mismatch'), { statusCode: 409 }); return service._getSelectableClassOrThrow(); };
  Registration.prototype.save = async function () { return this; };
  const base = { school_id: '507f1f77bcf86cd799439011', registrationType: 'ADULT_STUDENT', studentData: { fullName: 'Teste', birthDate: '2010-01-01', cpf: '52998224725' } };
  try {
    const explicit = await service.createPublicRequest({ ...base, academicYearTo: 2027 });
    assert.equal(explicit.academicYearTo, 2027); assert.equal(explicit.selectedClassId, undefined);
    const selected = await service.createPublicRequest({ ...base, selectedClassId: '507f1f77bcf86cd799439012' });
    assert.equal(selected.academicYearTo, 2026); assert.equal(selected.selectedClassSnapshot.schoolYear, 2026);
    const legacy = await service.createPublicRequest(base);
    assert.equal(legacy.academicYearTo, undefined);
    await assert.rejects(service.createPublicRequest({ ...base, academicYearTo: 2027, selectedClassId: '507f1f77bcf86cd799439012' }), e => e.statusCode === 409);
    for (const academicYearTo of [2027.5, 0, 2201, 'invalid']) {
      await assert.rejects(service.createPublicRequest({ ...base, academicYearTo }), e => e.statusCode === 400);
    }
  } finally { [service._assertSchoolExists, service._getSelectableClassOrThrow, service._resolveDestination, Registration.prototype.save] = originals; }
});
