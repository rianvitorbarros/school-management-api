require('dotenv').config();

const mongoose = require('mongoose');
const GuardianAccessEvent = require('../api/models/guardianAccessEvent.model');
const GuardianPinRecoveryChallenge = require('../api/models/guardianPinRecoveryChallenge.model');

const REPLACED_EVENT_INDEXES = new Set([
  'idx_guardian_access_event_school_account_created',
  'idx_guardian_access_event_school_student_created',
]);

async function dropIndexIfPresent(collection, name) {
  const indexes = await collection.indexes();
  if (indexes.some((index) => index.name === name)) {
    await collection.dropIndex(name);
  }
}

async function migrate() {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI nao configurada.');
  }

  await mongoose.connect(process.env.MONGO_URI);

  const challengeCollection = GuardianPinRecoveryChallenge.collection;
  await GuardianPinRecoveryChallenge.updateMany(
    { purgeAt: { $exists: false }, expiresAt: { $type: 'date' } },
    [
      {
        $set: {
          purgeAt: {
            $dateAdd: {
              startDate: '$expiresAt',
              unit: 'hour',
              amount: 24,
            },
          },
        },
      },
    ]
  );
  await dropIndexIfPresent(
    challengeCollection,
    'ttl_guardian_pin_recovery_challenge'
  );

  const eventCollection = GuardianAccessEvent.collection;
  for (const indexName of REPLACED_EVENT_INDEXES) {
    await dropIndexIfPresent(eventCollection, indexName);
  }

  await GuardianPinRecoveryChallenge.createIndexes();
  await GuardianAccessEvent.createIndexes();

  console.log('Indices de auditoria de responsaveis atualizados com sucesso.');
}

migrate()
  .catch((error) => {
    console.error('Falha ao atualizar indices de auditoria:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
