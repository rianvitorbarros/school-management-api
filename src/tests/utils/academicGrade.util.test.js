const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAcademicGrade } = require('../../api/utils/academicGrade.util');

test('legacy period identities require the class label and stay distinct', () => {
  assert.equal(normalizeAcademicGrade('PERIODO', 'I PERIODO B'), '1º Período');
  assert.equal(normalizeAcademicGrade('PERIODO', 'II PERÍODO A'), '2º Período');
  assert.equal(normalizeAcademicGrade('1º Período'), '1º Período');
  assert.equal(normalizeAcademicGrade('II PERIODO'), '2º Período');
  assert.equal(normalizeAcademicGrade('PERIODO'), 'PERIODO');
});
test('existing annual and legacy seventh grade aliases remain compatible', () => {
  assert.equal(normalizeAcademicGrade('6° ANO'), '6º Ano');
  assert.equal(normalizeAcademicGrade('.'), '7º Ano');
  assert.equal(normalizeAcademicGrade('maternal'), 'Maternal');
  assert.equal(normalizeAcademicGrade('Etapa da escola'), 'Etapa da escola');
});
