const crypto = require('crypto');

const AUDIT_SOURCES = Object.freeze([
  'mobile',
  'desktop',
  'api',
  'system',
  'unknown',
]);
const AUDIT_STATUSES = Object.freeze([
  'success',
  'failed',
  'blocked',
  'expired',
  'revoked',
  'info',
]);
const DEVICE_PLATFORMS = Object.freeze([
  'android',
  'ios',
  'web',
  'windows',
  'macos',
  'linux',
  'unknown',
]);

const SAFE_METADATA_KEYS = new Set([
  'attempts',
  'blockedUntil',
  'expiresInSeconds',
  'guardiansCount',
  'identifierType',
  'legacyCpfNormalizedPersisted',
  'legacyCpfNormalizedRecovered',
  'linkedStudentsCount',
  'matches',
  'newStatus',
  'nextAction',
  'optionId',
  'reason',
  'result',
  'restoredStatus',
  'scope',
  'source',
]);

const SENSITIVE_KEY_PATTERN =
  /(pin|password|token|cpf|document|birth|nascimento|phone|telefone|(^|_)ip($|_)|useragent|full.?name|nome.?completo|raw|secret)/i;
const MAX_METADATA_STRING_LENGTH = 160;
const MAX_REASON_TEXT_LENGTH = 500;

const DISPLAY_TYPES = Object.freeze({
  FIRST_ACCESS_STARTED: ['Primeiro acesso iniciado', 'first_access'],
  FIRST_ACCESS_FAILED: ['Primeiro acesso não confirmado', 'first_access'],
  RESPONSIBLE_VERIFIED: ['Responsável confirmado', 'first_access'],
  RESPONSIBLE_VERIFICATION_FAILED: [
    'Falha na confirmação do responsável',
    'first_access',
  ],
  PIN_SET: ['PIN criado no primeiro acesso', 'credential'],
  PIN_SET_FAILED: ['Falha ao criar PIN', 'credential'],
  LOGIN_SUCCESS: ['Login do responsável realizado', 'authentication'],
  LOGIN_FAILED: ['Falha no login do responsável', 'authentication'],
  ACCOUNT_BLOCKED: ['Conta do responsável bloqueada', 'account'],
  ACCOUNT_UNLOCKED: ['Conta do responsável desbloqueada', 'account'],
  ACCOUNT_DEACTIVATED: ['Conta do responsável desativada', 'account'],
  ACCOUNT_REACTIVATED: ['Conta do responsável reativada', 'account'],
  PIN_RESET: ['PIN resetado pela escola', 'credential'],
  PIN_RECOVERY_STARTED: ['Recuperação de PIN iniciada', 'credential'],
  PIN_RECOVERY_FAILED: ['Falha na recuperação de PIN', 'credential'],
  PIN_RECOVERY_BLOCKED: ['Recuperação de PIN bloqueada', 'credential'],
  PIN_RECOVERY_EXPIRED: ['Recuperação de PIN expirada', 'credential'],
  PIN_RECOVERY_SUCCEEDED: ['Recuperação de PIN concluída', 'credential'],
  GUARDIAN_PIN_UPDATED: ['PIN do responsável atualizado', 'credential'],
  GUARDIAN_SESSIONS_REVOKED: [
    'Sessões do responsável revogadas',
    'session',
  ],
});

const NORMALIZED_EVENT_TYPES = Object.freeze({
  LOGIN_SUCCESS: 'GUARDIAN_LOGIN_SUCCESS',
  LOGIN_FAILED: 'GUARDIAN_LOGIN_FAILED',
  ACCOUNT_BLOCKED: 'GUARDIAN_ACCOUNT_BLOCKED',
  ACCOUNT_UNLOCKED: 'GUARDIAN_ACCOUNT_UNLOCKED',
  ACCOUNT_DEACTIVATED: 'GUARDIAN_ACCOUNT_DEACTIVATED',
  ACCOUNT_REACTIVATED: 'GUARDIAN_ACCOUNT_REACTIVATED',
  PIN_RESET: 'GUARDIAN_ADMIN_PIN_RESET',
  PIN_SET: 'FIRST_ACCESS_PIN_CREATED',
  RESPONSIBLE_VERIFIED: 'FIRST_ACCESS_RESPONSIBLE_VERIFIED',
});

const STATUS_BY_EVENT = Object.freeze({
  FIRST_ACCESS_FAILED: 'failed',
  RESPONSIBLE_VERIFICATION_FAILED: 'failed',
  PIN_SET_FAILED: 'failed',
  LOGIN_FAILED: 'failed',
  ACCOUNT_BLOCKED: 'blocked',
  PIN_RECOVERY_FAILED: 'failed',
  PIN_RECOVERY_BLOCKED: 'blocked',
  PIN_RECOVERY_EXPIRED: 'expired',
  GUARDIAN_SESSIONS_REVOKED: 'revoked',
});

function boundedString(value, maxLength) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function redactSensitiveText(value, maxLength) {
  const bounded = boundedString(value, maxLength);
  if (!bounded) return null;

  return bounded
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[DADO REDIGIDO]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[DADO REDIGIDO]')
    .replace(/\b\d{6,}\b/g, '[DADO REDIGIDO]')
    .replace(/\b[a-f0-9]{24,}\b/gi, '[DADO REDIGIDO]')
    .slice(0, maxLength);
}

function sanitizeEventMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  return Object.entries(metadata).reduce((result, [key, value]) => {
    if (!SAFE_METADATA_KEYS.has(key) || SENSITIVE_KEY_PATTERN.test(key)) {
      return result;
    }

    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      result[key] = value;
      return result;
    }

    if (value instanceof Date) {
      result[key] = value.toISOString();
      return result;
    }

    if (typeof value === 'string') {
      result[key] = redactSensitiveText(
        value,
        MAX_METADATA_STRING_LENGTH
      );
      return result;
    }

    if (
      Array.isArray(value) &&
      value.length <= 20 &&
      value.every((item) =>
        ['string', 'number', 'boolean'].includes(typeof item)
      )
    ) {
      result[key] = value.map((item) =>
        typeof item === 'string'
          ? redactSensitiveText(item, MAX_METADATA_STRING_LENGTH)
          : item
      );
    }

    return result;
  }, {});
}

function sanitizeReasonText(value) {
  return redactSensitiveText(value, MAX_REASON_TEXT_LENGTH);
}

function normalizeReasonCode(value) {
  const normalized = boundedString(value, 80);
  return normalized && /^[a-z0-9_.-]+$/i.test(normalized) ? normalized : null;
}

function normalizeSource(value, fallback = 'unknown') {
  const normalized = String(value || '').trim().toLowerCase();
  return AUDIT_SOURCES.includes(normalized) ? normalized : fallback;
}

function normalizeDevicePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return DEVICE_PLATFORMS.includes(normalized) ? normalized : 'unknown';
}

function normalizeAppVersion(value) {
  const normalized = boundedString(value, 40);
  return normalized && /^[a-z0-9._+-]+$/i.test(normalized) ? normalized : null;
}

function normalizeCorrelationId(value) {
  const normalized = boundedString(value, 80);
  return normalized && /^[a-z0-9_-]+$/i.test(normalized)
    ? normalized
    : crypto.randomUUID();
}

function maskIp(value) {
  const ip = String(value || '').trim().replace(/^::ffff:/, '');
  if (!ip) return null;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.');
    if (parts.some((part) => Number(part) > 255)) return null;
    return `${parts[0]}.***.***.${parts[3]}`;
  }

  if (ip.includes(':')) {
    const parts = ip.split(':').filter(Boolean);
    return parts.length ? `${parts.slice(0, 2).join(':')}:****` : null;
  }

  return null;
}

function summarizeUserAgent(value, platformHint = 'unknown') {
  const userAgent = String(value || '');
  if (!userAgent) return null;

  const platform =
    platformHint !== 'unknown'
      ? platformHint
      : /android/i.test(userAgent)
        ? 'android'
        : /(iphone|ipad|ios)/i.test(userAgent)
          ? 'ios'
          : /windows/i.test(userAgent)
            ? 'windows'
            : /mac os|macintosh/i.test(userAgent)
              ? 'macos'
              : /linux/i.test(userAgent)
                ? 'linux'
                : 'unknown';
  const client = /academy.?hub/i.test(userAgent)
    ? 'Academy Hub Mobile'
    : /edg\//i.test(userAgent)
      ? 'Edge'
      : /chrome\//i.test(userAgent)
        ? 'Chrome'
        : /firefox\//i.test(userAgent)
          ? 'Firefox'
          : /safari\//i.test(userAgent)
            ? 'Safari'
            : 'Cliente API';

  return `${client} / ${platform === 'unknown' ? 'Plataforma desconhecida' : platform}`;
}

function normalizeActorType(actorType) {
  return (
    {
      guardian: 'guardian_self',
      staff: 'admin_user',
      system: 'system',
      public: 'public_anonymous',
    }[actorType] || 'public_anonymous'
  );
}

function inferEventStatus(event = {}) {
  return event.status || STATUS_BY_EVENT[event.eventType] || 'success';
}

function buildGuardianAccessEventDto(event = {}) {
  const [displayType, category] = DISPLAY_TYPES[event.eventType] || [
    'Evento de acesso do responsável',
    'other',
  ];
  const ipCorrelationId = event.ipHash
    ? String(event.ipHash).slice(0, 12)
    : null;

  return {
    id: String(event._id || event.id),
    schemaVersion: Number(event.schemaVersion || 1),
    createdAt: event.createdAt || null,
    eventType: event.eventType,
    normalizedEventType:
      NORMALIZED_EVENT_TYPES[event.eventType] || event.eventType,
    displayType,
    category,
    status: inferEventStatus(event),
    source: normalizeSource(event.source),
    actor: {
      type: normalizeActorType(event.actorType),
      name: event.actorNameSnapshot || null,
      roles: Array.isArray(event.actorRoleSnapshot)
        ? event.actorRoleSnapshot
        : [],
    },
    target: {
      accountId: event.accountId ? String(event.accountId) : null,
      studentId: event.studentId ? String(event.studentId) : null,
      tutorId: event.tutorId ? String(event.tutorId) : null,
    },
    security: {
      ipMasked: event.ipMasked || null,
      ipCorrelationId,
      userAgentSummary: event.userAgentSummary || null,
      cpfMasked: event.cpfMasked || null,
      devicePlatform: event.devicePlatform || 'unknown',
      appVersion: event.appVersion || null,
    },
    details: {
      reasonCode: event.reasonCode || null,
      reasonText: event.reasonText || null,
      affectedFields: Array.isArray(event.affectedFields)
        ? event.affectedFields
        : [],
      sessionsRevoked: Boolean(event.sessionsRevoked),
      tokenVersionBefore:
        Number.isInteger(event.tokenVersionBefore)
          ? event.tokenVersionBefore
          : null,
      tokenVersionAfter:
        Number.isInteger(event.tokenVersionAfter)
          ? event.tokenVersionAfter
          : null,
    },
    correlationId: event.correlationId || null,
  };
}

function encodeEventCursor(event) {
  if (!event?.createdAt || !event?._id) return null;
  return Buffer.from(
    JSON.stringify({
      createdAt: new Date(event.createdAt).toISOString(),
      id: String(event._id),
    })
  ).toString('base64url');
}

function decodeEventCursor(cursor) {
  try {
    const parsed = JSON.parse(
      Buffer.from(String(cursor || ''), 'base64url').toString('utf8')
    );
    const createdAt = new Date(parsed.createdAt);
    if (!parsed.id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: String(parsed.id) };
  } catch (_) {
    return null;
  }
}

module.exports = {
  AUDIT_SOURCES,
  AUDIT_STATUSES,
  DEVICE_PLATFORMS,
  buildGuardianAccessEventDto,
  decodeEventCursor,
  encodeEventCursor,
  inferEventStatus,
  maskIp,
  normalizeAppVersion,
  normalizeCorrelationId,
  normalizeDevicePlatform,
  normalizeReasonCode,
  normalizeSource,
  sanitizeEventMetadata,
  sanitizeReasonText,
  summarizeUserAgent,
};
