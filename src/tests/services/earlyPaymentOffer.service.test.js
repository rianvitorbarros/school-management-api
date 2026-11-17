const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../api/services/earlyPaymentOffer.service');
const { computeDiscount, isOpen, buildStats } = service;
const Offer = require('../../api/models/earlyPaymentOffer.model');
const Adhesion = require('../../api/models/earlyPaymentAdhesion.model');
const feePlans = require('../../api/services/academicMonthlyFeePlan.service');

const day = 24 * 3600 * 1000;
const baseOffer = { _id: '6abe466df1583ec667d0e01f', school_id: '6abe466df1583ec667d0e01e', title: 'Janeiro antecipado', academicYear: 2027, referenceMonth: 1,
  discountType: 'PERCENTAGE', discountValue: 10, startDate: new Date(Date.now() - day), endDate: new Date(Date.now() + 10 * day), audience: 'ALL', status: 'ACTIVE' };

test('percentage and fixed discounts never exceed the fee', () => {
  assert.deepEqual(computeDiscount(baseOffer, 50000), { originalAmountCents: 50000, discountCents: 5000, finalAmountCents: 45000 });
  assert.deepEqual(computeDiscount({ discountType: 'FIXED', discountValue: 80 }, 50000), { originalAmountCents: 50000, discountCents: 8000, finalAmountCents: 42000 });
  assert.equal(computeDiscount({ discountType: 'FIXED', discountValue: 900 }, 50000).finalAmountCents, 0);
  assert.equal(computeDiscount(baseOffer, null).discountCents, null);
});

test('offer is open only while active and within its window (end day inclusive)', () => {
  assert.equal(isOpen(baseOffer), true);
  assert.equal(isOpen({ ...baseOffer, status: 'PAUSED' }), false);
  assert.equal(isOpen({ ...baseOffer, endDate: new Date(Date.now() - 2 * day) }), false);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  assert.equal(isOpen({ ...baseOffer, endDate: today }), true);
});

test('stats count live adhesions, committed and granted discounts', () => {
  const stats = buildStats([
    { status: 'PAID', source: 'reEnrollment', discountCents: 5000, finalAmountCents: 45000 },
    { status: 'INTERESTED', source: 'web', discountCents: 4000, finalAmountCents: 36000 },
    { status: 'CANCELLED', source: 'web', discountCents: 9999, finalAmountCents: 1 },
    { status: 'CONFIRMED', source: 'manual', discountCents: null, finalAmountCents: null },
  ]);
  assert.equal(stats.adhesions, 3);
  assert.equal(stats.paid, 1);
  assert.equal(stats.discountCommitted, 90);
  assert.equal(stats.discountGranted, 50);
  assert.equal(stats.anticipatedRevenue, 450);
  assert.equal(stats.withoutAmount, 1);
  assert.equal(stats.byStatus.CANCELLED, 1);
});

test('create validates percentage above 100 and inverted dates', async () => {
  await assert.rejects(() => service.create('s', 'u', { title: 'x', discountValue: 120, startDate: '2026-11-01', endDate: '2026-12-31' }), /100%/);
  await assert.rejects(() => service.create('s', 'u', { title: 'x', discountValue: 10, startDate: '2026-12-31', endDate: '2026-11-01' }), /anterior/);
});

test('public adhesion uses the published fee of the offer year and respects audience', async () => {
  const originals = [Offer.findOne, Adhesion.create, Adhesion.findOne, Adhesion.countDocuments, feePlans.publishedForDestination];
  let created = null;
  Offer.findOne = async () => ({ ...baseOffer });
  Adhesion.countDocuments = async () => 0;
  Adhesion.findOne = async () => null;
  Adhesion.create = async (doc) => { created = doc; return { ...doc, _id: 'a1' }; };
  feePlans.publishedForDestination = async (_s, year) => (year === 2027 ? { cents: 60000, value: 600 } : null);
  try {
    const r = await service.publicAdhesion(baseOffer.school_id, baseOffer._id, { studentName: 'Ana', guardianName: 'Bia', guardianPhone: '11999999999', targetLevel: 'Ensino Fundamental I', targetGrade: '2º Ano' });
    assert.equal(r.created, true);
    assert.equal(created.source, 'web');
    assert.equal(created.finalAmountCents, 54000);
    assert.equal(r.adhesion.discountAmount, 60);
    await assert.rejects(() => service.publicAdhesion(baseOffer.school_id, baseOffer._id, { studentName: 'Ana' }), /responsável/);
    Offer.findOne = async () => ({ ...baseOffer, audience: 'RE_ENROLLMENT' });
    await assert.rejects(() => service.publicAdhesion(baseOffer.school_id, baseOffer._id, { studentName: 'Ana', guardianName: 'B', guardianPhone: '1' }), /rematrícula/);
    Offer.findOne = async () => ({ ...baseOffer, maxAdhesions: 2 });
    Adhesion.countDocuments = async () => 2;
    await assert.rejects(() => service.publicAdhesion(baseOffer.school_id, baseOffer._id, { studentName: 'Ana', guardianName: 'B', guardianPhone: '1' }), /preenchidas/);
  } finally {
    [Offer.findOne, Adhesion.create, Adhesion.findOne, Adhesion.countDocuments, feePlans.publishedForDestination] = originals;
  }
});
