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
//   IARA_IMAGE_API_KEY    chave EXCLUSIVA para gerar imagens (recomendado). Fica
//                         separada da GEMINI_API_KEY, usada pela Iara de texto,
//                         para que cada uma tenha seu projeto/saldo/limites.
//   GEMINI_API_KEY        usada para imagens apenas se IARA_IMAGE_API_KEY estiver vazia
//   VERTEX_API_KEY        chave da Agent Platform (provedor 'vertex'; se vazia,
//                         usa IARA_IMAGE_API_KEY e depois GEMINI_API_KEY)
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

function clean(value) {
  return String(value || '').trim();
}

/** Chave usada para gerar imagens (nunca exposta em respostas ou logs). */
function getApiKey(provider = getProvider()) {
  const imageKey = clean(process.env.IARA_IMAGE_API_KEY);
  const geminiKey = clean(process.env.GEMINI_API_KEY);
  if (provider === 'vertex') return clean(process.env.VERTEX_API_KEY) || imageKey || geminiKey;
  return imageKey || geminiKey;
}

/** Nome da variável de onde veio a chave (para mensagens de log). */
function getApiKeySource(provider = getProvider()) {
  if (provider === 'vertex' && clean(process.env.VERTEX_API_KEY)) return 'VERTEX_API_KEY';
  if (clean(process.env.IARA_IMAGE_API_KEY)) return 'IARA_IMAGE_API_KEY';
  return 'GEMINI_API_KEY';
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

/**
 * Resumo seguro de um erro HTTP: SO status e mensagem. Nunca guarda o objeto
 * do axios, que carrega a requisicao inteira (inclusive o cabecalho com a
 * chave da API) e acabaria impresso nos logs.
 */
function safeCause(error) {
  if (!error) return null;
  if (error instanceof IaraImageError) return error.cause;
  return {
    status: Number(error?.response?.status || error?.status) || null,
    apiStatus: error?.response?.data?.error?.status || null,
    message: String(error?.response?.data?.error?.message || error?.message || '').slice(0, 300),
  };
}

class IaraImageError extends Error {
  constructor(message, { statusCode = 502, code = 'IARA_IMAGE_ERROR', cause = null } = {}) {
    super(message);
    this.name = 'IaraImageError';
    this.status = statusCode;
    this.statusCode = statusCode;
    this.code = code;
    this.cause = safeCause(cause);
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
      + 'Very thick, bold, clean, closed black outlines (like a thick marker, uniform line width) on a pure white background. No shading, no gray tones, '
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

/**
 * Fundo das imagens coloridas:
 * - 'transparent' (padrao): so o desenho, sobre branco liso — o servidor
 *   remove esse branco depois e a imagem fica sem fundo;
 * - 'scene': com um cenario simples ocupando a imagem toda.
 */
const BACKGROUNDS = ['transparent', 'scene'];

function normalizeBackground(value) {
  return BACKGROUNDS.includes(value) ? value : 'transparent';
}

const COLOR_SCENE_PROMPT =
  'A simple, cute cartoon illustration for preschool children of: {subject}. '
  + 'Flat bright colors, thick dark outlines, with a simple, soft, colorful background scene that fits the subject '
  + '(for example sky, grass, a room or a classroom). The scene is full-bleed: it reaches all four edges of the '
  + 'image, with no rounded corners, no card, no frame, no border and no white margin around it. '
  + 'No text, no letters, no numbers.';

function buildPrompt(subject, style, { background } = {}) {
  if (style === 'color' && normalizeBackground(background) === 'scene') {
    return COLOR_SCENE_PROMPT.replace('{subject}', subject);
  }
  const definition = IMAGE_STYLES[style] || IMAGE_STYLES.lineart;
  const prompt = definition.prompt.replace('{subject}', subject);
  return style === 'color'
    ? `${prompt} The subject is isolated: no ground, no scenery, no cast shadow.`
    : prompt;
}

/**
 * Pedido para recriar o desenho de uma imagem de referencia (print de livro,
 * foto de atividade, PDF escaneado). Tudo que nao e ilustracao sai: o
 * cabecalho da folha (escola, aluno, QR) e colocado pelo proprio AcademyHub.
 */
const REFERENCE_STYLE_PROMPTS = {
  lineart:
    'Render it as a black and white coloring page for young children: very thick, bold, clean, closed black outlines '
    + '(uniform line width) on a pure white background. No shading, no gray tones, no color fill, no hatching.',
  color:
    'Render it as a cute cartoon for preschool children with flat bright colors and thick dark outlines.',
  icon:
    'Render only the main object of the reference as a very simple icon: thick black outline, flat simple colors, '
    + 'pure white background, one object only, centered, filling most of the canvas.',
};

function buildReferencePrompt({
  instructions = '', style = 'lineart', background, keepText = false, transcribedText = '',
} = {}) {
  const parts = [
    'Use the attached image only as a visual reference. Redraw it as a new, clean drawing for a '
      + 'preschool worksheet, keeping the same characters, objects, composition and mood.',
    'The reference may be a photo or a scan of a printed page (tilted, with shadows, dark background or page '
      + 'edges). The result must be a clean digital illustration on a flat, pure white canvas, perfectly straight '
      + '(no perspective, no tilt): no photo borders, no dark background around the page, no page edges or folds.',
    'Do NOT trace or copy the photo pixel by pixel: rebuild the page from scratch, fixing its defects. Correct any '
      + 'perspective distortion, rotation or skew; make shapes symmetric and well proportioned (circles truly round, '
      + 'center lines straight and centered, matching left and right parts); use smooth, clean, uniform outlines; '
      + 'align elements neatly. Keep the same number of lines and parts as the reference: never duplicate, split '
      + 'or add lines (a single dividing line stays a single line). If the teacher asks to "improve" ("melhorar", '
      + '"deixar mais bonito", "caprichar"), apply exactly these corrections while keeping the same content.',
  ];
  if (keepText) {
    parts.push(
      'Keep the activity title and instructions text that appear in the reference, with exactly the same words '
        + '(Portuguese, correct spelling and accents), redrawn as clean, bold, easy-to-read printed letters in the same place on the page. '
        + 'Every line of text must be perfectly horizontal and left-aligned like a freshly printed worksheet (never '
        + 'tilted or curved, even if it is in the photo), and any box or balloon around the text must be a neat, '
        + 'straight rectangle with rounded corners (a dashed border stays dashed, evenly spaced). Remove only: "Name:" lines and other fields to write on, logos, school headers, page '
        + 'numbers, watermarks, scan marks, shadows of the paper and paper texture. The worksheet header (school '
        + 'name, student name, QR code) is added later by our own system.'
    );
    const exactText = String(transcribedText || '').trim();
    if (exactText) {
      parts.push(
        'The text is exactly this (copy it letter by letter, with the same line breaks and accents; do not '
          + 'invent, drop or misspell any word):\n' + exactText
      );
    }
  } else {
    parts.push(
      'Remove everything that is not part of the illustration itself: titles, headings, instructions, any text, '
        + 'letters or numbers, "Name:" lines and other fields to write on, page borders and frames, logos, school '
        + 'headers, page numbers, watermarks, scan marks, shadows of the paper and paper texture. Do not add any text. '
        + 'The worksheet header (school name, student name, QR code) is added later by our own system. '
        + 'Let the drawing fill the whole image: do not leave empty space where the removed text used to be.'
    );
  }
  parts.push(REFERENCE_STYLE_PROMPTS[style] || REFERENCE_STYLE_PROMPTS.lineart);
  if (style === 'color') {
    parts.push(normalizeBackground(background) === 'scene'
      ? 'Keep the background scene, in soft flat colors, full-bleed to all four edges of the image '
        + '(no rounded corners, no card, no frame, no white margin).'
      : 'Keep only the characters and objects on a plain pure white background: no scenery, no ground, no cast shadow.');
  }
  const extra = String(instructions || '').trim();
  if (extra) {
    parts.push(
      `Changes requested by the teacher (they may be written in Portuguese): ${extra}. `
        + 'If a request conflicts with the rules above (for example, asking to keep or add some text), '
        + 'follow the teacher\'s request.'
    );
  }
  return parts.join(' ');
}

/** Proporcoes aceitas pelo modelo de imagem; escolhe a mais proxima. */
const ASPECT_RATIOS = [
  ['1:1', 1], ['3:4', 3 / 4], ['4:3', 4 / 3], ['2:3', 2 / 3], ['3:2', 3 / 2], ['9:16', 9 / 16], ['16:9', 16 / 9],
];

function closestAspectRatio(width, height) {
  if (!(width > 0) || !(height > 0)) return '1:1';
  const ratio = width / height;
  let best = ASPECT_RATIOS[0];
  for (const candidate of ASPECT_RATIOS) {
    if (Math.abs(Math.log(candidate[1] / ratio)) < Math.abs(Math.log(best[1] / ratio))) best = candidate;
  }
  return best[0];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Motivos de parada que sao bloqueio de conteudo de verdade (nao adianta repetir). */
const SAFETY_FINISH_REASONS = new Set([
  'SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_PROHIBITED_CONTENT',
]);

/** Parecido demais com a original (pagina de livro, por exemplo). */
const RECITATION_FINISH_REASONS = new Set(['RECITATION', 'IMAGE_RECITATION']);

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
          const finishReason = String(candidate?.finishReason || '');
          const promptBlock = response?.data?.promptFeedback?.blockReason || null;
          console.warn('[Iara imagem] Resposta sem imagem', { model, attempt, finishReason, promptBlock });
          if (promptBlock || SAFETY_FINISH_REASONS.has(finishReason)) {
            throw new IaraImageError(
              'A Iara nao pode gerar essa imagem. Tente descrever de outro jeito.',
              { statusCode: 422, code: 'IARA_IMAGE_BLOCKED' }
            );
          }
          // Outros motivos (parecida demais com a original, "IMAGE_OTHER",
          // resposta so com texto) costumam passar numa nova tentativa.
          const recitation = RECITATION_FINISH_REASONS.has(finishReason);
          const empty = new IaraImageError(
            recitation
              ? 'A Iara nao conseguiu recriar a imagem tao parecida com a original. '
                + 'Tente pedir algumas mudancas (ex.: "deixar mais simples").'
              : 'A Iara nao conseguiu gerar a imagem desta vez. Tente novamente.',
            { statusCode: 502, code: recitation ? 'IARA_IMAGE_TOO_SIMILAR' : 'IARA_IMAGE_EMPTY' }
          );
          empty.retryable = true;
          throw empty;
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
            `[Iara imagem] A chave ${getApiKeySource(provider)} nao tem permissao para usar o modelo de imagem `
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
            `[Iara imagem] O projeto da chave ${getApiKeySource(provider)} esta sem cota ou sem creditos para gerar imagens `
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
        const retryable = error?.retryable === true
          || RETRYABLE_STATUS.has(status)
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

const TEXT_MODEL = 'gemini-2.5-flash';
const TRANSCRIBE_PROMPT =
  'Transcribe exactly the title and the instructions text printed on this worksheet (it is in Portuguese). '
  + 'Keep the original words, accents, numbering and line breaks. Do not include "Nome:"/"Name:" lines, dates, '
  + 'school names, page numbers or text inside the drawing. Answer with the text only, nothing else. '
  + 'If there is no such text, answer with an empty response.';

/**
 * Le o enunciado da imagem de referencia com o modelo de texto (que le
 * muito melhor que o de imagem), para o desenho copiar letra por letra.
 * Falhas nao impedem a geracao: devolve ''.
 */
async function transcribeReferenceText({
  imagePart,
  httpClient = axios,
  provider = getProvider(),
  apiKey = getApiKey(provider),
  model = String(process.env.IARA_TEXT_MODEL || TEXT_MODEL).trim() || TEXT_MODEL,
}) {
  if (!apiKey || !imagePart) return '';
  try {
    const response = await httpClient.post(
      buildEndpoint(model, provider),
      {
        contents: [{ role: 'user', parts: [imagePart, { text: TRANSCRIBE_PROMPT }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 800 },
      },
      {
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    const parts = response?.data?.candidates?.[0]?.content?.parts || [];
    return parts.map((part) => part?.text || '').join('').trim().slice(0, 1200);
  } catch (error) {
    console.warn('[Iara imagem] Nao foi possivel transcrever o enunciado da referencia', safeCause(error));
    return '';
  }
}

module.exports = {
  generateImage,
  transcribeReferenceText,
  buildPrompt,
  buildReferencePrompt,
  closestAspectRatio,
  normalizeBackground,
  BACKGROUNDS,
  getImageModelNames,
  IMAGE_STYLES,
  IaraImageError,
  isBillingQuotaError,
  isPermissionError,
  getApiKey,
  getApiKeySource,
  buildEndpoint,
  getProvider,
};
