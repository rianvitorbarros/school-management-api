// src/api/services/iara/iaraQuestion.utils.js
//
// Funcoes puras usadas pela Iara (assistente de provas) para validar, normalizar
// e balancear as questoes geradas pela IA antes de devolve-las ao app.
// Nada aqui chama a IA ou o banco: tudo e testavel isoladamente.

const LETTERS = ['A', 'B', 'C', 'D', 'E'];
const OPTION_COUNT = LETTERS.length;

const QUESTION_TYPES = ['OBJECTIVE', 'DISSERTATIVE'];
const REQUEST_TYPES = ['OBJECTIVE', 'DISSERTATIVE', 'MIXED'];
const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'];
const REQUEST_DIFFICULTIES = [...DIFFICULTIES, 'MIXED'];
const OBJECTIVE_STYLES = ['STANDARD', 'TRUE_FALSE', 'ASSOCIATION', 'FILL_BLANK', 'ORDERING', 'MIXED'];
const QUESTION_STYLES = ['DIRECT', 'CONTEXTUALIZED'];

const LIMITS = Object.freeze({
  minCount: 1,
  maxCount: 20,
  topicMaxLength: 500,
  instructionMaxLength: 500,
  sourceTextMaxLength: 20000,
  avoidQuestionsMax: 60,
  avoidQuestionMaxLength: 300,
  questionTextMaxLength: 4000,
  optionMaxLength: 1000,
  reviewMaxQuestions: 60,
  minLines: 1,
  maxLines: 30,
});

// Codigos BNCC: Ed. Infantil (EI03EO01), Fundamental (EF67EF01) e Medio (EM13LGG101).
const BNCC_PATTERN = /^(EI\d{2}[A-Z]{2}\d{2}|EF\d{2}[A-Z]{2}\d{2}|EM13[A-Z]{3}\d{3})$/;

// Alternativas que deixam de fazer sentido quando a ordem e embaralhada.
const ORDER_DEPENDENT_OPTION = /\b(todas as (alternativas|anteriores|op[cç][oõ]es)|nenhuma das (alternativas|anteriores|op[cç][oõ]es)|alternativas? (a|b|c|d|e) e (a|b|c|d|e))\b/i;

class IaraValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'IaraValidationError';
    this.statusCode = 400;
    this.details = details;
  }
}

function asTrimmedString(value, maxLength = Infinity) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\r\n/g, '\n').trim();
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function pickEnum(value, allowed, fallback) {
  const normalized = asTrimmedString(value).toUpperCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'sim', 'on'].includes(String(value).trim().toLowerCase());
}

function parseJsonField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function normalizeTextForComparison(text) {
  return asTrimmedString(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordSet(text) {
  return new Set(normalizeTextForComparison(text).split(' ').filter((word) => word.length > 2));
}

// Similaridade de Jaccard entre os conjuntos de palavras de dois enunciados.
function textSimilarity(left, right) {
  const a = wordSet(left);
  const b = wordSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function isNearDuplicate(text, others, threshold = 0.8) {
  const normalized = normalizeTextForComparison(text);
  return others.some((other) => {
    if (!other) return false;
    if (normalizeTextForComparison(other) === normalized) return true;
    return textSimilarity(text, other) >= threshold;
  });
}

function stripOptionPrefix(option) {
  // Remove prefixos como "A) ", "b. ", "(C) " que a IA as vezes repete.
  return asTrimmedString(option, LIMITS.optionMaxLength).replace(/^\(?[A-Ea-e][).:\-–]\s+/, '').trim();
}

function resolveCorrectIndex(raw) {
  if (raw.correctIndex !== undefined && raw.correctIndex !== null && raw.correctIndex !== '') {
    const index = Number(raw.correctIndex);
    if (Number.isInteger(index) && index >= 0 && index < OPTION_COUNT) return index;
  }
  const letter = asTrimmedString(raw.correctAnswer).toUpperCase().replace(/[^A-E]/g, '').charAt(0);
  const index = LETTERS.indexOf(letter);
  return index >= 0 ? index : -1;
}

function sanitizeBnccSkill(value) {
  const code = asTrimmedString(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return BNCC_PATTERN.test(code) ? code : null;
}

/**
 * Normaliza uma questao vinda da IA (ou do app) para o formato do banco.
 * Retorna { question } quando valida ou { error } explicando o descarte.
 */
function normalizeQuestion(raw, { defaultDifficulty = null } = {}) {
  if (!raw || typeof raw !== 'object') return { error: 'Item nao e um objeto.' };

  const type = pickEnum(raw.type, QUESTION_TYPES, null);
  if (!type) return { error: `Tipo de questao invalido: ${raw.type}` };

  const text = asTrimmedString(raw.text, LIMITS.questionTextMaxLength);
  if (text.length < 10) return { error: 'Enunciado vazio ou curto demais.' };

  const difficulty = pickEnum(raw.difficulty, DIFFICULTIES, defaultDifficulty);
  const explanation = asTrimmedString(raw.explanation, 2000) || null;
  const bnccSkill = sanitizeBnccSkill(raw.bnccSkill);
  const estimatedMinutes = clampInt(raw.estimatedMinutes, 1, 60, null);

  if (type === 'OBJECTIVE') {
    const options = Array.isArray(raw.options) ? raw.options.map(stripOptionPrefix) : [];
    if (options.length !== OPTION_COUNT || options.some((option) => !option)) {
      return { error: `Questao objetiva precisa de ${OPTION_COUNT} alternativas preenchidas.` };
    }
    const unique = new Set(options.map(normalizeTextForComparison));
    if (unique.size !== OPTION_COUNT) return { error: 'Questao objetiva com alternativas repetidas.' };

    const correctIndex = resolveCorrectIndex(raw);
    if (correctIndex < 0) return { error: 'Questao objetiva sem gabarito valido.' };

    const weight = Number(raw.weight);
    return {
      question: {
        type,
        text,
        options,
        correctAnswer: LETTERS[correctIndex],
        linesToLeave: 0,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
        difficulty,
        explanation,
        expectedAnswer: null,
        bnccSkill,
        estimatedMinutes,
        generatedByIara: true,
      },
    };
  }

  const weight = Number(raw.weight);
  return {
    question: {
      type,
      text,
      options: [],
      correctAnswer: null,
      linesToLeave: clampInt(raw.linesToLeave, LIMITS.minLines, LIMITS.maxLines, 5),
      weight: Number.isFinite(weight) && weight > 0 ? weight : 2,
      difficulty,
      explanation,
      expectedAnswer: asTrimmedString(raw.expectedAnswer, 3000) || null,
      bnccSkill,
      estimatedMinutes,
      generatedByIara: true,
    },
  };
}

function shuffleInPlace(items, random = Math.random) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Reposiciona a alternativa correta de cada questao objetiva para que o
 * gabarito fique distribuido entre A-E (os modelos tendem a repetir a mesma
 * letra). Questoes com alternativas dependentes de ordem ("todas as
 * anteriores") sao mantidas como vieram.
 */
function balanceAnswerKey(questions, random = Math.random) {
  const objective = questions.filter(
    (question) => question.type === 'OBJECTIVE' && !question.options.some((option) => ORDER_DEPENDENT_OPTION.test(option))
  );

  let targets = [];
  for (const question of objective) {
    if (targets.length === 0) targets = shuffleInPlace([...LETTERS], random);
    const target = LETTERS.indexOf(targets.pop());
    const correctIndex = LETTERS.indexOf(question.correctAnswer);
    const correctOption = question.options[correctIndex];
    const distractors = shuffleInPlace(question.options.filter((_, index) => index !== correctIndex), random);
    distractors.splice(target, 0, correctOption);
    question.options = distractors;
    question.correctAnswer = LETTERS[target];
  }
  return questions;
}

/**
 * Valida a lista bruta da IA: normaliza, descarta itens invalidos ou
 * repetidos (entre si e em relacao a `avoidQuestions`) e balanceia o gabarito.
 */
function sanitizeGeneratedQuestions(rawItems, { avoidQuestions = [], expectedType = null, defaultDifficulty = null, random = Math.random, balance = true } = {}) {
  const items = Array.isArray(rawItems)
    ? rawItems
    : Array.isArray(rawItems?.questions)
      ? rawItems.questions
      : [];

  const accepted = [];
  const discarded = [];
  const seenTexts = [...avoidQuestions];

  items.forEach((item, index) => {
    const { question, error } = normalizeQuestion(item, { defaultDifficulty });
    if (error) {
      discarded.push({ index, reason: error });
      return;
    }
    if (expectedType && expectedType !== 'MIXED' && question.type !== expectedType) {
      discarded.push({ index, reason: `Tipo ${question.type} diferente do solicitado (${expectedType}).` });
      return;
    }
    if (isNearDuplicate(question.text, seenTexts)) {
      discarded.push({ index, reason: 'Questao repetida.' });
      return;
    }
    seenTexts.push(question.text);
    accepted.push(question);
  });

  if (balance) balanceAnswerKey(accepted, random);
  return { questions: accepted, discarded };
}

function sanitizeAvoidQuestions(value) {
  const list = parseJsonField(value, []);
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => asTrimmedString(typeof item === 'object' && item ? item.text : item, LIMITS.avoidQuestionMaxLength))
    .filter(Boolean)
    .slice(0, LIMITS.avoidQuestionsMax);
}

/**
 * Valida e normaliza o corpo de POST /generate.
 * Lanca IaraValidationError com mensagem amigavel em portugues.
 */
function parseGenerateRequest(body = {}) {
  const topic = asTrimmedString(body.topic, LIMITS.topicMaxLength);
  const gradeLevel = asTrimmedString(body.gradeLevel, 120);
  const sourceText = asTrimmedString(body.sourceText, LIMITS.sourceTextMaxLength);

  if (!topic && !sourceText) {
    throw new IaraValidationError("Informe o tema das questoes ou um material de apoio.");
  }
  if (!gradeLevel) {
    throw new IaraValidationError("O campo 'gradeLevel' (serie/ano) e obrigatorio.");
  }

  const rawCount = Number.parseInt(body.count, 10);
  if (Number.isFinite(rawCount) && (rawCount < LIMITS.minCount || rawCount > LIMITS.maxCount)) {
    throw new IaraValidationError(`A quantidade deve estar entre ${LIMITS.minCount} e ${LIMITS.maxCount} questoes.`);
  }

  const type = pickEnum(body.type, REQUEST_TYPES, 'OBJECTIVE');
  let count = clampInt(body.count, LIMITS.minCount, LIMITS.maxCount, 5);
  let objectiveCount = type === 'OBJECTIVE' ? count : 0;
  let dissertativeCount = type === 'DISSERTATIVE' ? count : 0;

  if (type === 'MIXED') {
    const objective = clampInt(body.objectiveCount, 0, LIMITS.maxCount, null);
    const dissertative = clampInt(body.dissertativeCount, 0, LIMITS.maxCount, null);
    if (objective === null && dissertative === null) {
      dissertativeCount = Math.max(1, Math.round(count * 0.3));
      objectiveCount = Math.max(0, count - dissertativeCount);
    } else {
      objectiveCount = objective ?? Math.max(0, count - (dissertative ?? 0));
      dissertativeCount = dissertative ?? Math.max(0, count - objectiveCount);
    }
    count = objectiveCount + dissertativeCount;
    if (count < LIMITS.minCount || count > LIMITS.maxCount) {
      throw new IaraValidationError(`A soma de objetivas e dissertativas deve ficar entre ${LIMITS.minCount} e ${LIMITS.maxCount}.`);
    }
  }

  return {
    topic,
    subject: asTrimmedString(body.subject, 120) || null,
    gradeLevel,
    examTitle: asTrimmedString(body.examTitle, 200) || null,
    type,
    count,
    objectiveCount,
    dissertativeCount,
    difficulty: pickEnum(body.difficulty, REQUEST_DIFFICULTIES, 'MEDIUM'),
    objectiveStyle: pickEnum(body.objectiveStyle, OBJECTIVE_STYLES, 'STANDARD'),
    questionStyle: pickEnum(body.questionStyle, QUESTION_STYLES, 'DIRECT'),
    includeBncc: toBoolean(body.includeBncc, true),
    includeExplanations: toBoolean(body.includeExplanations, true),
    sourceText: sourceText || null,
    avoidQuestions: sanitizeAvoidQuestions(body.avoidQuestions),
    classId: asTrimmedString(body.classId, 64) || null,
    subjectId: asTrimmedString(body.subjectId, 64) || null,
    examId: asTrimmedString(body.examId, 64) || null,
  };
}

function parseRegenerateRequest(body = {}) {
  const base = parseGenerateRequest({ ...body, count: 1, type: undefined });
  const { question, error } = normalizeQuestion(parseJsonField(body.question, null));
  if (error) throw new IaraValidationError(`Questao original invalida: ${error}`);
  return {
    ...base,
    type: question.type,
    count: 1,
    objectiveCount: question.type === 'OBJECTIVE' ? 1 : 0,
    dissertativeCount: question.type === 'DISSERTATIVE' ? 1 : 0,
    difficulty: pickEnum(body.difficulty, DIFFICULTIES, question.difficulty || base.difficulty),
    question,
    instruction: asTrimmedString(body.instruction, LIMITS.instructionMaxLength) || null,
  };
}

/** Normaliza questoes enviadas pelo app (revisao/adaptacao) sem descartar indices. */
function parseExamQuestions(value, { max = LIMITS.reviewMaxQuestions } = {}) {
  const list = parseJsonField(value, null);
  if (!Array.isArray(list) || list.length === 0) {
    throw new IaraValidationError('Envie ao menos uma questao.');
  }
  if (list.length > max) {
    throw new IaraValidationError(`Envie no maximo ${max} questoes por vez.`);
  }
  return list.map((item, index) => {
    const raw = item && typeof item === 'object' ? item : {};
    const type = pickEnum(raw.type, QUESTION_TYPES, 'DISSERTATIVE');
    return {
      index,
      type,
      text: asTrimmedString(raw.text, LIMITS.questionTextMaxLength),
      options: type === 'OBJECTIVE' && Array.isArray(raw.options)
        ? raw.options.map((option) => asTrimmedString(option, LIMITS.optionMaxLength))
        : [],
      correctAnswer: type === 'OBJECTIVE' ? (asTrimmedString(raw.correctAnswer).toUpperCase() || null) : null,
      linesToLeave: clampInt(raw.linesToLeave, 0, LIMITS.maxLines, 5),
      weight: Number.isFinite(Number(raw.weight)) ? Number(raw.weight) : 0,
      hasImage: Boolean(raw.image && raw.image.url),
    };
  });
}

/**
 * Checagens deterministicas da revisao de prova (nao dependem da IA).
 */
function runDeterministicReview(questions, { totalValue = null, correctionType = null } = {}) {
  const issues = [];
  const push = (questionIndex, severity, category, message, suggestion = null) =>
    issues.push({ questionIndex, severity, category, message, suggestion, source: 'RULES' });

  const answerKeyDistribution = Object.fromEntries(LETTERS.map((letter) => [letter, 0]));
  let objectiveCount = 0;

  questions.forEach((question) => {
    const { index } = question;
    if (question.text.length < 10) {
      push(index, 'ERROR', 'ENUNCIADO', 'Enunciado vazio ou muito curto.', 'Escreva o comando completo da questao.');
    }
    if (question.weight <= 0) {
      push(index, 'WARNING', 'PESO', 'Questao sem peso definido.', 'Defina um peso maior que zero.');
    }

    if (question.type === 'OBJECTIVE') {
      objectiveCount += 1;
      const filled = question.options.filter(Boolean);
      if (filled.length < question.options.length || question.options.length < 2) {
        push(index, 'ERROR', 'ALTERNATIVAS', 'Ha alternativas em branco.', 'Preencha todas as alternativas ou remova as vazias.');
      }
      const normalized = filled.map(normalizeTextForComparison);
      if (new Set(normalized).size !== normalized.length) {
        push(index, 'ERROR', 'ALTERNATIVAS', 'Ha alternativas repetidas.', 'Reescreva as alternativas iguais.');
      }
      const correctIndex = LETTERS.indexOf(question.correctAnswer || '');
      if (correctIndex < 0 || correctIndex >= question.options.length) {
        push(index, 'ERROR', 'GABARITO', 'Questao sem gabarito definido.', 'Marque a alternativa correta.');
      } else {
        answerKeyDistribution[LETTERS[correctIndex]] += 1;
      }
      if (filled.some((option) => ORDER_DEPENDENT_OPTION.test(option))) {
        push(index, 'INFO', 'ALTERNATIVAS', 'Alternativa do tipo "todas/nenhuma das anteriores".', 'Esse tipo de alternativa costuma facilitar o chute; prefira distratores plausiveis.');
      }
      const lengths = filled.map((option) => option.length);
      if (correctIndex >= 0 && lengths.length === OPTION_COUNT) {
        const longest = Math.max(...lengths);
        const second = [...lengths].sort((a, b) => b - a)[1];
        if (lengths[correctIndex] === longest && longest > second * 1.6) {
          push(index, 'WARNING', 'ALTERNATIVAS', 'A alternativa correta e bem mais longa que as outras.', 'Equilibre o tamanho das alternativas para nao entregar a resposta.');
        }
      }
    }
  });

  const texts = questions.map((question) => question.text);
  texts.forEach((text, index) => {
    if (!text) return;
    const duplicateOf = texts.findIndex((other, otherIndex) => otherIndex < index && other && isNearDuplicate(text, [other]));
    if (duplicateOf >= 0) {
      push(index, 'WARNING', 'REPETICAO', `Questao muito parecida com a questao ${duplicateOf + 1}.`, 'Troque uma das duas por outra abordagem do conteudo.');
    }
  });

  if (objectiveCount >= 5) {
    const counts = Object.values(answerKeyDistribution);
    const maxShare = Math.max(...counts) / objectiveCount;
    const unused = counts.filter((count) => count === 0).length;
    if (maxShare >= 0.5 || unused >= 2) {
      push(null, 'WARNING', 'GABARITO', 'O gabarito esta concentrado em poucas letras.', 'Distribua as respostas corretas entre A, B, C, D e E.');
    }
  }

  const weightSum = Math.round(questions.reduce((sum, question) => sum + Math.max(0, question.weight), 0) * 100) / 100;
  const total = Number(totalValue);
  if (Number.isFinite(total) && total > 0 && Math.abs(weightSum - total) > 0.009) {
    push(null, 'WARNING', 'PESO', `A soma dos pesos (${weightSum}) e diferente do valor total da prova (${total}).`, 'Use "Distribuir pesos" para ajustar automaticamente.');
  }
  if (correctionType === 'BUBBLE_SHEET' && questions.some((question) => question.type === 'DISSERTATIVE')) {
    push(null, 'INFO', 'CORRECAO', 'Prova com cartao-resposta possui questoes dissertativas.', 'As dissertativas precisarao de correcao manual.');
  }

  return { issues, answerKeyDistribution, weightSum, objectiveCount };
}

/**
 * Distribui o valor total entre as questoes (dissertativas valem
 * `dissertativeFactor` vezes uma objetiva), arredondando em 0,1 e ajustando o
 * residuo na ultima questao para fechar o total exato.
 */
function distributeWeights(questions, totalValue, { dissertativeFactor = 2, step = 0.1 } = {}) {
  const total = Number(totalValue);
  if (!Array.isArray(questions) || questions.length === 0 || !Number.isFinite(total) || total <= 0) return [];
  const units = questions.map((question) => (question.type === 'DISSERTATIVE' ? dissertativeFactor : 1));
  const unitSum = units.reduce((sum, unit) => sum + unit, 0);
  const precision = Math.round(1 / step);
  const weights = units.map((unit) => Math.floor((total * unit / unitSum) * precision) / precision);
  const assigned = weights.reduce((sum, weight) => sum + weight, 0);
  weights[weights.length - 1] = Math.round((weights[weights.length - 1] + (total - assigned)) * 100) / 100;
  return weights;
}

module.exports = {
  LETTERS,
  LIMITS,
  DIFFICULTIES,
  REQUEST_TYPES,
  OBJECTIVE_STYLES,
  IaraValidationError,
  asTrimmedString,
  normalizeQuestion,
  sanitizeGeneratedQuestions,
  balanceAnswerKey,
  parseGenerateRequest,
  parseRegenerateRequest,
  parseExamQuestions,
  runDeterministicReview,
  distributeWeights,
  textSimilarity,
  isNearDuplicate,
  toBoolean,
  parseJsonField,
};
