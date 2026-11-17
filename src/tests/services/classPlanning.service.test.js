const test = require('node:test');
const assert = require('node:assert/strict');
const Class = require('../../api/models/class.model');
const School = require('../../api/models/school.model');
const AuditLog = require('../../api/models/auditLog.model');
const feePlans = require('../../api/services/academicMonthlyFeePlan.service');
const { planClasses } = require('../../api/services/classPlanning.service');

const source = { _id: 'c1', name: '1º Ano A', level: 'Ensino Fundamental I', grade: '1º Ano', shift: 'Matutino', schoolYear: 2026, status: 'Ativa', monthlyFee: 500 };
const other = { ...source, _id: 'c2', name: '2º Ano A', grade: '2º Ano' };
const existing = { ...other, _id: 'c3', schoolYear: 2027, status: 'Planejada' };

async function withMocks(classes, run, published = null) {
  const originals = [Class.find, Class.create, School.findById, AuditLog.create, feePlans.publishedForDestination];
  const created = [];
  Class.find = () => ({ select: () => ({ lean: async () => classes }) });
  Class.create = async (doc) => { created.push(doc); return { ...doc, _id: `new-${created.length}` }; };
  School.findById = () => ({ select: () => ({ lean: async () => ({ _id: 's', educationModel: 'regular' }) }) });
  AuditLog.create = async () => ({});
  feePlans.publishedForDestination = async () => published;
  try { await run(created); } finally {
    [Class.find, Class.create, School.findById, AuditLog.create, feePlans.publishedForDestination] = originals;
  }
}

test('creates planned classes from projections with capacity and published fee', async () => {
  await withMocks([source, other, existing], async (created) => {
    const result = await planClasses('s', 'u', { academicYear: 2027, items: [{ sourceClassId: 'planning:2027:c1', capacity: 25 }, { sourceClassId: 'c2', capacity: 20 }] });
    assert.equal(result.created.length, 1);
    assert.equal(created[0].status, 'Planejada');
    assert.equal(created[0].schoolYear, 2027);
    assert.equal(created[0].capacity, 25);
    assert.equal(created[0].monthlyFee, 550);
    assert.equal(result.skipped[0].sourceClassId, 'c2');
  }, { value: 550 });
});

test('keeps the reference fee and rejects invalid capacity', async () => {
  await withMocks([source], async (created) => {
    const bad = await planClasses('s', 'u', { academicYear: 2027, items: [{ sourceClassId: 'c1', capacity: 0 }] });
    assert.equal(bad.created.length, 0);
    const ok = await planClasses('s', 'u', { academicYear: 2027, items: [{ sourceClassId: 'c1' }] });
    assert.equal(ok.created.length, 1);
    assert.equal(created[0].monthlyFee, 500);
  });
});

test('requires items and a valid year', async () => {
  await assert.rejects(() => planClasses('s', 'u', { academicYear: 2027, items: [] }), /Selecione/);
  await assert.rejects(() => planClasses('s', 'u', { academicYear: 'x', items: [{}] }), /ano letivo/);
});
