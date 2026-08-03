const assert = require('node:assert/strict');
const test = require('node:test');

const SchoolController = require('../../api/controllers/school.controller');

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('school controller rejects access to another school before reading or updating it', async () => {
  const request = {
    params: { id: 'school-b' },
    user: { schoolId: 'school-a' },
  };
  const response = createResponse();
  let nextCalled = false;

  await SchoolController.getById(request, response, () => {
    nextCalled = true;
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.message, 'Escola nao encontrada.');
  assert.equal(nextCalled, false);

  const updateResponse = createResponse();
  await SchoolController.update(
    { ...request, body: { inepCode: '15183041' } },
    updateResponse,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(updateResponse.statusCode, 404);
  assert.equal(updateResponse.body.message, 'Escola nao encontrada.');
  assert.equal(nextCalled, false);
});
