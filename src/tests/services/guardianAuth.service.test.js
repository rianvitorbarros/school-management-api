const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { GuardianAuthService } = require('../../api/services/guardianAuth.service');
const GuardianAccessEvent = require('../../api/models/guardianAccessEvent.model');
const {
  GUARDIAN_ACCESS_EVENT_TYPES,
  GUARDIAN_ACCESS_EVENT_TYPE_VALUES,
} = require('../../api/constants/guardianAccessEventTypes');
const {
  sanitizeEventMetadata,
  sanitizeReasonText,
} = require('../../api/utils/guardianAudit.util');

function createQuery(value) {
  let currentValue = value;
  return {
    select() {
      return this;
    },
    session() {
      return this;
    },
    sort(spec = {}) {
      if (Array.isArray(currentValue)) {
        const entries = Object.entries(spec);
        currentValue = [...currentValue].sort((left, right) => {
          for (const [field, direction] of entries) {
            const leftValue = getPathValues(left, field)[0];
            const rightValue = getPathValues(right, field)[0];
            const leftTime = new Date(leftValue).getTime();
            const rightTime = new Date(rightValue).getTime();
            const comparison =
              !Number.isNaN(leftTime) && !Number.isNaN(rightTime)
                ? leftTime - rightTime
                : String(leftValue).localeCompare(String(rightValue));
            if (comparison) return direction < 0 ? -comparison : comparison;
          }
          return 0;
        });
      }
      return this;
    },
    limit(limit) {
      if (Array.isArray(currentValue)) {
        currentValue = currentValue.slice(0, limit);
      }
      return this;
    },
    lean() {
      return Promise.resolve(currentValue);
    },
    then(resolve, reject) {
      return Promise.resolve(currentValue).then(resolve, reject);
    },
  };
}

function getPathValues(source, path) {
  const segments = String(path || '').split('.');

  function walk(current, index) {
    if (index >= segments.length) return [current];
    if (current === null || current === undefined) return [];

    const segment = segments[index];

    if (Array.isArray(current)) {
      return current.flatMap((item) => walk(item, index));
    }

    return walk(current[segment], index + 1);
  }

  return walk(source, 0);
}

function sameValue(left, right) {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
    return leftTime === rightTime;
  }
  return String(left) === String(right);
}

function matchesFilter(document, filter = {}) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') {
      return Array.isArray(condition) && condition.some((item) => matchesFilter(document, item));
    }
    if (key === '$and') {
      return Array.isArray(condition) && condition.every((item) => matchesFilter(document, item));
    }

    const values = getPathValues(document, key);

    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if (Object.prototype.hasOwnProperty.call(condition, '$in')) {
        return values.some((value) =>
          condition.$in.some((candidate) => sameValue(value, candidate))
        );
      }

      if (Object.prototype.hasOwnProperty.call(condition, '$exists')) {
        const exists = values.length > 0 && values.some((value) => value !== undefined);
        return exists === Boolean(condition.$exists);
      }

      if (Object.prototype.hasOwnProperty.call(condition, '$ne')) {
        return values.every((value) => !sameValue(value, condition.$ne));
      }

      if (Object.prototype.hasOwnProperty.call(condition, '$gte')) {
        return values.some(
          (value) =>
            new Date(value).getTime() >= new Date(condition.$gte).getTime()
        );
      }

      if (Object.prototype.hasOwnProperty.call(condition, '$gt')) {
        return values.some(
          (value) =>
            new Date(value).getTime() > new Date(condition.$gt).getTime()
        );
      }

      if (Object.prototype.hasOwnProperty.call(condition, '$lt')) {
        return values.some(
          (value) => {
            const leftTime = new Date(value).getTime();
            const rightTime = new Date(condition.$lt).getTime();
            return !Number.isNaN(leftTime) && !Number.isNaN(rightTime)
              ? leftTime < rightTime
              : String(value) < String(condition.$lt);
          }
        );
      }

      if (Object.prototype.hasOwnProperty.call(condition, '$lte')) {
        return values.some(
          (value) =>
            new Date(value).getTime() <= new Date(condition.$lte).getTime()
        );
      }
    }

    return values.some((value) => sameValue(value, condition));
  });
}

function attachSave(document, nowProvider) {
  if (!document || typeof document !== 'object') return document;

  document.save = async function save() {
    this.updatedAt = nowProvider().toISOString();
    return this;
  };

  return document;
}

function createHarness(seed = {}) {
  let sequence = 0;
  let now = new Date('2026-04-07T10:00:00.000Z');

  const state = {
    schools: (seed.schools || []).map((item) => ({ ...item })),
    students: (seed.students || []).map((item) => ({ ...item })),
    classes: (seed.classes || []).map((item) => ({ ...item })),
    enrollments: (seed.enrollments || []).map((item) => ({ ...item })),
    tutors: (seed.tutors || []).map((item) => ({ ...item })),
    accounts: (seed.accounts || []).map((item) => ({ ...item })),
    links: (seed.links || []).map((item) => ({ ...item })),
    events: (seed.events || []).map((item) => ({ ...item })),
    challenges: (seed.challenges || []).map((item) => ({ ...item })),
    recoveryChallenges: (seed.recoveryChallenges || []).map((item) => ({
      ...item,
    })),
    recoveryRateLimits: (seed.recoveryRateLimits || []).map((item) => ({
      ...item,
    })),
  };

  const nowProvider = () => new Date(now);
  const nextId = (prefix) => `${prefix}_${++sequence}`;

  state.accounts.forEach((item) => attachSave(item, nowProvider));
  state.challenges.forEach((item) => attachSave(item, nowProvider));
  state.recoveryChallenges.forEach((item) => attachSave(item, nowProvider));

  const service = new GuardianAuthService({
    SchoolModel: {
      findOne(filter) {
        return createQuery(state.schools.find((item) => matchesFilter(item, filter)) || null);
      },
      findById(id) {
        return createQuery(state.schools.find((item) => sameValue(item._id, id)) || null);
      },
      find(filter = {}) {
        return createQuery(state.schools.filter((item) => matchesFilter(item, filter)));
      },
    },
    StudentModel: {
      find(filter = {}) {
        return createQuery(state.students.filter((item) => matchesFilter(item, filter)));
      },
      findOne(filter = {}) {
        return createQuery(state.students.find((item) => matchesFilter(item, filter)) || null);
      },
    },
    ClassModel: {
      find(filter = {}) {
        return createQuery(state.classes.filter((item) => matchesFilter(item, filter)));
      },
    },
    EnrollmentModel: {
      find(filter = {}) {
        return createQuery(state.enrollments.filter((item) => matchesFilter(item, filter)));
      },
    },
    TutorModel: {
      find(filter = {}) {
        return createQuery(state.tutors.filter((item) => matchesFilter(item, filter)));
      },
      findOne(filter = {}) {
        return createQuery(state.tutors.find((item) => matchesFilter(item, filter)) || null);
      },
      async updateOne(filter = {}, update = {}) {
        const tutor = state.tutors.find((item) => matchesFilter(item, filter)) || null;
        if (!tutor) {
          return { matchedCount: 0, modifiedCount: 0 };
        }

        Object.assign(tutor, update.$set || {});
        return { matchedCount: 1, modifiedCount: 1 };
      },
      aggregate(pipeline = []) {
        const match = pipeline[0]?.$match || {};
        const tutors = state.tutors.filter((item) => matchesFilter(item, match));
        const grouped = new Map();

        tutors.forEach((tutor) => {
          const key = tutor.cpfNormalized;
          if (!key) return;
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key).push(tutor);
        });

        return Promise.resolve(
          [...grouped.entries()]
            .filter(([, bucket]) => bucket.length > 1)
            .map(([cpfNormalized, bucket]) => ({
              _id: cpfNormalized,
              count: bucket.length,
              tutorIds: bucket.map((item) => item._id),
            }))
        );
      },
    },
    GuardianAccessAccountModel: {
      findOne(filter = {}) {
        return createQuery(state.accounts.find((item) => matchesFilter(item, filter)) || null);
      },
      find(filter = {}) {
        return Promise.resolve(state.accounts.filter((item) => matchesFilter(item, filter)));
      },
      async create(data) {
        const record = attachSave(
          {
            _id: data._id || nextId('account'),
            createdAt: nowProvider().toISOString(),
            updatedAt: nowProvider().toISOString(),
            ...data,
          },
          nowProvider
        );
        state.accounts.push(record);
        return record;
      },
    },
    GuardianAccessLinkModel: {
      find(filter = {}) {
        return createQuery(state.links.filter((item) => matchesFilter(item, filter)));
      },
      findOne(filter = {}) {
        return createQuery(state.links.find((item) => matchesFilter(item, filter)) || null);
      },
      async findOneAndUpdate(filter = {}, update = {}, options = {}) {
        let record = state.links.find((item) => matchesFilter(item, filter)) || null;

        if (!record && options.upsert) {
          record = {
            _id: nextId('link'),
            createdAt: nowProvider().toISOString(),
            ...filter,
            ...(update.$setOnInsert || {}),
          };
          state.links.push(record);
        }

        if (!record) return null;

        Object.assign(record, update.$setOnInsert || {}, update.$set || {});
        record.updatedAt = nowProvider().toISOString();
        return record;
      },
    },
    GuardianAccessEventModel: {
      async create(data) {
        const record = {
          _id: nextId('event'),
          createdAt: nowProvider().toISOString(),
          ...data,
        };
        state.events.push(record);
        return record;
      },
      find(filter = {}) {
        return createQuery(
          state.events.filter((item) => matchesFilter(item, filter))
        );
      },
    },
    GuardianFirstAccessChallengeModel: {
      async create(data) {
        const record = attachSave(
          {
            _id: nextId('challenge'),
            createdAt: nowProvider().toISOString(),
            updatedAt: nowProvider().toISOString(),
            ...data,
          },
          nowProvider
        );
        state.challenges.push(record);
        return record;
      },
      findById(id) {
        return createQuery(state.challenges.find((item) => sameValue(item._id, id)) || null);
      },
    },
    GuardianPinRecoveryChallengeModel: {
      async countDocuments(filter = {}) {
        return state.recoveryChallenges.filter((item) =>
          matchesFilter(item, filter)
        ).length;
      },
      async create(data) {
        const record = attachSave(
          {
            _id: data._id || nextId('recovery'),
            createdAt: nowProvider().toISOString(),
            updatedAt: nowProvider().toISOString(),
            ...data,
          },
          nowProvider
        );
        state.recoveryChallenges.push(record);
        return record;
      },
      findById(id) {
        return createQuery(
          state.recoveryChallenges.find((item) => sameValue(item._id, id)) ||
            null
        );
      },
      find(filter = {}) {
        return createQuery(
          state.recoveryChallenges.filter((item) =>
            matchesFilter(item, filter)
          )
        );
      },
      findOneAndUpdate(filter = {}, update = {}) {
        const record =
          state.recoveryChallenges.find((item) =>
            matchesFilter(item, filter)
          ) || null;
        if (record) {
          Object.assign(record, update.$set || {});
          record.updatedAt = nowProvider().toISOString();
        }
        return createQuery(record);
      },
    },
    GuardianPinRecoveryRateLimitModel: {
      async findOneAndUpdate(filter = {}, update = {}, options = {}) {
        let record =
          state.recoveryRateLimits.find((item) =>
            matchesFilter(item, filter)
          ) || null;

        if (!record && options.upsert) {
          record = {
            _id: nextId('recovery-rate'),
            createdAt: nowProvider().toISOString(),
            updatedAt: nowProvider().toISOString(),
            ...filter,
            ...(update.$setOnInsert || {}),
            count: 0,
          };
          state.recoveryRateLimits.push(record);
        }

        if (!record) return null;
        Object.assign(record, update.$setOnInsert || {});
        record.count =
          Number(record.count || 0) + Number(update.$inc?.count || 0);
        record.updatedAt = nowProvider().toISOString();
        return record;
      },
    },
    guardianJwtSecret: 'guardian-secret',
    auditHashSecret: 'guardian-audit-test-secret',
    now: nowProvider,
    runCriticalTransaction: async (work) => work(null),
  });

  return {
    service,
    state,
    setNow(value) {
      now = new Date(value);
    },
  };
}

function createBaseSeed() {
  return {
    schools: [
      { _id: 'school-1', name: 'Escola A', publicIdentifier: 'escola-a' },
    ],
    students: [
      {
        _id: 'student-1',
        school_id: 'school-1',
        fullName: 'Ana Souza',
        fullNameNormalized: 'ana souza',
        birthDateKey: '2012-03-10',
        birthDate: '2012-03-10T00:00:00.000Z',
        isActive: true,
        financialTutorId: 'tutor-1',
        tutors: [{ tutorId: 'tutor-1', relationship: 'Mae' }],
      },
    ],
    tutors: [
      {
        _id: 'tutor-1',
        school_id: 'school-1',
        fullName: 'Maria Souza',
        cpf: '123.456.789-09',
        cpfNormalized: '12345678909',
        birthDate: '1985-07-10T00:00:00.000Z',
        students: ['student-1'],
      },
    ],
    accounts: [],
    links: [],
    events: [],
    challenges: [],
  };
}

function createMultiChildSeed() {
  const seed = createBaseSeed();
  seed.students.push({
    _id: 'student-2',
    school_id: 'school-1',
    fullName: 'Gabriel Souza',
    fullNameNormalized: 'gabriel souza',
    birthDateKey: '2014-08-20',
    birthDate: '2014-08-20T00:00:00.000Z',
    isActive: true,
    financialTutorId: 'tutor-2',
    tutors: [{ tutorId: 'tutor-2', relationship: 'Mae' }],
  });
  seed.tutors.push({
    _id: 'tutor-2',
    school_id: 'school-1',
    fullName: 'Maria Souza',
    cpf: '123.456.789-09',
    cpfNormalized: '12345678909',
    birthDate: '1985-07-10T00:00:00.000Z',
    students: ['student-2'],
  });
  return seed;
}

async function createRecoverySeed({
  pin = '246810',
  status = 'active',
  pinHash = undefined,
} = {}) {
  const seed = createBaseSeed();
  seed.accounts.push({
    _id: 'account-1',
    school_id: 'school-1',
    tutorId: 'tutor-1',
    identifierType: 'cpf',
    identifierNormalized: '12345678909',
    identifierMasked: '***.***.***-09',
    pinHash:
      pinHash === undefined
        ? await bcrypt.hash(pin, 4)
        : pinHash,
    status,
    activatedAt: status === 'active' ? '2026-01-01T00:00:00.000Z' : null,
    pinUpdatedAt: status === 'active' ? '2026-01-01T00:00:00.000Z' : null,
    tokenVersion: 2,
    failedLoginCount: 0,
    lastFailedAt: null,
    blockedUntil: null,
  });
  seed.links.push({
    _id: 'link-1',
    school_id: 'school-1',
    guardianAccessAccountId: 'account-1',
    studentId: 'student-1',
    tutorId: 'tutor-1',
    relationshipSnapshot: 'Mae',
    status: 'active',
  });
  return seed;
}

async function startValidRecovery(service, overrides = {}) {
  return service.startPinRecovery({
    cpf: '12345678909',
    studentFullName: 'Ana Souza',
    studentBirthDate: '2012-03-10',
    guardianBirthDate: '1985-07-10',
    schoolPublicId: 'escola-a',
    requestMeta: { ip: '203.0.113.10', userAgent: 'test-agent' },
    ...overrides,
  });
}

test('guardian auth first access succeeds end-to-end with PIN creation and recurring login', async () => {
  const harness = createHarness(createBaseSeed());

  const started = await harness.service.startFirstAccess({
    studentFullName: 'Ana Souza',
    birthDate: '2012-03-10',
  });

  assert.equal(started.status, 'challenge_started');
  assert.equal(started.guardians.length, 1);
  assert.equal(started.guardians[0].displayName, 'Maria Souza');
  assert.equal(started.school.publicIdentifier, 'escola-a');

  const verified = await harness.service.verifyResponsible({
    challengeId: started.challengeId,
    optionId: started.guardians[0].optionId,
    cpf: '123.456.789-09',
  });

  assert.equal(verified.status, 'new_account_requires_pin');
  assert.ok(verified.verificationToken);

  const configured = await harness.service.setPin({
    challengeId: started.challengeId,
    verificationToken: verified.verificationToken,
    pin: '246810',
  });

  assert.equal(configured.status, 'pin_configured');
  assert.equal(configured.identifierType, 'cpf');
  assert.equal(configured.identifierMasked, '***.***.***-09');
  assert.equal(Object.prototype.hasOwnProperty.call(configured, 'accountId'), false);

  const login = await harness.service.login({
    identifier: '12345678909',
    pin: '246810',
  });

  assert.ok(login.token);
  assert.equal(login.guardian.identifierMasked, '***.***.***-09');
  assert.equal(login.guardian.linkedStudentsCount, 1);
  assert.equal(login.linkedStudents.length, 1);
  assert.equal(login.defaultStudent.id, 'student-1');
  assert.equal(login.school.publicIdentifier, 'escola-a');
  assert.equal(harness.state.accounts.length, 1);
  assert.equal(harness.state.links.length, 1);
});

test('guardian auth links a second child with the existing PIN instead of creating a new account', async () => {
  const harness = createHarness(createMultiChildSeed());

  const startedFirst = await harness.service.startFirstAccess({
    studentFullName: 'Ana Souza',
    birthDate: '2012-03-10',
  });
  const verifiedFirst = await harness.service.verifyResponsible({
    challengeId: startedFirst.challengeId,
    optionId: startedFirst.guardians[0].optionId,
    cpf: '123.456.789-09',
  });

  await harness.service.setPin({
    challengeId: startedFirst.challengeId,
    verificationToken: verifiedFirst.verificationToken,
    pin: '246810',
  });
  const existingAccountId = harness.state.accounts[0]._id;

  const startedSecond = await harness.service.startFirstAccess({
    studentFullName: 'Gabriel Souza',
    birthDate: '2014-08-20',
  });
  const verifiedSecond = await harness.service.verifyResponsible({
    challengeId: startedSecond.challengeId,
    optionId: startedSecond.guardians[0].optionId,
    cpf: '123.456.789-09',
  });

  assert.equal(verifiedSecond.status, 'existing_account_requires_pin');
  assert.ok(verifiedSecond.verificationToken);

  const linked = await harness.service.linkExistingAccount({
    challengeId: startedSecond.challengeId,
    verificationToken: verifiedSecond.verificationToken,
    pin: '246810',
  });

  assert.equal(linked.status, 'student_linked');
  assert.equal(harness.state.accounts.length, 1);
  assert.equal(harness.state.links.length, 2);
  assert.equal(
    harness.state.links.filter((link) => link.guardianAccessAccountId === existingAccountId)
      .length,
    2
  );
  assert.ok(
    harness.state.events.some(
      (event) =>
        event.eventType === GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_LINKED_WITH_EXISTING_PIN
    )
  );
});

test('guardian auth treats student_already_linked as an idempotent success', async () => {
  const seed = createBaseSeed();
  seed.accounts.push({
    _id: 'account-1',
    school_id: 'school-1',
    tutorId: 'tutor-1',
    identifierType: 'cpf',
    identifierNormalized: '12345678909',
    identifierMasked: '***.***.***-09',
    pinHash: await bcrypt.hash('246810', 4),
    status: 'active',
    tokenVersion: 0,
    failedLoginCount: 0,
    blockedUntil: null,
  });
  seed.links.push({
    _id: 'link-1',
    school_id: 'school-1',
    guardianAccessAccountId: 'account-1',
    studentId: 'student-1',
    tutorId: 'tutor-1',
    relationshipSnapshot: 'Mae',
    source: 'first_access',
    status: 'active',
  });

  const harness = createHarness(seed);
  const started = await harness.service.startFirstAccess({
    studentFullName: 'Ana Souza',
    birthDate: '2012-03-10',
  });

  const verified = await harness.service.verifyResponsible({
    challengeId: started.challengeId,
    optionId: started.guardians[0].optionId,
    cpf: '123.456.789-09',
  });

  assert.equal(verified.status, 'student_already_linked');
  assert.equal(verified.identifierMasked, '***.***.***-09');
  assert.equal(harness.state.links.length, 1);
  assert.ok(
    harness.state.events.some(
      (event) => event.eventType === GUARDIAN_ACCESS_EVENT_TYPES.STUDENT_ALREADY_LINKED
    )
  );
});

test('guardian access event model enum stays aligned with guardian auth event constants', () => {
  const eventEnumValues = GuardianAccessEvent.schema.path('eventType').enumValues;

  assert.deepEqual(
    [...eventEnumValues].sort(),
    [...GUARDIAN_ACCESS_EVENT_TYPE_VALUES].sort()
  );
  assert.ok(
    eventEnumValues.includes(
      GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_LINKED_WITH_EXISTING_PIN
    )
  );
  assert.ok(
    eventEnumValues.includes(GUARDIAN_ACCESS_EVENT_TYPES.STUDENT_ALREADY_LINKED)
  );
  assert.ok(
    eventEnumValues.includes(GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_LINK_FAILED)
  );
});

test('guardian auth keeps the existing-account link flow successful even if audit event persistence fails', async () => {
  const harness = createHarness(createMultiChildSeed());

  const startedFirst = await harness.service.startFirstAccess({
    studentFullName: 'Ana Souza',
    birthDate: '2012-03-10',
  });
  const verifiedFirst = await harness.service.verifyResponsible({
    challengeId: startedFirst.challengeId,
    optionId: startedFirst.guardians[0].optionId,
    cpf: '123.456.789-09',
  });

  await harness.service.setPin({
    challengeId: startedFirst.challengeId,
    verificationToken: verifiedFirst.verificationToken,
    pin: '246810',
  });

  const startedSecond = await harness.service.startFirstAccess({
    studentFullName: 'Gabriel Souza',
    birthDate: '2014-08-20',
  });
  const verifiedSecond = await harness.service.verifyResponsible({
    challengeId: startedSecond.challengeId,
    optionId: startedSecond.guardians[0].optionId,
    cpf: '123.456.789-09',
  });

  harness.service.GuardianAccessEventModel.create = async (data) => {
    if (
      data.eventType ===
      GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_LINKED_WITH_EXISTING_PIN
    ) {
      throw new Error('event insert failed');
    }

    const record = {
      _id: `event_fallback_${harness.state.events.length + 1}`,
      createdAt: new Date().toISOString(),
      ...data,
    };
    harness.state.events.push(record);
    return record;
  };

  const linked = await harness.service.linkExistingAccount({
    challengeId: startedSecond.challengeId,
    verificationToken: verifiedSecond.verificationToken,
    pin: '246810',
  });

  assert.equal(linked.status, 'student_linked');
  assert.equal(
    harness.state.links.filter((link) => link.studentId === 'student-2').length,
    1
  );
  assert.equal(
    harness.state.challenges.find((challenge) => challenge._id === startedSecond.challengeId)
      ?.stage,
    'completed'
  );
});

test('guardian auth login returns linked students and default student for multi-child accounts', async () => {
  const seed = createMultiChildSeed();
  seed.accounts.push({
    _id: 'account-1',
    school_id: 'school-1',
    tutorId: 'tutor-1',
    identifierType: 'cpf',
    identifierNormalized: '12345678909',
    identifierMasked: '***.***.***-09',
    pinHash: await bcrypt.hash('246810', 4),
    status: 'active',
    tokenVersion: 0,
    failedLoginCount: 0,
    blockedUntil: null,
  });
  seed.links.push({
    _id: 'link-1',
    school_id: 'school-1',
    guardianAccessAccountId: 'account-1',
    studentId: 'student-1',
    tutorId: 'tutor-1',
    relationshipSnapshot: 'Mae',
    source: 'first_access',
    status: 'active',
  });
  seed.links.push({
    _id: 'link-2',
    school_id: 'school-1',
    guardianAccessAccountId: 'account-1',
    studentId: 'student-2',
    tutorId: 'tutor-2',
    relationshipSnapshot: 'Mae',
    source: 'first_access',
    status: 'active',
  });

  const harness = createHarness(seed);
  const login = await harness.service.login({
    identifier: '12345678909',
    pin: '246810',
  });

  assert.equal(login.guardian.linkedStudentsCount, 2);
  assert.equal(login.linkedStudents.length, 2);
  assert.ok(login.defaultStudent);
  assert.ok(
    ['student-1', 'student-2'].includes(login.defaultStudent.id)
  );
});

test('guardian auth deduplicates duplicate tutor documents with the same CPF for the same student', async () => {
  const seed = createBaseSeed();
  seed.students[0].tutors.push({ tutorId: 'tutor-2', relationship: 'Mae' });
  seed.tutors.push({
    _id: 'tutor-2',
    school_id: 'school-1',
    fullName: 'Maria Souza',
    cpf: '123.456.789-09',
    cpfNormalized: '12345678909',
    students: ['student-1'],
  });

  const harness = createHarness(seed);
  const started = await harness.service.startFirstAccess({
    studentFullName: 'Ana Souza',
    birthDate: '2012-03-10',
  });

  assert.equal(started.guardians.length, 1);
  assert.equal(started.guardians[0].displayName, 'Maria Souza');
});

test('guardian auth rejects when student is not found', async () => {
  const harness = createHarness(createBaseSeed());

  await assert.rejects(
    () =>
      harness.service.startFirstAccess({
        studentFullName: 'Aluno Inexistente',
        birthDate: '2012-03-10',
      }),
    (error) => error.statusCode === 404
  );
});

test('guardian auth asks for school only when student identity is ambiguous across schools', async () => {
  const seed = createBaseSeed();
  seed.schools.push({
    _id: 'school-2',
    name: 'Escola B',
    publicIdentifier: 'escola-b',
  });
  seed.students.push({
    _id: 'student-2',
    school_id: 'school-2',
    fullName: 'Ana Souza',
    fullNameNormalized: 'ana souza',
    birthDateKey: '2012-03-10',
    birthDate: '2012-03-10T00:00:00.000Z',
    isActive: true,
    financialTutorId: 'tutor-2',
    tutors: [{ tutorId: 'tutor-2', relationship: 'Mae' }],
  });
  seed.tutors.push({
    _id: 'tutor-2',
    school_id: 'school-2',
    fullName: 'Marina Souza',
    cpf: '987.654.321-00',
    cpfNormalized: '98765432100',
    students: ['student-2'],
  });

  const harness = createHarness(seed);

  await assert.rejects(
    () =>
      harness.service.startFirstAccess({
        studentFullName: 'Ana Souza',
        birthDate: '2012-03-10',
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.payload.status, 'student_ambiguous');
      assert.equal(error.payload.ambiguityType, 'across_schools');
      assert.equal(error.payload.candidateSchools.length, 2);
      return true;
    }
  );
});

test('guardian auth reports ambiguity within a school when duplicated student identity exists in the same school', async () => {
  const seed = createBaseSeed();
  seed.students.push({
    _id: 'student-2',
    school_id: 'school-1',
    fullName: 'Ana Souza',
    fullNameNormalized: 'ana souza',
    birthDateKey: '2012-03-10',
    birthDate: '2012-03-10T00:00:00.000Z',
    isActive: true,
    financialTutorId: 'tutor-1',
    tutors: [{ tutorId: 'tutor-1', relationship: 'Tia' }],
  });

  const harness = createHarness(seed);

  await assert.rejects(
    () =>
      harness.service.startFirstAccess({
        studentFullName: 'Ana Souza',
        birthDate: '2012-03-10',
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.payload.status, 'student_ambiguous');
      assert.equal(error.payload.ambiguityType, 'within_school');
      assert.equal(error.payload.candidateSchools, undefined);
      return true;
    }
  );
});

test('guardian auth rejects when no eligible tutor exists', async () => {
  const seed = createBaseSeed();
  seed.tutors[0].cpfNormalized = null;
  seed.tutors[0].cpf = null;

  const harness = createHarness(seed);

  await assert.rejects(
    () =>
      harness.service.startFirstAccess({
        studentFullName: 'Ana Souza',
        birthDate: '2012-03-10',
      }),
    (error) => error.statusCode === 404
  );
});

test('guardian auth rejects invalid CPF in responsible verification', async () => {
  const harness = createHarness(createBaseSeed());
  const started = await harness.service.startFirstAccess({
    studentFullName: 'Ana Souza',
    birthDate: '2012-03-10',
  });

  await assert.rejects(
    () =>
      harness.service.verifyResponsible({
        challengeId: started.challengeId,
        optionId: started.guardians[0].optionId,
        cpf: '11111111111',
      }),
    (error) => error.statusCode === 400
  );
});

test('guardian auth verifies responsible with legacy tutor CPF when cpfNormalized is missing', async () => {
  const seed = createBaseSeed();
  seed.tutors[0].cpfNormalized = null;

  const harness = createHarness(seed);
  const started = await harness.service.startFirstAccess({
    studentFullName: 'Ana Souza',
    birthDate: '2012-03-10',
  });

  const verified = await harness.service.verifyResponsible({
    challengeId: started.challengeId,
    optionId: started.guardians[0].optionId,
    cpf: '123.456.789-09',
  });

  assert.equal(verified.status, 'new_account_requires_pin');
  assert.equal(harness.state.tutors[0].cpfNormalized, '12345678909');
});

test('guardian auth reports tutor CPF missing during responsible verification', async () => {
  const seed = createBaseSeed();
  seed.challenges.push({
    _id: 'challenge-cpf-missing',
    school_id: 'school-1',
    studentId: 'student-1',
    stage: 'awaiting_selection',
    failedCpfAttempts: 0,
    expiresAt: '2026-04-07T12:00:00.000Z',
    candidateGuardians: [
      {
        optionId: 'option-1',
        tutorId: 'tutor-1',
        displayName: 'Maria Souza',
        relationship: 'Mae',
      },
    ],
  });
  seed.tutors[0].cpf = null;
  seed.tutors[0].cpfNormalized = null;

  const harness = createHarness(seed);

  await assert.rejects(
    () =>
      harness.service.verifyResponsible({
        challengeId: 'challenge-cpf-missing',
        optionId: 'option-1',
        cpf: '123.456.789-09',
      }),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.equal(error.reason, 'tutor_cpf_missing');
      return true;
    }
  );
});

test('guardian auth applies lockout after repeated login failures', async () => {
  const seed = createBaseSeed();
  seed.accounts.push({
    _id: 'account-1',
    school_id: 'school-1',
    tutorId: 'tutor-1',
    identifierType: 'cpf',
    identifierNormalized: '12345678909',
    identifierMasked: '***.***.***-09',
    pinHash: await bcrypt.hash('999999', 4),
    status: 'active',
    tokenVersion: 0,
    failedLoginCount: 0,
    blockedUntil: null,
  });

  const harness = createHarness(seed);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(
      () =>
        harness.service.login({
          schoolPublicId: 'escola-a',
          identifier: '12345678909',
          pin: '000000',
        }),
      (error) => error.statusCode === 401
    );
  }

  await assert.rejects(
    () =>
      harness.service.login({
        schoolPublicId: 'escola-a',
        identifier: '12345678909',
        pin: '000000',
      }),
    (error) => error.statusCode === 423
  );

  assert.ok(harness.state.accounts[0].blockedUntil);
});

test('guardian auth administrative reset forces account back to pending', async () => {
  const seed = createBaseSeed();
  seed.accounts.push({
    _id: 'account-1',
    school_id: 'school-1',
    tutorId: 'tutor-1',
    identifierType: 'cpf',
    identifierNormalized: '12345678909',
    identifierMasked: '***.***.***-09',
    pinHash: await bcrypt.hash('999999', 4),
    status: 'active',
    tokenVersion: 0,
    failedLoginCount: 1,
    blockedUntil: '2026-04-07T11:00:00.000Z',
  });

  const harness = createHarness(seed);

  const result = await harness.service.resetPin({
    schoolId: 'school-1',
    accountId: 'account-1',
    actor: { id: 'user-1', roles: ['Admin'] },
  });

  assert.equal(result.status, 'pending');
  assert.equal(harness.state.accounts[0].status, 'pending');
  assert.equal(harness.state.accounts[0].pinHash, null);
  assert.equal(harness.state.accounts[0].blockedUntil, null);
});

test('guardian auth isolates recurring login by school public identifier', async () => {
  const seed = createBaseSeed();
  seed.schools.push({
    _id: 'school-2',
    name: 'Escola B',
    publicIdentifier: 'escola-b',
  });
  seed.tutors.push({
    _id: 'tutor-2',
    school_id: 'school-2',
    fullName: 'Maria Souza',
    cpf: '123.456.789-09',
    cpfNormalized: '12345678909',
    students: [],
  });
  seed.accounts.push({
    _id: 'account-1',
    school_id: 'school-1',
    tutorId: 'tutor-1',
    identifierType: 'cpf',
    identifierNormalized: '12345678909',
    identifierMasked: '***.***.***-09',
    pinHash: await bcrypt.hash('111111', 4),
    status: 'active',
    tokenVersion: 0,
    failedLoginCount: 0,
    blockedUntil: null,
  });
  seed.accounts.push({
    _id: 'account-2',
    school_id: 'school-2',
    tutorId: 'tutor-2',
    identifierType: 'cpf',
    identifierNormalized: '12345678909',
    identifierMasked: '***.***.***-09',
    pinHash: await bcrypt.hash('222222', 4),
    status: 'active',
    tokenVersion: 0,
    failedLoginCount: 0,
    blockedUntil: null,
  });

  const harness = createHarness(seed);

  const loginA = await harness.service.login({
    schoolPublicId: 'escola-a',
    identifier: '12345678909',
    pin: '111111',
  });
  assert.ok(loginA.token);

  await assert.rejects(
    () =>
      harness.service.login({
        schoolPublicId: 'escola-b',
        identifier: '12345678909',
        pin: '111111',
      }),
    (error) => error.statusCode === 401
  );
});

test('guardian auth login resolves the correct school automatically when CPF and PIN match a single account', async () => {
  const seed = createBaseSeed();
  seed.schools.push({
    _id: 'school-2',
    name: 'Escola B',
    publicIdentifier: 'escola-b',
  });
  seed.tutors.push({
    _id: 'tutor-2',
    school_id: 'school-2',
    fullName: 'Maria Souza',
    cpf: '123.456.789-09',
    cpfNormalized: '12345678909',
    students: [],
  });
  seed.accounts.push({
    _id: 'account-1',
    school_id: 'school-1',
    tutorId: 'tutor-1',
    identifierType: 'cpf',
    identifierNormalized: '12345678909',
    identifierMasked: '***.***.***-09',
    pinHash: await bcrypt.hash('111111', 4),
    status: 'active',
    tokenVersion: 0,
    failedLoginCount: 0,
    blockedUntil: null,
  });
  seed.accounts.push({
    _id: 'account-2',
    school_id: 'school-2',
    tutorId: 'tutor-2',
    identifierType: 'cpf',
    identifierNormalized: '12345678909',
    identifierMasked: '***.***.***-09',
    pinHash: await bcrypt.hash('222222', 4),
    status: 'active',
    tokenVersion: 0,
    failedLoginCount: 0,
    blockedUntil: null,
  });

  const harness = createHarness(seed);

  const result = await harness.service.login({
    identifier: '12345678909',
    pin: '222222',
  });

  assert.ok(result.token);
  assert.equal(result.school.publicIdentifier, 'escola-b');
});

test('guardian auth login requests school selection only when the same CPF and PIN match more than one school', async () => {
  const seed = createBaseSeed();
  seed.schools.push({
    _id: 'school-2',
    name: 'Escola B',
    publicIdentifier: 'escola-b',
  });
  seed.tutors.push({
    _id: 'tutor-2',
    school_id: 'school-2',
    fullName: 'Maria Souza',
    cpf: '123.456.789-09',
    cpfNormalized: '12345678909',
    students: [],
  });
  seed.accounts.push({
    _id: 'account-1',
    school_id: 'school-1',
    tutorId: 'tutor-1',
    identifierType: 'cpf',
    identifierNormalized: '12345678909',
    identifierMasked: '***.***.***-09',
    pinHash: await bcrypt.hash('111111', 4),
    status: 'active',
    tokenVersion: 0,
    failedLoginCount: 0,
    blockedUntil: null,
  });
  seed.accounts.push({
    _id: 'account-2',
    school_id: 'school-2',
    tutorId: 'tutor-2',
    identifierType: 'cpf',
    identifierNormalized: '12345678909',
    identifierMasked: '***.***.***-09',
    pinHash: await bcrypt.hash('111111', 4),
    status: 'active',
    tokenVersion: 0,
    failedLoginCount: 0,
    blockedUntil: null,
  });

  const harness = createHarness(seed);

  await assert.rejects(
    () =>
      harness.service.login({
        identifier: '12345678909',
        pin: '111111',
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.payload.status, 'school_selection_required');
      assert.equal(error.payload.candidateSchools.length, 2);
      return true;
    }
  );
});

test('guardian PIN recovery succeeds with the complete validated identity', async () => {
  const harness = createHarness(await createRecoverySeed());
  const started = await startValidRecovery(harness.service);

  assert.equal(started.schoolSelectionRequired, false);
  assert.equal(started.expiresInSeconds, 900);
  assert.ok(started.challengeId);
  assert.ok(started.verificationToken);

  const result = await harness.service.completePinRecovery({
    challengeId: started.challengeId,
    verificationToken: started.verificationToken,
    newPin: '654321',
  });

  assert.equal(result.status, 'pin_updated');
  assert.equal(result.identifierMasked, '***.***.***-09');
});

test('guardian PIN recovery rejects a wrong student with a generic message', async () => {
  const harness = createHarness(await createRecoverySeed());

  await assert.rejects(
    () =>
      startValidRecovery(harness.service, {
        studentFullName: 'Aluno Inexistente',
      }),
    (error) =>
      error.statusCode === 400 &&
      error.message ===
        'Nao foi possivel confirmar os dados informados. Revise e tente novamente ou procure a escola.'
  );
});

test('guardian PIN recovery rejects a CPF that is not linked to the student', async () => {
  const seed = await createRecoverySeed();
  seed.tutors.push({
    _id: 'tutor-2',
    school_id: 'school-1',
    fullName: 'Outro Responsavel',
    cpf: '529.982.247-25',
    cpfNormalized: '52998224725',
    birthDate: '1985-07-10T00:00:00.000Z',
  });
  seed.accounts.push({
    _id: 'account-2',
    school_id: 'school-1',
    tutorId: 'tutor-2',
    identifierType: 'cpf',
    identifierNormalized: '52998224725',
    identifierMasked: '***.***.***-25',
    pinHash: await bcrypt.hash('111111', 4),
    status: 'active',
    tokenVersion: 0,
  });
  const harness = createHarness(seed);

  await assert.rejects(
    () => startValidRecovery(harness.service, { cpf: '52998224725' }),
    (error) =>
      error.reason === 'pin_recovery_identity_not_confirmed' &&
      !error.message.includes('CPF')
  );
});

test('guardian PIN recovery rejects an incorrect guardian birth date', async () => {
  const harness = createHarness(await createRecoverySeed());

  await assert.rejects(
    () =>
      startValidRecovery(harness.service, {
        guardianBirthDate: '1985-07-11',
      }),
    (error) =>
      error.reason === 'pin_recovery_identity_not_confirmed' &&
      !error.message.toLowerCase().includes('nascimento')
  );
});

test('guardian PIN recovery isolates accounts with the same CPF across schools', async () => {
  const seed = await createRecoverySeed({ pin: '111111' });
  seed.schools.push({
    _id: 'school-2',
    name: 'Escola B',
    publicIdentifier: 'escola-b',
  });
  seed.students.push({
    ...seed.students[0],
    _id: 'student-2',
    school_id: 'school-2',
    financialTutorId: 'tutor-2',
    tutors: [{ tutorId: 'tutor-2', relationship: 'Mae' }],
  });
  seed.tutors.push({
    ...seed.tutors[0],
    _id: 'tutor-2',
    school_id: 'school-2',
    students: ['student-2'],
  });
  seed.accounts.push({
    ...seed.accounts[0],
    _id: 'account-2',
    school_id: 'school-2',
    tutorId: 'tutor-2',
    pinHash: await bcrypt.hash('222222', 4),
    tokenVersion: 4,
  });
  seed.links.push({
    ...seed.links[0],
    _id: 'link-2',
    school_id: 'school-2',
    guardianAccessAccountId: 'account-2',
    studentId: 'student-2',
    tutorId: 'tutor-2',
  });
  const harness = createHarness(seed);

  const selection = await startValidRecovery(harness.service, {
    schoolPublicId: null,
  });
  assert.equal(selection.schoolSelectionRequired, true);
  assert.deepEqual(
    selection.options.map((item) => item.schoolPublicId).sort(),
    ['escola-a', 'escola-b']
  );

  const started = await startValidRecovery(harness.service, {
    schoolPublicId: 'escola-b',
  });
  await harness.service.completePinRecovery({
    challengeId: started.challengeId,
    verificationToken: started.verificationToken,
    newPin: '333333',
  });

  assert.equal(await bcrypt.compare('111111', harness.state.accounts[0].pinHash), true);
  assert.equal(await bcrypt.compare('333333', harness.state.accounts[1].pinHash), true);
  assert.equal(harness.state.accounts[0].tokenVersion, 2);
  assert.equal(harness.state.accounts[1].tokenVersion, 5);
});

test('administrative reset can be completed only through PIN recovery and new login', async () => {
  const harness = createHarness(await createRecoverySeed({ pin: '246810' }));

  await harness.service.resetPin({
    schoolId: 'school-1',
    accountId: 'account-1',
    actor: { id: 'user-1', roles: ['Admin'] },
  });

  assert.equal(harness.state.accounts[0].status, 'pending');
  assert.equal(harness.state.accounts[0].pinHash, null);

  const firstAccess = await harness.service.startFirstAccess({
    studentFullName: 'Ana Souza',
    birthDate: '2012-03-10',
  });
  await assert.rejects(
    () =>
      harness.service.verifyResponsible({
        challengeId: firstAccess.challengeId,
        optionId: firstAccess.guardians[0].optionId,
        cpf: '12345678909',
      }),
    (error) => error.reason === 'pin_recovery_required'
  );

  const started = await startValidRecovery(harness.service);
  await harness.service.completePinRecovery({
    challengeId: started.challengeId,
    verificationToken: started.verificationToken,
    newPin: '654321',
  });
  const login = await harness.service.login({
    schoolPublicId: 'escola-a',
    identifier: '12345678909',
    pin: '654321',
  });

  assert.ok(login.token);
  assert.equal(harness.state.accounts[0].status, 'active');
});

test('the old PIN stops working after guardian PIN recovery', async () => {
  const harness = createHarness(await createRecoverySeed({ pin: '246810' }));
  const started = await startValidRecovery(harness.service);
  await harness.service.completePinRecovery({
    challengeId: started.challengeId,
    verificationToken: started.verificationToken,
    newPin: '654321',
  });

  await assert.rejects(
    () =>
      harness.service.login({
        schoolPublicId: 'escola-a',
        identifier: '12345678909',
        pin: '246810',
      }),
    (error) => error.statusCode === 401
  );
});

test('the new PIN authenticates after guardian PIN recovery', async () => {
  const harness = createHarness(await createRecoverySeed());
  const started = await startValidRecovery(harness.service);
  await harness.service.completePinRecovery({
    challengeId: started.challengeId,
    verificationToken: started.verificationToken,
    newPin: '654321',
  });

  const login = await harness.service.login({
    schoolPublicId: 'escola-a',
    identifier: '12345678909',
    pin: '654321',
  });
  assert.ok(login.token);
});

test('guardian PIN recovery increments tokenVersion', async () => {
  const harness = createHarness(await createRecoverySeed());
  const account = harness.state.accounts[0];
  const started = await startValidRecovery(harness.service);

  await harness.service.completePinRecovery({
    challengeId: started.challengeId,
    verificationToken: started.verificationToken,
    newPin: '654321',
  });

  assert.equal(account.tokenVersion, 3);
});

test('guardian PIN recovery makes previously issued session versions stale', async () => {
  const harness = createHarness(await createRecoverySeed());
  const account = harness.state.accounts[0];
  const oldToken = harness.service._signGuardianToken(account);
  const oldPayload = harness.service.jwt.verify(oldToken, 'guardian-secret');
  const started = await startValidRecovery(harness.service);

  await harness.service.completePinRecovery({
    challengeId: started.challengeId,
    verificationToken: started.verificationToken,
    newPin: '654321',
  });

  assert.equal(oldPayload.tokenVersion, 2);
  assert.notEqual(oldPayload.tokenVersion, account.tokenVersion);
});

test('an expired guardian PIN recovery challenge cannot be completed', async () => {
  const harness = createHarness(await createRecoverySeed());
  const started = await startValidRecovery(harness.service);
  harness.setNow('2026-04-07T10:16:00.000Z');

  await assert.rejects(
    () =>
      harness.service.completePinRecovery({
        challengeId: started.challengeId,
        verificationToken: started.verificationToken,
        newPin: '654321',
      }),
    (error) =>
      error.statusCode === 410 &&
      error.reason === 'pin_recovery_challenge_expired'
  );
});

test('a completed guardian PIN recovery challenge cannot be replayed', async () => {
  const harness = createHarness(await createRecoverySeed());
  const started = await startValidRecovery(harness.service);
  await harness.service.completePinRecovery({
    challengeId: started.challengeId,
    verificationToken: started.verificationToken,
    newPin: '654321',
  });

  await assert.rejects(
    () =>
      harness.service.completePinRecovery({
        challengeId: started.challengeId,
        verificationToken: started.verificationToken,
        newPin: '111111',
      }),
    (error) =>
      error.statusCode === 409 &&
      error.reason === 'pin_recovery_challenge_used'
  );
});

test('an invalid guardian PIN recovery token cannot change the PIN', async () => {
  const harness = createHarness(await createRecoverySeed({ pin: '246810' }));
  const started = await startValidRecovery(harness.service);

  await assert.rejects(
    () =>
      harness.service.completePinRecovery({
        challengeId: started.challengeId,
        verificationToken: 'invalid-token',
        newPin: '654321',
      }),
    (error) => error.statusCode === 401
  );
  assert.equal(
    await bcrypt.compare('246810', harness.state.accounts[0].pinHash),
    true
  );
});

test('persistent rate limiting blocks excessive PIN recovery starts', async () => {
  const harness = createHarness(await createRecoverySeed());

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(() =>
      startValidRecovery(harness.service, {
        studentFullName: `Aluno Incorreto ${attempt}`,
      })
    );
  }

  await assert.rejects(
    () =>
      startValidRecovery(harness.service, {
        studentFullName: 'Outro Aluno',
      }),
    (error) =>
      error.statusCode === 429 &&
      error.reason === 'pin_recovery_rate_limited'
  );
});

test('PIN recovery identity failures remain non-enumerable', async () => {
  const harness = createHarness(await createRecoverySeed());
  const failures = [
    { cpf: '52998224725' },
    { studentFullName: 'Nome Incorreto' },
    { studentBirthDate: '2012-03-11' },
    { guardianBirthDate: '1985-07-11' },
  ];

  for (const override of failures) {
    await assert.rejects(
      () => startValidRecovery(harness.service, override),
      (error) =>
        error.message ===
        'Nao foi possivel confirmar os dados informados. Revise e tente novamente ou procure a escola.'
    );
  }
});

test('guardian PIN recovery records success audit without sensitive metadata', async () => {
  const harness = createHarness(await createRecoverySeed());
  const started = await startValidRecovery(harness.service);
  await harness.service.completePinRecovery({
    challengeId: started.challengeId,
    verificationToken: started.verificationToken,
    newPin: '654321',
  });

  const event = harness.state.events.find(
    (item) =>
      item.eventType === GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_SUCCEEDED
  );
  assert.ok(event);
  assert.equal(JSON.stringify(event).includes('654321'), false);
  assert.equal(JSON.stringify(event).includes('12345678909'), false);
});

test('guardian PIN recovery records failure and challenge blocking audit', async () => {
  const harness = createHarness(await createRecoverySeed());
  const started = await startValidRecovery(harness.service);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(() =>
      harness.service.completePinRecovery({
        challengeId: started.challengeId,
        verificationToken: `invalid-${attempt}`,
        newPin: '654321',
      })
    );
  }

  assert.ok(
    harness.state.events.some(
      (item) =>
        item.eventType === GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_FAILED
    )
  );
  assert.ok(
    harness.state.events.some(
      (item) =>
        item.eventType === GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_BLOCKED
    )
  );
});

test('guardian PIN recovery stores the new PIN only as a bcrypt hash', async () => {
  const harness = createHarness(await createRecoverySeed());
  const started = await startValidRecovery(harness.service);
  await harness.service.completePinRecovery({
    challengeId: started.challengeId,
    verificationToken: started.verificationToken,
    newPin: '654321',
  });

  const account = harness.state.accounts[0];
  assert.notEqual(account.pinHash, '654321');
  assert.match(account.pinHash, /^\$2[aby]\$/);
  assert.equal(await bcrypt.compare('654321', account.pinHash), true);
});

test('guardian PIN recovery does not expose PIN or token in logs or responses', async () => {
  const harness = createHarness(await createRecoverySeed());
  const captured = [];
  const originalInfo = console.info;
  console.info = (...args) => captured.push(args.join(' '));

  try {
    const started = await startValidRecovery(harness.service);
    const result = await harness.service.completePinRecovery({
      challengeId: started.challengeId,
      verificationToken: started.verificationToken,
      newPin: '654321',
    });

    assert.equal(JSON.stringify(result).includes('654321'), false);
    assert.equal(JSON.stringify(result).includes(started.verificationToken), false);
    assert.equal(captured.join(' ').includes('654321'), false);
    assert.equal(captured.join(' ').includes(started.verificationToken), false);
  } finally {
    console.info = originalInfo;
  }
});

test('multiple linked students remain available after guardian PIN recovery', async () => {
  const seed = await createRecoverySeed();
  seed.students.push({
    _id: 'student-2',
    school_id: 'school-1',
    fullName: 'Gabriel Souza',
    fullNameNormalized: 'gabriel souza',
    birthDateKey: '2014-08-20',
    birthDate: '2014-08-20T00:00:00.000Z',
    isActive: true,
    financialTutorId: 'tutor-1',
    tutors: [{ tutorId: 'tutor-1', relationship: 'Mae' }],
  });
  seed.links.push({
    _id: 'link-2',
    school_id: 'school-1',
    guardianAccessAccountId: 'account-1',
    studentId: 'student-2',
    tutorId: 'tutor-1',
    relationshipSnapshot: 'Mae',
    status: 'active',
  });
  const harness = createHarness(seed);
  const started = await startValidRecovery(harness.service);
  await harness.service.completePinRecovery({
    challengeId: started.challengeId,
    verificationToken: started.verificationToken,
    newPin: '654321',
  });
  const login = await harness.service.login({
    schoolPublicId: 'escola-a',
    identifier: '12345678909',
    pin: '654321',
  });

  assert.equal(login.guardian.linkedStudentsCount, 2);
  assert.equal(login.linkedStudents.length, 2);
});

test('guardian PIN recovery records credential update and session revocation with one correlation id', async () => {
  const harness = createHarness(await createRecoverySeed());
  const started = await startValidRecovery(harness.service, {
    requestMeta: {
      ip: '203.0.113.25',
      userAgent: 'Academy Hub Mobile Android',
      source: 'mobile',
      devicePlatform: 'android',
      appVersion: '2.4.0',
      correlationId: 'recovery-correlation',
    },
  });

  await harness.service.completePinRecovery({
    challengeId: started.challengeId,
    verificationToken: started.verificationToken,
    newPin: '654321',
  });

  const criticalTypes = [
    GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_SUCCEEDED,
    GUARDIAN_ACCESS_EVENT_TYPES.GUARDIAN_PIN_UPDATED,
    GUARDIAN_ACCESS_EVENT_TYPES.GUARDIAN_SESSIONS_REVOKED,
  ];
  const events = harness.state.events.filter((event) =>
    criticalTypes.includes(event.eventType)
  );

  assert.equal(events.length, 3);
  assert.deepEqual(
    [...new Set(events.map((event) => event.correlationId))],
    ['recovery-correlation']
  );
  events.forEach((event) => {
    assert.equal(event.schemaVersion, 2);
    assert.equal(event.tokenVersionBefore, 2);
    assert.equal(event.tokenVersionAfter, 3);
    assert.equal(event.sessionsRevoked, true);
    assert.equal(event.source, 'mobile');
    assert.equal(event.ipMasked, '203.***.***.25');
    assert.equal(event.cpfMasked, '***.***.***-09');
    assert.equal(String(event.ipHash).includes('203.0.113.25'), false);
  });
});

test('administrative reset records actor snapshot, sanitized reason and revocation atomically', async () => {
  const harness = createHarness(await createRecoverySeed());

  await harness.service.resetPin({
    schoolId: 'school-1',
    accountId: 'account-1',
    actor: {
      id: 'user-1',
      fullName: 'Gestora Escolar',
      roles: ['Admin'],
    },
    reasonCode: 'guardian_request',
    reasonText: `  Solicitação presencial confirmada. ${'x'.repeat(600)}  `,
    requestMeta: {
      ip: '198.51.100.8',
      userAgent: 'Chrome Windows',
      source: 'desktop',
      devicePlatform: 'windows',
      correlationId: 'admin-reset-correlation',
    },
  });

  const events = harness.state.events.filter((event) =>
    [
      GUARDIAN_ACCESS_EVENT_TYPES.PIN_RESET,
      GUARDIAN_ACCESS_EVENT_TYPES.GUARDIAN_SESSIONS_REVOKED,
    ].includes(event.eventType)
  );
  assert.equal(events.length, 2);
  events.forEach((event) => {
    assert.equal(event.actorUserId, 'user-1');
    assert.equal(event.actorNameSnapshot, 'Gestora Escolar');
    assert.deepEqual(event.actorRoleSnapshot, ['ADMIN']);
    assert.equal(event.reasonCode, 'guardian_request');
    assert.equal(event.reasonText.length, 500);
    assert.equal(event.correlationId, 'admin-reset-correlation');
    assert.equal(event.tokenVersionBefore, 2);
    assert.equal(event.tokenVersionAfter, 3);
  });
});

test('administrative unlock, deactivate and reactivate actions always create critical audit events', async () => {
  const harness = createHarness(await createRecoverySeed());
  const actor = {
    id: 'user-1',
    fullName: 'Gestora Escolar',
    roles: ['Admin'],
  };
  const requestMeta = {
    source: 'desktop',
    correlationId: 'admin-action-correlation',
  };

  harness.state.accounts[0].blockedUntil = '2026-04-07T10:10:00.000Z';
  harness.state.accounts[0].failedLoginCount = 5;
  await harness.service.unlockAccount({
    schoolId: 'school-1',
    accountId: 'account-1',
    actor,
    reasonText: 'Identidade confirmada pela secretaria.',
    requestMeta,
  });
  await harness.service.deactivateAccount({
    schoolId: 'school-1',
    accountId: 'account-1',
    actor,
    reasonCode: 'guardian_request',
    requestMeta,
  });
  await harness.service.reactivateAccount({
    schoolId: 'school-1',
    accountId: 'account-1',
    actor,
    requestMeta,
  });

  const types = harness.state.events.map((event) => event.eventType);
  assert.ok(types.includes(GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_UNLOCKED));
  assert.ok(types.includes(GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_DEACTIVATED));
  assert.ok(types.includes(GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_REACTIVATED));
  assert.ok(
    types.includes(GUARDIAN_ACCESS_EVENT_TYPES.GUARDIAN_SESSIONS_REVOKED)
  );
  assert.equal(harness.state.accounts[0].tokenVersion, 3);
});

test('critical administrative mutation is not confirmed when audit persistence fails', async () => {
  const harness = createHarness(await createRecoverySeed());
  const account = harness.state.accounts[0];
  const original = {
    pinHash: account.pinHash,
    status: account.status,
    pinUpdatedAt: account.pinUpdatedAt,
    tokenVersion: account.tokenVersion,
  };
  harness.service.runCriticalTransaction = async (work) => {
    try {
      return await work(null);
    } catch (error) {
      Object.assign(account, original);
      throw error;
    }
  };
  harness.service.GuardianAccessEventModel.create = async () => {
    throw new Error('audit unavailable');
  };

  await assert.rejects(
    () =>
      harness.service.resetPin({
        schoolId: 'school-1',
        accountId: 'account-1',
        actor: { id: 'user-1', fullName: 'Gestora', roles: ['Admin'] },
      }),
    /audit unavailable/
  );
  assert.equal(account.pinHash, original.pinHash);
  assert.equal(account.status, original.status);
  assert.equal(account.pinUpdatedAt, original.pinUpdatedAt);
  assert.equal(account.tokenVersion, original.tokenVersion);
});

test('observed and swept expired recovery challenges produce PIN_RECOVERY_EXPIRED', async () => {
  const harness = createHarness(await createRecoverySeed());
  const started = await startValidRecovery(harness.service);
  harness.setNow('2026-04-07T10:16:00.000Z');

  await assert.rejects(() =>
    harness.service.completePinRecovery({
      challengeId: started.challengeId,
      verificationToken: started.verificationToken,
      newPin: '654321',
    })
  );
  assert.ok(
    harness.state.events.some(
      (event) =>
        event.eventType ===
          GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_EXPIRED &&
        event.status === 'expired'
    )
  );

  const second = await startValidRecovery(harness.service, {
    requestMeta: { ip: '203.0.113.77', userAgent: 'test-agent' },
  });
  harness.setNow('2026-04-07T10:32:00.000Z');
  const sweep = await harness.service.expirePinRecoveryChallenges();
  assert.equal(sweep.expiredCount, 1);
  assert.equal(
    harness.state.recoveryChallenges.find(
      (challenge) => challenge._id === second.challengeId
    ).stage,
    'expired'
  );
});

test('guardian audit metadata sanitizer only keeps shallow allowlisted values', () => {
  const sanitized = sanitizeEventMetadata({
    attempts: 2,
    result: 'pin_updated',
    pin: '654321',
    newPin: '654321',
    verificationToken: 'secret',
    cpf: '12345678909',
    ip: '203.0.113.1',
    userAgent: 'raw agent',
    studentFullName: 'Ana Souza',
    nested: { password: 'secret' },
    source: 'x'.repeat(300),
  });

  assert.deepEqual(Object.keys(sanitized).sort(), [
    'attempts',
    'result',
    'source',
  ]);
  assert.equal(sanitized.source.length, 160);
  assert.equal(sanitizeReasonText('x'.repeat(600)).length, 500);
  assert.equal(
    sanitizeReasonText(
      'PIN 654321, CPF 123.456.789-09 e IP 203.0.113.25'
    ).includes('654321'),
    false
  );
  assert.equal(JSON.stringify(sanitized).includes('654321'), false);
  assert.equal(JSON.stringify(sanitized).includes('12345678909'), false);
});

function createAuditQuerySeed() {
  const schoolId = '64a000000000000000000001';
  const accountId = '64a000000000000000000002';
  const tutorId = '64a000000000000000000003';
  const studentId = '64a000000000000000000004';
  return {
    schoolId,
    accountId,
    tutorId,
    studentId,
    seed: {
      schools: [{ _id: schoolId, name: 'Escola Auditada' }],
      students: [{ _id: studentId, school_id: schoolId }],
      tutors: [{ _id: tutorId, school_id: schoolId }],
      accounts: [
        {
          _id: accountId,
          school_id: schoolId,
          tutorId,
          identifierNormalized: '12345678909',
          identifierMasked: '***.***.***-09',
          status: 'active',
        },
      ],
      links: [
        {
          _id: '64a000000000000000000005',
          school_id: schoolId,
          guardianAccessAccountId: accountId,
          tutorId,
          studentId,
          status: 'active',
        },
      ],
      events: [
        {
          _id: '64a000000000000000000013',
          school_id: schoolId,
          accountId,
          tutorId,
          studentId,
          actorType: 'guardian',
          eventType: GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_SUCCEEDED,
          schemaVersion: 2,
          status: 'success',
          source: 'mobile',
          ipHash: 'abcdef1234567890',
          ipMasked: '179.***.***.25',
          cpfMasked: '***.***.***-09',
          metadata: {
            pin: 'must-not-return',
            verificationToken: 'must-not-return',
          },
          createdAt: '2026-04-07T12:00:00.000Z',
        },
        {
          _id: '64a000000000000000000012',
          school_id: schoolId,
          accountId,
          tutorId,
          actorType: 'public',
          eventType: GUARDIAN_ACCESS_EVENT_TYPES.LOGIN_FAILED,
          status: 'failed',
          source: 'api',
          createdAt: '2026-04-07T11:00:00.000Z',
        },
        {
          _id: '64a000000000000000000011',
          school_id: schoolId,
          accountId,
          tutorId,
          actorType: 'staff',
          eventType: GUARDIAN_ACCESS_EVENT_TYPES.PIN_RESET,
          metadata: { password: 'must-not-return' },
          createdAt: '2026-04-07T10:00:00.000Z',
        },
      ],
    },
  };
}

test('administrative event query returns sanitized DTO and normalizes legacy events', async () => {
  const context = createAuditQuerySeed();
  const harness = createHarness(context.seed);
  const actor = { id: 'user-1', roles: ['Admin'] };

  const firstPage = await harness.service.listGuardianAccessEvents({
    schoolId: context.schoolId,
    accountId: context.accountId,
    actor,
    filters: { limit: 2 },
  });

  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);
  assert.equal(firstPage.items[0].eventType, 'PIN_RECOVERY_SUCCEEDED');
  assert.equal(firstPage.items[0].security.ipCorrelationId, 'abcdef123456');
  assert.equal(
    Object.prototype.hasOwnProperty.call(firstPage.items[0], 'metadata'),
    false
  );
  assert.equal(JSON.stringify(firstPage).includes('must-not-return'), false);
  assert.equal(JSON.stringify(firstPage).includes('abcdef1234567890'), false);

  const secondPage = await harness.service.listGuardianAccessEvents({
    schoolId: context.schoolId,
    accountId: context.accountId,
    actor,
    filters: { limit: 2, cursor: firstPage.nextCursor },
  });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.items[0].schemaVersion, 1);
  assert.equal(
    secondPage.items[0].normalizedEventType,
    'GUARDIAN_ADMIN_PIN_RESET'
  );
  assert.equal(secondPage.hasMore, false);
});

test('administrative event query enforces school, permission, student link and filters', async () => {
  const context = createAuditQuerySeed();
  const harness = createHarness(context.seed);
  const actor = { id: 'user-1', roles: ['Admin'] };

  await assert.rejects(
    () =>
      harness.service.listGuardianAccessEvents({
        schoolId: '64a000000000000000000099',
        accountId: context.accountId,
        actor,
      }),
    (error) => error.statusCode === 404
  );
  await assert.rejects(
    () =>
      harness.service.listGuardianAccessEvents({
        schoolId: context.schoolId,
        accountId: context.accountId,
        actor: { roles: ['Professor'] },
      }),
    (error) => error.statusCode === 403
  );
  await assert.rejects(
    () =>
      harness.service.listGuardianAccessEvents({
        schoolId: context.schoolId,
        accountId: context.accountId,
        actor,
        filters: { studentId: '64a000000000000000000099' },
      }),
    (error) => error.statusCode === 404
  );

  const filtered = await harness.service.listGuardianAccessEvents({
    schoolId: context.schoolId,
    accountId: context.accountId,
    actor,
    filters: {
      eventType: GUARDIAN_ACCESS_EVENT_TYPES.LOGIN_FAILED,
      status: 'failed',
      from: '2026-04-07T10:30:00.000Z',
      to: '2026-04-07T11:30:00.000Z',
    },
  });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].normalizedEventType, 'GUARDIAN_LOGIN_FAILED');
});
