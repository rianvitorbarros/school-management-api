const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const express = require('express');
const mongoose = require('mongoose');
const path = require('node:path');

const School = require('../../api/models/school.model');
const activityCorrectionService = require('../../api/services/activityCorrection.service');

function createQuery(value) {
  return {
    select() { return this; },
    lean() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function patchMethods(entries) {
  const restores = entries.map(({ target, key, value }) => {
    const original = target[key];
    target[key] = value;
    return () => {
      target[key] = original;
    };
  });

  return () => restores.reverse().forEach((restore) => restore());
}

async function withServer(handler) {
  const routesPath = path.resolve(__dirname, '../../api/routes/activityCorrection.routes.js');
  delete require.cache[routesPath];
  const activityCorrectionRoutes = require(routesPath);
  const app = express();
  app.use(express.json());
  app.use('/api/school', activityCorrectionRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address();
  try {
    return await handler(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function createSchoolAuthHarness() {
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'school-secret-test';

  const schoolId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  const restore = patchMethods([
    {
      target: School,
      key: 'findById',
      value(id) {
        return createQuery(String(id) === String(schoolId) ? {
          _id: schoolId,
          platformAccess: { isBlocked: false, status: 'active' },
        } : null);
      },
    },
  ]);

  const token = jwt.sign(
    {
      id: String(userId),
      school_id: String(schoolId),
      roles: ['Professor'],
    },
    process.env.JWT_SECRET
  );

  return {
    schoolId: String(schoolId),
    token,
    restore() {
      restore();
      if (originalSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = originalSecret;
    },
  };
}

test('POST /activity-corrections/resolve returns the resolved activity QR payload', async () => {
  const auth = createSchoolAuthHarness();
  let capturedInput = null;

  const restore = patchMethods([
    {
      target: activityCorrectionService,
      key: 'resolveQr',
      value: async (input) => {
        capturedInput = input;
        return {
          type: 'activity',
          activity: {
            activityPrintRunId: 'run-1',
            qrCodePayload: input.qrCodePayload,
            activityPageId: 'page-1',
            bookId: 'book-1',
            bookTitle: 'Caderno',
            activityTitle: 'Pagina 04',
            pageNumber: 4,
            subject: 'Portugues',
            printDate: '2026-06-08',
          },
          student: { id: 'student-1', name: 'Lara Sophia' },
          class: { id: 'class-1', name: '1 B' },
          teacher: { id: 'teacher-1', name: 'Professora Ana' },
          correction: { exists: false, id: null, status: 'pending', criteria: [], generalObservation: null },
          criteriaTemplate: [],
        };
      },
    },
  ]);

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/school/activity-corrections/resolve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ qrCodePayload: 'AH-ACTIVITY-1:uuid-1' }),
      });

      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.type, 'activity');
      assert.equal(capturedInput.schoolId, auth.schoolId);
      assert.equal(capturedInput.qrCodePayload, 'AH-ACTIVITY-1:uuid-1');
    });
  } finally {
    restore();
    auth.restore();
  }
});

test('POST /activity-corrections forwards validation errors from the service', async () => {
  const auth = createSchoolAuthHarness();

  const restore = patchMethods([
    {
      target: activityCorrectionService,
      key: 'createCorrection',
      value: async () => {
        const error = new Error('Ja existe uma correcao registrada para esta atividade.');
        error.status = 409;
        error.code = 'ACTIVITY_CORRECTION_ALREADY_EXISTS';
        throw error;
      },
    },
  ]);

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/school/activity-corrections`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
          criteria: [{ key: 'coordenacao_motora', value: 'realizou_com_apoio', note: '' }],
        }),
      });

      const payload = await response.json();
      assert.equal(response.status, 409);
      assert.equal(payload.code, 'ACTIVITY_CORRECTION_ALREADY_EXISTS');
    });
  } finally {
    restore();
    auth.restore();
  }
});

test('GET /students/:studentId/activity-corrections returns student corrections', async () => {
  const auth = createSchoolAuthHarness();
  let capturedStudentId = null;

  const restore = patchMethods([
    {
      target: activityCorrectionService,
      key: 'listStudentCorrections',
      value: async (input) => {
        capturedStudentId = input.studentId;
        return {
          items: [
            {
              id: 'correction-1',
              studentId: input.studentId,
              status: 'corrected',
              qrCodePayload: 'AH-ACTIVITY-1:uuid-1',
            },
          ],
          page: 1,
          limit: 20,
          total: 1,
        };
      },
    },
  ]);

  try {
    await withServer(async (baseUrl) => {
      const studentId = String(new mongoose.Types.ObjectId());
      const response = await fetch(`${baseUrl}/api/school/students/${studentId}/activity-corrections`, {
        headers: {
          Authorization: `Bearer ${auth.token}`,
        },
      });

      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.total, 1);
      assert.equal(capturedStudentId, studentId);
    });
  } finally {
    restore();
    auth.restore();
  }
});

test('GET /activity-corrections/print-runs forwards academic filters', async () => {
  const auth = createSchoolAuthHarness();
  let capturedInput = null;

  const restore = patchMethods([
    {
      target: activityCorrectionService,
      key: 'listPrintRunsForCorrection',
      value: async (input) => {
        capturedInput = input;
        return { items: [], total: 0 };
      },
    },
  ]);

  try {
    await withServer(async (baseUrl) => {
      const classId = String(new mongoose.Types.ObjectId());
      const termId = String(new mongoose.Types.ObjectId());
      const response = await fetch(
        `${baseUrl}/api/school/activity-corrections/print-runs?classId=${classId}&termId=${termId}`,
        { headers: { Authorization: `Bearer ${auth.token}` } }
      );

      assert.equal(response.status, 200);
      assert.equal(capturedInput.schoolId, auth.schoolId);
      assert.equal(capturedInput.filters.classId, classId);
      assert.equal(capturedInput.filters.termId, termId);
    });
  } finally {
    restore();
    auth.restore();
  }
});
