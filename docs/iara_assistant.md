# Iara — assistente de provas

Rotas em `/api/gemini-exam` (todas exigem token de professor/equipe; alunos e responsaveis recebem 403).

| Metodo | Rota | Uso |
| --- | --- | --- |
| POST | `/generate` | Gera questoes. JSON ou `multipart/form-data` com arquivo opcional em `attachment` (PDF, PNG, JPG, WEBP ou TXT, ate 10 MB). |
| POST | `/regenerate-question` | Refaz uma questao (`question`) com pedido opcional (`instruction`, ex.: "mais dificil"). |
| POST | `/review` | Revisa a prova: regras automaticas (gabarito, alternativas, pesos, repeticao) + analise pedagogica da Iara (`useAi=false` desliga a IA). |
| POST | `/adapt` | Adapta questoes para alunos com necessidades especificas (`needs`). Itens que a IA nao conseguiu adaptar voltam `null`. |
| POST | `/exams/:examId/recovery` | Analise de desempenho por questao (provas com cartao-resposta corrigidas) + questoes de recuperacao. |

## Campos de `/generate`

- `topic` (ou `sourceText`/anexo), `gradeLevel` obrigatorios; `subject`, `examTitle`.
- `type`: `OBJECTIVE` | `DISSERTATIVE` | `MIXED` (com `objectiveCount` e `dissertativeCount`).
- `count`: 1 a 20.
- `difficulty`: `EASY` | `MEDIUM` | `HARD` | `MIXED`.
- `objectiveStyle`: `STANDARD` | `TRUE_FALSE` | `ASSOCIATION` | `FILL_BLANK` | `ORDERING` | `MIXED` (todas continuam com alternativas A-E, compativeis com o cartao-resposta).
- `questionStyle`: `DIRECT` | `CONTEXTUALIZED` (texto-base estilo ENEM/SAEB).
- `includeBncc`, `includeExplanations` (padrao `true`).
- `avoidQuestions`: enunciados ja existentes na prova. Com `classId` + `subjectId`, o servidor tambem evita questoes das ultimas provas da turma/disciplina.

Resposta: `data` continua sendo a lista de questoes (compativel com versoes antigas do app), com `warnings`, `meta` e `quota`.

## Garantias aplicadas no servidor

- Saida estruturada (`responseSchema`) e validacao de cada questao: 5 alternativas preenchidas e distintas, gabarito valido, enunciado preenchido, codigo BNCC em formato valido. Itens invalidos ou repetidos sao descartados.
- O gabarito e redistribuido entre A-E (evita a tendencia do modelo de repetir a mesma letra).
- Texto do professor vai em blocos delimitados; as regras ficam na instrucao de sistema.
- Erros tecnicos ficam so no log; o app recebe mensagens amigaveis.

## Variaveis de ambiente

| Variavel | Padrao | Descricao |
| --- | --- | --- |
| `IARA_MODELS` | `gemini-2.5-flash,gemini-2.5-flash-lite` | Modelos em ordem de preferencia (fallback). |
| `IARA_TIMEOUT_MS` | `60000` | Prazo maximo por chamada. |
| `IARA_MAX_ATTEMPTS` | `2` | Tentativas por modelo em erros temporarios (429/5xx/timeout). |
| `IARA_RATE_LIMIT_PER_MINUTE` | `6` | Limite por usuario por minuto (em memoria, por instancia). |
| `IARA_DAILY_QUOTA` | `80` | Usos por usuario por dia (contados em `IaraUsageLog`). `0` desliga. |

## Uso e custo

Cada chamada gera um `IaraUsageLog` (escola, usuario, acao, modelo, tokens, duracao, questoes pedidas/devolvidas/descartadas). Os registros expiram em 180 dias.

Testes: `node --test src/tests/services/iara.service.test.js`.
