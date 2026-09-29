const mongoose = require('mongoose');
require('dotenv').config();

const ActivityPrintRun = require('../api/models/activityPrintRun.model');
const ClassModel = require('../api/models/class.model');
const Periodo = require('../api/models/periodo.model');
const SchoolYear = require('../api/models/schoolyear.model');

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function dayRange(date) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  const start = new Date(value);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(value);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

async function backfillActivityPrintRunAcademicTerms({ dryRun = true, schoolId = null } = {}) {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required to run this script.');
  if (schoolId && !mongoose.Types.ObjectId.isValid(schoolId)) {
    throw new Error('The --school-id value must be a valid Mongo ObjectId.');
  }

  await mongoose.connect(process.env.MONGO_URI);
  const counters = {
    found: 0,
    eligible: 0,
    corrected: 0,
    skippedMissingClass: 0,
    skippedMissingAcademicYear: 0,
    skippedAmbiguousOrMissingTerm: 0,
  };
  const yearCache = new Map();
  const termCache = new Map();

  try {
    const filter = {
      termId: null,
      ...(schoolId ? { schoolId } : {}),
    };
    const cursor = ActivityPrintRun.find(filter)
      .select('_id schoolId classId printDate snapshot.bookTitle snapshot.activityTitle')
      .lean()
      .cursor();

    for await (const run of cursor) {
      counters.found += 1;
      const classDoc = await ClassModel.findOne({
        _id: run.classId,
        school_id: run.schoolId,
      }).select('_id schoolYear').lean();
      if (!classDoc || !Number.isInteger(Number(classDoc.schoolYear))) {
        counters.skippedMissingClass += 1;
        console.warn('[ActivityPrintRunTermBackfill] Skipped run without an unambiguous class year', {
          runId: String(run._id),
        });
        continue;
      }

      const yearKey = `${run.schoolId}:${classDoc.schoolYear}`;
      let academicYear = yearCache.get(yearKey);
      if (academicYear === undefined) {
        academicYear = await SchoolYear.findOne({
          school_id: run.schoolId,
          year: Number(classDoc.schoolYear),
        }).select('_id year').lean();
        yearCache.set(yearKey, academicYear || null);
      }
      if (!academicYear) {
        counters.skippedMissingAcademicYear += 1;
        console.warn('[ActivityPrintRunTermBackfill] Skipped run without its official school year', {
          runId: String(run._id),
          schoolYear: classDoc.schoolYear,
        });
        continue;
      }

      const range = dayRange(run.printDate);
      if (!range) {
        counters.skippedAmbiguousOrMissingTerm += 1;
        console.warn('[ActivityPrintRunTermBackfill] Skipped run with invalid print date', {
          runId: String(run._id),
        });
        continue;
      }

      const termKey = `${run.schoolId}:${academicYear._id}:${range.start.toISOString().slice(0, 10)}`;
      let terms = termCache.get(termKey);
      if (!terms) {
        terms = await Periodo.find({
          school_id: run.schoolId,
          anoLetivoId: academicYear._id,
          tipo: 'Letivo',
          dataInicio: { $lte: range.end },
          dataFim: { $gte: range.start },
        }).select('_id titulo').lean();
        termCache.set(termKey, terms);
      }
      if (terms.length !== 1) {
        counters.skippedAmbiguousOrMissingTerm += 1;
        console.warn('[ActivityPrintRunTermBackfill] Skipped run without exactly one official term', {
          runId: String(run._id),
          matchingTerms: terms.map((term) => ({ id: String(term._id), title: term.titulo })),
        });
        continue;
      }

      counters.eligible += 1;
      const term = terms[0];
      console.log('[ActivityPrintRunTermBackfill] Resolved run', {
        runId: String(run._id),
        termId: String(term._id),
        termName: term.titulo,
        dryRun,
      });

      if (dryRun) continue;
      const result = await ActivityPrintRun.updateOne(
        { _id: run._id, termId: null },
        {
          $set: {
            termId: term._id,
            academicYearId: academicYear._id,
          },
        }
      );
      counters.corrected += result.modifiedCount || 0;
    }

    console.log('[ActivityPrintRunTermBackfill] Finished', { dryRun, ...counters });
    return { dryRun, ...counters };
  } finally {
    await mongoose.connection.close();
  }
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  backfillActivityPrintRunAcademicTerms({
    dryRun: !apply,
    schoolId: argumentValue('--school-id') || null,
  }).catch((error) => {
    console.error('[ActivityPrintRunTermBackfill] Failed', error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { backfillActivityPrintRunAcademicTerms, dayRange };
