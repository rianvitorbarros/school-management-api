# Rematrícula

## Fluxo

O responsável consulta `GET /api/guardian/re-enrollments/eligibility` e envia a solicitação por `POST /api/guardian/re-enrollments`. A API valida o vínculo do responsável, uma matrícula ativa no ano de origem, a progressão acadêmica e pendências financeiras vencidas. A solicitação preserva snapshots de aluno, responsável e turma.

`ReEnrollmentPeriod` define anos consecutivos, janela de datas e status `DRAFT`, `OPEN` ou `CLOSED`. A escola só pode manter um período `OPEN` por ano letivo de destino. `createdBy`, `updatedBy` e timestamps registram a operação administrativa.

`AcademicProgression` representa série para série, sempre no contexto da escola e do nível. Os valores de `level` e `grade` seguem o catálogo atualmente usado por `Class`; não representam turma concreta. Uma regra `TERMINAL` registra explicitamente a última série de um ciclo sem inventar série de destino.

## Administração

- `GET/POST /api/re-enrollment-periods`
- `GET/PATCH /api/re-enrollment-periods/:id`
- `POST /api/re-enrollment-periods/:id/activate`
- `POST /api/re-enrollment-periods/:id/close`
- `GET/POST/PATCH /api/academic-progressions`
- `POST /api/academic-progressions/:id/deactivate`
- `GET /api/admin/re-enrollment/readiness`

As rotas administrativas usam o token da escola; `school_id` nunca é recebido do cliente. O diagnóstico retorna contagens de configuração e de matrículas ativas sem expor nomes de alunos.

## Aprovação, finanças e notificações

Pendências financeiras vencidas e não pagas/canceladas bloqueiam a solicitação e a aprovação. Ao aprovar com turma de destino válida, cria-se a `Enrollment` do ano seguinte. Sem turma de destino, a solicitação é aprovada **sem** criar matrícula; nenhuma turma é criada automaticamente e a matrícula atual não é alterada.

Os eventos `re_enrollment:created`, `re_enrollment:approved` e `re_enrollment:rejected` geram notificações para equipe ou responsável. O script `src/scripts/configureReEnrollment.js` continua apenas como apoio/auditoria; a configuração operacional é feita pela interface administrativa.

## Aprovação e efetivação da matrícula

`APPROVED` continua significando que a escola aprovou a solicitação. A matrícula é identificada separadamente por `approvalEnrollmentId`: ausente, a solicitação aguarda definição de turma; presente, a matrícula do próximo ano está efetivada. `enrollmentCreatedAt` e `enrollmentCreatedBy` registram a operação.

`POST /api/re-enrollment-requests/:id/effectivate` recebe `targetClassId` para concluir uma solicitação aprovada que aguardava turma. A mesma rotina interna usada na aprovação com turma valida escola, ano, nível, série e matrícula existente. Não há nova regra financeira nessa etapa: a política financeira é validada ao solicitar e revalidada ao aprovar.
