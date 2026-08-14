# Contrato da API de Histórico Escolar

## Compatibilidade do registro anual

Os registros continuam embutidos em `Student.academicHistory`. A ampliação é aditiva e não exige migração para leitura:

- snapshot: `schoolName`, `inepCode`, `city`, `state`;
- vínculo opcional: `enrollmentId`, `classId`;
- totais: `annualWorkload`, `annualFrequency`, `schoolDays`;
- encerramento: `finalResult`, `observations`, `approvalCriterion`;
- rastreabilidade: `origin`, `gradingFormulaSnapshot`, `createdByUserId`, `updatedByUserId`, timestamps;
- disciplinas: `subjectId`, `historicalName`, `curriculumCategory`, `finalGrade`, `concept`, `specialStatus`, `workloadHours`, `origin`, além dos campos legados.

Resultados finais centralizados: `Aprovado`, `Reprovado`, `Transferido`, `Em andamento` e `Outro`.

## Endpoints

### `GET /api/students/:studentId/history/context`

Query: `schoolYear`, `enrollmentId` opcional.

Retorna instituição atual, matrícula/turma sugerida, resultados finais suportados e disciplinas curriculares. Prioridade: `CourseLoad` -> `ReportCard` -> `Horario`.

### `POST /api/students/:studentId/history/import-preview`

Body: `schoolYear`, `enrollmentId` opcional.

Retorna bimestres, notas por disciplina, média sugerida somente com quatro bimestres, média mínima, fórmula explícita e alertas.

### `POST /api/students/:studentId/history/import`

Grava o registro revisado com origem `system_import`.

### CRUD legado preservado

- `POST /api/students/:studentId/history`
- `PUT /api/students/:studentId/history/:recordId`
- `DELETE /api/students/:studentId/history/:recordId`

As rotas de escrita exigem `Admin`, `Coordenador` ou `Staff`, sempre no tenant de `req.user.school_id`. Duplicidade por série, ano e instituição retorna HTTP 409.

## Migração

Nenhuma migração de dados é obrigatória nesta versão. Os campos novos possuem defaults compatíveis. Não executar backfill automático em produção; um backfill futuro deve ser idempotente, oferecer simulação e não remover os campos legados.
