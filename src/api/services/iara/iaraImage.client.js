// src/api/services/iara/iaraImage.client.js
//
// Geracao de imagens da Iara (modelo de imagem do Gemini) para o editor de
// atividades. Usa a API REST diretamente (o SDK @google/generative-ai em uso
// no projeto foi descontinuado e nao expoe a saida de imagem).
//
// Configuracao por .env:
//   IARA_IMAGE_PROVIDER   'gemini' (padrao, API do Google AI Studio) ou 'vertex'
//                         (Agent Platform / Vertex AI, cobrada na conta de
//                         faturamento do Google Cloud — onde caem os creditos
//                         do Google Developer Program)
//   GEMINI_API_KEY        chave ja usada pela Iara (provedor 'gemini')
//   VERTEX_API_KEY        chave da Agent Platform (provedor 'vertex'; se vazia,
//                         usa GEMINI_API_KEY)
//   VERTEX_PROJECT_ID     opcional: projeto do Google Cloud (modo com projeto)
//   VERTEX_LOCATION       opcional: regiao (padrao 'global')
//   IARA_IMAGE_MODELS     lista separada por virgula (padrao: gemini-2.5-flash-image)
//   IARA_IMAGE_TIMEOUT_MS prazo por chamada (padrao: 90000)

const axios = require('axios');

const DEFAULT_IMAGE_MODELS = ['gemini-2.5-flash-image', 'gemini-3.1-flash-image'];
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const VERTEX_BASE = 'https://aiplatform.googleapis.com/v1';

function getProvider() {
  return String(process.env.IARA_IMAGE_PROVIDER || 'gemini').trim().toLowerCase() === 'vertex'
    ? 'vertex'
    : 'gemini';
}

function getApiKey(provider = getProvider()) {
  if (provider === 'vertex') return process.env.VERTEX_API_KEY || process.env.GEMINI_API_KEY;
  return process.env.GEMINI_API_KEY;
}

/** URL do generateContent para o provedor configurado. */
function buildEndpoint(model, provider = getProvider()) {
  const encoded = encodeURIComponent(model);
  if (provider !== 'vertex') return `${API_BASE}/${encoded}:generateContent`;
  const project = String(process.env.VERTEX_PROJECT_ID || '').trim();
  const location = String(process.env.VERTEX_LOCATION || 'global').trim() || 'global';
  if (project) {
    return `${VERTEX_BASE}/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}`
      + `/publishers/google/models/${encoded}:generateContent`;
  }
  return `${VERTEX_BASE}/publishers/google/models/${encoded}:generateContent`;
}
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

class IaraImageError extends Error {
  constructor(message, { statusCode = 502, code = 'IARA_IMAGE_ERROR', cause = null } = {}) {
    super(message);
    this.name = 'IaraImageError';
    this.status = statusCode;
    this.statusCode = statusCode;
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Estilos oferecidos ao professor. O texto do professor entra em `{subject}`;
 * o restante garante um resultado imprimivel e adequado para criancas.
 */
const IMAGE_STYLES = {
  lineart: {
    label: 'Para colorir',
    kind: 'lineart',
    prompt:
      'A black and white coloring page line drawing for young children (ages 3 to 6) of: {subject}. '
      + 'Thick, clean, closed black outlines on a pure white background. No shading, no gray tones, '
      + 'no color fill, no hatching, no text, no letters, no numbers, no border or frame. '
      + 'Simple, friendly, cute shapes with large areas to color. Single subject centered with margin around it.',
  },
  color: {
    label: 'Colorido',
    kind: 'color',
    prompt:
      'A simple, cute cartoon illustration for preschool children of: {subject}. '
      + 'Flat bright colors, thick dark outlines, plain pure white background, no shadows on the background, '
      + 'no text, no letters, no numbers, no border or frame. Single subject centered with margin around it.',
  },
  icon: {
    label: 'Ícone para contagem',
    kind: 'icon',
    prompt:
      'A very simple small icon-style drawing of a single {subject}, for counting exercises in a preschool worksheet. '
      + 'Thick black outline, flat simple colors, pure white background, no text, no letters, no numbers, '
      + 'no extra objects, no frame. One object only, centered, filling most of the canvas.',
  },
};

function getImageModelNames() {
  const configured = String(process.env.IARA_IMAGE_MODELS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_IMAGE_MODELS;
}

function getTimeoutMs() {
  const value = Number.parseInt(process.env.IARA_IMAGE_TIMEOUT_MS, 10);
  return Number.isFinite(value) && value > 0 ? value : 90000;
}

function buildPrompt(subject, style) {
  const definition = IMAGE_STYLES[style] || IMAGE_STYLES.lineart;
  return definition.prompt.replace('{subject}', subject);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Problema de faturamento do projeto (nao adianta repetir):
 * - 402: creditos pre-pagos esgotados;
 * - 429 por cota ZERADA (projeto no plano gratuito, sem faturamento): os modelos
 * de imagem do Gemini nao tem cota gratuita, entao tentar de novo ou trocar de
 * modelo nao adianta. Diferente de um 429 por excesso momentaneo de pedidos.
 */
function isPermissionError(error) {
  const status = Number(error?.response?.status || error?.status);
  return status === 403
    && /PERMISSION_DENIED|has not been used|is disabled|aiplatform\.endpoints\.predict/i.test(
      `${error?.response?.data?.error?.status || ''} ${error?.response?.data?.error?.message || ''}`
    );
}

function isBillingQuotaError(error) {
  const status = Number(error?.response?.status || error?.status);
  const message = String(error?.response?.data?.error?.message || error?.message || '');
  // 402: faturamento pre-pago com creditos esgotados.
  if (status === 402 || /credits are depleted|prepayment/i.test(message)) return true;
  if (status !== 429) return false;
  return /limit:\s*0\b/.test(message) || /free_tier/i.test(message) || /billing/i.test(message);
}

/**
 * Gera UMA imagem. Retorna { buffer, mimeType, model }.
 * `parts` extras (ex.: imagem de referencia) podem ser enviados para a
 * entrega de "trazer elemento de um print".
 */
async function generateImage({
  prompt,
  extraParts = [],
  aspectRatio = '1:1',
  httpClient = axios,
  provider = getProvider(),
  apiKey = getApiKey(provider),
  sleepFn = sleep,
}) {
  if (!apiKey) {
    throw new IaraImageError(
      'A geracao de imagens da Iara nao esta configurada neste servidor.',
      { statusCode: 503, code: 'IARA_IMAGE_NOT_CONFIGURED' }
    );
  }

  const models = getImageModelNames();
  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await httpClient.post(
          buildEndpoint(model, provider),
          {
            contents: [{ role: 'user', parts: [...extraParts, { text: prompt }] }],
            generationConfig: {
              responseModalities: ['IMAGE'],
              imageConfig: { aspectRatio },
            },
          },
          {
            headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
            timeout: getTimeoutMs(),
            maxBodyLength: 30 * 1024 * 1024,
            maxContentLength: 30 * 1024 * 1024,
          }
        );

        const candidate = response?.data?.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const imagePart = parts.find((part) => part?.inlineData?.data || part?.inline_data?.data);
        if (!imagePart) {
          const blocked = response?.data?.promptFeedback?.blockReason
            || (candidate?.finishReason && candidate.finishReason !== 'STOP' ? candidate.finishReason : null);
          if (blocked) {
            throw new IaraImageError(
              'A Iara nao pode gerar essa imagem. Tente descrever de outro jeito.',
              { statusCode: 422, code: 'IARA_IMAGE_BLOCKED' }
            );
          }
          throw new IaraImageError('A Iara nao retornou imagem.', { statusCode: 502, code: 'IARA_IMAGE_EMPTY' });
        }
        const inline = imagePart.inlineData || imagePart.inline_data;
        return {
          buffer: Buffer.from(inline.data, 'base64'),
          mimeType: inline.mimeType || inline.mime_type || 'image/png',
          model,
        };
      } catch (error) {
        if (error instanceof IaraImageError && error.code === 'IARA_IMAGE_BLOCKED') throw error;
        if (isPermissionError(error)) {
          console.error(
            '[Iara imagem] A chave nao tem permissao para usar o modelo de imagem '
            + `(${provider}). Na Agent Platform/Vertex AI, vincule a chave a uma conta de servico `
            + 'com o papel "Vertex AI User" e confira as restricoes de API da chave.',
            { model, message: String(error?.response?.data?.error?.message || '').slice(0, 200) }
          );
          throw new IaraImageError(
            'A geracao de imagens da Iara ainda nao esta liberada para esta escola. '
            + 'Avise o suporte do AcademyHub.',
            { statusCode: 503, code: 'IARA_IMAGE_NOT_AUTHORIZED', cause: error }
          );
        }
        if (isBillingQuotaError(error)) {
          console.error(
            '[Iara imagem] O projeto da GEMINI_API_KEY esta sem cota ou sem creditos para gerar imagens '
            + '(plano gratuito ou creditos pre-pagos esgotados). Verifique o faturamento em https://ai.studio/projects.',
            { model }
          );
          throw new IaraImageError(
            'A geracao de imagens da Iara ainda nao esta liberada para esta escola. '
            + 'Avise o suporte do AcademyHub.',
            { statusCode: 503, code: 'IARA_IMAGE_BILLING_REQUIRED', cause: error }
          );
        }
        lastError = error;
        const status = Number(error?.response?.status || error?.status);
        const retryable = RETRYABLE_STATUS.has(status)
          || /timeout|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String(error?.message || ''));
        console.warn('[Iara imagem] Falha na chamada ao modelo', {
          model,
          attempt,
          status: status || null,
          retryable,
          message: String(error?.response?.data?.error?.message || error?.message || '').slice(0, 300),
        });
        if (!retryable) break;
        if (attempt < 2) await sleepFn(1000 * attempt);
      }
    }
  }

  const status = Number(lastError?.response?.status || lastError?.status);
  if (status === 429) {
    throw new IaraImageError(
      'A Iara esta com muita demanda agora. Tente novamente em alguns instantes.',
      { statusCode: 503, code: 'IARA_IMAGE_BUSY', cause: lastError }
    );
  }
  if (lastError instanceof IaraImageError) throw lastError;
  throw new IaraImageError(
    'Nao foi possivel gerar a imagem agora. Tente novamente.',
    { statusCode: 502, code: 'IARA_IMAGE_FAILED', cause: lastError }
  );
}

module.exports = {
  generateImage,
  buildPrompt,
  getImageModelNames,
  IMAGE_STYLES,
  IaraImageError,
  isBillingQuotaError,
  isPermissionError,
  buildEndpoint,
  getProvider,
};
