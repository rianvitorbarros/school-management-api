const mongoose = require('mongoose');
require('dotenv').config();

const School = require('../api/models/school.model');

const SCHOOL_NAME = 'COLÉGIO A SEMENTINHA';
const INEP_CODE = '15183041';

function normalizeSchoolName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleUpperCase('pt-BR');
}

async function run({ apply = false } = {}) {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is required to update the school INEP code.');
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const matches = await School.find({}).select('_id name inepCode');
    const candidates = matches.filter(
      (school) => normalizeSchoolName(school.name) === normalizeSchoolName(SCHOOL_NAME)
    );

    if (candidates.length === 0) {
      throw new Error(`School not found: ${SCHOOL_NAME}`);
    }

    if (candidates.length > 1) {
      throw new Error(`More than one school matches: ${SCHOOL_NAME}`);
    }

    const [school] = candidates;

    const result = {
      schoolId: String(school._id),
      schoolName: school.name,
      previousInepCode: school.inepCode || null,
      nextInepCode: INEP_CODE,
      applied: apply,
    };

    if (apply && school.inepCode !== INEP_CODE) {
      school.inepCode = INEP_CODE;
      await school.save();
    }

    console.log('[SchoolInepCode]', result);
    return result;
  } finally {
    await mongoose.connection.close();
  }
}

if (require.main === module) {
  run({ apply: process.argv.includes('--apply') }).catch((error) => {
    console.error('[SchoolInepCode] Failed', error);
    process.exitCode = 1;
  });
}

module.exports = { INEP_CODE, SCHOOL_NAME, normalizeSchoolName, run };
