const test = require('node:test');
const assert = require('node:assert/strict');

const Student = require('../../api/models/student.model');
const Attendance = require('../../api/models/attendance.model');
const {
  AcademicHistoryService,
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
  assert.equal(document.academicHistory[0].institutionType, 'legacy');
  assert.equal(document.academicHistory[0].gradeEntryMode, 'final_only');
});

test('schema suporta escola externa e notas bimestrais opcionais', () => {
  const document = new Student({
    fullName: 'Aluno Bimestral',
    birthDate: new Date('2015-01-01'),
    gender: 'Outro',
    race: 'Parda',
    nationality: 'Brasileira',
    address: { street: 'Rua A', neighborhood: 'Centro', number: '1', cep: '00000000', city: 'Cidade', state: 'PA' },
    financialResp: 'STUDENT',
    cpf: '00000000001',
    school_id: '64b7f193c54d7f0012345678',
    academicHistory: [{
      gradeLevel: '2º Ano',
      schoolYear: 2025,
      schoolName: 'Escola Externa',
      city: 'Marabá',
      state: 'PA',
      finalResult: 'Aprovado',
      institutionType: 'external_school',
      gradeEntryMode: 'bimonthly',
      grades: [{
        subjectName: 'Português',
        gradeValue: '8.5',
        finalGrade: 8.5,
        bimonthlyGrades: [8, 9, null, null],
      }],
    }],
  });
  const error = document.validateSync();
  assert.equal(error, undefined);
  assert.deepEqual(document.academicHistory[0].grades[0].bimonthlyGrades, [8, 9, null, null]);
});

test('servico rejeita nota bimestral fora do intervalo permitido', () => {
  const service = new AcademicHistoryService();
  assert.throws(
    () => service._sanitizeRecord({
      gradeLevel: '2º Ano',
      schoolYear: 2025,
      schoolName: 'Escola Externa',
      city: 'Marabá',
      state: 'PA',
      finalResult: 'Aprovado',
      institutionType: 'external_school',
      gradeEntryMode: 'bimonthly',
      grades: [{ subjectName: 'Matemática', bimonthlyGrades: [11] }],
    }, { id: '64b7f193c54d7f0012345679' }),
    /entre 0 e 10/
  );
});

test('transferência não reutiliza metas anuais como dados cumpridos', () => {
  const service = new AcademicHistoryService();
  const record = service._sanitizeRecord({
    gradeLevel: '4º Ano',
    schoolYear: 2026,
    schoolName: 'Colégio Batista',
    city: 'Parauapebas',
    state: 'PA',
    finalResult: 'Transferido',
    institutionType: 'current_school',
    annualWorkload: '800',
    annualFrequency: 98,
    schoolDays: 200,
    transferDate: '2026-03-15T00:00:00.000Z',
    grades: [],
  }, { id: '64b7f193c54d7f0012345679' });

  assert.equal(record.annualWorkload, null);
  assert.equal(record.annualFrequency, null);
  assert.equal(record.schoolDays, null);
  assert.equal(record.completedWorkloadHours, null);
  assert.equal(record.completedFrequency, null);
  assert.equal(record.completedSchoolDays, null);
  assert.equal(record.transferDate.toISOString(), '2026-03-15T00:00:00.000Z');
});

test('apura frequência de transferência somente pelas chamadas registradas', () => {
  const result = _private.summarizeAttendanceForStudent({
    studentId: 'student-1',
    schoolYear: 2026,
    attendance: [
      { date: '2026-02-02T12:00:00.000Z', records: [{ studentId: 'student-1', status: 'PRESENT' }] },
      { date: '2026-02-03T12:00:00.000Z', records: [{ studentId: 'student-1', status: 'ABSENT' }] },
      { date: '2026-02-04T12:00:00.000Z', records: [{ studentId: 'student-1', status: 'PRESENT' }] },
      { date: '2025-12-18T12:00:00.000Z', records: [{ studentId: 'student-1', status: 'PRESENT' }] },
      { date: '2026-02-05T12:00:00.000Z', records: [{ studentId: 'student-2', status: 'PRESENT' }] },
    ],
  });

  assert.equal(result.completedFrequency, 66.7);
  assert.equal(result.completedSchoolDays, 3);
  assert.equal(result.metricsMeasuredThrough.toISOString(), '2026-02-04T12:00:00.000Z');
});

test('integra chamadas da própria escola até a data da transferência', async () => {
  const service = new AcademicHistoryService();
  const originalFind = Attendance.find;
  const originalResolveEnrollment = service._resolveEnrollment;
  Attendance.find = () => ({
    select: async () => [
      { date: '2026-03-14T12:00:00.000Z', records: [{ studentId: 'student-1', status: 'PRESENT' }] },
      { date: '2026-03-15T12:00:00.000Z', records: [{ studentId: 'student-1', status: 'ABSENT' }] },
      { date: '2026-03-16T12:00:00.000Z', records: [{ studentId: 'student-1', status: 'PRESENT' }] },
    ],
  });
  service._resolveEnrollment = async () => ({ class: { _id: 'class-1' } });
  const record = {
    finalResult: 'Transferido',
    institutionType: 'current_school',
    schoolYear: 2026,
    transferDate: new Date('2026-03-15T00:00:00.000Z'),
    completedWorkloadHours: null,
    completedFrequency: null,
    completedSchoolDays: null,
    metricsMeasuredThrough: null,
    metricsSource: '',
  };
  try {
    await service._enrichTransferredMetrics({
      schoolId: 'school-1', studentId: 'student-1', recordData: record,
    });
  } finally {
    Attendance.find = originalFind;
    service._resolveEnrollment = originalResolveEnrollment;
  }

  assert.equal(record.completedFrequency, 50);
  assert.equal(record.completedSchoolDays, 2);
  assert.equal(record.completedWorkloadHours, null);
  assert.equal(record.metricsMeasuredThrough.toISOString(), '2026-03-15T12:00:00.000Z');
  assert.equal(record.metricsSource, 'attendance_records');
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
