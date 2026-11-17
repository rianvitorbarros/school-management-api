const Class = require('../models/class.model');
const School = require('../models/school.model');
const AuditLog = require('../models/auditLog.model');
const feePlans = require('./academicMonthlyFeePlan.service');
const { resolveClasses } = require('./classOccupancy.service');

const error = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code });
const id = (value) => String(value?._id || value || '');

/**
 * Turns the read-only projections of the occupancy panel ("Vagas <ano>") into
 * real classes of the destination year, with status "Planejada".
 *
 * The projection keeps the structure of the latest previous year. Each created
 * class copies that structure (name, level, grade, shift, room, schedule) and
 * receives the capacity informed by the manager. The monthly fee comes from the
 * published monthly fee plan of the destination year when it exists; otherwise
 * the reference class value is kept. Existing destination classes are never
 * duplicated nor changed.
 */
async function planClasses(schoolId, actorId, { academicYear, items = [] } = {}) {
  if (!schoolId) throw error('Usuário sem escola autorizada.', 403);
  const year = Number(academicYear);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw error('Informe um ano letivo válido.', 400, 'INVALID_ACADEMIC_YEAR');
  if (!Array.isArray(items) || !items.length) throw error('Selecione ao menos uma turma para planejar.', 400, 'EMPTY_PLAN');
  const school = await School.findById(schoolId).select('educationModel').lean();
  if (!school || school.educationModel === 'technical_apprenticeship') throw error('Planejamento disponível para ensino regular.', 403);

  const classes = await Class.find({ school_id: schoolId, schoolYear: { $lte: year } })
    .select('name level grade shift capacity schoolYear status room monthlyFee scheduleSettings').lean();
  const { rows } = resolveClasses(classes, year);
  const projections = new Map(rows.filter((row) => row.isProjection).map((row) => [id(row.sourceClassId), row]));

  const created = [], skipped = [];
  for (const item of items) {
    const sourceId = String(item?.sourceClassId || '').replace(/^planning:\d+:/, '');
    const source = projections.get(sourceId);
    if (!source) { skipped.push({ sourceClassId: sourceId, reason: 'Turma já planejada ou fora da projeção.' }); continue; }
    const capacity = item.capacity === null || item.capacity === undefined || item.capacity === '' ? undefined : Number(item.capacity);
    if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1 || capacity > 500)) {
      skipped.push({ sourceClassId: sourceId, name: source.name, reason: 'Capacidade inválida.' });
      continue;
    }
    let monthlyFee = Number(source.monthlyFee);
    try {
      const published = await feePlans.publishedForDestination(schoolId, year, { level: source.level, grade: source.grade, shift: source.shift });
      if (published && Number.isFinite(Number(published.value))) monthlyFee = Number(published.value);
    } catch (_) { /* keeps the reference value */ }
    if (!Number.isFinite(monthlyFee) || monthlyFee < 0) monthlyFee = 0;
    const name = String(item.name || source.name).trim() || source.name;
    try {
      const doc = await Class.create({
        name, schoolYear: year, level: source.level, grade: source.grade, shift: source.shift,
        room: source.room, monthlyFee, capacity: capacity ?? (Number.isInteger(source.capacity) && source.capacity > 0 ? source.capacity : undefined),
        scheduleSettings: source.scheduleSettings, school_id: schoolId, status: 'Planejada',
      });
      created.push({ id: id(doc), name: doc.name, sourceClassId: sourceId, capacity: doc.capacity ?? null, monthlyFee: doc.monthlyFee });
      if (actorId) {
        await AuditLog.create({ school: schoolId, actor: actorId, entity: 'Class', entityId: doc._id, action: 'CREATE',
          changes: { previous: null, current: { name: doc.name, schoolYear: year, sourceClassId: sourceId, capacity: doc.capacity ?? null } },
          reason: 'NEXT_YEAR_CLASS_PLANNED' }).catch(() => {});
      }
    } catch (e) {
      skipped.push({ sourceClassId: sourceId, name, reason: e?.code === 11000 ? 'Já existe uma turma com esse nome e turno no ano.' : (e?.message || 'Erro ao criar a turma.') });
    }
  }
  return { academicYear: year, created, skipped };
}

module.exports = { planClasses };
