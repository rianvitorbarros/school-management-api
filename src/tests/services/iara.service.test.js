const test = require('node:test');
const assert = require('node:assert/strict');

const utils = require('../../api/services/iara/iaraQuestion.utils');
const { GeminiExamService } = require('../../api/services/gemini-exam.service');
const { createIaraRateLimit } = require('../../api/middlewares/iaraRateLimit.middleware');
const { isRetryable } = require('../../api/services/iara/iaraModel.client');

function seededRandom(seed = 42) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function objective(text, correctIndex = 1, options = null) {
  return {
    type: 'OBJECTIVE',
    text,
    options: options || ['Alternativa um', 'Alternativa dois', 'Alternativa tres', 'Alternativa quatro', 'Alternativa cinco'],
    correctIndex,
    difficulty: 'MEDIUM',
  };
}

function createService(responseData, extra = {}) {
  const calls = [];
  const logs = [];
  const service = new GeminiExamService({
    generate: async (args) => {
      calls.push(args);
      return { data: typeof responseData === 'function' ? responseData(args) : responseData, model: 'fake-model', usage: { totalTokenCount: 10 }, attempts: 1 };
    },
    UsageLog: { create: async (entry) => logs.push(entry) },
    loadExamModel: () => ({ find: () => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }) }) }),
    random: seededRandom(),
    ...extra,
  });
  return { service, calls, logs };
}

test('normalizeQuestion converte correctIndex em letra e remove prefixos das alternativas', () => {
  const { question, error } = utils.normalizeQuestion(objective('Qual e a capital do Brasil hoje?', 2, ['A) Rio', 'B) Salvador', 'C) Brasilia', 'D) Recife', 'E) Belem']));
  assert.equal(error, undefined);
  assert.equal(question.correctAnswer, 'C');
  assert.deepEqual(question.options, ['Rio', 'Salvador', 'Brasilia', 'Recife', 'Belem']);
  assert.equal(question.generatedByIara, true);
});

test('normalizeQuestion descarta objetivas sem 5 alternativas, repetidas ou sem gabarito', () => {
  assert.ok(utils.normalizeQuestion({ ...objective('Enunciado valido da questao?'), options: ['a', 'b', 'c'] }).error);
  assert.ok(utils.normalizeQuestion(objective('Enunciado valido da questao?', 0, ['x', 'x', 'y', 'z', 'w'])).error);
  assert.ok(utils.normalizeQuestion({ ...objective('Enunciado valido da questao?'), correctIndex: 9, correctAnswer: 'F' }).error);
  assert.ok(utils.normalizeQuestion({ type: 'OBJECTIVE', text: 'curto' }).error);
});

test('normalizeQuestion aceita dissertativa e limita linhas e codigo BNCC', () => {
  const { question } = utils.normalizeQuestion({ type: 'DISSERTATIVE', text: 'Explique a fotossintese com suas palavras.', linesToLeave: 99, bnccSkill: 'ef07ci07', expectedAnswer: 'Processo...' });
  assert.equal(question.linesToLeave, 30);
  assert.equal(question.bnccSkill, 'EF07CI07');
  assert.equal(question.correctAnswer, null);
  assert.equal(utils.normalizeQuestion({ type: 'DISSERTATIVE', text: 'Explique a fotossintese com suas palavras.', bnccSkill: 'inventado' }).question.bnccSkill, null);
});

test('balanceAnswerKey distribui o gabarito e mantem a alternativa correta', () => {
  const questions = Array.from({ length: 10 }, (_, index) => utils.normalizeQuestion(
    objective(`Questao numero ${index} sobre um tema qualquer?`, 1, [`errada ${index}a`, `CORRETA ${index}`, `errada ${index}b`, `errada ${index}c`, `errada ${index}d`])
  ).question);
  utils.balanceAnswerKey(questions, seededRandom(7));
  const letters = questions.map((question) => question.correctAnswer);
  for (const letter of utils.LETTERS) {
    assert.equal(letters.filter((item) => item === letter).length, 2, `letra ${letter} deveria aparecer 2 vezes`);
  }
  questions.forEach((question, index) => {
    assert.equal(question.options[utils.LETTERS.indexOf(question.correctAnswer)], `CORRETA ${index}`);
  });
});

test('sanitizeGeneratedQuestions remove repetidas e as que ja existem na prova', () => {
  const { questions, discarded } = utils.sanitizeGeneratedQuestions({
    questions: [
      objective('Quais sao os fundamentos do voleibol de quadra?'),
      objective('Quais sao os fundamentos do voleibol de quadra?'),
      objective('Explique a regra do impedimento no futebol de campo?'),
      { type: 'OBJECTIVE', text: 'invalida' },
    ],
  }, { avoidQuestions: ['Explique a regra do impedimento no futebol de campo'], random: seededRandom() });
  assert.equal(questions.length, 1);
  assert.equal(discarded.length, 3);
});

test('parseGenerateRequest valida limites e calcula a mistura de tipos', () => {
  assert.throws(() => utils.parseGenerateRequest({ gradeLevel: '1 ano' }), utils.IaraValidationError);
  assert.throws(() => utils.parseGenerateRequest({ topic: 'Voleibol' }), /gradeLevel/);
  assert.throws(() => utils.parseGenerateRequest({ topic: 'Voleibol', gradeLevel: '1 ano', count: 500 }), /entre 1 e 20/);

  const legacy = utils.parseGenerateRequest({ topic: 'Voleibol', gradeLevel: '1 ano', count: '5', type: 'OBJECTIVE' });
  assert.equal(legacy.count, 5);
  assert.equal(legacy.objectiveCount, 5);
  assert.equal(legacy.difficulty, 'MEDIUM');

  const mixed = utils.parseGenerateRequest({ topic: 'Voleibol', gradeLevel: '1 ano', type: 'MIXED', objectiveCount: 6, dissertativeCount: 2, avoidQuestions: '["a", {"text": "b"}]' });
  assert.equal(mixed.count, 8);
  assert.deepEqual(mixed.avoidQuestions, ['a', 'b']);
});

test('runDeterministicReview aponta gabarito ausente, alternativa vazia, repeticao e soma de pesos', () => {
  const questions = utils.parseExamQuestions([
    { type: 'OBJECTIVE', text: 'Qual esporte usa rede e bola leve?', options: ['Volei', 'Futebol', '', 'Judo', 'Natacao'], correctAnswer: null, weight: 1 },
    { type: 'OBJECTIVE', text: 'Qual esporte usa rede e bola leve?', options: ['Volei', 'Futebol', 'Basquete', 'Judo', 'Natacao'], correctAnswer: 'A', weight: 1 },
    { type: 'DISSERTATIVE', text: 'Explique a importancia do aquecimento.', weight: 2 },
  ]);
  const review = utils.runDeterministicReview(questions, { totalValue: 10, correctionType: 'BUBBLE_SHEET' });
  const categories = review.issues.map((issue) => `${issue.questionIndex}:${issue.category}`);
  assert.ok(categories.includes('0:ALTERNATIVAS'));
  assert.ok(categories.includes('0:GABARITO'));
  assert.ok(categories.includes('1:REPETICAO'));
  assert.ok(categories.includes('null:PESO'));
  assert.ok(categories.includes('null:CORRECAO'));
  assert.equal(review.weightSum, 4);
  assert.equal(review.answerKeyDistribution.A, 1);
});

test('distributeWeights fecha exatamente o valor total', () => {
  const weights = utils.distributeWeights([{ type: 'OBJECTIVE' }, { type: 'OBJECTIVE' }, { type: 'OBJECTIVE' }, { type: 'DISSERTATIVE' }], 10);
  assert.equal(Math.round(weights.reduce((sum, weight) => sum + weight, 0) * 100) / 100, 10);
  assert.equal(weights[0], 2);
  assert.equal(weights[3], 4);
  assert.deepEqual(utils.distributeWeights([], 10), []);
});

test('generateQuestions envia disciplina e material ao modelo, valida a saida e registra o uso', async () => {
  const { service, calls, logs } = createService({
    questions: [
      objective('Qual fundamento do volei e usado para iniciar o rali?'),
      objective('Quantos jogadores cada equipe tem em quadra no volei?'),
      { type: 'OBJECTIVE', text: 'Questao quebrada sem alternativas suficientes', options: ['a'], correctIndex: 0 },
    ],
  });
  const result = await service.generateQuestions(
    { topic: 'Voleibol', subject: 'Ed. Fisica', gradeLevel: '1 ano', count: 3, sourceText: 'Texto da apostila', avoidQuestions: ['Questao ja existente na prova'] },
    { actor: { id: '64b000000000000000000001', school_id: '64b000000000000000000002' } }
  );
  assert.equal(result.questions.length, 2);
  assert.equal(result.meta.discarded, 1);
  assert.equal(result.warnings.length, 1);
  const prompt = calls[0].parts[0].text;
  assert.match(prompt, /Ed\. Fisica/);
  assert.match(prompt, /material_de_apoio/);
  assert.match(prompt, /Questao ja existente na prova/);
  assert.ok(calls[0].responseSchema);
  assert.equal(logs[0].status, 'SUCCESS');
  assert.equal(logs[0].returned, 2);
});

test('generateQuestions recusa anexo de formato invalido sem chamar o modelo', async () => {
  const { service, calls } = createService({ questions: [] });
  await assert.rejects(
    service.generateQuestions({ topic: 'Volei', gradeLevel: '1 ano' }, { attachment: { mimetype: 'application/zip', buffer: Buffer.from('x'), size: 1 } }),
    /Formato de arquivo/
  );
  assert.equal(calls.length, 0);
});

test('generateQuestions devolve 422 e registra erro quando nada e valido', async () => {
  const { service, logs } = createService({ questions: [{ type: 'OBJECTIVE', text: 'x' }] });
  await assert.rejects(service.generateQuestions({ topic: 'Volei', gradeLevel: '1 ano' }), (error) => error.statusCode === 422);
  assert.equal(logs[0].status, 'ERROR');
});

test('regenerateQuestion devolve uma questao diferente da original', async () => {
  const { service, calls } = createService({ questions: [objective('Qual e a altura oficial da rede no volei masculino?')] });
  const result = await service.regenerateQuestion({
    topic: 'Volei',
    gradeLevel: '1 ano',
    instruction: 'mais dificil',
    question: objective('Quantos jogadores ficam em quadra no volei?'),
  });
  assert.match(result.question.text, /altura oficial/);
  assert.match(calls[0].parts[0].text, /mais dificil/);
});

test('reviewExam junta regras automaticas e apontamentos da Iara', async () => {
  const { service } = createService({
    summary: 'Prova adequada.',
    estimatedMinutes: 30,
    issues: [{ questionNumber: 1, severity: 'WARNING', category: 'enunciado', message: 'Enunciado ambiguo.', suggestion: 'Especifique.' }],
  });
  const result = await service.reviewExam({
    totalValue: 5,
    questions: [{ type: 'OBJECTIVE', text: 'Qual esporte usa rede e bola leve?', options: ['Volei', 'Futebol', 'Basquete', 'Judo', 'Natacao'], correctAnswer: 'A', weight: 1 }],
  });
  assert.equal(result.summary, 'Prova adequada.');
  assert.ok(result.issues.some((issue) => issue.source === 'IARA' && issue.questionIndex === 0 && issue.category === 'ENUNCIADO'));
  assert.ok(result.issues.some((issue) => issue.source === 'RULES' && issue.category === 'PESO'));
});

test('reviewExam com useAi=false nao chama o modelo', async () => {
  const { service, calls } = createService({});
  const result = await service.reviewExam({ useAi: false, questions: [{ type: 'DISSERTATIVE', text: 'Explique o aquecimento.', weight: 1 }] });
  assert.equal(calls.length, 0);
  assert.ok(Array.isArray(result.issues));
});

test('adaptQuestions mantem o alinhamento e marca itens invalidos como null', async () => {
  const { service } = createService({
    questions: [
      objective('Qual esporte usa rede? (versao simples)'),
      { type: 'OBJECTIVE', text: 'quebrada' },
    ],
  });
  const result = await service.adaptQuestions({
    questions: [
      { type: 'OBJECTIVE', text: 'Qual esporte usa rede e bola leve?', options: ['a', 'b', 'c', 'd', 'e'], correctAnswer: 'A', weight: 3 },
      { type: 'OBJECTIVE', text: 'Qual esporte usa bola oval no campo?', options: ['a', 'b', 'c', 'd', 'e'], correctAnswer: 'A', weight: 1 },
    ],
  });
  assert.equal(result.questions.length, 2);
  assert.equal(result.questions[0].weight, 3);
  assert.equal(result.questions[1], null);
});

test('buildRecoveryPlan exige dados de correcao por questao', async () => {
  const { service } = createService({}, {
    loadExamService: () => ({ getExamResults: async () => ({ exam: {}, insights: { available: false, questions: [] } }) }),
  });
  await assert.rejects(service.buildRecoveryPlan('64b000000000000000000003'), utils.IaraValidationError);
});

test('buildRecoveryPlan gera analise e questoes de recuperacao', async () => {
  const { service, calls } = createService({
    summary: 'A turma teve dificuldade em regras.',
    weakTopics: ['Regras do volei'],
    recommendations: ['Revisar regras com video'],
    questions: [objective('Em qual situacao ocorre o rodizio de jogadores no volei?')],
  }, {
    loadExamService: () => ({
      getExamResults: async () => ({
        exam: { id: 'e1', title: 'Prova 1', subject: 'Ed. Fisica', className: '1A' },
        insights: { available: true, averageAccuracy: 55, questions: [{ questionNumber: 1, questionText: 'Quantos jogadores?', responses: 20, correctPercentage: 30 }] },
      }),
    }),
  });
  const result = await service.buildRecoveryPlan('e1', { count: 3 });
  assert.equal(result.questions.length, 1);
  assert.deepEqual(result.weakTopics, ['Regras do volei']);
  assert.equal(result.hardestQuestions[0].correctPercentage, 30);
  assert.match(calls[0].parts[0].text, /percentual_de_acerto/);
});

function runMiddleware(middleware, user) {
  return new Promise((resolve) => {
    const res = {
      locals: {},
      statusCode: 200,
      headers: {},
      set(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ blocked: true, statusCode: this.statusCode, body, headers: this.headers }); },
    };
    middleware({ user }, res, () => resolve({ blocked: false, res }));
  });
}

test('iaraRateLimit bloqueia alunos, limita por minuto e aplica cota diaria', async () => {
  let clock = 1_000_000;
  const limiter = createIaraRateLimit({ perMinute: 2, perDay: 0, now: () => clock });
  const teacher = { id: 't1', role: 'professor' };

  assert.equal((await runMiddleware(limiter, { id: 's1', role: 'student' })).statusCode, 403);
  assert.equal((await runMiddleware(limiter, teacher)).blocked, false);
  assert.equal((await runMiddleware(limiter, teacher)).blocked, false);
  const third = await runMiddleware(limiter, teacher);
  assert.equal(third.statusCode, 429);
  assert.ok(Number(third.headers['Retry-After']) > 0);
  clock += 61000;
  assert.equal((await runMiddleware(limiter, teacher)).blocked, false);

  const quota = createIaraRateLimit({ perMinute: 0, perDay: 3, countToday: async () => 3 });
  const blocked = await runMiddleware(quota, teacher);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.code, 'IARA_DAILY_QUOTA');
});

test('isRetryable reconhece erros temporarios', () => {
  assert.equal(isRetryable({ status: 503 }), true);
  assert.equal(isRetryable({ status: 429 }), true);
  assert.equal(isRetryable({ status: 400, message: 'bad request' }), false);
  assert.equal(isRetryable(new SyntaxError('Unexpected end of JSON input')), true);
});
