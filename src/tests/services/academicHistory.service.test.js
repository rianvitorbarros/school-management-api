const test = require('node:test');
const assert = require('node:assert/strict');

const Student = require('../../api/models/student.model');
const {
  FINAL_RESULTS,
  _private,
} = require('../../api/services/academicHistory.service');

test('dominio centraliza os resultados finais suportados', () => {
  assert.deepEqual([...FINAL_RESULTS], [
    'Aprovado',
    'Reprovado',
    'Transferido',
    'Em andamento',
    'Outro',
  ]);
});

test('permissao de escrita aceita administracao, coordenacao e staff', () => {
  assert.equal(_private.canManage({ roles: ['Admin'] }), true);
  assert.equal(_private.canManage({ roles: ['Coordenador'] }), true);
  assert.equal(_private.canManage({ roles: ['Staff'] }), true);
  assert.equal(_private.canManage({ role: 'Admin' }), true);
  assert.equal(_private.canManage({ roles: ['Professor'] }), false);
});

test('deduplica disciplinas por id preservando fotografia historica', () => {
  const result = _private.dedupeGrades([
    { subjectId: 'subject-1', subjectName: 'Matemática', gradeValue: '8.0' },
    { subjectId: 'subject-1', subjectName: 'MATEMÁTICA', gradeValue: '9.0' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].historicalName, 'Matemática');
  assert.equal(result[0].gradeValue, '8.0');
});

test('deduplica componente personalizado por nome normalizado', () => {
  const result = _private.dedupeGrades([
    { subjectName: 'Educação Física', gradeValue: 'A' },
    { subjectName: '  educacao   fisica ', gradeValue: 'B' },
  ]);
  assert.equal(result.length, 1);
});

test('identifica ordem dos quatro bimestres sem texto fixo', () => {
  assert.equal(_private.parseTermOrder({ titulo: '1º Bimestre' }), 1);
  assert.equal(_private.parseTermOrder({ titulo: 'Segundo bimestre' }), 2);
  assert.equal(_private.parseTermOrder({ titulo: '3ª etapa' }), 3);
  assert.equal(_private.parseTermOrder({ titulo: 'Quarto período' }), 4);
});

test('arredonda media anual para uma casa decimal', () => {
  assert.equal(_private.roundOne((7.2 + 8.3 + 9.1 + 6.9) / 4), 7.9);
});

test('schema aceita registro anual legado sem novos campos', () => {
  const document = new Student({
    fullName: 'Aluno Legado',
    birthDate: new Date('2015-01-01'),
    gender: 'Outro',
    race: 'Parda',
    nationality: 'Brasileira',
    address: { street: 'Rua A', neighborhood: 'Centro', number: '1', cep: '00000000', city: 'Cidade', state: 'PA' },
    financialResp: 'STUDENT',
    cpf: '00000000000',
    school_id: '64b7f193c54d7f0012345678',
    academicHistory: [{
      gradeLevel: '1º Ano',
      schoolYear: 2024,
      schoolName: 'Escola Antiga',
      city: 'Parauapebas',
      state: 'PA',
      annualWorkload: '800',
      finalResult: 'Aprovado',
      grades: [{ subjectName: 'Português', gradeValue: '8.0' }],
    }],
  });
  const error = document.validateSync();
  assert.equal(error, undefined);
  assert.equal(document.academicHistory[0].origin, 'legacy');
  assert.equal(document.academicHistory[0].grades[0].origin, 'legacy');
});

test('schema suporta nota numerica, conceito e situacao especial', () => {
  const gradePath = Student.schema.path('academicHistory').schema.path('grades').schema;
  const numeric = { subjectName: 'Matemática', gradeValue: '8.5', finalGrade: 8.5 };
  const concept = { subjectName: 'Arte', gradeValue: 'MB', concept: 'MB' };
  const special = { subjectName: 'Música', gradeValue: '', specialStatus: 'not_offered' };
  assert.equal(gradePath.path('finalGrade').cast(numeric.finalGrade), 8.5);
  assert.equal(gradePath.path('concept').cast(concept.concept), 'MB');
  assert.equal(gradePath.path('specialStatus').cast(special.specialStatus), 'not_offered');
});
