const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../api/services/academicMonthlyFeePlan.service');
const Plan = require('../../api/models/academicMonthlyFeePlan.model');

async function withPlans(plans, run) {
  const original = Plan.find;
  Plan.find = (query) => ({ lean: async () => plans.filter(item => item.level === query.level && item.publishedCents != null) });
  try { await run(); } finally { Plan.find = original; }
}
const common = { _id: 'legacy-price', level: 'Educação Infantil', grade: 'PERIODO', shift: 'Vespertino', publishedCents: 35000, publishedVersion: 2 };
test('both numbered periods reuse the published legacy shared price and version', async () => {
  await withPlans([common], async () => {
    for (const grade of ['1º Período', '2º Período']) {
      const price = await service.publishedForDestination('school', 2027, { level: common.level, grade, shift: common.shift });
      assert.deepEqual(price, { value: 350, cents: 35000, versionId: 'legacy-price', version: 2 });
    }
  });
});
test('an explicitly published period price takes precedence over the shared legacy key', async () => {
  await withPlans([common, { ...common, _id: 'explicit', grade: '2º Período', publishedCents: 37500 }], async () => {
    assert.equal((await service.publishedForDestination('school', 2027, { level: common.level, grade: '2º Período', shift: common.shift })).cents, 37500);
  });
});
test('a published grade price is shared across shifts without changing the student shift', async () => {
  await withPlans([{ ...common, shift: 'Matutino' }], async () => {
    const price = await service.publishedForDestination('school', 2027, { level: common.level, grade: '2º Período', shift: 'Vespertino' });
    assert.equal(price.cents, 35000);
    assert.equal(price.versionId, 'legacy-price');
  });
});
test('a canonical published grade takes precedence over a conflicting legacy grade alias', async () => {
  const canonical = { ...common, _id: 'canonical-first-year', level: 'Ensino Fundamental I', grade: '1º Ano', shift: 'Vespertino', publishedCents: 45000 };
  const legacyAlias = { ...canonical, _id: 'legacy-first-year', grade: '1° ANO', shift: 'Matutino', publishedCents: 35000 };
  await withPlans([canonical, legacyAlias], async () => {
    const price = await service.publishedForDestination('school', 2027, { level: canonical.level, grade: '1º Ano', shift: canonical.shift });
    assert.deepEqual(price, { value: 450, cents: 45000, versionId: 'canonical-first-year', version: 2 });
  });
});
test('draft-only and conflicting publications cannot provide an official common price', async () => {
  await withPlans([{ ...common, publishedCents: null, draftCents: 35000 }], async () => {
    assert.equal(await service.publishedForDestination('school', 2027, { level: common.level, grade: '2º Período', shift: 'Vespertino' }), null);
  });
  await withPlans([common, { ...common, _id: 'other', shift: 'Matutino', publishedCents: 37500 }], async () => {
    assert.equal(await service.publishedForDestination('school', 2027, { level: common.level, grade: '2º Período', shift: 'Vespertino' }), null);
  });
});
test('zero is a valid published common price and stays distinct from missing publication', async () => {
  await withPlans([{ ...common, publishedCents: 0 }], async () => {
    assert.equal((await service.publishedForDestination('school', 2027, { level: common.level, grade: '2º Período', shift: 'Vespertino' })).cents, 0);
  });
});
