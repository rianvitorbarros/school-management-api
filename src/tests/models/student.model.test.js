const test = require('node:test');
const assert = require('node:assert/strict');

const Student = require('../../api/models/student.model');

test('Student persiste naturalidade como campo opcional distinto de nacionalidade', () => {
  const birthPlace = Student.schema.path('birthPlace');

  assert.equal(birthPlace.instance, 'String');
  assert.equal(birthPlace.options.required, undefined);
  assert.equal(birthPlace.options.trim, true);
  assert.equal(birthPlace.options.default, '');
});
