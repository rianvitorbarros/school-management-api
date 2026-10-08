const AcademicMonthlyFeePlan = require('../models/academicMonthlyFeePlan.model');
const Class = require('../models/class.model');
const AuditLog = require('../models/auditLog.model');
const academicClassVisibilityFilter = {
  $or: [
    { status: { $in: ['Planejada', 'Ativa'] } },
    { status: { $exists: false } },
    { status: null },
  ],
};

const normalizeGrade = (grade, className = '') => {
  const raw = String(grade || '').trim();
  const normalized = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  if (normalized === 'MATERNAL') return 'Maternal';
  if (raw === '.' && /7\s*[º°o]?\s*ano/i.test(className)) return '7º Ano';
  const year = normalized.match(/^(\d+)\s*[º°o]?\s*ANO$/) || normalized.match(/^(\d+)$/);
  return year ? `${year[1]}º Ano` : raw;
};
const normalizedItem = (item) => ({ ...item, grade: normalizeGrade(item.grade, item.className || item.name) });
const keyOf = (item) => `${item.level}::${normalizeGrade(item.grade, item.className || item.name)}::${item.shift}`;
const toCents = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) throw Object.assign(new Error('Mensalidade inválida.'), { statusCode: 400, code: 'INVALID_MONTHLY_FEE' });
  return Math.round(amount * 100);
};
const money = (cents) => cents === null || cents === undefined ? null : Number((cents / 100).toFixed(2));
const publicPlan = (item) => ({
  id: String(item._id), academicYear: item.academicYear, level: item.level, grade: item.grade, shift: item.shift,
  draftValue: money(item.draftCents), publishedValue: money(item.publishedCents), publishedVersion: item.publishedVersion,
  publishedAt: item.publishedAt, updatedAt: item.updatedAt, hasUnpublishedChanges: item.draftCents !== item.publishedCents,
});

class AcademicMonthlyFeePlanService {
  async _audit({ schoolId, actorId, entityId, action, previous, current, reason }) {
    if (!actorId || !entityId) return;
    await AuditLog.create({ school: schoolId, actor: actorId, entity: 'AcademicMonthlyFeePlan', entityId, action, changes: { previous, current }, reason });
  }

  async overview(schoolId, academicYear) {
    const year = Number(academicYear);
    if (!Number.isInteger(year)) throw Object.assign(new Error('Ano letivo inválido.'), { statusCode: 400, code: 'INVALID_ACADEMIC_YEAR' });
    const [classes, priorClasses, plans] = await Promise.all([
      Class.find({ school_id: schoolId, schoolYear: year, ...academicClassVisibilityFilter }).select('+monthlyFee').lean(),
      // School years are not guaranteed to be consecutive in legacy data.
      // Select the latest available earlier class per academic key instead of
      // assuming `target year - 1` always exists.
      Class.find({ school_id: schoolId, schoolYear: { $lt: year }, ...academicClassVisibilityFilter }).select('+monthlyFee').sort({ schoolYear: -1 }).lean(),
      AcademicMonthlyFeePlan.find({ school_id: schoolId, academicYear: year }).lean(),
    ]);
    const planByKey = new Map(plans.map((plan) => [keyOf(plan), plan]));
    const currentByKey = new Map();
    for (const item of priorClasses) {
      if (!currentByKey.has(keyOf(item))) currentByKey.set(keyOf(item), item);
    }
    // A first plan projects the current academic catalogue. When next-year
    // classes exist, they become the display catalogue while prices remain
    // shared by the academic key (not by the A/B class section).
    const displayClasses = classes.length ? classes : priorClasses;
    const rows = displayClasses.map((rawItem) => {
      const item = normalizedItem(rawItem);
      const plan = planByKey.get(keyOf(item));
      // For the future catalogue, resolve the price from the latest currently
      // active matching academic key. The future draft never replaces it.
      const current = classes.length ? currentByKey.get(keyOf(item)) : rawItem;
      // When the target catalogue does not exist yet, `rawItem` is itself the
      // current class. Keep that value as the authoritative fallback instead
      // of allowing a failed key lookup to erase a valid Class.monthlyFee.
      const currentFee = Number(current?.monthlyFee ?? rawItem.monthlyFee);
      const currentValue = Number.isFinite(currentFee) ? money(Math.round(currentFee * 100)) : null;
      const draftValue = plan ? money(plan.draftCents) : null;
      return { ...publicPlan(plan || { _id: `${keyOf(item)}`, academicYear: year, level: item.level, grade: item.grade, shift: item.shift, draftCents: null, publishedCents: null, publishedVersion: 0, updatedAt: null }),
        // The plan can predate normalization. The display/lookup key must
        // always describe the class catalogue currently being planned.
        level: item.level, grade: item.grade, shift: item.shift,
        id: plan ? String(plan._id) : null, classId: String(item._id), className: item.name, classCount: 1, studentCount: Number(item.studentCount || 0),
        status: draftValue === null ? 'PENDING' : 'CONFIGURED' };
    }).sort((a, b) => `${a.level}${a.grade}${a.shift}${a.className}`.localeCompare(`${b.level}${b.grade}${b.shift}${b.className}`, 'pt-BR'));
    const configurations = [...new Map(rows.map((row) => [keyOf(row), row])).values()];
    const configured = configurations.filter((row) => row.draftValue !== null);
    const average = (items, field) => items.length ? Number((items.reduce((sum, row) => sum + Number(row[field] || 0), 0) / items.length).toFixed(2)) : null;
    const currentAcademicYear = priorClasses.length ? Math.max(...priorClasses.map((item) => Number(item.schoolYear))) : year - 1;
    return { academicYear: year, currentAcademicYear, rows, summary: { totalClasses: displayClasses.length, totalConfigurations: configurations.length, configured: configured.length, pending: configurations.length - configured.length, currentAverage: average(configurations.filter((row) => row.currentValue !== null), 'currentValue'), plannedAverage: average(configured, 'draftValue'), updatedAt: plans.map((item) => item.updatedAt).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null } };
  }

  async saveDraft(schoolId, actorId, { academicYear, rows = [] }) {
    const year = Number(academicYear);
    if (!Number.isInteger(year) || !Array.isArray(rows)) throw Object.assign(new Error('Planejamento inválido.'), { statusCode: 400, code: 'INVALID_PLAN' });
    const uniqueRows = [...new Map(rows.map((row) => [keyOf(row), normalizedItem(row)])).values()];
    for (const row of uniqueRows) {
      if (!row.level || !row.grade || !row.shift) throw Object.assign(new Error('Série, segmento e turno são obrigatórios.'), { statusCode: 400, code: 'INVALID_PRICING_KEY' });
      const candidates = await AcademicMonthlyFeePlan.find({ school_id: schoolId, academicYear: year, level: row.level, shift: row.shift });
      const existing = candidates.find((item) => keyOf(item) === keyOf(row)) || null;
      if (row.updatedAt && existing && new Date(row.updatedAt).getTime() !== new Date(existing.updatedAt).getTime()) throw Object.assign(new Error('Este planejamento foi alterado por outro usuário. Atualize a tela antes de salvar.'), { statusCode: 409, code: 'PRICING_VERSION_CONFLICT' });
      const previous = existing ? publicPlan(existing) : null;
      const plan = existing || new AcademicMonthlyFeePlan({ school_id: schoolId, academicYear: year, level: row.level, grade: row.grade, shift: row.shift });
      // Keep legacy aliases as historical records while the active plan adopts
      // the canonical academic key on its next explicit save.
      plan.grade = row.grade;
      plan.draftCents = toCents(row.draftValue);
      plan.draftUpdatedBy = actorId || null;
      await plan.save();
      await this._audit({ schoolId, actorId, entityId: plan._id, action: previous ? 'UPDATE' : 'CREATE', previous, current: publicPlan(plan), reason: 'MONTHLY_FEE_DRAFT_SAVED' });
    }
    return this.overview(schoolId, year);
  }

  async bulkAdjust(schoolId, actorId, payload) {
    const { academicYear, adjustmentType, value, scope = 'ALL', rows = [], baseSource = 'CURRENT' } = payload;
    const signed = Number(value);
    if (!Number.isFinite(signed) || !['PERCENTAGE', 'FIXED'].includes(adjustmentType)) throw Object.assign(new Error('Reajuste inválido.'), { statusCode: 400, code: 'INVALID_ADJUSTMENT' });
    const overview = await this.overview(schoolId, academicYear);
    const allowed = new Set((rows.length ? rows : overview.rows).map((row) => keyOf(row)));
    if (!['CURRENT', 'DRAFT'].includes(baseSource)) throw Object.assign(new Error('Base de reajuste inválida.'), { statusCode: 400, code: 'INVALID_ADJUSTMENT_BASE' });
    const selected = overview.rows.filter((row) => allowed.has(keyOf(row)) && (scope === 'ALL' || row.draftValue === null));
    const missingBase = selected.filter((row) => (baseSource === 'DRAFT' ? row.draftValue : row.currentValue) === null);
    if (missingBase.length) throw Object.assign(new Error('Não foi possível aplicar o reajuste porque existem configurações sem mensalidade vigente.'), { statusCode: 409, code: 'MISSING_CURRENT_MONTHLY_FEE', details: missingBase.map(({ level, grade, shift }) => ({ level, grade, shift })) });
    const updates = selected.map((row) => {
      const base = baseSource === 'DRAFT' ? row.draftValue : row.currentValue;
      return { level: row.level, grade: row.grade, shift: row.shift, draftValue: Number(((base * (adjustmentType === 'PERCENTAGE' ? 1 + signed / 100 : 1)) + (adjustmentType === 'FIXED' ? signed : 0)).toFixed(2)) };
    });
    if (updates.some((row) => row.draftValue < 0)) throw Object.assign(new Error('O reajuste não pode gerar mensalidade negativa.'), { statusCode: 400, code: 'NEGATIVE_MONTHLY_FEE' });
    return { affected: updates.length, overview: await this.saveDraft(schoolId, actorId, { academicYear, rows: updates }) };
  }

  async publish(schoolId, actorId, academicYear) {
    const overview = await this.overview(schoolId, academicYear);
    const missing = overview.rows.filter((row) => row.draftValue === null);
    if (missing.length) throw Object.assign(new Error(`Existem ${missing.length} mensalidade(s) ainda não configurada(s).`), { statusCode: 409, code: 'MONTHLY_FEE_PENDING', details: missing.map(({ level, grade, shift }) => ({ level, grade, shift })) });
    const plans = await AcademicMonthlyFeePlan.find({ school_id: schoolId, academicYear: Number(academicYear) });
    for (const plan of plans) { const previous = publicPlan(plan); plan.publishedCents = plan.draftCents; plan.publishedVersion += 1; plan.publishedAt = new Date(); plan.publishedBy = actorId || null; await plan.save(); await this._audit({ schoolId, actorId, entityId: plan._id, action: 'UPDATE', previous, current: publicPlan(plan), reason: 'MONTHLY_FEE_PUBLISHED' }); }
    return this.overview(schoolId, academicYear);
  }

  async publishedForDestination(schoolId, academicYear, { level, grade, shift }) {
    const canonicalGrade = normalizeGrade(grade);
    const candidates = await AcademicMonthlyFeePlan.find({ school_id: schoolId, academicYear: Number(academicYear), level, shift, publishedCents: { $ne: null } }).lean();
    const exact = candidates.find((item) => normalizeGrade(item.grade) === canonicalGrade) || null;
    return exact ? { value: money(exact.publishedCents), cents: exact.publishedCents, versionId: String(exact._id), version: exact.publishedVersion } : null;
  }
}
module.exports = new AcademicMonthlyFeePlanService();
