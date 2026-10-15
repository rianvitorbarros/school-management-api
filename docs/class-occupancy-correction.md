# Correção do planejamento de ocupação

## Proposta de dados (antes da publicação)

RegistrationRequest não contém ano de destino nem vínculo persistido com o aluno criado na aprovação. Adicionar campos opcionais `academicYearTo` (1900–2200), `approvedStudentId` e `selectedClassSnapshot.schoolYear`. Novos pedidos do formulário informam o ano explicitamente; pedidos com turma selecionada usam o ano real dessa turma. Uma escolha explícita conflitante é rejeitada. Aprovações futuras registram o aluno criado. Não haverá backfill, atualização de registros históricos, migração nem criação de turmas ou matrículas de planejamento. Clientes antigos continuam compatíveis; pedidos sem destino comprovável serão diagnosticados e excluídos das contagens por ano.

Turmas projetadas existem apenas na resposta do painel, com ID derivado do ano e da turma de referência. Configurações efetivas têm precedência; a estrutura do último ano anterior disponível complementa apenas turmas ausentes. Matrículas são consultadas exclusivamente no ano de destino. Demanda sem turma explícita permanece separada.

CPF e nome normalizado + data de nascimento seguem os utilitários de identidade existentes. Correspondências ambíguas não são atribuídas. Matrícula do ano de destino prevalece sobre pedidos históricos. Aprovação sem matrícula permanece categoria própria e participa da projeção somente se tiver turma resolvida.

## Diagnóstico e validação

- A consulta anterior exigia `Class.schoolYear === anoSelecionado`; sem configuração própria de 2027 retornava zero turmas. Agora a estrutura do último ano anterior complementa apenas as turmas ausentes. Identidade estrutural acompanha o índice de Class: escola, nome, ano e turno. Uma configuração cancelada de destino não é ressuscitada.
- O contador anterior `approvedWithoutEnrollment` consultava exclusivamente ReEnrollmentRequest APPROVED da escola autenticada e do ano solicitado. A aprovação sem targetClassId é permitida pelo fluxo existente e não gera Enrollment; portanto não constitui, por si só, erro cadastral. O código anterior descartava toda essa categoria antes da projeção. Ela agora fica separada, distribuída ou aguardando distribuição, e jamais vira confirmação por mudança de status artificial.
- `Enrollment.Ativa` confirma; `Pendente` continua aguardando efetivação. Vínculos encerrados/transferidos/inativos suprimem pedidos antigos. Não alteramos aprovação, efetivação nem a regra financeira.
- GET `/api/classes/occupancy?academicYear=...` mantém os totais sem dados pessoais, acrescenta metadados de referência, split Web/rematrícula e resumo sem distribuição. GET `/api/classes/occupancy/:classId/students` acrescenta `approved`; o valor reservado `unallocated` retorna demanda sem turma com as mesmas permissões e isolamento. Nenhum endpoint paralelo.
- 48 testes essenciais aprovados. Suíte ampliada sem OMR e sem o teste de release que depende de GEMINI_API_KEY: 341 aprovados antes do último caso de matrícula Pendente, validado em seguida nos 48 essenciais. Análise sintática Node aprovada. Não repetimos testes externos cujas limitações de Python/Gemini já constam na entrega anterior.
- Consulta autenticada real disponível: **Colégio Batista**, ID `6abe466df1583ec667d0e01e`: 18 turmas de 2026, nenhuma com capacidade definida; nenhuma rematrícula de 2027; 10 solicitações Web PENDING, todas com selectedClassId de 2026, sem ano explícito/snapshot. Elas não devem entrar em 2027. Nenhum dado real foi modificado.
- As cinco capturas citadas na solicitação não vieram anexadas; a escola dos 44 aprovados/quatro pendentes ainda não foi identificada. Não afirmamos ter auditado individualmente esses registros. A origem do contador foi identificada no código; a investigação individual depende da escola/acesso correspondente.
