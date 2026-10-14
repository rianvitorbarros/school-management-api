const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../api/services/academicMonthlyFeePlan.service');
const Plan = require('../../api/models/academicMonthlyFeePlan.model');

async function withPlans(plans, run) {
  const original = Plan.find;
  Plan.find = (query) => ({ lean: async () => plans.filter(item => item.shift === query.shift && item.level === query.level && item.publishedCents != null) });
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
test('a draft and a price of another shift never replace a missing published value', async () => {
  await withPlans([{ ...common, shift: 'Matutino' }, { ...common, grade: '2º Período', publishedCents: null, draftCents: 35000 }], async () => {
    assert.equal(await service.publishedForDestination('school', 2027, { level: common.level, grade: '2º Período', shift: 'Vespertino' }), null);
  });
});
