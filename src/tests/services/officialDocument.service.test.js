const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OfficialDocumentService,
} = require('../../api/services/officialDocument.service');
const {
  hasDetachedPdfSignature,
} = require('../../api/services/officialDocumentStorage.service');

function createQuery(value) {
  return {
    populate() {
      return this;
    },
    select() {
      return this;
    },
    sort() {
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
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
  return String(left) === String(right);
}

function matchesFilter(document, filter = {}) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') {
      return Array.isArray(condition) && condition.some((item) => matchesFilter(document, item));
    }

    const values = getPathValues(document, key);

    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if (Object.prototype.hasOwnProperty.call(condition, '$in')) {
        return values.some((value) =>
          condition.$in.some((candidate) => sameValue(value, candidate))
        );
      }
    }

    return values.some((value) => sameValue(value, condition));
  });
}

function createPdfFile(name = 'documento-final.pdf') {
  const cms = `30${'11'.repeat(160)}`;
  const before = '%PDF-1.7\n1 0 obj\n<< /Type /Sig /SubFilter /adbe.pkcs7.detached /ByteRange [0 0000000000 0000000000 0000000000] /Contents ';
  const after = '>>\nendobj\ntrailer\n<<>>\n%%EOF';
  const firstLength = before.length;
  const secondOffset = firstLength + cms.length + 2;
  const byteRange = `[0 ${String(firstLength).padStart(10, '0')} ${String(secondOffset).padStart(10, '0')} ${String(after.length).padStart(10, '0')}]`;
  const buffer = Buffer.from(
    `${before.replace('[0 0000000000 0000000000 0000000000]', byteRange)}<${cms}>${after}`,
    'latin1'
  );
  return {
    originalname: name,
    mimetype: 'application/pdf',
    size: buffer.length,
    buffer,
  };
}

test('rejects an unsigned PDF instead of registering it as an official signed document', async () => {
  const { service } = createHarness({
    students: [{ _id: 'student_1', school_id: 'school_1', tutors: [] }],
  });

  const unsigned = {
    originalname: 'sem-assinatura.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF'),
  };
  unsigned.size = unsigned.buffer.length;

  await assert.rejects(
    service.registerSignedDocument(
      { documentType: 'official_statement', studentId: 'student_1' },
      unsigned,
      { schoolId: 'school_1', actorId: 'user_staff_1' }
    ),
    (error) => error.code === 'digital_signature_required'
  );
});

function createHarness(seed = {}) {
  let documentSequence = 0;
  const state = {
    students: (seed.students || []).map((item) => ({ ...item })),
    links: (seed.links || []).map((item) => ({ ...item })),
    documents: (seed.documents || []).map((item) => ({ ...item })),
    requestSyncCalls: [],
    emittedEvents: [],
  };

  class FakeOfficialDocumentModel {
    constructor(data = {}) {
      this._id = data._id || `document_${++documentSequence}`;
      Object.assign(this, {
        auditTrail: [],
        guardianIds: [],
      }, data);
    }

    async save() {
      const existingIndex = state.documents.findIndex((item) => sameValue(item._id, this._id));
      if (existingIndex >= 0) {
        state.documents[existingIndex] = this;
      } else {
        state.documents.push(this);
      }

      return this;
    }

    static findOne(filter = {}) {
      return createQuery(state.documents.find((item) => matchesFilter(item, filter)) || null);
    }

    static find(filter = {}) {
      return createQuery(state.documents.filter((item) => matchesFilter(item, filter)));
    }

    static async exists(filter = {}) {
      return state.documents.some((item) => matchesFilter(item, filter))
        ? { _id: 'existing_document' }
        : null;
    }
  }

  const requestService = {
    async getSchoolRequestById(requestId) {
      if (requestId === 'request_1') {
        return {
          _id: 'request_1',
          studentId: 'student_1',
          documentType: 'official_statement',
          targetGuardianIds: ['guardian_target'],
          status: 'approved',
        };
      }

      return null;
    },
    async syncStatusFromDocumentLifecycle(payload) {
      state.requestSyncCalls.push(payload);
      return payload;
    },
  };

  const service = new OfficialDocumentService({
    OfficialDocumentModel: FakeOfficialDocumentModel,
    StudentModel: {
      findOne(filter = {}) {
        return createQuery(state.students.find((item) => matchesFilter(item, filter)) || null);
      },
    },
    GuardianAccessLinkModel: {
      find(filter = {}) {
        return createQuery(state.links.filter((item) => matchesFilter(item, filter)));
      },
      findOne(filter = {}) {
        return createQuery(state.links.find((item) => matchesFilter(item, filter)) || null);
      },
    },
    requestService,
    eventEmitter: {
      emit(name, payload) {
        state.emittedEvents.push({ name, payload });
      },
    },
    now: () => new Date('2026-04-16T15:00:00.000Z'),
  });

  return { service, state };
}

test('registerSignedDocument stores final signed PDF metadata and syncs linked request', async () => {
  const { service, state } = createHarness({
    students: [
      {
        _id: 'student_1',
        school_id: 'school_1',
        financialTutorId: 'guardian_financial',
        tutors: [
          { tutorId: 'guardian_target' },
          { tutorId: 'guardian_financial' },
        ],
      },
    ],
  });

  const signedFile = createPdfFile();
  assert.equal(hasDetachedPdfSignature(signedFile.buffer), true);
  const result = await service.registerSignedDocument(
    {
      requestId: 'request_1',
      documentType: 'official_statement',
      isVisibleToGuardian: true,
      certificateSubject: 'CN=Escola Teste',
    },
    signedFile,
    {
      schoolId: 'school_1',
      actorId: 'user_staff_1',
    }
  );

  assert.equal(result.status, 'signed');
  assert.equal(result.mimeType, 'application/pdf');
  assert.equal(result.signatureProvider, 'local_windows_certificate');
  assert.deepEqual(result.guardianIds, ['guardian_target']);
  assert.ok(result.fileHash);
  assert.equal(state.requestSyncCalls.length, 1);
  assert.equal(state.requestSyncCalls[0].nextStatus, 'signed');
  assert.equal(state.emittedEvents.length, 1);
  assert.equal(state.emittedEvents[0].name, 'official_document_signed');
  assert.equal(state.emittedEvents[0].payload.schoolId, 'school_1');
  assert.equal(state.emittedEvents[0].payload.documentId, result._id);
  assert.equal(state.documents.length, 1);
});

test('listGuardianDocuments only returns published documents visible to the authenticated guardian', async () => {
  const { service } = createHarness({
    links: [
      {
        _id: 'link_1',
        school_id: 'school_1',
        guardianAccessAccountId: 'account_1',
        tutorId: 'guardian_1',
        studentId: 'student_1',
        status: 'active',
      },
    ],
    documents: [
      {
        _id: 'doc_visible',
        schoolId: 'school_1',
        studentId: 'student_1',
        guardianIds: ['guardian_1'],
        status: 'published',
        isVisibleToGuardian: true,
        documentType: 'history',
      },
      {
        _id: 'doc_hidden_status',
        schoolId: 'school_1',
        studentId: 'student_1',
        guardianIds: ['guardian_1'],
        status: 'signed',
        isVisibleToGuardian: true,
        documentType: 'history',
      },
      {
        _id: 'doc_hidden_guardian',
        schoolId: 'school_1',
        studentId: 'student_1',
        guardianIds: ['guardian_2'],
        status: 'published',
        isVisibleToGuardian: true,
        documentType: 'history',
      },
    ],
  });

  const result = await service.listGuardianDocuments(
    {},
    {
      schoolId: 'school_1',
      accountId: 'account_1',
      tutorId: 'guardian_1',
    }
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]._id, 'doc_visible');
});
