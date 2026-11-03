// src/api/services/iara/iaraModel.client.js
//
// Cliente unico da Iara para o Gemini: modelo configuravel por .env,
// saida estruturada (responseSchema), prazo maximo por chamada, novas
// tentativas com espera crescente em erros temporarios e fallback de modelo.

const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

class IaraModelError extends Error {
  constructor(message, { statusCode = 502, cause = null } = {}) {
    super(message);
    this.name = 'IaraModelError';
    this.statusCode = statusCode;
    this.cause = cause;
  }
}

function getModelNames() {
  const configured = String(process.env.IARA_MODELS || process.env.IARA_MODEL || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_MODELS;
}

function getTimeoutMs() {
  const value = Number.parseInt(process.env.IARA_TIMEOUT_MS, 10);
  return Number.isFinite(value) && value > 0 ? value : 60000;
}

function getMaxAttempts() {
  const value = Number.parseInt(process.env.IARA_MAX_ATTEMPTS, 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 5) : 2;
}

function isRetryable(error) {
  if (!error) return false;
  if (RETRYABLE_STATUS.has(Number(error.status))) return true;
  if (error.name === 'AbortError' || /abort|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(String(error.message))) return true;
  return error instanceof SyntaxError; // JSON truncado: vale tentar novamente
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultClientFactory() {
  // Carregado sob demanda para que testes nao exijam GEMINI_API_KEY.
  // eslint-disable-next-line global-require
  return require('../../../config/gemini').genAI;
}

/**
 * Executa uma chamada JSON estruturada. Retorna { data, model, usage, attempts }.
 * `parts` aceita texto e anexos ({ inlineData: { mimeType, data } }).
 */
async function generateJson({
  parts,
  systemInstruction,
  responseSchema,
  temperature = 0.7,
  maxOutputTokens = 16384,
  clientFactory = defaultClientFactory,
  sleepFn = sleep,
}) {
  const client = clientFactory();
  const models = getModelNames();
  const attemptsPerModel = getMaxAttempts();
  const timeout = getTimeoutMs();
  let lastError = null;
  let attempts = 0;

  for (const modelName of models) {
    for (let attempt = 1; attempt <= attemptsPerModel; attempt += 1) {
      attempts += 1;
      try {
        const model = client.getGenerativeModel(
          {
            model: modelName,
            systemInstruction,
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema,
              temperature,
              maxOutputTokens,
            },
          },
          { timeout }
        );

        const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
        const text = result.response.text();
        const data = JSON.parse(text);
        return { data, model: modelName, usage: result.response.usageMetadata || null, attempts };
      } catch (error) {
        lastError = error;
        const retryable = isRetryable(error);
        console.warn('[Iara] Falha na chamada ao modelo', {
          model: modelName,
          attempt,
          status: error?.status || null,
          retryable,
          message: String(error?.message || '').slice(0, 300),
        });
        if (!retryable) break; // erro definitivo neste modelo: tenta o proximo
        if (attempt < attemptsPerModel) await sleepFn(800 * 2 ** (attempt - 1));
      }
    }
  }

  const status = Number(lastError?.status);
  if (status === 429) {
    throw new IaraModelError('A Iara esta com muita demanda agora. Tente novamente em alguns instantes.', { statusCode: 503, cause: lastError });
  }
  if (lastError?.name === 'AbortError' || /abort|timeout/i.test(String(lastError?.message))) {
    throw new IaraModelError('A Iara demorou demais para responder. Tente com menos questoes.', { statusCode: 504, cause: lastError });
  }
  throw new IaraModelError('Nao foi possivel falar com a Iara agora. Tente novamente.', { statusCode: 502, cause: lastError });
}

module.exports = { generateJson, IaraModelError, getModelNames, isRetryable };
