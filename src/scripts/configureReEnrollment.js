/*
 * Safe administration helper. Defaults to audit mode; --apply is required to write.
 * Example:
 * node src/scripts/configureReEnrollment.js --school-id <id> --from 2026 --to 2027 --start 2026-09-28 --end 2027-02-28 --progressions-file C:\path\progressions.json --apply
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Class = require('../api/models/class.model');
const ReEnrollmentPeriod = require('../api/models/reEnrollmentPeriod.model');
const AcademicProgression = require('../api/models/academicProgression.model');

function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
function required(name) { const value = argument(name); if (!value) throw new Error(`${name} é obrigatório.`); return value; }

async function main() {
  const schoolId = required('--school-id');
  const from = Number(required('--from'));
  const to = Number(required('--to'));
  const start = required('--start');
  const end = required('--end');
  const file = argument('--progressions-file');
  const apply = process.argv.includes('--apply');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI não configurada. Nenhuma alteração foi feita.');
  if (to !== from + 1) throw new Error('O ano de destino deve ser o ano seguinte.');
  await mongoose.connect(process.env.MONGO_URI);
  const classes = await Class.find({ school_id: schoolId, schoolYear: from }).select('level grade name shift schoolYear').sort({ level: 1, grade: 1, name: 1 }).lean();
  const catalog = [...new Map(classes.map((item) => [`${item.level}::${item.grade}`, { level: item.level, grade: item.grade }])).values()];
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'audit', schoolId, academicYearFrom: from, academicYearTo: to, currentGradeCatalog: catalog }, null, 2));
  if (!apply) return;
  if (!file) throw new Error('--progressions-file é obrigatório com --apply.');
  const progressions = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(progressions) || !progressions.every((item) => item?.level && item?.fromGrade && item?.toGrade)) throw new Error('O arquivo deve ser um array de { level, fromGrade, toGrade }.');
  await ReEnrollmentPeriod.findOneAndUpdate({ school_id: schoolId, academicYearFrom: from, academicYearTo: to }, { $set: { startDate: new Date(start), endDate: new Date(end), status: 'OPEN' } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
  for (const progression of progressions) {
    await AcademicProgression.findOneAndUpdate({ school_id: schoolId, level: progression.level, fromGrade: progression.fromGrade }, { $set: { toGrade: progression.toGrade, active: true } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
  }
  console.log(JSON.stringify({ configured: true, period: `${from}→${to}`, progressionCount: progressions.length }));
}

main().catch((error) => { console.error(`[configure-reenrollment] ${error.message}`); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect().catch(() => {}); });
