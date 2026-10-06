const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const School = require('../models/school.model');
const Student = require('../models/student.model');
const Tutor = require('../models/tutor.model');
const Class = require('../models/class.model');
const Enrollment = require('../models/enrollment.model');
const User = require('../models/user.model');
const Subject = require('../models/subject.model');
const Invoice = require('../models/invoice.model');
const Attendance = require('../models/attendance.model');
const Horario = require('../models/horario.model');
const Periodo = require('../models/periodo.model');
const ClassActivity = require('../models/classActivity.model');
const ClassActivitySubmission = require('../models/classActivitySubmission.model');
const GuardianAccessAccount = require('../models/guardianAccessAccount.model');
const GuardianAccessLink = require('../models/guardianAccessLink.model');
const GuardianAccessEvent = require('../models/guardianAccessEvent.model');
const GuardianFirstAccessChallenge = require('../models/guardianFirstAccessChallenge.model');
const GuardianPinRecoveryChallenge = require('../models/guardianPinRecoveryChallenge.model');
const GuardianPinRecoveryRateLimit = require('../models/guardianPinRecoveryRateLimit.model');
const invoiceService = require('./invoice.service');
const tutorFinancialScoreService = require('./tutorFinancialScore.service');
const {
  GUARDIAN_ACCESS_EVENT_TYPES,
  GUARDIAN_ACCESS_EVENT_TYPE_VALUES,
} = require('../constants/guardianAccessEventTypes');
const {
  buildBirthDateKey,
  buildPublicIdentifier,
  isValidCpf,
  maskCpf,
  normalizeCpf,
  normalizeName,
  parseDateInput,
} = require('../utils/guardianAccess.util');
const {
  AUDIT_STATUSES,
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
} = require('../utils/guardianAudit.util');

const ADMIN_ROLES = new Set([
  'ADMIN',
  'ADMINISTRADOR',
  'COORDENADOR',
  'DIRETOR',
  'GESTOR',
  'SECRETARIA',
]);

const CHALLENGE_TTL_MINUTES = 20;
const LOGIN_BLOCK_MINUTES = 15;
const MAX_LOGIN_FAILURES = 5;
const MAX_CHALLENGE_CPF_FAILURES = 3;
const PIN_SALT_ROUNDS = 10;
const PIN_RECOVERY_TTL_MINUTES = 15;
const PIN_RECOVERY_WINDOW_MINUTES = 15;
const MAX_PIN_RECOVERY_CHALLENGE_FAILURES = 3;
const MAX_PIN_RECOVERY_STARTS_PER_CPF = 5;
const MAX_PIN_RECOVERY_STARTS_PER_IP = 5;
const PIN_RECOVERY_GENERIC_MESSAGE =
  'Nao foi possivel confirmar os dados informados. Revise e tente novamente ou procure a escola.';
const PIN_RECOVERY_LIMIT_MESSAGE =
  'Nao foi possivel continuar agora. Aguarde alguns minutos e tente novamente.';
const PIN_RECOVERY_PURGE_DELAY_MINUTES = 24 * 60;
const GUARDIAN_TEMP_ACCESS_TTL_MINUTES = Number(process.env.GUARDIAN_TEMP_ACCESS_TTL_MINUTES || 15);
const LEGACY_EVENT_TYPES_BY_STATUS = Object.freeze({
  failed: [
    'FIRST_ACCESS_FAILED',
    'RESPONSIBLE_VERIFICATION_FAILED',
    'PIN_SET_FAILED',
    'LOGIN_FAILED',
    'ACCOUNT_LINK_FAILED',
    'PIN_RECOVERY_FAILED',
  ],
  blocked: ['ACCOUNT_BLOCKED', 'PIN_RECOVERY_BLOCKED'],
  expired: ['PIN_RECOVERY_EXPIRED'],
  revoked: ['GUARDIAN_SESSIONS_REVOKED'],
});

class GuardianAuthService {
  constructor(options = {}) {
    this.SchoolModel = options.SchoolModel || School;
    this.StudentModel = options.StudentModel || Student;
    this.TutorModel = options.TutorModel || Tutor;
    this.ClassModel = options.ClassModel || Class;
    this.EnrollmentModel = options.EnrollmentModel || Enrollment;
    this.UserModel = options.UserModel || User;
    this.SubjectModel = options.SubjectModel || Subject;
    this.InvoiceModel = options.InvoiceModel || Invoice;
    this.AttendanceModel = options.AttendanceModel || Attendance;
    this.HorarioModel = options.HorarioModel || Horario;
    this.PeriodoModel = options.PeriodoModel || Periodo;
    this.ClassActivityModel = options.ClassActivityModel || ClassActivity;
    this.ClassActivitySubmissionModel =
      options.ClassActivitySubmissionModel || ClassActivitySubmission;
    this.GuardianAccessAccountModel =
      options.GuardianAccessAccountModel || GuardianAccessAccount;
    this.GuardianAccessLinkModel =
      options.GuardianAccessLinkModel || GuardianAccessLink;
    this.GuardianAccessEventModel =
      options.GuardianAccessEventModel || GuardianAccessEvent;
    this.GuardianFirstAccessChallengeModel =
      options.GuardianFirstAccessChallengeModel || GuardianFirstAccessChallenge;
    this.GuardianPinRecoveryChallengeModel =
      options.GuardianPinRecoveryChallengeModel || GuardianPinRecoveryChallenge;
    this.GuardianPinRecoveryRateLimitModel =
      options.GuardianPinRecoveryRateLimitModel || GuardianPinRecoveryRateLimit;
    this.invoiceService = options.invoiceService || invoiceService;
    this.tutorFinancialScoreService =
      options.tutorFinancialScoreService || tutorFinancialScoreService;
    this.bcrypt = options.bcrypt || bcrypt;
    this.jwt = options.jwt || jwt;
    this.crypto = options.crypto || crypto;
    this.now = options.now || (() => new Date());
    this.guardianJwtSecret =
      options.guardianJwtSecret ||
      process.env.GUARDIAN_JWT_SECRET ||
      process.env.JWT_SECRET;
    this.auditHashSecret =
      options.auditHashSecret ||
      process.env.GUARDIAN_AUDIT_HASH_SECRET ||
      process.env.GUARDIAN_RECOVERY_HASH_SECRET ||
      this.guardianJwtSecret;
    this.runCriticalTransaction =
      options.runCriticalTransaction ||
      (async (work) => {
        const session = await mongoose.startSession();
        try {
          let result;
          await session.withTransaction(async () => {
            result = await work(session);
          });
          return result;
        } finally {
          await session.endSession();
        }
      });
  }

  _createHttpError(message, statusCode = 400, extra = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    Object.assign(error, extra);
    return error;
  }

  _getNow() {
    return this.now();
  }

  _addMinutes(date, minutes) {
    return new Date(date.getTime() + minutes * 60 * 1000);
  }

  _randomToken(size = 24) {
    return this.crypto.randomBytes(size).toString('hex');
  }

  _hashValue(value) {
    return this.crypto
      .createHash('sha256')
      .update(String(value || ''))
      .digest('hex');
  }

  _hashSensitiveValue(value) {
    const secret = this.auditHashSecret;

    if (!secret) {
      throw this._createHttpError(
        'Segredo de HMAC da auditoria nao configurado.',
        500
      );
    }

    return this.crypto
      .createHmac('sha256', secret)
      .update(String(value || ''))
      .digest('hex');
  }

  _buildRequestHashes(requestMeta = {}) {
    const ipHash = requestMeta.ip
      ? this._hashSensitiveValue(requestMeta.ip)
      : null;
    const userAgentHash = requestMeta.userAgent
      ? this._hashSensitiveValue(requestMeta.userAgent)
      : null;

    return { ipHash, userAgentHash };
  }

  _buildAuditContext(requestMeta = {}, { cpf = null, fallbackSource = 'api' } = {}) {
    const { ipHash, userAgentHash } = this._buildRequestHashes(requestMeta);
    const devicePlatform = normalizeDevicePlatform(requestMeta.devicePlatform);
    const normalizedCpf = cpf ? normalizeCpf(cpf) : null;
    const cpfHashInput = cpf ? String(cpf).replace(/\D/g, '') || 'invalid' : null;

    return {
      ipHash,
      ipMasked: maskIp(requestMeta.ip),
      userAgentHash,
      userAgentSummary: summarizeUserAgent(
        requestMeta.userAgent,
        devicePlatform
      ),
      devicePlatform,
      appVersion: normalizeAppVersion(requestMeta.appVersion),
      source: normalizeSource(requestMeta.source, fallbackSource),
      cpfHash: cpfHashInput ? this._hashSensitiveValue(cpfHashInput) : null,
      cpfMasked: normalizedCpf ? maskCpf(normalizedCpf) : null,
      correlationId: normalizeCorrelationId(requestMeta.correlationId),
    };
  }

  _auditContextFromChallenge(challenge = {}, fallbackSource = 'api') {
    return {
      ipHash: challenge.ipHash || null,
      ipMasked: challenge.ipMasked || null,
      userAgentHash: challenge.userAgentHash || null,
      userAgentSummary: challenge.userAgentSummary || null,
      devicePlatform: challenge.devicePlatform || 'unknown',
      appVersion: challenge.appVersion || null,
      source: normalizeSource(challenge.source, fallbackSource),
      cpfHash: challenge.cpfHash || null,
      cpfMasked: challenge.cpfMasked || null,
      correlationId: normalizeCorrelationId(challenge.correlationId),
    };
  }

  _buildAdminActorSnapshot(actor = {}) {
    return {
      actorNameSnapshot:
        sanitizeReasonText(actor.fullName || actor.name || actor.username) || null,
      actorRoleSnapshot: this._extractRoles(actor).slice(0, 12),
    };
  }

  async _runCriticalMutation(work) {
    try {
      return await this.runCriticalTransaction(work);
    } catch (error) {
      if (
        /transaction numbers are only allowed|replica set|transactions are not supported/i.test(
          String(error?.message || '')
        )
      ) {
        throw this._createHttpError(
          'Operacao critica indisponivel: o MongoDB precisa suportar transacoes.',
          503,
          { reason: 'guardian_audit_transaction_unavailable' }
        );
      }
      throw error;
    }
  }

  _withSession(query, session) {
    return session && query && typeof query.session === 'function'
      ? query.session(session)
      : query;
  }

  _saveDocument(document, session) {
    return document.save(session ? { session } : undefined);
  }

  _isDebugEnabled() {
    return String(process.env.GUARDIAN_AUTH_DEBUG || '').toLowerCase() === 'true';
  }

  _debugLog(scope, payload = {}) {
    if (!this._isDebugEnabled()) return;

    try {
      console.info(
        `[guardian-auth][${scope}] ${JSON.stringify(payload, null, 2)}`
      );
    } catch (_) {
      console.info(`[guardian-auth][${scope}]`, payload);
    }
  }

  _extractRoles(actor = {}) {
    const roles = [];

    if (Array.isArray(actor.roles)) roles.push(...actor.roles);
    if (actor.role) roles.push(actor.role);
    if (actor.profile) roles.push(actor.profile);
    if (actor.userType) roles.push(actor.userType);

    return roles
      .map((role) => String(role || '').trim().toUpperCase())
      .filter(Boolean);
  }

  _assertAdminActor(actor = {}) {
    const hasPermission = this._extractRoles(actor).some((role) =>
      ADMIN_ROLES.has(role)
    );

    if (!hasPermission) {
      throw this._createHttpError(
        'Acesso negado para gestao de acessos de responsaveis.',
        403
      );
    }
  }

  _getAccountStatus(account = {}) {
    if (!account) return 'unknown';

    const now = this._getNow();
    if (account.blockedUntil && new Date(account.blockedUntil) > now) {
      return 'blocked';
    }

    return account.status || 'pending';
  }

  _assertValidPin(pin) {
    if (!/^\d{6}$/.test(String(pin || ''))) {
      throw this._createHttpError(
        'O PIN deve conter exatamente 6 digitos numericos.',
        400
      );
    }
  }

  async _validateGuardianCredential(account, credential) {
    if (account.pinHash && await this.bcrypt.compare(String(credential), account.pinHash)) return { valid: true, type: 'PERMANENT_PIN' };
    const temporary = account.temporaryAccess;
    const now = this._getNow();
    if (!temporary?.passwordHash || !temporary.credentialId || temporary.usedAt || temporary.revokedAt || !temporary.expiresAt || new Date(temporary.expiresAt) <= now) return { valid: false };
    if (!await this.bcrypt.compare(String(credential), temporary.passwordHash)) return { valid: false };
    const consumed = await this.GuardianAccessAccountModel.findOneAndUpdate({ _id: account._id, 'temporaryAccess.credentialId': temporary.credentialId, 'temporaryAccess.usedAt': null, 'temporaryAccess.revokedAt': null, 'temporaryAccess.expiresAt': { $gt: now } }, { $set: { 'temporaryAccess.usedAt': now } }, { new: true });
    if (!consumed) return { valid: false };
    await this._registerEvent({ schoolId: account.school_id, accountId: account._id, tutorId: account.tutorId, actorType: 'public', eventType: GUARDIAN_ACCESS_EVENT_TYPES.TEMPORARY_ACCESS_USED, metadata: { authenticationMethod: 'TEMPORARY_ACCESS' } });
    return { valid: true, type: 'TEMPORARY_ACCESS' };
  }

  _generateTemporaryCredential() {
    return String(this.crypto.randomInt(0, 1000000)).padStart(6, '0');
  }

  _assertGuardianJwtSecret() {
    if (!this.guardianJwtSecret) {
      throw this._createHttpError(
        'Segredo JWT de responsavel nao configurado.',
        500
      );
    }
  }

  async _registerEvent({
    schoolId,
    accountId = null,
    linkId = null,
    challengeId = null,
    recoveryChallengeId = null,
    studentId = null,
    tutorId = null,
    actorType,
    actorUserId = null,
    actorNameSnapshot = null,
    actorRoleSnapshot = [],
    eventType,
    metadata = {},
    status = null,
    source = 'unknown',
    reasonCode = null,
    reasonText = null,
    affectedFields = [],
    tokenVersionBefore = null,
    tokenVersionAfter = null,
    sessionsRevoked = false,
    ipHash = null,
    ipMasked = null,
    userAgentHash = null,
    userAgentSummary = null,
    devicePlatform = 'unknown',
    appVersion = null,
    cpfHash = null,
    cpfMasked = null,
    correlationId = null,
    session = null,
  }) {
    if (!schoolId || !actorType || !eventType) return null;

    const safeMetadata = sanitizeEventMetadata(metadata);
    const eventPayload = {
      school_id: schoolId,
      accountId,
      linkId,
      challengeId,
      recoveryChallengeId,
      studentId,
      tutorId,
      actorType,
      actorUserId,
      actorNameSnapshot: actorNameSnapshot
        ? String(actorNameSnapshot).trim().slice(0, 160)
        : null,
      actorRoleSnapshot: Array.isArray(actorRoleSnapshot)
        ? actorRoleSnapshot.map(String).slice(0, 12)
        : [],
      eventType,
      schemaVersion: 2,
      status:
        status && AUDIT_STATUSES.includes(status)
          ? status
          : inferEventStatus({ eventType }),
      source: normalizeSource(source),
      reasonCode:
        normalizeReasonCode(reasonCode) ||
        normalizeReasonCode(safeMetadata.reason),
      reasonText: sanitizeReasonText(reasonText),
      affectedFields: Array.isArray(affectedFields)
        ? affectedFields
            .map((field) => String(field || '').trim())
            .filter((field) => /^[a-zA-Z0-9_.]+$/.test(field))
            .slice(0, 20)
        : [],
      tokenVersionBefore:
        Number.isInteger(tokenVersionBefore) ? tokenVersionBefore : null,
      tokenVersionAfter:
        Number.isInteger(tokenVersionAfter) ? tokenVersionAfter : null,
      sessionsRevoked: Boolean(sessionsRevoked),
      ipHash,
      ipMasked,
      userAgentHash,
      userAgentSummary,
      devicePlatform: normalizeDevicePlatform(devicePlatform),
      appVersion: normalizeAppVersion(appVersion),
      cpfHash,
      cpfMasked,
      correlationId: normalizeCorrelationId(correlationId),
      metadata: safeMetadata,
    };

    if (session) {
      const created = await this.GuardianAccessEventModel.create(
        [eventPayload],
        { session }
      );
      return created[0] || null;
    }

    return this.GuardianAccessEventModel.create(eventPayload);
  }

  async _registerEventBestEffort(scope, payload = {}) {
    try {
      return await this._registerEvent(payload);
    } catch (error) {
      this._debugLog(scope, {
        message: error?.message || 'event_registration_failed',
        eventType: payload?.eventType || null,
      });
      return null;
    }
  }

  async resolveSchoolByPublicIdentifier(publicIdentifier) {
    const normalizedPublicIdentifier = buildPublicIdentifier(publicIdentifier);

    if (!normalizedPublicIdentifier) {
      throw this._createHttpError('schoolPublicId invalido.', 400);
    }

    const school = await this.SchoolModel.findOne({
      publicIdentifier: normalizedPublicIdentifier,
    })
      .select('_id name publicIdentifier')
      .lean();

    if (!school) {
      throw this._createHttpError('Escola nao encontrada.', 404);
    }

    return school;
  }

  async _getSchoolSummaryById(schoolId) {
    if (!schoolId) return null;

    return this.SchoolModel.findById(schoolId)
      .select('_id name publicIdentifier')
      .lean();
  }

  async _listSchoolSummariesByIds(schoolIds = []) {
    const uniqueSchoolIds = [...new Set(schoolIds.map(String).filter(Boolean))];

    if (!uniqueSchoolIds.length) {
      return [];
    }

    const schools = await this.SchoolModel.find({
      _id: { $in: uniqueSchoolIds },
    })
      .select('_id name publicIdentifier')
      .lean();

    return schools
      .map((school) => ({
        schoolId: String(school._id),
        schoolName: school.name || '',
        schoolPublicId: school.publicIdentifier || '',
      }))
      .filter((school) => school.schoolPublicId)
      .sort((left, right) =>
        String(left.schoolName || '').localeCompare(
          String(right.schoolName || ''),
          'pt-BR'
        )
      );
  }

  _buildSchoolResponse(school = null) {
    if (!school?._id) return null;

    return {
      id: String(school._id),
      schoolId: String(school._id),
      publicIdentifier: school.publicIdentifier || null,
      name: school.name || null,
    };
  }

  _extractId(value) {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
  }

  _timeToMinutes(timeValue) {
    const [hour, minute] = String(timeValue || '')
      .split(':')
      .map((part) => Number.parseInt(part, 10));

    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }

    return hour * 60 + minute;
  }

  _getWeekdayLabel(dayOfWeek) {
    switch (Number(dayOfWeek)) {
      case 1:
        return 'Segunda';
      case 2:
        return 'Terca';
      case 3:
        return 'Quarta';
      case 4:
        return 'Quinta';
      case 5:
        return 'Sexta';
      case 6:
        return 'Sabado';
      case 7:
        return 'Domingo';
      default:
        return 'Dia';
    }
  }

  _buildGuardianClassSummary(classDoc = null) {
    const classId = this._extractId(classDoc?._id || classDoc);
    if (!classId) return null;

    return {
      id: classId,
      name: classDoc?.name || '',
      grade: classDoc?.grade || '',
      shift: classDoc?.shift || '',
      schoolYear: classDoc?.schoolYear ?? null,
      room: classDoc?.room || null,
    };
  }

  _sortGuardianLinkedStudents(students = []) {
    return [...students].sort((left, right) =>
      String(left.fullName || '').localeCompare(
        String(right.fullName || ''),
        'pt-BR'
      )
    );
  }

  _pickDefaultGuardianStudent(students = []) {
    if (!students.length) return null;

    const withClass = students.find((student) => student.class != null);
    return withClass || students[0];
  }

  _getEffectiveTutorCpfNormalized(tutor = null) {
    const directNormalized =
      typeof tutor?.cpfNormalized === 'string' && tutor.cpfNormalized.trim()
        ? tutor.cpfNormalized.trim()
        : null;

    return directNormalized || normalizeCpf(tutor?.cpf);
  }

  async _findGuardianAccountByIdentifier({
    schoolId,
    identifierNormalized,
    includePinHash = false,
  }) {
    if (!schoolId || !identifierNormalized) return null;

    const query = this.GuardianAccessAccountModel.findOne({
      school_id: schoolId,
      identifierNormalized,
    });

    if (includePinHash && query && typeof query.select === 'function') {
      query.select('+pinHash');
    }

    return query;
  }

  _buildGuardianStudentPayload(student = null) {
    if (!student?.id) return null;

    return {
      id: String(student.id),
      fullName: student.fullName || '',
      relationship: student.relationship || 'Responsavel',
      class: student.class || null,
      enrollment: student.enrollment || null,
      birthDate: student.birthDate || null,
    };
  }

  async _buildGuardianLoginContext({ schoolId, accountId }) {
    const linkedStudents = await this._listGuardianLinkedStudents({
      schoolId,
      accountId,
    });
    const defaultStudent = this._pickDefaultGuardianStudent(linkedStudents);

    return {
      linkedStudents,
      linkedStudentsCount: linkedStudents.length,
      defaultStudent,
    };
  }

  _serializeGuardianLesson(
    lesson,
    { subjectById = new Map(), teacherById = new Map(), classById = new Map() } = {}
  ) {
    const subjectId = this._extractId(lesson?.subjectId);
    const teacherId = this._extractId(lesson?.teacherId);
    const classId = this._extractId(lesson?.classId);

    const subject = subjectById.get(subjectId) || {};
    const teacher = teacherById.get(teacherId) || {};
    const classDoc = classById.get(classId) || {};

    return {
      id: this._extractId(lesson?._id),
      dayOfWeek: Number(lesson?.dayOfWeek || 0),
      weekdayLabel: this._getWeekdayLabel(lesson?.dayOfWeek),
      startTime: lesson?.startTime || '',
      endTime: lesson?.endTime || '',
      timeLabel: `${lesson?.startTime || '--:--'} - ${lesson?.endTime || '--:--'}`,
      subjectName: subject?.name || 'Disciplina',
      teacherName: teacher?.fullName || 'Professor',
      room: lesson?.room || classDoc?.room || null,
      className: classDoc?.name || '',
      grade: classDoc?.grade || '',
      shift: classDoc?.shift || '',
    };
  }

  _computeGuardianSchedulePointers(entries = [], referenceDate = this._getNow()) {
    if (!entries.length) {
      return {
        currentClass: null,
        nextClass: null,
      };
    }

    const currentDayOfWeek = referenceDate.getDay() === 0 ? 7 : referenceDate.getDay();
    const currentMinutes = referenceDate.getHours() * 60 + referenceDate.getMinutes();

    const sortedEntries = [...entries].sort((left, right) => {
      if (left.dayOfWeek !== right.dayOfWeek) {
        return left.dayOfWeek - right.dayOfWeek;
      }

      return this._timeToMinutes(left.startTime) - this._timeToMinutes(right.startTime);
    });

    let currentClass = null;
    let nextClass = null;

    for (const entry of sortedEntries) {
      const startMinutes = this._timeToMinutes(entry.startTime);
      const endMinutes = this._timeToMinutes(entry.endTime);

      if (
        entry.dayOfWeek === currentDayOfWeek &&
        startMinutes !== null &&
        endMinutes !== null &&
        currentMinutes >= startMinutes &&
        currentMinutes < endMinutes
      ) {
        currentClass = entry;
        break;
      }
    }

    if (currentClass) {
      for (const entry of sortedEntries) {
        const startMinutes = this._timeToMinutes(entry.startTime);
        if (
          entry.dayOfWeek === currentDayOfWeek &&
          startMinutes !== null &&
          startMinutes > currentMinutes
        ) {
          nextClass = entry;
          break;
        }
      }

      if (!nextClass) {
        nextClass = sortedEntries.find((entry) => entry.dayOfWeek > currentDayOfWeek) || null;
      }

      if (!nextClass) {
        nextClass =
          sortedEntries.find((entry) => entry.dayOfWeek < currentDayOfWeek) || null;
      }

      return { currentClass, nextClass };
    }

    nextClass =
      sortedEntries.find((entry) => {
        const startMinutes = this._timeToMinutes(entry.startTime);

        if (entry.dayOfWeek === currentDayOfWeek) {
          return startMinutes !== null && startMinutes > currentMinutes;
        }

        return entry.dayOfWeek > currentDayOfWeek;
      }) || null;

    if (!nextClass) {
      nextClass =
        sortedEntries.find((entry) => entry.dayOfWeek < currentDayOfWeek) || null;
    }

    return {
      currentClass: null,
      nextClass,
    };
  }

  _buildGuardianAttendanceLabel(status, absenceState) {
    if (status === 'PRESENT') {
      return 'Presente';
    }

    switch (String(absenceState || 'NONE').toUpperCase()) {
      case 'APPROVED':
        return 'Falta justificada';
      case 'PENDING':
        return 'Falta aguardando justificativa';
      case 'REJECTED':
        return 'Falta com justificativa recusada';
      case 'EXPIRED':
        return 'Falta sem justificativa';
      default:
        return 'Falta';
    }
  }

  _buildGuardianActivityWorkflowState(activity = {}) {
    const now = this._getNow().getTime();
    const status = String(activity.status || 'ACTIVE').toUpperCase();

    if (status === 'CANCELLED') return 'CANCELLED';
    if (status === 'COMPLETED') return 'COMPLETED';

    const assignedAt = activity.assignedAt ? new Date(activity.assignedAt).getTime() : null;
    if (assignedAt && assignedAt > now) {
      return 'PLANNED';
    }

    const referenceDate = activity.correctionDate || activity.dueDate;
    const referenceTime = referenceDate ? new Date(referenceDate).getTime() : null;

    if (referenceTime && referenceTime <= now) {
      return 'IN_REVIEW';
    }

    return 'ACTIVE';
  }

  async _getRelevantGuardianTerm(schoolId) {
    const terms = await this.PeriodoModel.find({
      school_id: schoolId,
      tipo: 'Letivo',
    })
      .select('_id titulo dataInicio dataFim')
      .lean();

    if (!terms.length) {
      return null;
    }

    const sortedTerms = [...terms].sort(
      (left, right) => new Date(left.dataInicio) - new Date(right.dataInicio)
    );
    const now = this._getNow().getTime();

    const activeTerm = sortedTerms.find((term) => {
      const start = new Date(term.dataInicio).getTime();
      const end = new Date(term.dataFim).getTime();
      return start <= now && end >= now;
    });

    if (activeTerm) {
      return activeTerm;
    }

    const nextTerm = sortedTerms.find(
      (term) => new Date(term.dataInicio).getTime() > now
    );

    return nextTerm || sortedTerms[sortedTerms.length - 1] || null;
  }

  async _listGuardianLinkedStudents({ schoolId, accountId }) {
    const links = await this.GuardianAccessLinkModel.find({
      school_id: schoolId,
      guardianAccessAccountId: accountId,
      status: 'active',
    })
      .select('studentId relationshipSnapshot linkedAt')
      .lean();

    const studentIds = [...new Set(links.map((link) => this._extractId(link.studentId)).filter(Boolean))];
    if (!studentIds.length) {
      return [];
    }

    const [students, enrollments] = await Promise.all([
      this.StudentModel.find({
        _id: { $in: studentIds },
        school_id: schoolId,
        isActive: true,
      })
        .select('_id fullName birthDate classId isActive')
        .lean(),
      this.EnrollmentModel.find({
        school_id: schoolId,
        student: { $in: studentIds },
        status: { $in: ['Ativa', 'Pendente'] },
      })
        .select('_id student class academicYear enrollmentDate status')
        .lean(),
    ]);

    const classIds = [
      ...new Set(
        [
          ...students.map((student) => this._extractId(student.classId)),
          ...enrollments.map((enrollment) => this._extractId(enrollment.class)),
        ].filter(Boolean)
      ),
    ];

    const classes = classIds.length
      ? await this.ClassModel.find({
          _id: { $in: classIds },
          school_id: schoolId,
        })
          .select('_id name grade shift schoolYear room')
          .lean()
      : [];

    const classById = new Map(
      classes.map((classDoc) => [this._extractId(classDoc._id), classDoc])
    );

    const latestEnrollmentByStudentId = new Map();
    const sortedEnrollments = [...enrollments].sort((left, right) => {
      const yearDiff = Number(right.academicYear || 0) - Number(left.academicYear || 0);
      if (yearDiff !== 0) return yearDiff;

      const leftDate = new Date(left.enrollmentDate || 0).getTime();
      const rightDate = new Date(right.enrollmentDate || 0).getTime();
      return rightDate - leftDate;
    });

    sortedEnrollments.forEach((enrollment) => {
      const studentId = this._extractId(enrollment.student);
      if (!studentId || latestEnrollmentByStudentId.has(studentId)) return;
      latestEnrollmentByStudentId.set(studentId, enrollment);
    });

    const relationshipByStudentId = new Map(
      links.map((link) => [
        this._extractId(link.studentId),
        link.relationshipSnapshot || 'Responsavel',
      ])
    );

    return this._sortGuardianLinkedStudents(
      students.map((student) => {
        const studentId = this._extractId(student._id);
        const enrollment = latestEnrollmentByStudentId.get(studentId) || null;
        const classInfo =
          classById.get(
            this._extractId(enrollment?.class) || this._extractId(student.classId)
          ) || null;

        return {
          id: studentId,
          fullName: student.fullName || '',
          birthDate: student.birthDate || null,
          relationship: relationshipByStudentId.get(studentId) || 'Responsavel',
          class: this._buildGuardianClassSummary(classInfo),
          enrollment: enrollment
            ? {
                id: this._extractId(enrollment._id),
                academicYear: enrollment.academicYear ?? null,
                enrollmentDate: enrollment.enrollmentDate || null,
                status: enrollment.status || null,
              }
            : null,
        };
      })
    );
  }

  async _resolveGuardianStudentContext({ schoolId, accountId, studentId = null }) {
    const linkedStudents = await this._listGuardianLinkedStudents({
      schoolId,
      accountId,
    });

    if (!linkedStudents.length) {
      throw this._createHttpError(
        'Nenhum aluno vinculado a esta conta foi encontrado.',
        404
      );
    }

    const selectedStudent = studentId
      ? linkedStudents.find((item) => item.id === String(studentId))
      : this._pickDefaultGuardianStudent(linkedStudents);

    if (!selectedStudent) {
      throw this._createHttpError('Aluno vinculado nao encontrado.', 404);
    }

    return {
      linkedStudents,
      selectedStudent,
    };
  }

  async _buildGuardianScheduleData({ schoolId, student }) {
    const classId = this._extractId(student?.class?.id);

    if (!classId) {
      return {
        term: null,
        currentClass: null,
        nextClass: null,
        today: [],
        week: [],
      };
    }

    const term = await this._getRelevantGuardianTerm(schoolId);
    const baseFilter = {
      school_id: schoolId,
      classId,
    };

    const filterWithTerm = term?._id
      ? { ...baseFilter, termId: this._extractId(term._id) }
      : baseFilter;

    let rawLessons = await this.HorarioModel.find(filterWithTerm)
      .select('_id classId subjectId teacherId dayOfWeek startTime endTime room')
      .lean();

    if (!rawLessons.length && term?._id) {
      rawLessons = await this.HorarioModel.find(baseFilter)
        .select('_id classId subjectId teacherId dayOfWeek startTime endTime room')
        .lean();
    }

    const subjectIds = [
      ...new Set(rawLessons.map((lesson) => this._extractId(lesson.subjectId)).filter(Boolean)),
    ];
    const teacherIds = [
      ...new Set(rawLessons.map((lesson) => this._extractId(lesson.teacherId)).filter(Boolean)),
    ];

    const [subjects, teachers, classes] = await Promise.all([
      subjectIds.length
        ? this.SubjectModel.find({ _id: { $in: subjectIds } })
            .select('_id name level')
            .lean()
        : [],
      teacherIds.length
        ? this.UserModel.find({ _id: { $in: teacherIds } })
            .select('_id fullName profilePictureUrl')
            .lean()
        : [],
      this.ClassModel.find({ _id: classId, school_id: schoolId })
        .select('_id name grade shift schoolYear room')
        .lean(),
    ]);

    const subjectById = new Map(
      subjects.map((subject) => [this._extractId(subject._id), subject])
    );
    const teacherById = new Map(
      teachers.map((teacher) => [this._extractId(teacher._id), teacher])
    );
    const classById = new Map(
      classes.map((classDoc) => [this._extractId(classDoc._id), classDoc])
    );

    const serializedLessons = rawLessons
      .map((lesson) =>
        this._serializeGuardianLesson(lesson, {
          subjectById,
          teacherById,
          classById,
        })
      )
      .sort((left, right) => {
        if (left.dayOfWeek !== right.dayOfWeek) {
          return left.dayOfWeek - right.dayOfWeek;
        }

        return this._timeToMinutes(left.startTime) - this._timeToMinutes(right.startTime);
      });

    const currentDayOfWeek = this._getNow().getDay() === 0 ? 7 : this._getNow().getDay();
    const { currentClass, nextClass } = this._computeGuardianSchedulePointers(
      serializedLessons,
      this._getNow()
    );

    return {
      term: term
        ? {
            id: this._extractId(term._id),
            title: term.titulo || '',
            startDate: term.dataInicio || null,
            endDate: term.dataFim || null,
          }
        : null,
      currentClass,
      nextClass,
      today: serializedLessons.filter((lesson) => lesson.dayOfWeek === currentDayOfWeek),
      week: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        label: this._getWeekdayLabel(dayOfWeek),
        items: serializedLessons.filter((lesson) => lesson.dayOfWeek === dayOfWeek),
      })),
    };
  }

  async _buildGuardianAttendanceData({ schoolId, student }) {
    const studentId = this._extractId(student?.id || student?._id);
    const classId = this._extractId(student?.class?.id);

    if (!studentId) {
      return {
        summary: {
          totalRecords: 0,
          presentCount: 0,
          absentCount: 0,
          justifiedAbsences: 0,
          pendingJustifications: 0,
          rejectedJustifications: 0,
          expiredJustifications: 0,
          presenceRate: 0,
          lastRecordedAt: null,
          recentAbsences: 0,
          attentionLevel: 'neutral',
        },
        recentRecords: [],
      };
    }

    const query = {
      schoolId,
      'records.studentId': studentId,
    };

    if (classId) {
      query.classId = classId;
    }

    const history = await this.AttendanceModel.find(query)
      .sort({ date: -1, updatedAt: -1 })
      .select('date records updatedAt')
      .lean();

    const records = history
      .map((entry) => {
        const studentRecord = (Array.isArray(entry.records) ? entry.records : []).find(
          (record) => this._extractId(record.studentId) === studentId
        );

        if (!studentRecord) return null;

        const status =
          String(studentRecord.status || 'PRESENT').toUpperCase() === 'ABSENT'
            ? 'ABSENT'
            : 'PRESENT';
        const absenceState = status === 'ABSENT'
          ? String(studentRecord.absenceState || 'NONE').toUpperCase()
          : 'NONE';

        return {
          date: entry.date || null,
          status,
          absenceState,
          label: this._buildGuardianAttendanceLabel(status, absenceState),
          observation: studentRecord.observation || '',
          updatedAt:
            studentRecord.justificationUpdatedAt || entry.updatedAt || entry.date || null,
        };
      })
      .filter(Boolean)
      .sort((left, right) => new Date(right.date || 0) - new Date(left.date || 0));

    const presentCount = records.filter((record) => record.status === 'PRESENT').length;
    const absentCount = records.filter((record) => record.status === 'ABSENT').length;
    const justifiedAbsences = records.filter(
      (record) =>
        record.status === 'ABSENT' && record.absenceState === 'APPROVED'
    ).length;
    const pendingJustifications = records.filter(
      (record) =>
        record.status === 'ABSENT' && record.absenceState === 'PENDING'
    ).length;
    const rejectedJustifications = records.filter(
      (record) =>
        record.status === 'ABSENT' && record.absenceState === 'REJECTED'
    ).length;
    const expiredJustifications = records.filter(
      (record) =>
        record.status === 'ABSENT' && record.absenceState === 'EXPIRED'
    ).length;
    const totalRecords = records.length;
    const presenceRate =
      totalRecords === 0
        ? 0
        : Math.round((presentCount / totalRecords) * 10000) / 100;
    const recentAbsences = records.slice(0, 10).filter((record) => record.status === 'ABSENT').length;

    let attentionLevel = 'neutral';
    if (totalRecords > 0) {
      attentionLevel = presenceRate >= 90 && recentAbsences <= 1 ? 'good' : 'attention';
    }

    return {
      summary: {
        totalRecords,
        presentCount,
        absentCount,
        justifiedAbsences,
        pendingJustifications,
        rejectedJustifications,
        expiredJustifications,
        presenceRate,
        lastRecordedAt: records[0]?.date || null,
        recentAbsences,
        attentionLevel,
      },
      recentRecords: records.slice(0, 20),
    };
  }

  async _buildGuardianActivitiesData({ schoolId, student }) {
    const studentId = this._extractId(student?.id || student?._id);
    const classId = this._extractId(student?.class?.id);

    if (!studentId || !classId) {
      return {
        summary: {
          totalActivities: 0,
          deliveredCount: 0,
          pendingCount: 0,
          overdueCount: 0,
          recentCount: 0,
          lastActivity: null,
        },
        items: [],
      };
    }

    const activities = await this.ClassActivityModel.find({
      schoolId,
      classId,
      visibilityToGuardians: true,
      status: { $ne: 'CANCELLED' },
    })
      .select(
        '_id classId teacherId subjectId title description assignedAt dueDate correctionDate status visibilityToGuardians summary'
      )
      .lean();

    const sortedActivities = [...activities].sort((left, right) => {
      const leftDate = new Date(left.dueDate || left.assignedAt || left.createdAt || 0).getTime();
      const rightDate = new Date(
        right.dueDate || right.assignedAt || right.createdAt || 0
      ).getTime();
      return rightDate - leftDate;
    });

    const activityIds = sortedActivities.map((activity) => this._extractId(activity._id));
    const teacherIds = [
      ...new Set(
        sortedActivities.map((activity) => this._extractId(activity.teacherId)).filter(Boolean)
      ),
    ];
    const subjectIds = [
      ...new Set(
        sortedActivities.map((activity) => this._extractId(activity.subjectId)).filter(Boolean)
      ),
    ];

    const [submissions, teachers, subjects] = await Promise.all([
      activityIds.length
        ? this.ClassActivitySubmissionModel.find({
            schoolId,
            classId,
            studentId,
            activityId: { $in: activityIds },
          })
            .select(
              '_id activityId deliveryStatus submittedAt isCorrected correctedAt score teacherNote'
            )
            .lean()
        : [],
      teacherIds.length
        ? this.UserModel.find({ _id: { $in: teacherIds } })
            .select('_id fullName profilePictureUrl')
            .lean()
        : [],
      subjectIds.length
        ? this.SubjectModel.find({ _id: { $in: subjectIds } })
            .select('_id name level')
            .lean()
        : [],
    ]);

    const submissionByActivityId = new Map(
      submissions.map((submission) => [
        this._extractId(submission.activityId),
        submission,
      ])
    );
    const teacherById = new Map(
      teachers.map((teacher) => [this._extractId(teacher._id), teacher])
    );
    const subjectById = new Map(
      subjects.map((subject) => [this._extractId(subject._id), subject])
    );

    const nowTime = this._getNow().getTime();
    const items = sortedActivities.map((activity) => {
      const activityId = this._extractId(activity._id);
      const submission = submissionByActivityId.get(activityId) || null;
      const dueTime = activity.dueDate ? new Date(activity.dueDate).getTime() : null;
      const deliveryStatus = String(submission?.deliveryStatus || 'PENDING').toUpperCase();
      const isDelivered = ['DELIVERED', 'PARTIAL', 'EXCUSED'].includes(deliveryStatus);
      const isPending = ['PENDING', 'NOT_DELIVERED', 'PARTIAL'].includes(deliveryStatus);
      const isOverdue = Boolean(
        isPending && dueTime && dueTime < nowTime && !isDelivered
      );
      const teacher = teacherById.get(this._extractId(activity.teacherId)) || {};
      const subject = subjectById.get(this._extractId(activity.subjectId)) || {};

      return {
        id: activityId,
        title: activity.title || 'Atividade',
        description: activity.description || '',
        assignedAt: activity.assignedAt || null,
        dueDate: activity.dueDate || null,
        correctionDate: activity.correctionDate || null,
        status: activity.status || 'ACTIVE',
        workflowState: this._buildGuardianActivityWorkflowState(activity),
        subjectName: subject.name || '',
        teacherName: teacher.fullName || '',
        deliveryStatus,
        submittedAt: submission?.submittedAt || null,
        isCorrected: Boolean(submission?.isCorrected),
        correctedAt: submission?.correctedAt || null,
        score: submission?.score ?? null,
        teacherNote: submission?.teacherNote || '',
        isDelivered,
        isPending,
        isOverdue,
      };
    });

    const deliveredCount = items.filter((item) => item.isDelivered).length;
    const pendingCount = items.filter((item) => item.isPending && !item.isOverdue).length;
    const overdueCount = items.filter((item) => item.isOverdue).length;
    const recentCount = items.filter((item) => {
      const referenceDate = item.assignedAt || item.dueDate;
      if (!referenceDate) return false;
      const diff = nowTime - new Date(referenceDate).getTime();
      return diff <= 1000 * 60 * 60 * 24 * 21;
    }).length;

    const lastActivity = items[0]
      ? {
          id: items[0].id,
          title: items[0].title,
          dueDate: items[0].dueDate,
          subjectName: items[0].subjectName,
          teacherName: items[0].teacherName,
          deliveryStatus: items[0].deliveryStatus,
        }
      : null;

    return {
      summary: {
        totalActivities: items.length,
        deliveredCount,
        pendingCount,
        overdueCount,
        recentCount,
        lastActivity,
      },
      items,
    };
  }

  async findStudentsByPublicIdentity({ schoolId, studentFullName, birthDate }) {
    const fullNameNormalized = normalizeName(studentFullName);
    const birthDateKey = buildBirthDateKey(birthDate);
    const parsedBirthDate = parseDateInput(birthDate);

    if (!fullNameNormalized) {
      throw this._createHttpError(
        'Nome completo e data de nascimento sao obrigatorios.',
        400,
        { reason: 'invalid_student_name_payload' }
      );
    }

    if (!birthDateKey || !parsedBirthDate) {
      throw this._createHttpError(
        'Nome completo e data de nascimento sao obrigatorios.',
        400,
        { reason: 'invalid_birth_date_payload' }
      );
    }

    const filter = {
      fullNameNormalized,
      birthDateKey,
      isActive: true,
    };

    if (schoolId) {
      filter.school_id = schoolId;
    }

    this._debugLog('first-access.find-students.input', {
      schoolId: schoolId ? String(schoolId) : null,
    });

    const indexedMatches = await this.StudentModel.find(filter)
      .select(
        '_id fullName birthDate birthDateKey fullNameNormalized school_id financialTutorId tutors isActive'
      )
      .lean();

    this._debugLog('first-access.find-students.indexed-result', {
      matchesCount: indexedMatches.length,
      matchIds: indexedMatches.map((student) => String(student._id)),
    });

    if (indexedMatches.length) {
      return indexedMatches;
    }

    const dayStart = new Date(
      Date.UTC(
        parsedBirthDate.getUTCFullYear(),
        parsedBirthDate.getUTCMonth(),
        parsedBirthDate.getUTCDate()
      )
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const fallbackFilter = {
      birthDate: {
        $gte: dayStart,
        $lt: dayEnd,
      },
      isActive: true,
    };

    if (schoolId) {
      fallbackFilter.school_id = schoolId;
    }

    const fallbackCandidates = await this.StudentModel.find(fallbackFilter)
      .select(
        '_id fullName birthDate birthDateKey fullNameNormalized school_id financialTutorId tutors isActive'
      )
      .lean();

    const fallbackMatches = fallbackCandidates.filter((student) => {
      const candidateFullNameNormalized =
        student.fullNameNormalized || normalizeName(student.fullName);
      const candidateBirthDateKey =
        student.birthDateKey || buildBirthDateKey(student.birthDate);

      return (
        candidateFullNameNormalized === fullNameNormalized &&
        candidateBirthDateKey === birthDateKey
      );
    });

    this._debugLog('first-access.find-students.fallback-result', {
      candidatesCount: fallbackCandidates.length,
      matchesCount: fallbackMatches.length,
      matchIds: fallbackMatches.map((student) => String(student._id)),
    });

    return fallbackMatches;
  }

  async getSingleStudentByPublicIdentity({
    schoolId,
    studentFullName,
    birthDate,
  }) {
    const students = await this.findStudentsByPublicIdentity({
      schoolId,
      studentFullName,
      birthDate,
    });

    if (students.length === 0) {
      return { status: 'not_found', student: null };
    }

    if (students.length > 1) {
      return { status: 'ambiguous', student: null, students };
    }

    return { status: 'ok', student: students[0] };
  }

  async _buildStudentAmbiguityError(students = []) {
    const schoolIds = [...new Set(students.map((student) => String(student.school_id)).filter(Boolean))];

    if (schoolIds.length > 1) {
      const candidateSchools = await this._listSchoolSummariesByIds(schoolIds);

      if (candidateSchools.length > 1) {
        const message =
          'Encontramos mais de uma escola com um aluno compativel. Selecione a escola para continuar.';

        return this._createHttpError(message, 409, {
          payload: {
            status: 'student_ambiguous',
            ambiguityType: 'across_schools',
            message,
            candidateSchools,
          },
        });
      }
    }

    const message =
      'Encontramos mais de um cadastro compativel. Procure a secretaria para continuar.';

    return this._createHttpError(message, 409, {
      payload: {
        status: 'student_ambiguous',
        ambiguityType: 'within_school',
        message,
      },
    });
  }

  _buildDuplicateCpfMapFromTutors(tutors = []) {
    const buckets = new Map();

    tutors.forEach((tutor) => {
      const effectiveCpfNormalized =
        tutor.effectiveCpfNormalized || tutor.cpfNormalized || normalizeCpf(tutor.cpf);

      if (!effectiveCpfNormalized) return;

      if (!buckets.has(effectiveCpfNormalized)) {
        buckets.set(effectiveCpfNormalized, []);
      }

      buckets.get(effectiveCpfNormalized).push(String(tutor._id));
    });

    return new Map(
      [...buckets.entries()].filter(([, tutorIds]) => tutorIds.length > 1)
    );
  }

  _buildTutorRelationshipMap(student = {}) {
    const relationshipByTutorId = new Map();

    if (student.financialTutorId) {
      relationshipByTutorId.set(
        String(student.financialTutorId),
        'Responsavel Financeiro'
      );
    }

    const tutorLinks = Array.isArray(student.tutors) ? student.tutors : [];

    tutorLinks.forEach((link) => {
      const tutorId = link?.tutorId?._id || link?.tutorId;
      if (!tutorId) return;

      const relationship = link.relationship || 'Responsavel';
      if (!relationshipByTutorId.has(String(tutorId))) {
        relationshipByTutorId.set(String(tutorId), relationship);
      }
    });

    return relationshipByTutorId;
  }

  async resolveEligibleGuardiansByStudent(studentOrId, schoolId = null) {
    let student = studentOrId;

    if (!studentOrId || typeof studentOrId !== 'object' || !studentOrId._id) {
      student = await this.StudentModel.findOne({
        _id: studentOrId,
        school_id: schoolId,
      })
        .select('_id school_id fullName financialTutorId tutors')
        .lean();
    }

    if (!student) {
      throw this._createHttpError('Aluno nao encontrado.', 404);
    }

    const resolvedSchoolId = schoolId || student.school_id;
    const relationshipByTutorId = this._buildTutorRelationshipMap(student);
    const tutorIds = [...relationshipByTutorId.keys()];

    if (!tutorIds.length) {
      return [];
    }

    const tutors = await this.TutorModel.find({
      _id: { $in: tutorIds },
      school_id: resolvedSchoolId,
    })
      .select('_id fullName cpf cpfNormalized school_id students')
      .lean();

    const tutorsWithEffectiveCpf = tutors.map((tutor) => ({
      ...tutor,
      effectiveCpfNormalized: this._getEffectiveTutorCpfNormalized(tutor),
    }));

    const duplicateCpfMap =
      this._buildDuplicateCpfMapFromTutors(tutorsWithEffectiveCpf);

    this._debugLog('first-access.guardian-eligibility', {
      studentId: String(student._id),
      schoolId: String(resolvedSchoolId),
      relatedTutorIds: tutorIds,
      eligibleTutorsCount: tutorsWithEffectiveCpf.length,
      duplicateCpfCount: duplicateCpfMap.size,
    });

    const guardianBucketByCpf = new Map();

    tutorsWithEffectiveCpf
      .filter((tutor) => tutor.effectiveCpfNormalized)
      .forEach((tutor) => {
        const bucketKey = String(tutor.effectiveCpfNormalized);
        const relationship =
          relationshipByTutorId.get(String(tutor._id)) || 'Responsavel';
        const isFinancialTutor =
          String(student.financialTutorId || '') === String(tutor._id);
        const candidate = {
          tutorId: String(tutor._id),
          fullName: tutor.fullName,
          relationship,
          cpfNormalized: tutor.effectiveCpfNormalized,
          identifierType: 'cpf',
          identifierMasked: maskCpf(tutor.effectiveCpfNormalized),
          _score: isFinancialTutor ? 2 : relationship !== 'Responsavel' ? 1 : 0,
        };

        const existing = guardianBucketByCpf.get(bucketKey);
        if (!existing || candidate._score > existing._score) {
          guardianBucketByCpf.set(bucketKey, candidate);
        }
      });

    return [...guardianBucketByCpf.values()]
      .map(({ _score, ...guardian }) => guardian)
      .sort((left, right) =>
        String(left.fullName || '').localeCompare(
          String(right.fullName || ''),
          'pt-BR'
        )
      );
  }

  async _createFirstAccessChallenge({
    schoolId,
    studentId,
    guardians,
    requestMeta = {},
  }) {
    const now = this._getNow();
    const auditContext = this._buildAuditContext(requestMeta);

    return this.GuardianFirstAccessChallengeModel.create({
      school_id: schoolId,
      studentId,
      candidateGuardians: guardians.map((guardian) => ({
        optionId: this._randomToken(8),
        tutorId: guardian.tutorId,
        displayName: guardian.fullName,
        relationship: guardian.relationship,
      })),
      stage: 'awaiting_selection',
      expiresAt: this._addMinutes(now, CHALLENGE_TTL_MINUTES),
      ...auditContext,
    });
  }

  async _loadChallenge(challengeId, { includeVerificationHash = false } = {}) {
    if (!challengeId) {
      throw this._createHttpError('challengeId obrigatorio.', 400, {
        reason: 'challenge_invalid_or_expired',
      });
    }

    const query = this.GuardianFirstAccessChallengeModel.findById(challengeId);
    query.select(
      [
        'school_id',
        'studentId',
        'candidateGuardians',
        'selectedTutorId',
        'existingAccountId',
        'pinMode',
        'stage',
        'failedCpfAttempts',
        'verifiedAt',
        'completedAt',
        'expiresAt',
        'ipHash',
        'ipMasked',
        'userAgentHash',
        'userAgentSummary',
        'cpfHash',
        'cpfMasked',
        'devicePlatform',
        'appVersion',
        'source',
        'correlationId',
        includeVerificationHash ? '+verificationTokenHash' : null,
      ]
        .filter(Boolean)
        .join(' ')
    );

    const challenge = await query;

    if (!challenge) {
      throw this._createHttpError('Challenge nao encontrado.', 404, {
        reason: 'challenge_invalid_or_expired',
      });
    }

    const now = this._getNow();
    if (challenge.expiresAt && new Date(challenge.expiresAt) <= now) {
      challenge.stage = 'expired';
      await challenge.save();
      throw this._createHttpError('Challenge expirado.', 410, {
        reason: 'challenge_invalid_or_expired',
      });
    }

    if (challenge.stage === 'blocked') {
      throw this._createHttpError(
        'Tentativas excedidas para este primeiro acesso.',
        423,
        { reason: 'challenge_invalid_or_expired' }
      );
    }

    if (challenge.stage === 'completed') {
      throw this._createHttpError('Este primeiro acesso ja foi concluido.', 409, {
        reason: 'challenge_invalid_or_expired',
      });
    }

    if (challenge.stage === 'expired') {
      throw this._createHttpError('Challenge expirado.', 410, {
        reason: 'challenge_invalid_or_expired',
      });
    }

    return challenge;
  }

  async _incrementChallengeFailure(challenge, metadata = {}) {
    challenge.failedCpfAttempts = Number(challenge.failedCpfAttempts || 0) + 1;

    if (challenge.failedCpfAttempts >= MAX_CHALLENGE_CPF_FAILURES) {
      challenge.stage = 'blocked';
    }

    await challenge.save();

    await this._registerEvent({
      schoolId: challenge.school_id,
      challengeId: challenge._id,
      studentId: challenge.studentId,
      tutorId: challenge.selectedTutorId,
      actorType: 'public',
      eventType: GUARDIAN_ACCESS_EVENT_TYPES.RESPONSIBLE_VERIFICATION_FAILED,
      metadata: {
        attempts: challenge.failedCpfAttempts,
        blocked: challenge.stage === 'blocked',
        ...metadata,
      },
      ...this._auditContextFromChallenge(challenge),
    });
  }

  async _findTutorForChallenge(challenge, optionId) {
    const candidate = Array.isArray(challenge.candidateGuardians)
      ? challenge.candidateGuardians.find(
          (item) => String(item.optionId) === String(optionId)
        )
      : null;

    if (!candidate?.tutorId) {
      this._debugLog('first-access.verify-responsible.challenge-tutor-missing', {
        challengeId: challenge?._id ? String(challenge._id) : null,
        optionId: optionId || null,
        candidateGuardians: Array.isArray(challenge?.candidateGuardians)
          ? challenge.candidateGuardians.map((item) => ({
              optionId: item.optionId,
              tutorId: item.tutorId ? String(item.tutorId) : null,
            }))
          : [],
        reason: 'tutor_not_found_in_challenge',
      });

      throw this._createHttpError(
        'Responsavel selecionado nao encontrado para este challenge.',
        400,
        { reason: 'tutor_not_found_in_challenge' }
      );
    }

    const tutor = await this.TutorModel.findOne({
      _id: candidate.tutorId,
      school_id: challenge.school_id,
    })
      .select('_id fullName cpf cpfNormalized school_id students')
      .lean();

    if (!tutor) {
      this._debugLog('first-access.verify-responsible.tutor-not-found', {
        challengeId: challenge?._id ? String(challenge._id) : null,
        optionId: optionId || null,
        selectedTutorId: candidate?.tutorId ? String(candidate.tutorId) : null,
        schoolId: challenge?.school_id ? String(challenge.school_id) : null,
        reason: 'tutor_not_found_in_challenge',
      });

      throw this._createHttpError('Responsavel nao encontrado.', 404, {
        reason: 'tutor_not_found_in_challenge',
      });
    }

    return { candidate, tutor };
  }

  async _persistTutorCpfNormalizedIfMissing({ tutorId, cpfNormalized }) {
    if (!tutorId || !cpfNormalized) return false;
    if (typeof this.TutorModel.updateOne !== 'function') return false;

    try {
      const result = await this.TutorModel.updateOne(
        { _id: tutorId, $or: [{ cpfNormalized: null }, { cpfNormalized: '' }] },
        { $set: { cpfNormalized } }
      );

      return Boolean(result?.modifiedCount || result?.matchedCount);
    } catch (error) {
      this._debugLog('first-access.verify-responsible.persist-cpf-normalized-failed', {
        tutorId: String(tutorId),
        message: error?.message || 'unknown_error',
      });
      return false;
    }
  }

  async _loadChallengeTutor(challenge) {
    if (!challenge?.selectedTutorId) {
      throw this._createHttpError('Responsavel nao encontrado.', 404, {
        reason: 'tutor_not_found_in_challenge',
      });
    }

    const tutor = await this.TutorModel.findOne({
      _id: challenge.selectedTutorId,
      school_id: challenge.school_id,
    })
      .select('_id fullName cpf cpfNormalized school_id')
      .lean();

    if (!tutor) {
      throw this._createHttpError('Responsavel nao encontrado.', 404, {
        reason: 'tutor_not_found_in_challenge',
      });
    }

    return tutor;
  }

  async _validateChallengeVerificationToken({
    challenge,
    verificationToken,
    failedEventType,
  }) {
    if (
      !verificationToken ||
      this._hashValue(verificationToken) !== challenge.verificationTokenHash
    ) {
      await this._registerEvent({
        schoolId: challenge.school_id,
        challengeId: challenge._id,
        studentId: challenge.studentId,
        tutorId: challenge.selectedTutorId,
        actorType: 'public',
        eventType: failedEventType,
        metadata: { reason: 'invalid_verification_token' },
        ...this._auditContextFromChallenge(challenge),
      });

      throw this._createHttpError('Token de verificacao invalido.', 401);
    }
  }

  async _upsertGuardianStudentLink({
    schoolId,
    accountId,
    studentId,
    tutorId,
    relationshipSnapshot = 'Responsavel',
    source = 'first_access',
    session = null,
  }) {
    const query = this.GuardianAccessLinkModel.findOneAndUpdate(
      {
        school_id: schoolId,
        guardianAccessAccountId: accountId,
        studentId,
      },
      {
        $set: {
          guardianAccessAccountId: accountId,
          tutorId,
          relationshipSnapshot,
          source,
          status: 'active',
          revokedAt: null,
        },
        $setOnInsert: {
          linkedAt: this._getNow(),
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        ...(session ? { session } : {}),
      }
    );
    return query;
  }

  async _findExistingGuardianAccountForTutor({
    schoolId,
    tutor,
    includePinHash = false,
  }) {
    const identifierNormalized = this._getEffectiveTutorCpfNormalized(tutor);
    if (!identifierNormalized) return null;

    return this._findGuardianAccountByIdentifier({
      schoolId,
      identifierNormalized,
      includePinHash,
    });
  }

  async _findOrCreateGuardianAccount({ schoolId, tutor, pin, session = null }) {
    const identifierNormalized = tutor?.cpfNormalized || normalizeCpf(tutor?.cpf);

    if (!identifierNormalized) {
      throw this._createHttpError('Responsavel sem CPF elegivel.', 400);
    }

    const pinHash = await this.bcrypt.hash(String(pin), PIN_SALT_ROUNDS);
    const identifierMasked = maskCpf(identifierNormalized);

    let accountQuery = this.GuardianAccessAccountModel.findOne({
      school_id: schoolId,
      $or: [{ tutorId: tutor._id }, { identifierNormalized }],
    }).select('+pinHash');
    accountQuery = this._withSession(accountQuery, session);
    const account = await accountQuery;

    if (account) {
      throw this._createHttpError(
        String(account.tutorId) !== String(tutor._id)
          ? 'CPF duplicado em contas de responsavel na mesma escola.'
          : 'Ja existe uma conta para este responsavel. Use a recuperacao de PIN.',
        409,
        { reason: 'pin_recovery_required' }
      );
    }

    const payload = {
      school_id: schoolId,
      tutorId: tutor._id,
      identifierType: 'cpf',
      identifierNormalized,
      identifierMasked,
      pinHash,
      status: 'active',
      activatedAt: this._getNow(),
      pinUpdatedAt: this._getNow(),
      failedLoginCount: 0,
      blockedUntil: null,
      lastFailedAt: null,
    };

    if (session) {
      const created = await this.GuardianAccessAccountModel.create([payload], {
        session,
      });
      return created[0];
    }

    return this.GuardianAccessAccountModel.create(payload);
  }

  async _syncAccountLinksForTutor({
    schoolId,
    tutorId,
    accountId,
    source = 'sync',
  }) {
    const students = await this.StudentModel.find({
      school_id: schoolId,
      isActive: true,
      $or: [{ financialTutorId: tutorId }, { 'tutors.tutorId': tutorId }],
    })
      .select('_id financialTutorId tutors')
      .lean();

    const syncedLinks = [];

    for (const student of students) {
      let relationshipSnapshot = 'Responsavel';

      if (String(student.financialTutorId || '') === String(tutorId)) {
        relationshipSnapshot = 'Responsavel Financeiro';
      } else {
        const tutorLink = Array.isArray(student.tutors)
          ? student.tutors.find(
              (item) => String(item?.tutorId?._id || item?.tutorId) === String(tutorId)
            )
          : null;

        if (tutorLink?.relationship) {
          relationshipSnapshot = tutorLink.relationship;
        }
      }

      const link = await this._upsertGuardianStudentLink({
        schoolId,
        accountId,
        studentId: student._id,
        tutorId,
        relationshipSnapshot,
        source,
      });

      syncedLinks.push(link);
    }

    await this._registerEvent({
      schoolId,
      accountId,
      tutorId,
      actorType: 'system',
      eventType: GUARDIAN_ACCESS_EVENT_TYPES.STUDENT_LINK_SYNCED,
      metadata: {
        linkedStudentsCount: syncedLinks.length,
        source,
      },
    });

    return syncedLinks;
  }

  _buildAccountSummary(account, tutor = null, relationship = 'Responsavel') {
    const temporary = account.temporaryAccess;
    const temporaryActive = Boolean(temporary?.expiresAt && !temporary.usedAt && !temporary.revokedAt && new Date(temporary.expiresAt) > this._getNow());
    return {
      accountId: String(account._id),
      tutorId: String(account.tutorId),
      guardianName: tutor?.fullName || null,
      relationship,
      identifierType: account.identifierType,
      identifierMasked: account.identifierMasked,
      status: this._getAccountStatus(account),
      createdAt: account.createdAt || null,
      activatedAt: account.activatedAt || null,
      pinUpdatedAt: account.pinUpdatedAt || null,
      lastLoginAt: account.lastLoginAt || null,
      failedLoginCount: Number(account.failedLoginCount || 0),
      blockedUntil: account.blockedUntil || null,
      temporaryAccess: { active: temporaryActive, expiresAt: temporaryActive ? temporary.expiresAt : null },
    };
  }

  async startFirstAccess({
    schoolPublicId,
    studentFullName,
    birthDate,
    requestMeta = {},
  }) {
    const requestAuditContext = this._buildAuditContext(requestMeta);
    this._debugLog('first-access.request', {
      schoolPublicId: schoolPublicId || null,
      correlationId: requestAuditContext.correlationId,
    });

    let school = null;
    let studentResult = null;

    if (schoolPublicId) {
      school = await this.resolveSchoolByPublicIdentifier(schoolPublicId);
      studentResult = await this.getSingleStudentByPublicIdentity({
        schoolId: school._id,
        studentFullName,
        birthDate,
      });
    } else {
      studentResult = await this.getSingleStudentByPublicIdentity({
        studentFullName,
        birthDate,
      });

      if (studentResult.status === 'ok') {
        school = await this._getSchoolSummaryById(studentResult.student.school_id);
      }
    }

    if (studentResult.status === 'not_found') {
      this._debugLog('first-access.discarded', {
        reason: 'student_not_found',
        schoolId: school?._id ? String(school._id) : null,
      });

      if (school?._id) {
        await this._registerEvent({
          schoolId: school._id,
          actorType: 'public',
          eventType: GUARDIAN_ACCESS_EVENT_TYPES.FIRST_ACCESS_FAILED,
          metadata: { reason: 'student_not_found' },
          ...requestAuditContext,
        });
      }

      throw this._createHttpError(
        'Nao foi possivel validar as informacoes informadas.',
        404,
        { reason: 'student_not_found' }
      );
    }

    if (studentResult.status === 'ambiguous') {
      this._debugLog('first-access.discarded', {
        reason: 'student_ambiguous',
        schoolId: school?._id ? String(school._id) : null,
        matchIds: studentResult.students.map((student) => String(student._id)),
      });

      if (school?._id) {
        await this._registerEvent({
          schoolId: school._id,
          actorType: 'public',
          eventType: GUARDIAN_ACCESS_EVENT_TYPES.FIRST_ACCESS_FAILED,
          metadata: {
            reason: 'student_ambiguous',
            matches: studentResult.students.length,
          },
          ...requestAuditContext,
        });
      }

      throw await this._buildStudentAmbiguityError(studentResult.students);
    }

    if (!school?._id) {
      throw this._createHttpError('Escola nao encontrada.', 404);
    }

    const guardians = await this.resolveEligibleGuardiansByStudent(
      studentResult.student,
      school._id
    );

    if (!guardians.length) {
      this._debugLog('first-access.discarded', {
        reason: 'student_found_but_no_eligible_guardians',
        schoolId: String(school._id),
        studentId: String(studentResult.student._id),
      });

      await this._registerEvent({
        schoolId: school._id,
        studentId: studentResult.student._id,
        actorType: 'public',
        eventType: GUARDIAN_ACCESS_EVENT_TYPES.FIRST_ACCESS_FAILED,
        metadata: { reason: 'no_eligible_guardian' },
        ...requestAuditContext,
      });

      throw this._createHttpError(
        'Nao foi possivel validar as informacoes informadas.',
        404,
        { reason: 'student_found_but_no_eligible_guardians' }
      );
    }

    this._debugLog('first-access.success', {
      schoolId: String(school._id),
      studentId: String(studentResult.student._id),
      guardiansCount: guardians.length,
      guardianTutorIds: guardians.map((guardian) => guardian.tutorId),
    });

    const challenge = await this._createFirstAccessChallenge({
      schoolId: school._id,
      studentId: studentResult.student._id,
      guardians,
      requestMeta,
    });

    await this._registerEvent({
      schoolId: school._id,
      studentId: studentResult.student._id,
      challengeId: challenge._id,
      actorType: 'public',
      eventType: GUARDIAN_ACCESS_EVENT_TYPES.FIRST_ACCESS_STARTED,
      metadata: {
        guardiansCount: guardians.length,
      },
      ...this._auditContextFromChallenge(challenge),
    });

    return {
      status: 'challenge_started',
      challengeId: String(challenge._id),
      guardians: challenge.candidateGuardians.map((guardian) => ({
        optionId: guardian.optionId,
        displayName: guardian.displayName,
        relationship: guardian.relationship || 'Responsavel',
      })),
      school: this._buildSchoolResponse(school),
      message: 'Responsaveis encontrados para este aluno.',
    };
  }

  async verifyResponsible({ challengeId, optionId, cpf }) {
    const normalizedCpf = normalizeCpf(cpf);
    let challenge = null;

    this._debugLog('first-access.verify-responsible.received', {
      challengeId: challengeId || null,
      optionId: optionId || null,
    });

    try {
      challenge = await this._loadChallenge(challengeId);
    } catch (error) {
      this._debugLog('first-access.verify-responsible.challenge-failed', {
        challengeId: challengeId || null,
        optionId: optionId || null,
        reason: error?.reason || 'challenge_invalid_or_expired',
        message: error?.message || null,
      });
      throw error;
    }

    if (challenge.stage !== 'awaiting_selection') {
      throw this._createHttpError(
        'Este primeiro acesso nao aceita mais validacao de responsavel.',
        409,
        { reason: 'challenge_invalid_or_expired' }
      );
    }

    const { candidate, tutor } = await this._findTutorForChallenge(
      challenge,
      optionId
    );

    const tutorCpfNormalized =
      typeof tutor.cpfNormalized === 'string' && tutor.cpfNormalized.trim()
        ? tutor.cpfNormalized.trim()
        : null;
    const legacyCpfNormalized = normalizeCpf(tutor.cpf);
    const effectiveTutorCpfNormalized =
      tutorCpfNormalized || legacyCpfNormalized;
    const isLegacyTutorWithoutNormalized =
      !tutorCpfNormalized && Boolean(legacyCpfNormalized);

    this._debugLog('first-access.verify-responsible.loaded-tutor', {
      challengeId: String(challenge._id),
      optionId: optionId || null,
      selectedTutorId: String(candidate.tutorId),
      challengeSelectedTutorId: challenge.selectedTutorId
        ? String(challenge.selectedTutorId)
        : null,
      tutorId: tutor?._id ? String(tutor._id) : null,
      schoolId: tutor?.school_id ? String(tutor.school_id) : null,
    });

    if (!normalizedCpf || !isValidCpf(normalizedCpf)) {
      this._debugLog('first-access.verify-responsible.failed', {
        challengeId: String(challenge._id),
        optionId: optionId || null,
        selectedTutorId: String(candidate.tutorId),
        reason: 'invalid_cpf_format',
      });

      await this._incrementChallengeFailure(challenge, {
        reason: 'invalid_cpf_format',
        tutorId: String(candidate.tutorId),
      });

      throw this._createHttpError(
        'Nao foi possivel validar o responsavel.',
        challenge.stage === 'blocked' ? 423 : 400
      );
    }

    if (!effectiveTutorCpfNormalized) {
      this._debugLog('first-access.verify-responsible.failed', {
        challengeId: String(challenge._id),
        optionId: optionId || null,
        selectedTutorId: String(candidate.tutorId),
        comparisonResult: false,
        reason: 'tutor_cpf_missing',
      });

      await this._incrementChallengeFailure(challenge, {
        reason: 'tutor_cpf_missing',
        tutorId: String(candidate.tutorId),
      });

      throw this._createHttpError(
        'Nao foi possivel validar o responsavel.',
        challenge.stage === 'blocked' ? 423 : 401,
        { reason: 'tutor_cpf_missing' }
      );
    }

    if (String(effectiveTutorCpfNormalized) !== normalizedCpf) {
      this._debugLog('first-access.verify-responsible.failed', {
        challengeId: String(challenge._id),
        optionId: optionId || null,
        selectedTutorId: String(candidate.tutorId),
        comparisonResult: false,
        reason: 'tutor_cpf_mismatch',
      });

      await this._incrementChallengeFailure(challenge, {
        reason: 'tutor_cpf_mismatch',
        tutorId: String(candidate.tutorId),
      });

      throw this._createHttpError(
        'Nao foi possivel validar o responsavel.',
        challenge.stage === 'blocked' ? 423 : 401,
        { reason: 'tutor_cpf_mismatch' }
      );
    }

    let persistedLegacyCpfNormalized = false;
    if (isLegacyTutorWithoutNormalized) {
      persistedLegacyCpfNormalized = await this._persistTutorCpfNormalizedIfMissing({
        tutorId: tutor._id,
        cpfNormalized: effectiveTutorCpfNormalized,
      });
    }

    this._debugLog('first-access.verify-responsible.comparison', {
      challengeId: String(challenge._id),
      optionId: optionId || null,
      selectedTutorId: String(candidate.tutorId),
      comparisonResult: true,
      reason: isLegacyTutorWithoutNormalized
        ? 'tutor_cpf_legacy_not_normalized'
        : 'responsible_verified',
      persistedLegacyCpfNormalized,
    });

    const existingAccount = await this._findExistingGuardianAccountForTutor({
      schoolId: challenge.school_id,
      tutor,
      includePinHash: true,
    });
    const existingLink = existingAccount
      ? await this.GuardianAccessLinkModel.findOne({
          school_id: challenge.school_id,
          guardianAccessAccountId: existingAccount._id,
          studentId: challenge.studentId,
          status: 'active',
        })
      : null;

    if (
      existingAccount &&
      (!existingAccount.pinHash || existingAccount.status === 'pending')
    ) {
      challenge.stage = 'completed';
      challenge.completedAt = this._getNow();
      challenge.verificationTokenHash = null;
      await challenge.save();

      throw this._createHttpError(
        'Use a opcao Esqueci meu PIN para recuperar este acesso.',
        409,
        { reason: 'pin_recovery_required' }
      );
    }

    if (existingAccount?.status === 'inactive') {
      throw this._createHttpError(
        'Este acesso esta indisponivel. Procure a escola.',
        403,
        { reason: 'guardian_account_inactive' }
      );
    }

    challenge.selectedTutorId = tutor._id;
    challenge.cpfHash = this._hashSensitiveValue(normalizedCpf);
    challenge.cpfMasked = maskCpf(normalizedCpf);
    challenge.failedCpfAttempts = 0;
    challenge.verifiedAt = this._getNow();
    challenge.existingAccountId = existingAccount?._id || null;

    if (existingLink) {
      challenge.stage = 'completed';
      challenge.completedAt = this._getNow();
      challenge.pinMode = 'link_existing';
      challenge.verificationTokenHash = null;
      await challenge.save();

      await this._registerEventBestEffort('first-access.student-already-linked.event-failed', {
        schoolId: challenge.school_id,
        accountId: existingAccount._id,
        linkId: existingLink._id,
        challengeId: challenge._id,
        studentId: challenge.studentId,
        tutorId: tutor._id,
        actorType: 'public',
        eventType: GUARDIAN_ACCESS_EVENT_TYPES.STUDENT_ALREADY_LINKED,
        metadata: {
          optionId,
          legacyCpfNormalizedRecovered: isLegacyTutorWithoutNormalized,
          legacyCpfNormalizedPersisted: persistedLegacyCpfNormalized,
        },
        ...this._auditContextFromChallenge(challenge),
      });

      return {
        status: 'student_already_linked',
        identifierType: 'cpf',
        identifierMasked: existingAccount.identifierMasked,
        message: 'Este aluno ja esta disponivel nesta conta.',
      };
    }

    const verificationToken = this._randomToken();
    challenge.pinMode = existingAccount ? 'link_existing' : 'create';
    challenge.verificationTokenHash = this._hashValue(verificationToken);
    challenge.stage = 'awaiting_pin';
    challenge.completedAt = null;
    await challenge.save();

    await this._registerEvent({
      schoolId: challenge.school_id,
      accountId: existingAccount?._id || null,
      challengeId: challenge._id,
      studentId: challenge.studentId,
      tutorId: tutor._id,
      actorType: 'public',
      eventType: GUARDIAN_ACCESS_EVENT_TYPES.RESPONSIBLE_VERIFIED,
      metadata: {
        optionId,
        nextAction: existingAccount ? 'link_existing_account' : 'create_pin',
        legacyCpfNormalizedRecovered: isLegacyTutorWithoutNormalized,
        legacyCpfNormalizedPersisted: persistedLegacyCpfNormalized,
      },
      ...this._auditContextFromChallenge(challenge),
    });

    return {
      status: existingAccount
        ? 'existing_account_requires_pin'
        : 'new_account_requires_pin',
      verificationToken,
      identifierType: 'cpf',
      identifierMasked:
        existingAccount?.identifierMasked || maskCpf(effectiveTutorCpfNormalized),
      message: existingAccount
        ? 'Conta existente encontrada. Informe o PIN atual para vincular este aluno.'
        : 'Responsavel validado com sucesso. Crie o PIN para concluir o acesso.',
    };
  }

  async _consumePinRecoveryRateLimit({ scope, keyHash, limit }) {
    if (!keyHash) return { count: 0, blocked: false };

    const now = this._getNow();
    const windowMs = PIN_RECOVERY_WINDOW_MINUTES * 60 * 1000;
    const windowStartedAt = new Date(
      Math.floor(now.getTime() / windowMs) * windowMs
    );
    const expiresAt = new Date(windowStartedAt.getTime() + windowMs * 2);
    const filter = { scope, keyHash, windowStartedAt };
    const update = {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt },
    };

    let record;
    try {
      record = await this.GuardianPinRecoveryRateLimitModel.findOneAndUpdate(
        filter,
        update,
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
      record = await this.GuardianPinRecoveryRateLimitModel.findOneAndUpdate(
        filter,
        update,
        { new: true }
      );
    }

    const count = Number(record?.count || 0);
    return { count, blocked: count > limit };
  }

  async _assertPinRecoveryRateLimit({
    cpfHash,
    ipHash,
    schoolId = null,
    auditContext = {},
  }) {
    const cpfLimit = await this._consumePinRecoveryRateLimit({
      scope: 'cpf',
      keyHash: cpfHash,
      limit: MAX_PIN_RECOVERY_STARTS_PER_CPF,
    });
    const ipLimit = ipHash
      ? await this._consumePinRecoveryRateLimit({
          scope: 'ip',
          keyHash: ipHash,
          limit: MAX_PIN_RECOVERY_STARTS_PER_IP,
        })
      : { count: 0, blocked: false };

    if (!cpfLimit.blocked && !ipLimit.blocked) {
      return;
    }

    if (schoolId) {
      await this._registerEventBestEffort('pin-recovery.rate-limit.event-failed', {
        schoolId,
        actorType: 'public',
        eventType: GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_BLOCKED,
        metadata: {
          reason: 'rate_limit',
          scope: cpfLimit.blocked ? 'identity' : 'ip',
        },
        ...auditContext,
      });
    }

    throw this._createHttpError(PIN_RECOVERY_LIMIT_MESSAGE, 429, {
      reason: 'pin_recovery_rate_limited',
    });
  }

  async _findStudentsForPinRecovery({
    schoolId = null,
    studentFullName,
    studentBirthDate,
  }) {
    const fullNameNormalized = normalizeName(studentFullName);
    const birthDateKey = buildBirthDateKey(studentBirthDate);
    const parsedBirthDate = parseDateInput(studentBirthDate);

    if (!fullNameNormalized || !birthDateKey || !parsedBirthDate) {
      return [];
    }

    const indexedFilter = {
      fullNameNormalized,
      birthDateKey,
      isActive: true,
    };
    if (schoolId) indexedFilter.school_id = schoolId;

    const indexedMatches = await this.StudentModel.find(indexedFilter)
      .select(
        '_id fullName birthDate fullNameNormalized birthDateKey school_id financialTutorId tutors isActive'
      )
      .lean();

    if (indexedMatches.length) return indexedMatches;

    const dayStart = new Date(
      Date.UTC(
        parsedBirthDate.getUTCFullYear(),
        parsedBirthDate.getUTCMonth(),
        parsedBirthDate.getUTCDate()
      )
    );
    const fallbackFilter = {
      birthDate: {
        $gte: dayStart,
        $lt: new Date(dayStart.getTime() + 24 * 60 * 60 * 1000),
      },
      isActive: true,
    };
    if (schoolId) fallbackFilter.school_id = schoolId;

    const candidates = await this.StudentModel.find(fallbackFilter)
      .select(
        '_id fullName birthDate fullNameNormalized birthDateKey school_id financialTutorId tutors isActive'
      )
      .lean();

    return candidates.filter(
      (student) =>
        (student.fullNameNormalized || normalizeName(student.fullName)) ===
          fullNameNormalized &&
        (student.birthDateKey || buildBirthDateKey(student.birthDate)) ===
          birthDateKey
    );
  }

  async _findPinRecoveryMatches({
    cpfNormalized,
    studentFullName,
    studentBirthDate,
    guardianBirthDate,
    school = null,
  }) {
    const guardianBirthDateKey = buildBirthDateKey(guardianBirthDate);
    if (!guardianBirthDateKey) return [];

    const students = await this._findStudentsForPinRecovery({
      schoolId: school?._id || null,
      studentFullName,
      studentBirthDate,
    });
    const matches = [];

    for (const student of students) {
      const schoolId = student.school_id;
      const relationshipByTutorId = this._buildTutorRelationshipMap(student);
      const tutorIds = [...relationshipByTutorId.keys()];
      if (!schoolId || !tutorIds.length) continue;

      const tutors = await this.TutorModel.find({
        _id: { $in: tutorIds },
        school_id: schoolId,
      })
        .select('_id fullName birthDate cpf cpfNormalized school_id')
        .lean();

      for (const tutor of tutors) {
        const tutorCpf = this._getEffectiveTutorCpfNormalized(tutor);
        if (
          tutorCpf !== cpfNormalized ||
          buildBirthDateKey(tutor.birthDate) !== guardianBirthDateKey
        ) {
          continue;
        }

        // A guardian may be correctly registered on the student (including as
        // the financial guardian) before having ever created an app account.
        // It may also have an account created before CPF normalization was
        // introduced.  Recovery must validate the relationship first, then
        // reconcile the account by tutorId instead of treating either legacy
        // case as an invalid identity.
        const accounts = await this._findGuardianAccounts({
          school_id: schoolId,
          $or: [
            { tutorId: tutor._id },
            { identifierNormalized: cpfNormalized },
          ],
        });
        const accountForTutor = accounts.find(
          (item) => String(item.tutorId) === String(tutor._id)
        );
        const conflictingAccount = accounts.find(
          (item) => String(item.tutorId) !== String(tutor._id)
        );

        // The same CPF cannot safely identify two guardians at one school.
        // Keep the public response non-enumerable by excluding this match.
        if (conflictingAccount || accountForTutor?.status === 'inactive') {
          continue;
        }

        matches.push({
          schoolId: String(schoolId),
          student,
          tutor,
          account: accountForTutor || null,
          relationship:
            relationshipByTutorId.get(String(tutor._id)) || 'Responsavel',
        });
      }
    }

    return matches;
  }

  async _resolveGuardianAccountForPinRecovery({
    schoolId,
    tutor,
    session = null,
  }) {
    const identifierNormalized = this._getEffectiveTutorCpfNormalized(tutor);
    if (!schoolId || !tutor?._id || !identifierNormalized) {
      throw this._createHttpError(PIN_RECOVERY_GENERIC_MESSAGE, 409, {
        reason: 'pin_recovery_scope_changed',
      });
    }

    let accountQuery = this.GuardianAccessAccountModel.findOne({
      school_id: schoolId,
      tutorId: tutor._id,
    }).select('+pinHash');
    accountQuery = this._withSession(accountQuery, session);
    let account = await accountQuery;

    let conflictingAccountQuery = this.GuardianAccessAccountModel.findOne({
      school_id: schoolId,
      identifierNormalized,
      ...(account ? { _id: { $ne: account._id } } : {}),
    }).select('_id tutorId');
    conflictingAccountQuery = this._withSession(
      conflictingAccountQuery,
      session
    );
    const conflictingAccount = await conflictingAccountQuery;

    if (
      conflictingAccount &&
      String(conflictingAccount.tutorId) !== String(tutor._id)
    ) {
      throw this._createHttpError(PIN_RECOVERY_GENERIC_MESSAGE, 409, {
        reason: 'pin_recovery_scope_changed',
      });
    }

    if (!account && conflictingAccount) {
      accountQuery = this.GuardianAccessAccountModel.findOne({
        _id: conflictingAccount._id,
        school_id: schoolId,
        tutorId: tutor._id,
      }).select('+pinHash');
      accountQuery = this._withSession(accountQuery, session);
      account = await accountQuery;
    }

    if (account) return account;

    const now = this._getNow();
    const payload = {
      school_id: schoolId,
      tutorId: tutor._id,
      identifierType: 'cpf',
      identifierNormalized,
      identifierMasked: maskCpf(identifierNormalized),
      pinHash: null,
      status: 'pending',
      activatedAt: null,
      pinUpdatedAt: null,
      failedLoginCount: 0,
      lastFailedAt: null,
      blockedUntil: null,
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    };

    if (session) {
      const created = await this.GuardianAccessAccountModel.create([payload], {
        session,
      });
      return created[0];
    }

    return this.GuardianAccessAccountModel.create(payload);
  }

  async _failPinRecoveryStart(challenge, reason) {
    challenge.stage = 'failed';
    challenge.failedAttempts = Number(challenge.failedAttempts || 0) + 1;
    await challenge.save();

    if (challenge.school_id) {
      await this._registerEventBestEffort('pin-recovery.start-failed.event-failed', {
        schoolId: challenge.school_id,
        accountId: challenge.guardianAccessAccountId || null,
        recoveryChallengeId: challenge._id,
        studentId: challenge.studentId || null,
        tutorId: challenge.tutorId || null,
        actorType: 'public',
        eventType: GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_FAILED,
        metadata: { reason },
        ...this._auditContextFromChallenge(challenge),
      });
    }

    throw this._createHttpError(PIN_RECOVERY_GENERIC_MESSAGE, 400, {
      reason: 'pin_recovery_identity_not_confirmed',
    });
  }

  async startPinRecovery({
    cpf,
    studentFullName,
    studentBirthDate,
    guardianBirthDate,
    schoolPublicId,
    requestMeta = {},
  }) {
    const cpfDigits = String(cpf || '').replace(/\D/g, '');
    const cpfNormalized = normalizeCpf(cpfDigits);
    const auditContext = this._buildAuditContext(requestMeta, {
      cpf: cpfDigits || 'invalid',
    });
    const cpfHash = auditContext.cpfHash;
    const ipHash = auditContext.ipHash;
    let school = null;

    if ((schoolPublicId || '').trim()) {
      try {
        school = await this.resolveSchoolByPublicIdentifier(schoolPublicId);
      } catch (_) {
        school = null;
      }
    }

    await this._assertPinRecoveryRateLimit({
      cpfHash,
      ipHash,
      schoolId: school?._id || null,
      auditContext,
    });

    const now = this._getNow();
    const challenge = await this.GuardianPinRecoveryChallengeModel.create({
      school_id: school?._id || null,
      stage: 'attempted',
      failedAttempts: 0,
      expiresAt: this._addMinutes(now, PIN_RECOVERY_TTL_MINUTES),
      purgeAt: this._addMinutes(
        now,
        PIN_RECOVERY_TTL_MINUTES + PIN_RECOVERY_PURGE_DELAY_MINUTES
      ),
      ...auditContext,
    });

    if (
      !cpfNormalized ||
      !isValidCpf(cpfNormalized) ||
      !normalizeName(studentFullName) ||
      !buildBirthDateKey(studentBirthDate) ||
      !buildBirthDateKey(guardianBirthDate) ||
      ((schoolPublicId || '').trim() && !school)
    ) {
      return this._failPinRecoveryStart(challenge, 'identity_mismatch');
    }

    const matches = await this._findPinRecoveryMatches({
      cpfNormalized,
      studentFullName,
      studentBirthDate,
      guardianBirthDate,
      school,
    });

    const schoolIds = [...new Set(matches.map((match) => match.schoolId))];

    if (!school && schoolIds.length > 1) {
      const options = await this._listSchoolSummariesByIds(schoolIds);
      challenge.stage = 'failed';
      await challenge.save();

      return {
        schoolSelectionRequired: true,
        options: options.map((option) => ({
          schoolPublicId: option.schoolPublicId,
          schoolName: option.schoolName,
        })),
      };
    }

    if (matches.length !== 1) {
      if (!challenge.school_id && schoolIds.length === 1) {
        challenge.school_id = schoolIds[0];
      }
      return this._failPinRecoveryStart(challenge, 'identity_mismatch');
    }

    const [match] = matches;
    const verificationToken = this._randomToken();

    challenge.school_id = match.schoolId;
    challenge.guardianAccessAccountId = match.account?._id || null;
    challenge.studentId = match.student._id;
    challenge.tutorId = match.tutor._id;
    challenge.verificationTokenHash = this._hashValue(verificationToken);
    challenge.stage = 'awaiting_pin';
    challenge.failedAttempts = 0;
    await challenge.save();

    await this._registerEventBestEffort('pin-recovery.started.event-failed', {
      schoolId: match.schoolId,
      accountId: match.account?._id || null,
      recoveryChallengeId: challenge._id,
      studentId: match.student._id,
      tutorId: match.tutor._id,
      actorType: 'public',
      eventType: GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_STARTED,
      metadata: { expiresInSeconds: PIN_RECOVERY_TTL_MINUTES * 60 },
      ...this._auditContextFromChallenge(challenge),
    });

    return {
      challengeId: String(challenge._id),
      verificationToken,
      expiresInSeconds: PIN_RECOVERY_TTL_MINUTES * 60,
      schoolSelectionRequired: false,
    };
  }

  async _registerPinRecoveryChallengeFailure(challenge, reason) {
    challenge.failedAttempts = Number(challenge.failedAttempts || 0) + 1;
    const blocked =
      challenge.failedAttempts >= MAX_PIN_RECOVERY_CHALLENGE_FAILURES;
    challenge.stage = blocked ? 'blocked' : challenge.stage;
    await challenge.save();

    if (challenge.school_id) {
      await this._registerEventBestEffort(
        'pin-recovery.challenge-failed.event-failed',
        {
          schoolId: challenge.school_id,
          accountId: challenge.guardianAccessAccountId || null,
          recoveryChallengeId: challenge._id,
          studentId: challenge.studentId || null,
          tutorId: challenge.tutorId || null,
          actorType: 'public',
          eventType: blocked
            ? GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_BLOCKED
            : GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_FAILED,
          metadata: {
            reason,
            attempts: challenge.failedAttempts,
          },
          ...this._auditContextFromChallenge(challenge),
        }
      );
    }

    return blocked;
  }

  async expirePinRecoveryChallenges({ limit = 100 } = {}) {
    const now = this._getNow();
    const challenges = await this.GuardianPinRecoveryChallengeModel.find({
      expiresAt: { $lte: now },
      stage: { $in: ['attempted', 'awaiting_pin', 'processing'] },
    })
      .sort({ expiresAt: 1 })
      .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
    let expiredCount = 0;

    for (const challenge of challenges) {
      challenge.stage = 'expired';
      await challenge.save();
      expiredCount += 1;

      if (challenge.school_id) {
        await this._registerEventBestEffort(
          'pin-recovery.expiration-sweep.event-failed',
          {
            schoolId: challenge.school_id,
            accountId: challenge.guardianAccessAccountId || null,
            recoveryChallengeId: challenge._id,
            studentId: challenge.studentId || null,
            tutorId: challenge.tutorId || null,
            actorType: 'system',
            eventType: GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_EXPIRED,
            status: 'expired',
            source: 'system',
            reasonCode: 'challenge_expired',
            ...this._auditContextFromChallenge(challenge, 'system'),
          }
        );
      }
    }

    return { expiredCount };
  }

  async completePinRecovery({ challengeId, verificationToken, newPin }) {
    this._assertValidPin(newPin);

    if (!challengeId || !verificationToken) {
      throw this._createHttpError(PIN_RECOVERY_GENERIC_MESSAGE, 400, {
        reason: 'pin_recovery_challenge_invalid',
      });
    }

    const challengeQuery =
      this.GuardianPinRecoveryChallengeModel.findById(challengeId);
    challengeQuery.select('+verificationTokenHash');
    const challenge = await challengeQuery;

    if (!challenge) {
      throw this._createHttpError(PIN_RECOVERY_GENERIC_MESSAGE, 404, {
        reason: 'pin_recovery_challenge_invalid',
      });
    }

    const now = this._getNow();
    if (challenge.expiresAt && new Date(challenge.expiresAt) <= now) {
      challenge.stage = 'expired';
      await challenge.save();
      if (challenge.school_id) {
        await this._registerEventBestEffort(
          'pin-recovery.expired.event-failed',
          {
            schoolId: challenge.school_id,
            accountId: challenge.guardianAccessAccountId || null,
            recoveryChallengeId: challenge._id,
            studentId: challenge.studentId || null,
            tutorId: challenge.tutorId || null,
            actorType: 'public',
            eventType: GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_EXPIRED,
            status: 'expired',
            reasonCode: 'challenge_expired',
            ...this._auditContextFromChallenge(challenge),
          }
        );
      }
      throw this._createHttpError('O prazo para recuperacao expirou.', 410, {
        reason: 'pin_recovery_challenge_expired',
      });
    }

    if (challenge.stage === 'blocked') {
      throw this._createHttpError(PIN_RECOVERY_LIMIT_MESSAGE, 429, {
        reason: 'pin_recovery_rate_limited',
      });
    }

    if (challenge.stage !== 'awaiting_pin') {
      throw this._createHttpError(PIN_RECOVERY_GENERIC_MESSAGE, 409, {
        reason: 'pin_recovery_challenge_used',
      });
    }

    const submittedTokenHash = this._hashValue(verificationToken);
    const storedTokenHash = String(challenge.verificationTokenHash || '');
    const tokenMatches =
      submittedTokenHash.length === storedTokenHash.length &&
      this.crypto.timingSafeEqual(
        Buffer.from(submittedTokenHash),
        Buffer.from(storedTokenHash)
      );

    if (!tokenMatches) {
      const blocked = await this._registerPinRecoveryChallengeFailure(
        challenge,
        'invalid_verification_token'
      );
      throw this._createHttpError(
        blocked ? PIN_RECOVERY_LIMIT_MESSAGE : PIN_RECOVERY_GENERIC_MESSAGE,
        blocked ? 429 : 401,
        {
          reason: blocked
            ? 'pin_recovery_rate_limited'
            : 'pin_recovery_challenge_invalid',
        }
      );
    }

    const claimedChallenge =
      await this.GuardianPinRecoveryChallengeModel.findOneAndUpdate(
        {
          _id: challenge._id,
          stage: 'awaiting_pin',
          verificationTokenHash: submittedTokenHash,
          expiresAt: { $gt: now },
        },
        { $set: { stage: 'processing' } },
        { new: true }
      ).select('+verificationTokenHash');

    if (!claimedChallenge) {
      throw this._createHttpError(PIN_RECOVERY_GENERIC_MESSAGE, 409, {
        reason: 'pin_recovery_challenge_used',
      });
    }

    try {
      return await this._runCriticalMutation(async (session) => {
        let tutorQuery = this.TutorModel.findOne({
          _id: claimedChallenge.tutorId,
          school_id: claimedChallenge.school_id,
        })
          .select('_id cpf cpfNormalized school_id')
          .lean();
        tutorQuery = this._withSession(tutorQuery, session);
        const tutor = await tutorQuery;

        let studentQuery = this.StudentModel.findOne({
          _id: claimedChallenge.studentId,
          school_id: claimedChallenge.school_id,
          isActive: true,
          $or: [
            { financialTutorId: claimedChallenge.tutorId },
            { 'tutors.tutorId': claimedChallenge.tutorId },
          ],
        })
          .select('_id school_id financialTutorId tutors')
          .lean();
        studentQuery = this._withSession(studentQuery, session);
        const student = await studentQuery;

        const tutorCpf = tutor
          ? this._getEffectiveTutorCpfNormalized(tutor)
          : null;
        const tutorCpfHash = tutorCpf
          ? this._hashSensitiveValue(tutorCpf)
          : null;

        if (!tutor || !student || tutorCpfHash !== claimedChallenge.cpfHash) {
          throw this._createHttpError(PIN_RECOVERY_GENERIC_MESSAGE, 409, {
            reason: 'pin_recovery_scope_changed',
          });
        }

        const account = await this._resolveGuardianAccountForPinRecovery({
          schoolId: claimedChallenge.school_id,
          tutor,
          session,
        });

        if (account.status === 'inactive') {
          throw this._createHttpError(PIN_RECOVERY_GENERIC_MESSAGE, 409, {
            reason: 'pin_recovery_scope_changed',
          });
        }

        const tokenVersionBefore = Number(account.tokenVersion || 0);
        const tokenVersionAfter = tokenVersionBefore + 1;
        const auditContext = this._auditContextFromChallenge(claimedChallenge);

        // Canonicalize legacy account identifiers only after the recovery
        // challenge has proved the tutor CPF and student relationship.
        account.identifierType = 'cpf';
        account.identifierNormalized = tutorCpf;
        account.identifierMasked = maskCpf(tutorCpf);
        account.pinHash = await this.bcrypt.hash(
          String(newPin),
          PIN_SALT_ROUNDS
        );
        account.status = 'active';
        account.activatedAt = account.activatedAt || now;
        account.pinUpdatedAt = now;
        account.failedLoginCount = 0;
        account.lastFailedAt = null;
        account.blockedUntil = null;
        account.tokenVersion = tokenVersionAfter;
        await this._saveDocument(account, session);

        const relationshipSnapshot =
          this._buildTutorRelationshipMap(student).get(String(tutor._id)) ||
          'Responsavel';
        const link = await this._upsertGuardianStudentLink({
          schoolId: claimedChallenge.school_id,
          accountId: account._id,
          studentId: student._id,
          tutorId: tutor._id,
          relationshipSnapshot,
          source: 'pin_recovery',
          session,
        });

        claimedChallenge.stage = 'completed';
        claimedChallenge.completedAt = now;
        claimedChallenge.verificationTokenHash = null;
        await this._saveDocument(claimedChallenge, session);

        const commonEvent = {
          schoolId: account.school_id,
          accountId: account._id,
          linkId: link?._id || null,
          recoveryChallengeId: claimedChallenge._id,
          studentId: claimedChallenge.studentId,
          tutorId: account.tutorId,
          actorType: 'guardian',
          tokenVersionBefore,
          tokenVersionAfter,
          ...auditContext,
          session,
        };

        await this._registerEvent({
          ...commonEvent,
          eventType: GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_SUCCEEDED,
          affectedFields: ['pinHash', 'pinUpdatedAt', 'status'],
          sessionsRevoked: true,
          metadata: { result: 'pin_updated' },
        });
        await this._registerEvent({
          ...commonEvent,
          eventType: GUARDIAN_ACCESS_EVENT_TYPES.GUARDIAN_PIN_UPDATED,
          affectedFields: ['pinHash', 'pinUpdatedAt'],
          sessionsRevoked: true,
        });
        await this._registerEvent({
          ...commonEvent,
          eventType: GUARDIAN_ACCESS_EVENT_TYPES.GUARDIAN_SESSIONS_REVOKED,
          status: 'revoked',
          affectedFields: ['tokenVersion'],
          sessionsRevoked: true,
        });

        return {
          status: 'pin_updated',
          identifierType: account.identifierType,
          identifierMasked: account.identifierMasked,
          message:
            'PIN atualizado. Entre novamente com seu CPF e o novo PIN.',
        };
      });
    } catch (error) {
      claimedChallenge.stage = 'failed';
      claimedChallenge.verificationTokenHash = null;
      await claimedChallenge.save();

      await this._registerEventBestEffort(
        'pin-recovery.complete-failed.event-failed',
        {
          schoolId: claimedChallenge.school_id,
          accountId: claimedChallenge.guardianAccessAccountId,
          recoveryChallengeId: claimedChallenge._id,
          studentId: claimedChallenge.studentId,
          tutorId: claimedChallenge.tutorId,
          actorType: 'public',
          eventType: GUARDIAN_ACCESS_EVENT_TYPES.PIN_RECOVERY_FAILED,
          metadata: { reason: error.reason || 'completion_failed' },
          ...this._auditContextFromChallenge(claimedChallenge),
        }
      );

      throw error;
    }
  }

  async setPin({ challengeId, verificationToken, pin }) {
    this._assertValidPin(pin);

    const challenge = await this._loadChallenge(challengeId, {
      includeVerificationHash: true,
    });

    if (challenge.stage !== 'awaiting_pin' || challenge.pinMode !== 'create') {
      throw this._createHttpError(
        'Este primeiro acesso nao esta pronto para criacao de PIN.',
        409
      );
    }

    await this._validateChallengeVerificationToken({
      challenge,
      verificationToken,
      failedEventType: GUARDIAN_ACCESS_EVENT_TYPES.PIN_SET_FAILED,
    });

    const tutor = await this._loadChallengeTutor(challenge);

    const relationshipSnapshot =
      challenge.candidateGuardians.find(
        (item) => String(item.tutorId) === String(tutor._id)
      )?.relationship || 'Responsavel';

    return this._runCriticalMutation(async (session) => {
      const account = await this._findOrCreateGuardianAccount({
        schoolId: challenge.school_id,
        tutor,
        pin,
        session,
      });
      const link = await this._upsertGuardianStudentLink({
        schoolId: challenge.school_id,
        accountId: account._id,
        studentId: challenge.studentId,
        tutorId: tutor._id,
        relationshipSnapshot,
        source: 'first_access',
        session,
      });

      challenge.stage = 'completed';
      challenge.completedAt = this._getNow();
      challenge.verificationTokenHash = null;
      await this._saveDocument(challenge, session);

      await this._registerEvent({
        schoolId: challenge.school_id,
        accountId: account._id,
        linkId: link?._id || null,
        challengeId: challenge._id,
        studentId: challenge.studentId,
        tutorId: tutor._id,
        actorType: 'public',
        eventType: GUARDIAN_ACCESS_EVENT_TYPES.PIN_SET,
        affectedFields: ['pinHash', 'pinUpdatedAt', 'status'],
        metadata: { identifierType: 'cpf' },
        ...this._auditContextFromChallenge(challenge),
        session,
      });

      return {
        status: 'pin_configured',
        identifierType: 'cpf',
        identifierMasked: account.identifierMasked,
        message: 'PIN configurado com sucesso.',
      };
    });
  }

  async linkExistingAccount({ challengeId, verificationToken, pin }) {
    this._assertValidPin(pin);

    const challenge = await this._loadChallenge(challengeId, {
      includeVerificationHash: true,
    });

    if (challenge.stage !== 'awaiting_pin' || challenge.pinMode !== 'link_existing') {
      throw this._createHttpError(
        'Este primeiro acesso nao esta pronto para vinculacao com PIN existente.',
        409
      );
    }

    await this._validateChallengeVerificationToken({
      challenge,
      verificationToken,
      failedEventType: GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_LINK_FAILED,
    });

    const tutor = await this._loadChallengeTutor(challenge);
    const account = await this.GuardianAccessAccountModel.findOne({
      _id: challenge.existingAccountId,
      school_id: challenge.school_id,
    }).select('+pinHash');

    if (!account || !account.pinHash || account.status !== 'active') {
      throw this._createHttpError(
        'Nao foi possivel validar o PIN da conta existente.',
        401
      );
    }

    if (
      account.blockedUntil &&
      new Date(account.blockedUntil) > this._getNow()
    ) {
      throw this._createHttpError(
        'Acesso temporariamente bloqueado. Tente novamente mais tarde.',
        423
      );
    }

    const isMatch = await this.bcrypt.compare(String(pin), account.pinHash);
    if (!isMatch) {
      await this._registerLoginFailure(account, {
        reason: 'existing_account_pin_mismatch',
      }, this._auditContextFromChallenge(challenge));

      if (
        account.blockedUntil &&
        new Date(account.blockedUntil) > this._getNow()
      ) {
        throw this._createHttpError(
          'Acesso temporariamente bloqueado. Tente novamente mais tarde.',
          423
        );
      }

      throw this._createHttpError(
        'Nao foi possivel validar o PIN da conta existente.',
        401
      );
    }

    const relationshipSnapshot =
      challenge.candidateGuardians.find(
        (item) => String(item.tutorId) === String(tutor._id)
      )?.relationship || 'Responsavel';
    const link = await this._upsertGuardianStudentLink({
      schoolId: challenge.school_id,
      accountId: account._id,
      studentId: challenge.studentId,
      tutorId: tutor._id,
      relationshipSnapshot,
      source: 'first_access',
    });

    challenge.stage = 'completed';
    challenge.completedAt = this._getNow();
    challenge.verificationTokenHash = null;
    await challenge.save();

    await this._registerEventBestEffort(
      'first-access.link-existing-account.event-failed',
      {
      schoolId: challenge.school_id,
      accountId: account._id,
      linkId: link?._id || null,
      challengeId: challenge._id,
      studentId: challenge.studentId,
      tutorId: tutor._id,
      actorType: 'public',
      eventType:
        GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_LINKED_WITH_EXISTING_PIN,
      metadata: { identifierType: 'cpf' },
      }
    );

    return {
      status: 'student_linked',
      identifierType: 'cpf',
      identifierMasked: account.identifierMasked,
      message: 'Aluno vinculado com sucesso a conta existente.',
    };
  }

  _buildGuardianJwtPayload(account) {
    return {
      sub: String(account._id),
      accountId: String(account._id),
      tutorId: String(account.tutorId),
      school_id: String(account.school_id),
      principalType: 'guardian',
      tokenType: 'guardian_auth',
      tokenVersion: Number(account.tokenVersion || 0),
    };
  }

  _signGuardianToken(account) {
    this._assertGuardianJwtSecret();

    return this.jwt.sign(
      this._buildGuardianJwtPayload(account),
      this.guardianJwtSecret,
      { expiresIn: '30d' }
    );
  }

  async _registerLoginFailure(account, metadata = {}, auditContext = {}) {
    const now = this._getNow();
    account.failedLoginCount = Number(account.failedLoginCount || 0) + 1;
    account.lastFailedAt = now;

    let blocked = false;
    if (account.failedLoginCount >= MAX_LOGIN_FAILURES) {
      account.blockedUntil = this._addMinutes(now, LOGIN_BLOCK_MINUTES);
      blocked = true;
    }

    const persist = async (session = null) => {
      await this._saveDocument(account, session);
      await this._registerEvent({
      schoolId: account.school_id,
      accountId: account._id,
      tutorId: account.tutorId,
      actorType: 'public',
      eventType: blocked
        ? GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_BLOCKED
        : GUARDIAN_ACCESS_EVENT_TYPES.LOGIN_FAILED,
      metadata: {
        attempts: account.failedLoginCount,
        blockedUntil: account.blockedUntil,
        ...metadata,
      },
        ...auditContext,
        session,
      });
    };

    if (blocked) {
      await this._runCriticalMutation(persist);
    } else {
      await persist();
    }
  }

  async _findGuardianAccounts(filter = {}, { includePinHash = false } = {}) {
    const query = this.GuardianAccessAccountModel.find(filter);

    if (includePinHash && query && typeof query.select === 'function') {
      query.select('+pinHash +temporaryAccess.passwordHash +temporaryAccess.credentialId');
    }

    const result = await query;
    return Array.isArray(result) ? result : [];
  }

  async _buildLoginAmbiguityError(accounts = []) {
    const candidateSchools = await this._listSchoolSummariesByIds(
      accounts.map((account) => account.school_id)
    );
    const message =
      'Encontramos mais de uma escola vinculada a este CPF. Selecione a escola para continuar.';

    return this._createHttpError(message, 409, {
      payload: {
        status: 'school_selection_required',
        message,
        candidateSchools,
      },
    });
  }

  async _completeGuardianLogin(account, auditContext = {}) {
    account.failedLoginCount = 0;
    account.lastFailedAt = null;
    account.blockedUntil = null;
    account.lastLoginAt = this._getNow();
    await account.save();
    const loginContext = await this._buildGuardianLoginContext({
      schoolId: account.school_id,
      accountId: account._id,
    });

    await this._registerEvent({
      schoolId: account.school_id,
      accountId: account._id,
      tutorId: account.tutorId,
      actorType: 'public',
      eventType: GUARDIAN_ACCESS_EVENT_TYPES.LOGIN_SUCCESS,
      metadata: {
        linkedStudentsCount: loginContext.linkedStudentsCount,
      },
      ...auditContext,
    });

    const school = await this._getSchoolSummaryById(account.school_id);

    return {
      token: this._signGuardianToken(account),
      guardian: {
        identifierType: account.identifierType,
        identifierMasked: account.identifierMasked,
        status: this._getAccountStatus(account),
        linkedStudentsCount: loginContext.linkedStudentsCount,
      },
      linkedStudents: loginContext.linkedStudents,
      defaultStudent: this._buildGuardianStudentPayload(
        loginContext.defaultStudent
      ),
      school: this._buildSchoolResponse(school),
    };
  }

  async login({ schoolPublicId, identifier, pin, requestMeta = {} }) {
    this._assertValidPin(pin);

    const normalizedCpf = normalizeCpf(identifier);
    const auditContext = this._buildAuditContext(requestMeta, {
      cpf: normalizedCpf,
    });

    if (!normalizedCpf || !isValidCpf(normalizedCpf)) {
      throw this._createHttpError('CPF ou PIN invalidos.', 401);
    }

    if (schoolPublicId) {
      const school = await this.resolveSchoolByPublicIdentifier(schoolPublicId);
      const account = await this.GuardianAccessAccountModel.findOne({
        school_id: school._id,
        identifierNormalized: normalizedCpf,
      }).select('+pinHash +temporaryAccess.passwordHash +temporaryAccess.credentialId');

      if (!account || !account.pinHash || account.status !== 'active') {
        throw this._createHttpError('CPF ou PIN invalidos.', 401);
      }

      if (
        account.blockedUntil &&
        new Date(account.blockedUntil) > this._getNow()
      ) {
        await this._registerEvent({
          schoolId: account.school_id,
          accountId: account._id,
          tutorId: account.tutorId,
          actorType: 'public',
          eventType: GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_BLOCKED,
          metadata: {
            blockedUntil: account.blockedUntil,
            reason: 'login_while_blocked',
          },
          ...auditContext,
        });

        throw this._createHttpError(
          'Acesso temporariamente bloqueado. Tente novamente mais tarde.',
          423
        );
      }

      const credential = await this._validateGuardianCredential(account, pin);
      const isMatch = credential.valid;

      if (!isMatch) {
        await this._registerLoginFailure(
          account,
          { reason: 'pin_mismatch' },
          auditContext
        );

        if (
          account.blockedUntil &&
          new Date(account.blockedUntil) > this._getNow()
        ) {
          throw this._createHttpError(
            'Acesso temporariamente bloqueado. Tente novamente mais tarde.',
            423
          );
        }

        throw this._createHttpError('CPF ou PIN invalidos.', 401);
      }

      return this._completeGuardianLogin(account, auditContext);
    }

    const accounts = await this._findGuardianAccounts(
      { identifierNormalized: normalizedCpf },
      { includePinHash: true }
    );

    if (!accounts.length) {
      throw this._createHttpError('CPF ou PIN invalidos.', 401);
    }

    if (accounts.length === 1) {
      const [account] = accounts;

      if (!account.pinHash || account.status !== 'active') {
        throw this._createHttpError('CPF ou PIN invalidos.', 401);
      }

      if (
        account.blockedUntil &&
        new Date(account.blockedUntil) > this._getNow()
      ) {
        await this._registerEvent({
          schoolId: account.school_id,
          accountId: account._id,
          tutorId: account.tutorId,
          actorType: 'public',
          eventType: GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_BLOCKED,
          metadata: {
            blockedUntil: account.blockedUntil,
            reason: 'login_while_blocked',
          },
          ...auditContext,
        });

        throw this._createHttpError(
          'Acesso temporariamente bloqueado. Tente novamente mais tarde.',
          423
        );
      }

      const credential = await this._validateGuardianCredential(account, pin);
      const isMatch = credential.valid;

      if (!isMatch) {
        await this._registerLoginFailure(
          account,
          { reason: 'pin_mismatch' },
          auditContext
        );

        if (
          account.blockedUntil &&
          new Date(account.blockedUntil) > this._getNow()
        ) {
          throw this._createHttpError(
            'Acesso temporariamente bloqueado. Tente novamente mais tarde.',
            423
          );
        }

        throw this._createHttpError('CPF ou PIN invalidos.', 401);
      }

      return this._completeGuardianLogin(account, auditContext);
    }

    const matchingAccounts = [];

    for (const account of accounts) {
      if (!account.pinHash || account.status !== 'active') continue;
      if (
        account.blockedUntil &&
        new Date(account.blockedUntil) > this._getNow()
      ) {
        continue;
      }

      const isMatch = await this.bcrypt.compare(String(pin), account.pinHash);
      if (isMatch) {
        matchingAccounts.push(account);
      }
    }

    if (matchingAccounts.length === 1) {
      return this._completeGuardianLogin(matchingAccounts[0], auditContext);
    }

    if (matchingAccounts.length > 1) {
      throw await this._buildLoginAmbiguityError(matchingAccounts);
    }

    throw this._createHttpError('CPF ou PIN invalidos.', 401);
  }

  async listStudentGuardianAccesses({ schoolId, studentId, actor }) {
    this._assertAdminActor(actor);

    const student = await this.StudentModel.findOne({
      _id: studentId,
      school_id: schoolId,
    })
      .select('_id fullName financialTutorId tutors')
      .lean();

    if (!student) {
      throw this._createHttpError('Aluno nao encontrado.', 404);
    }

    const links = await this.GuardianAccessLinkModel.find({
      school_id: schoolId,
      studentId,
      status: 'active',
    })
      .select(
        'guardianAccessAccountId tutorId relationshipSnapshot linkedAt status'
      )
      .lean();

    if (!links.length) {
      return {
        student: {
          id: String(student._id),
          fullName: student.fullName,
        },
        accesses: [],
      };
    }

    const accountIds = [
      ...new Set(
        links
          .map((link) => this._extractId(link.guardianAccessAccountId))
          .filter(Boolean)
      ),
    ];
    const tutorIds = [
      ...new Set(links.map((link) => this._extractId(link.tutorId)).filter(Boolean)),
    ];

    const accounts = await this.GuardianAccessAccountModel.find({
      _id: { $in: accountIds },
    });
    const tutors = tutorIds.length
      ? await this.TutorModel.find({
          _id: { $in: tutorIds },
          school_id: schoolId,
        })
          .select('_id fullName cpf cpfNormalized')
          .lean()
      : [];

    const accountById = new Map(
      accounts.map((account) => [String(account._id), account])
    );
    const tutorById = new Map(tutors.map((tutor) => [String(tutor._id), tutor]));

    return {
      student: {
        id: String(student._id),
        fullName: student.fullName,
      },
      accesses: links
        .map((link) => {
          const account = accountById.get(
            this._extractId(link.guardianAccessAccountId)
          );
          if (!account) return null;

          const tutor = tutorById.get(this._extractId(link.tutorId)) || null;
          return this._buildAccountSummary(
            account,
            tutor,
            link.relationshipSnapshot || 'Responsavel'
          );
        })
        .filter(Boolean)
        .sort((left, right) =>
          String(left.guardianName || '').localeCompare(
            String(right.guardianName || ''),
            'pt-BR'
          )
        ),
    };
  }

  async listGuardianAccessEvents({
    schoolId,
    accountId,
    actor,
    filters = {},
  }) {
    this._assertAdminActor(actor);

    if (!mongoose.isValidObjectId(accountId)) {
      throw this._createHttpError('Conta de responsavel invalida.', 400);
    }

    const account = await this.GuardianAccessAccountModel.findOne({
      _id: accountId,
      school_id: schoolId,
    }).select('_id tutorId');

    if (!account) {
      throw this._createHttpError('Conta de responsavel nao encontrada.', 404);
    }

    const eventFilter = {
      school_id: schoolId,
      accountId: account._id,
    };
    const { studentId, tutorId, eventType, status, from, to, cursor } = filters;

    if (studentId) {
      if (!mongoose.isValidObjectId(studentId)) {
        throw this._createHttpError('Aluno invalido.', 400);
      }
      const link = await this.GuardianAccessLinkModel.findOne({
        school_id: schoolId,
        guardianAccessAccountId: account._id,
        studentId,
      });
      if (!link) {
        throw this._createHttpError(
          'Aluno nao esta vinculado a esta conta de responsavel.',
          404
        );
      }
      eventFilter.studentId = studentId;
    }

    if (tutorId) {
      if (
        !mongoose.isValidObjectId(tutorId) ||
        String(account.tutorId) !== String(tutorId)
      ) {
        throw this._createHttpError(
          'Responsavel nao esta vinculado a esta conta.',
          404
        );
      }
      eventFilter.tutorId = tutorId;
    }

    if (eventType) {
      if (!GUARDIAN_ACCESS_EVENT_TYPE_VALUES.includes(eventType)) {
        throw this._createHttpError('Tipo de evento invalido.', 400);
      }
      eventFilter.eventType = eventType;
    }

    if (status) {
      if (!AUDIT_STATUSES.includes(status)) {
        throw this._createHttpError('Status de evento invalido.', 400);
      }
      const legacyEventTypes = LEGACY_EVENT_TYPES_BY_STATUS[status] || [];
      eventFilter.$and = [
        {
          $or: [
            { status },
            ...(legacyEventTypes.length
              ? [
                  {
                    status: { $exists: false },
                    eventType: { $in: legacyEventTypes },
                  },
                ]
              : []),
          ],
        },
      ];
    }

    const createdAt = {};
    if (from) {
      const parsedFrom = new Date(from);
      if (Number.isNaN(parsedFrom.getTime())) {
        throw this._createHttpError('Data inicial invalida.', 400);
      }
      createdAt.$gte = parsedFrom;
    }
    if (to) {
      const parsedTo = new Date(to);
      if (Number.isNaN(parsedTo.getTime())) {
        throw this._createHttpError('Data final invalida.', 400);
      }
      createdAt.$lte = parsedTo;
    }
    if (createdAt.$gte && createdAt.$lte && createdAt.$gte > createdAt.$lte) {
      throw this._createHttpError(
        'A data inicial deve ser anterior a data final.',
        400
      );
    }
    if (Object.keys(createdAt).length) eventFilter.createdAt = createdAt;

    if (cursor) {
      const decodedCursor = decodeEventCursor(cursor);
      if (
        !decodedCursor ||
        !mongoose.isValidObjectId(decodedCursor.id)
      ) {
        throw this._createHttpError('Cursor invalido.', 400);
      }
      eventFilter.$and = [
        ...(eventFilter.$and || []),
        {
          $or: [
            { createdAt: { $lt: decodedCursor.createdAt } },
            {
              createdAt: decodedCursor.createdAt,
              _id: { $lt: decodedCursor.id },
            },
          ],
        },
      ];
    }

    const parsedLimit = Number.parseInt(filters.limit, 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 25;
    const events = await this.GuardianAccessEventModel.find(eventFilter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasMore = events.length > limit;
    const page = hasMore ? events.slice(0, limit) : events;

    return {
      items: page.map(buildGuardianAccessEventDto),
      nextCursor: hasMore ? encodeEventCursor(page[page.length - 1]) : null,
      hasMore,
    };
  }

  async _resolveGuardianInvoiceScope({ schoolId, accountId, studentId = null }) {
    if (!schoolId || !accountId) {
      return {
        links: [],
        studentIds: [],
        tutorIds: [],
      };
    }

    const filter = {
      school_id: schoolId,
      guardianAccessAccountId: accountId,
      status: 'active',
    };

    if (studentId) {
      filter.studentId = studentId;
    }

    const links = await this.GuardianAccessLinkModel.find(filter)
      .select('studentId tutorId relationshipSnapshot')
      .lean();

    return {
      links,
      studentIds: [
        ...new Set(
          links.map((link) => this._extractId(link.studentId)).filter(Boolean)
        ),
      ],
      tutorIds: [
        ...new Set(
          links.map((link) => this._extractId(link.tutorId)).filter(Boolean)
        ),
      ],
    };
  }

  _buildGuardianInvoiceAccessFilter({
    schoolId,
    tutorIds,
    studentIds,
    invoiceIds,
  }) {
    const filter = {
      school_id: schoolId,
      student: { $in: studentIds },
      $or: [
        { tutor: { $in: tutorIds } },
        { tutor: null },
        { tutor: { $exists: false } },
      ],
    };

    if (Array.isArray(invoiceIds) && invoiceIds.length) {
      filter._id = { $in: invoiceIds };
    }

    return filter;
  }

  async _buildGuardianFinancialScoreContext({
    schoolId,
    accountTutorId,
    scope,
  }) {
    const normalizedOwnerId = this._extractId(accountTutorId);
    const scopedTutorIds = new Set(
      (scope?.tutorIds || []).map((tutorId) => String(tutorId))
    );

    if (!normalizedOwnerId || !scopedTutorIds.has(String(normalizedOwnerId))) {
      return {
        available: false,
        ownerStatus: normalizedOwnerId ? 'not_in_scope' : 'missing_owner',
        owner: null,
        score: null,
      };
    }

    const tutor = await this.TutorModel.findOne({
      _id: normalizedOwnerId,
      school_id: schoolId,
    })
      .select('_id fullName financialScore')
      .lean();

    if (!tutor) {
      return {
        available: false,
        ownerStatus: 'owner_not_found',
        owner: null,
        score: null,
      };
    }

    const ownerLink = (scope?.links || []).find(
      (link) => this._extractId(link.tutorId) === String(normalizedOwnerId)
    );
    const financialScore =
      tutor.financialScore && typeof tutor.financialScore.value === 'number'
        ? tutor.financialScore
        : this.tutorFinancialScoreService.buildDefaultFinancialScore();

    return {
      available: true,
      ownerStatus: 'authenticated_guardian',
      owner: {
        tutorId: String(tutor._id),
        fullName: tutor.fullName || null,
        relationship: ownerLink?.relationshipSnapshot || null,
      },
      score: financialScore,
    };
  }

  async listGuardianInvoices({
    schoolId,
    accountId,
    accountTutorId = null,
    studentId = null,
  }) {
    if (!schoolId || !accountId) {
      throw this._createHttpError(
        'Contexto de responsavel invalido para listar boletos.',
        401
      );
    }

    const scope = await this._resolveGuardianInvoiceScope({
      schoolId,
      accountId,
      studentId,
    });

    if (studentId && !scope.studentIds.length) {
      throw this._createHttpError('Aluno vinculado nao encontrado.', 404);
    }

    if (!scope.studentIds.length) {
      return {
        invoices: [],
        linkedStudentsCount: 0,
        scopedStudentId: studentId || null,
        financialScoreContext: {
          available: false,
          ownerStatus: 'empty_scope',
          owner: null,
          score: null,
        },
      };
    }

    const invoices = await this.InvoiceModel.find(
      this._buildGuardianInvoiceAccessFilter({
        schoolId,
        tutorIds: scope.tutorIds,
        studentIds: scope.studentIds,
      })
    )
      .sort({ dueDate: 1, createdAt: -1 })
      .populate('student', 'fullName')
      .populate('tutor', 'fullName')
      .lean();

    const financialScoreContext = await this._buildGuardianFinancialScoreContext({
      schoolId,
      accountTutorId,
      scope,
    });

    return {
      invoices,
      linkedStudentsCount: scope.studentIds.length,
      scopedStudentId: studentId || null,
      financialScoreContext,
    };
  }

  async downloadGuardianBatchPdf({
    schoolId,
    accountId,
    invoiceIds,
    studentId = null,
  }) {
    if (!Array.isArray(invoiceIds) || !invoiceIds.length) {
      throw this._createHttpError('Lista de boletos invalida.', 400);
    }

    const scope = await this._resolveGuardianInvoiceScope({
      schoolId,
      accountId,
      studentId,
    });

    if (studentId && !scope.studentIds.length) {
      throw this._createHttpError('Aluno vinculado nao encontrado.', 404);
    }

    if (!scope.studentIds.length) {
      throw this._createHttpError(
        'Nenhum aluno vinculado a este responsavel foi encontrado.',
        404
      );
    }

    const normalizedInvoiceIds = [
      ...new Set(invoiceIds.map((invoiceId) => String(invoiceId || '')).filter(Boolean)),
    ];

    const accessibleInvoices = await this.InvoiceModel.find(
      this._buildGuardianInvoiceAccessFilter({
        schoolId,
        tutorIds: scope.tutorIds,
        studentIds: scope.studentIds,
        invoiceIds: normalizedInvoiceIds,
      })
    )
      .select('_id')
      .lean();

    const accessibleInvoiceIds = accessibleInvoices.map((invoice) =>
      String(invoice._id)
    );

    if (!accessibleInvoiceIds.length) {
      throw this._createHttpError(
        'Nenhum boleto acessivel foi encontrado para esta conta.',
        404
      );
    }

    return this.invoiceService.generateBatchPdf(accessibleInvoiceIds, schoolId);
  }

  async getGuardianPortalHome({ schoolId, accountId, studentId = null }) {
    if (!schoolId || !accountId) {
      throw this._createHttpError(
        'Contexto de responsavel invalido para carregar o portal.',
        401
      );
    }

    const { linkedStudents, selectedStudent } =
      await this._resolveGuardianStudentContext({
        schoolId,
        accountId,
        studentId,
      });

    const [schedule, attendance, activities] = await Promise.all([
      this._buildGuardianScheduleData({ schoolId, student: selectedStudent }),
      this._buildGuardianAttendanceData({ schoolId, student: selectedStudent }),
      this._buildGuardianActivitiesData({ schoolId, student: selectedStudent }),
    ]);

    return {
      linkedStudents,
      selectedStudent,
      schedule: {
        term: schedule.term,
        currentClass: schedule.currentClass,
        nextClass: schedule.nextClass,
        todayCount: Array.isArray(schedule.today) ? schedule.today.length : 0,
      },
      attendance,
      activities: {
        summary: activities.summary,
      },
    };
  }

  async getGuardianSchedule({ schoolId, accountId, studentId }) {
    if (!schoolId || !accountId) {
      throw this._createHttpError(
        'Contexto de responsavel invalido para carregar a grade.',
        401
      );
    }

    const { linkedStudents, selectedStudent } =
      await this._resolveGuardianStudentContext({
        schoolId,
        accountId,
        studentId,
      });

    return {
      linkedStudents,
      selectedStudent,
      schedule: await this._buildGuardianScheduleData({
        schoolId,
        student: selectedStudent,
      }),
    };
  }

  async getGuardianAttendance({ schoolId, accountId, studentId }) {
    if (!schoolId || !accountId) {
      throw this._createHttpError(
        'Contexto de responsavel invalido para carregar a frequencia.',
        401
      );
    }

    const { linkedStudents, selectedStudent } =
      await this._resolveGuardianStudentContext({
        schoolId,
        accountId,
        studentId,
      });

    return {
      linkedStudents,
      selectedStudent,
      attendance: await this._buildGuardianAttendanceData({
        schoolId,
        student: selectedStudent,
      }),
    };
  }

  async getGuardianActivities({ schoolId, accountId, studentId }) {
    if (!schoolId || !accountId) {
      throw this._createHttpError(
        'Contexto de responsavel invalido para carregar as atividades.',
        401
      );
    }

    const { linkedStudents, selectedStudent } =
      await this._resolveGuardianStudentContext({
        schoolId,
        accountId,
        studentId,
      });

    return {
      linkedStudents,
      selectedStudent,
      activities: await this._buildGuardianActivitiesData({
        schoolId,
        student: selectedStudent,
      }),
    };
  }

  async _getAdminAccountOrThrow(accountId, schoolId, actor, session = null) {
    this._assertAdminActor(actor);

    let query = this.GuardianAccessAccountModel.findOne({
      _id: accountId,
      school_id: schoolId,
    }).select('+pinHash');
    query = this._withSession(query, session);
    const account = await query;

    if (!account) {
      throw this._createHttpError('Conta de responsavel nao encontrada.', 404);
    }

    return account;
  }

  async resetPin({
    schoolId,
    accountId,
    actor,
    reasonCode = null,
    reasonText = null,
    requestMeta = {},
  }) {
    this._assertAdminActor(actor);
    const auditContext = this._buildAuditContext(requestMeta, {
      fallbackSource: 'desktop',
    });
    const actorSnapshot = this._buildAdminActorSnapshot(actor);

    return this._runCriticalMutation(async (session) => {
      const account = await this._getAdminAccountOrThrow(
        accountId,
        schoolId,
        actor,
        session
      );
      const tokenVersionBefore = Number(account.tokenVersion || 0);
      const tokenVersionAfter = tokenVersionBefore + 1;

      account.pinHash = null;
      account.status = 'pending';
      account.pinUpdatedAt = null;
      account.failedLoginCount = 0;
      account.lastFailedAt = null;
      account.blockedUntil = null;
      account.tokenVersion = tokenVersionAfter;
      await this._saveDocument(account, session);

      const commonEvent = {
        schoolId,
        accountId: account._id,
        tutorId: account.tutorId,
        actorType: 'staff',
        actorUserId: actor.id || actor._id || null,
        ...actorSnapshot,
        ...auditContext,
        cpfHash: this._hashSensitiveValue(account.identifierNormalized),
        cpfMasked: account.identifierMasked,
        reasonCode,
        reasonText,
        tokenVersionBefore,
        tokenVersionAfter,
        sessionsRevoked: true,
        session,
      };
      await this._registerEvent({
        ...commonEvent,
        eventType: GUARDIAN_ACCESS_EVENT_TYPES.PIN_RESET,
        affectedFields: ['pinHash', 'pinUpdatedAt', 'status', 'tokenVersion'],
        metadata: { newStatus: 'pending' },
      });
      await this._registerEvent({
        ...commonEvent,
        eventType: GUARDIAN_ACCESS_EVENT_TYPES.GUARDIAN_SESSIONS_REVOKED,
        status: 'revoked',
        affectedFields: ['tokenVersion'],
      });

      return {
        status: 'pending',
        identifierType: account.identifierType,
        identifierMasked: account.identifierMasked,
        message:
          'PIN resetado com sucesso. O responsavel devera usar a recuperacao de PIN.',
      };
    });
  }

  async createTemporaryAccess({ schoolId, accountId, actor }) {
    const account = await this._getAdminAccountOrThrow(accountId, schoolId, actor);
    if (account.status !== 'active') throw this._createHttpError('O portal deste responsavel nao esta ativo.', 409);
    const password = this._generateTemporaryCredential();
    const now = this._getNow();
    account.temporaryAccess = { credentialId: this.crypto.randomUUID(), passwordHash: await this.bcrypt.hash(password, PIN_SALT_ROUNDS), createdAt: now, createdBy: actor.id || actor._id || null, expiresAt: new Date(now.getTime() + GUARDIAN_TEMP_ACCESS_TTL_MINUTES * 60 * 1000), usedAt: null, revokedAt: null };
    await account.save();
    await this._registerEvent({ schoolId, accountId: account._id, tutorId: account.tutorId, actorType: 'staff', actorUserId: actor.id || actor._id || null, eventType: GUARDIAN_ACCESS_EVENT_TYPES.TEMPORARY_ACCESS_CREATED, metadata: { expiresAt: account.temporaryAccess.expiresAt } });
    return { temporaryPassword: password, expiresAt: account.temporaryAccess.expiresAt, loginIdentifier: account.identifierMasked };
  }

  async revokeTemporaryAccess({ schoolId, accountId, actor }) {
    const account = await this._getAdminAccountOrThrow(accountId, schoolId, actor);
    if (account.temporaryAccess?.credentialId && !account.temporaryAccess.usedAt) { account.temporaryAccess.revokedAt = this._getNow(); await account.save(); await this._registerEvent({ schoolId, accountId: account._id, tutorId: account.tutorId, actorType: 'staff', actorUserId: actor.id || actor._id || null, eventType: GUARDIAN_ACCESS_EVENT_TYPES.TEMPORARY_ACCESS_REVOKED }); }
    return { revoked: true };
  }

  async unlockAccount({
    schoolId,
    accountId,
    actor,
    reasonCode = null,
    reasonText = null,
    requestMeta = {},
  }) {
    this._assertAdminActor(actor);
    const auditContext = this._buildAuditContext(requestMeta, {
      fallbackSource: 'desktop',
    });
    const actorSnapshot = this._buildAdminActorSnapshot(actor);

    return this._runCriticalMutation(async (session) => {
      const account = await this._getAdminAccountOrThrow(
        accountId,
        schoolId,
        actor,
        session
      );
      account.failedLoginCount = 0;
      account.lastFailedAt = null;
      account.blockedUntil = null;
      await this._saveDocument(account, session);

      await this._registerEvent({
        schoolId,
        accountId: account._id,
        tutorId: account.tutorId,
        actorType: 'staff',
        actorUserId: actor.id || actor._id || null,
        ...actorSnapshot,
        ...auditContext,
        cpfHash: this._hashSensitiveValue(account.identifierNormalized),
        cpfMasked: account.identifierMasked,
        reasonCode,
        reasonText,
        eventType: GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_UNLOCKED,
        affectedFields: ['failedLoginCount', 'lastFailedAt', 'blockedUntil'],
        session,
      });

      return {
        status: this._getAccountStatus(account),
        message: 'Conta desbloqueada com sucesso.',
      };
    });
  }

  async deactivateAccount({
    schoolId,
    accountId,
    actor,
    reasonCode = null,
    reasonText = null,
    requestMeta = {},
  }) {
    this._assertAdminActor(actor);
    const auditContext = this._buildAuditContext(requestMeta, {
      fallbackSource: 'desktop',
    });
    const actorSnapshot = this._buildAdminActorSnapshot(actor);

    return this._runCriticalMutation(async (session) => {
      const account = await this._getAdminAccountOrThrow(
        accountId,
        schoolId,
        actor,
        session
      );
      const tokenVersionBefore = Number(account.tokenVersion || 0);
      const tokenVersionAfter = tokenVersionBefore + 1;

      account.status = 'inactive';
      account.failedLoginCount = 0;
      account.lastFailedAt = null;
      account.blockedUntil = null;
      account.tokenVersion = tokenVersionAfter;
      await this._saveDocument(account, session);

      const commonEvent = {
        schoolId,
        accountId: account._id,
        tutorId: account.tutorId,
        actorType: 'staff',
        actorUserId: actor.id || actor._id || null,
        ...actorSnapshot,
        ...auditContext,
        cpfHash: this._hashSensitiveValue(account.identifierNormalized),
        cpfMasked: account.identifierMasked,
        reasonCode,
        reasonText,
        tokenVersionBefore,
        tokenVersionAfter,
        sessionsRevoked: true,
        session,
      };
      await this._registerEvent({
        ...commonEvent,
        eventType: GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_DEACTIVATED,
        affectedFields: ['status', 'tokenVersion'],
      });
      await this._registerEvent({
        ...commonEvent,
        eventType: GUARDIAN_ACCESS_EVENT_TYPES.GUARDIAN_SESSIONS_REVOKED,
        status: 'revoked',
        affectedFields: ['tokenVersion'],
      });

      return {
        status: 'inactive',
        message: 'Conta desativada com sucesso.',
      };
    });
  }

  async reactivateAccount({
    schoolId,
    accountId,
    actor,
    reasonCode = null,
    reasonText = null,
    requestMeta = {},
  }) {
    this._assertAdminActor(actor);
    const auditContext = this._buildAuditContext(requestMeta, {
      fallbackSource: 'desktop',
    });
    const actorSnapshot = this._buildAdminActorSnapshot(actor);

    return this._runCriticalMutation(async (session) => {
      const account = await this._getAdminAccountOrThrow(
        accountId,
        schoolId,
        actor,
        session
      );
      account.status = account.pinHash ? 'active' : 'pending';
      account.failedLoginCount = 0;
      account.lastFailedAt = null;
      account.blockedUntil = null;
      await this._saveDocument(account, session);

      await this._registerEvent({
        schoolId,
        accountId: account._id,
        tutorId: account.tutorId,
        actorType: 'staff',
        actorUserId: actor.id || actor._id || null,
        ...actorSnapshot,
        ...auditContext,
        cpfHash: this._hashSensitiveValue(account.identifierNormalized),
        cpfMasked: account.identifierMasked,
        reasonCode,
        reasonText,
        eventType: GUARDIAN_ACCESS_EVENT_TYPES.ACCOUNT_REACTIVATED,
        affectedFields: ['status'],
        metadata: { restoredStatus: account.status },
        session,
      });

      return {
        status: account.status,
        message: 'Conta reativada com sucesso.',
      };
    });
  }

  async generateEligibilityReport({ schoolId = null, schoolPublicId = null } = {}) {
    let schools = [];

    if (schoolPublicId) {
      schools = [await this.resolveSchoolByPublicIdentifier(schoolPublicId)];
    } else if (schoolId) {
      const school = await this.SchoolModel.findById(schoolId)
        .select('_id name publicIdentifier')
        .lean();

      if (!school) {
        throw this._createHttpError('Escola nao encontrada.', 404);
      }

      schools = [school];
    } else {
      schools = await this.SchoolModel.find({})
        .select('_id name publicIdentifier')
        .lean();
    }

    const reports = [];
    for (const school of schools) {
      reports.push(await this._generateSchoolEligibilityReport(school));
    }

    return {
      generatedAt: this._getNow().toISOString(),
      schools: reports,
    };
  }

  async _generateSchoolEligibilityReport(school) {
    const schoolId = school._id;

    const [students, tutors] = await Promise.all([
      this.StudentModel.find({ school_id: schoolId })
        .select(
          '_id fullName fullNameNormalized birthDate birthDateKey financialTutorId tutors isActive'
        )
        .lean(),
      this.TutorModel.find({ school_id: schoolId })
        .select('_id fullName cpf cpfNormalized students')
        .lean(),
    ]);

    const tutorById = new Map(tutors.map((tutor) => [String(tutor._id), tutor]));
    const studentById = new Map(
      students.map((student) => [String(student._id), student])
    );

    const duplicateCpfBuckets = new Map();
    tutors.forEach((tutor) => {
      if (!tutor.cpfNormalized) return;
      if (!duplicateCpfBuckets.has(tutor.cpfNormalized)) {
        duplicateCpfBuckets.set(tutor.cpfNormalized, []);
      }
      duplicateCpfBuckets.get(tutor.cpfNormalized).push(tutor);
    });

    const duplicateCpfs = [...duplicateCpfBuckets.entries()]
      .filter(([, bucket]) => bucket.length > 1)
      .map(([cpfNormalized, bucket]) => ({
        cpfNormalized,
        identifierMasked: maskCpf(cpfNormalized),
        tutors: bucket.map((tutor) => ({
          tutorId: String(tutor._id),
          fullName: tutor.fullName,
        })),
      }));

    const duplicateCpfSet = new Set(
      duplicateCpfs.map((entry) => entry.cpfNormalized)
    );

    const ambiguousBuckets = new Map();
    students
      .filter((student) => student.isActive)
      .forEach((student) => {
        const key = `${student.fullNameNormalized || 'null'}::${student.birthDateKey || 'null'}`;
        if (!ambiguousBuckets.has(key)) ambiguousBuckets.set(key, []);
        ambiguousBuckets.get(key).push(student);
      });

    const ambiguousStudents = [...ambiguousBuckets.entries()]
      .filter(([, bucket]) => bucket.length > 1)
      .map(([identityKey, bucket]) => ({
        identityKey,
        students: bucket.map((student) => ({
          studentId: String(student._id),
          fullName: student.fullName,
          birthDateKey: student.birthDateKey,
        })),
      }));

    const tutorsWithoutCpf = tutors
      .filter((tutor) => !tutor.cpfNormalized)
      .map((tutor) => ({
        tutorId: String(tutor._id),
        fullName: tutor.fullName,
      }));

    const studentsWithoutEligibleTutor = [];
    const relationshipDivergences = [];

    for (const student of students.filter((item) => item.isActive)) {
      const relatedTutorIds = new Set();

      if (student.financialTutorId) {
        relatedTutorIds.add(String(student.financialTutorId));
      }

      (Array.isArray(student.tutors) ? student.tutors : []).forEach((link) => {
        const tutorId = link?.tutorId?._id || link?.tutorId;
        if (tutorId) relatedTutorIds.add(String(tutorId));
      });

      const relatedTutors = [...relatedTutorIds]
        .map((tutorId) => tutorById.get(String(tutorId)))
        .filter(Boolean);

      const eligibleCount = relatedTutors.filter(
        (tutor) =>
          tutor.cpfNormalized && !duplicateCpfSet.has(String(tutor.cpfNormalized))
      ).length;

      if (!eligibleCount) {
        studentsWithoutEligibleTutor.push({
          studentId: String(student._id),
          fullName: student.fullName,
          birthDateKey: student.birthDateKey,
          reasons: [
            relatedTutors.length ? 'linked_tutors_not_eligible' : 'no_linked_tutors',
          ],
        });
      }

      if (student.financialTutorId) {
        const financialTutor = tutorById.get(String(student.financialTutorId));

        if (!financialTutor) {
          relationshipDivergences.push({
            type: 'financial_tutor_missing',
            studentId: String(student._id),
            tutorId: String(student.financialTutorId),
            detail: 'financialTutorId aponta para um tutor inexistente na escola.',
          });
        } else if (
          !Array.isArray(financialTutor.students) ||
          !financialTutor.students.some(
            (linkedStudentId) => String(linkedStudentId) === String(student._id)
          )
        ) {
          relationshipDivergences.push({
            type: 'financial_tutor_missing_reverse_link',
            studentId: String(student._id),
            tutorId: String(student.financialTutorId),
            detail: 'Tutor financeiro nao referencia o aluno em Tutor.students[].',
          });
        }
      }

      (Array.isArray(student.tutors) ? student.tutors : []).forEach((link) => {
        const tutorId = link?.tutorId?._id || link?.tutorId;
        if (!tutorId) return;

        const tutor = tutorById.get(String(tutorId));
        if (!tutor) {
          relationshipDivergences.push({
            type: 'student_tutor_missing',
            studentId: String(student._id),
            tutorId: String(tutorId),
            detail: 'Student.tutors[] aponta para um tutor inexistente na escola.',
          });
          return;
        }

        if (
          !Array.isArray(tutor.students) ||
          !tutor.students.some(
            (linkedStudentId) => String(linkedStudentId) === String(student._id)
          )
        ) {
          relationshipDivergences.push({
            type: 'student_tutor_missing_reverse_link',
            studentId: String(student._id),
            tutorId: String(tutorId),
            detail:
              'Tutor vinculado em Student.tutors[] nao referencia o aluno em Tutor.students[].',
          });
        }
      });
    }

    tutors.forEach((tutor) => {
      (Array.isArray(tutor.students) ? tutor.students : []).forEach((studentId) => {
        const student = studentById.get(String(studentId));

        if (!student) {
          relationshipDivergences.push({
            type: 'tutor_reverse_student_missing',
            studentId: String(studentId),
            tutorId: String(tutor._id),
            detail: 'Tutor.students[] referencia um aluno inexistente na escola.',
          });
          return;
        }

        const linkedInStudentTutors = (Array.isArray(student.tutors)
          ? student.tutors
          : []
        ).some(
          (link) => String(link?.tutorId?._id || link?.tutorId) === String(tutor._id)
        );

        const isFinancialTutor =
          String(student.financialTutorId || '') === String(tutor._id);

        if (!linkedInStudentTutors && !isFinancialTutor) {
          relationshipDivergences.push({
            type: 'tutor_reverse_orphan_link',
            studentId: String(student._id),
            tutorId: String(tutor._id),
            detail:
              'Tutor.students[] aponta para aluno sem correspondencia em Student.tutors[] ou financialTutorId.',
          });
        }
      });
    });

    return {
      school: {
        id: String(school._id),
        name: school.name,
        publicIdentifier: school.publicIdentifier || null,
      },
      summary: {
        totalStudents: students.length,
        activeStudents: students.filter((student) => student.isActive).length,
        totalTutors: tutors.length,
        tutorsWithoutCpf: tutorsWithoutCpf.length,
        duplicateCpfs: duplicateCpfs.length,
        ambiguousStudents: ambiguousStudents.length,
        studentsWithoutEligibleTutor: studentsWithoutEligibleTutor.length,
        relationshipDivergences: relationshipDivergences.length,
      },
      tutorsWithoutCpf,
      duplicateCpfs,
      ambiguousStudents,
      studentsWithoutEligibleTutor,
      relationshipDivergences,
    };
  }
}

module.exports = new GuardianAuthService();
module.exports.GuardianAuthService = GuardianAuthService;
