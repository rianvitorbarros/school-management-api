const assert = require('node:assert/strict');
const test = require('node:test');

const School = require('../../api/models/school.model');

function validateSchool(payload = {}) {
  return new School({ name: 'Escola de Teste', ...payload }).validateSync();
}

test('School accepts an absent or empty INEP code for existing schools', () => {
  assert.equal(validateSchool(), undefined);
  assert.equal(validateSchool({ inepCode: '' }), undefined);
});

test('School stores a valid INEP code as a trimmed string', () => {
  const school = new School({ name: 'Escola de Teste', inepCode: ' 15183041 ' });

  assert.equal(school.validateSync(), undefined);
  assert.equal(school.inepCode, '15183041');
  assert.equal(typeof school.inepCode, 'string');
});

for (const inepCode of ['1518304', '151830410', '15183A41', '1518-3041']) {
  test(`School rejects invalid INEP code ${inepCode}`, () => {
    const error = validateSchool({ inepCode });

    assert.ok(error?.errors?.inepCode);
  });
}
