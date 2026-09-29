const mongoose = require('mongoose');

const ActivityBook = require('../models/activityBook.model');
const ActivityCorrection = require('../models/activityCorrection.model');
const ActivityPage = require('../models/activityPage.model');
const ActivityPrintRun = require('../models/activityPrintRun.model');
const appEmitter = require('../../loaders/eventEmitter');
const {
  ensureClassAccess,
  ensureStudentAccessInAnyOwnedClass,
  extractId,
  getAccessibleClassIds,
  getActorRoles,
  isPrivilegedActor,
} = require('./classAccess.service');
const { parseBusinessDateInput, shiftBusinessDate } = require('../utils/timeContext');

const ACTIVITY_QR_PREFIX = 'AH-ACTIVITY-1:';
const ACTIVITY_CORRECTION_STATUSES = ['pending', 'corrected', 'reviewed', 'voided'];
const DEFAULT_CRITERIA_SCALE = [
  'precisa_de_apoio',
  'realizou_com_apoio',
  'realizou_parcialmente',
  'realizou_com_autonomia',
];
const DEFAULT_CRITERIA_TEMPLATE = [
  { key: 'coordenacao_motora', label: 'Coordenação motora', scale: DEFAULT_CRITERIA_SCALE },
  { key: 'controle_tracado', label: 'Controle do traçado', scale: DEFAULT_CRITERIA_SCALE },
  { key: 'compreensao_instrucao', label: 'Compreensão da instrução', scale: DEFAULT_CRITERIA_SCALE },
  { key: 'organizacao_atividade', label: 'Organização da atividade', scale: DEFAULT_CRITERIA_SCALE },
  { key: 'autonomia', label: 'Autonomia', scale: DEFAULT_CRITERIA_SCALE },
  { key: 'participacao', label: 'Participação', scale: DEFAULT_CRITERIA_SCALE },
  { key: 'atencao_concentracao', label: 'Atenção e concentração', scale: DEFAULT_CRITERIA_SCALE },
];
const ALFABETIZACAO_CRITERION = {
  key: 'reconhecimento_letras_numeros',
  label: 'Reconhecimento de letras/números',
  scale: DEFAULT_CRITERIA_SCALE,
};
const FORBIDDEN_ACTOR_ROLES = new Set(['ALUNO', 'STUDENT', 'RESPONSAVEL', 'GUARDIAN']);

function createHttpError(message, status = 400, code = 'ACTIVITY_CORRECTION_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sameId(left, right) {
  return String(left) === String(right);
}

function toStringId(value) {
  return value ? String(value) : null;
}

function ensureObjectId(id, code, message) {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    throw createHttpError(message, 400, code);
  }
}

function normalizePagination(query = {}) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return [];
}

function sanitizeDateFilter(value, parser) {
  if (!value) return null;
  return parser(value, 'America/Sao_Paulo', {
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}

function formatDateOnly(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function cloneTemplateEntry(entry = {}) {
  return {
    key: normalizeText(entry.key),
    label: normalizeText(entry.label),
    scale: toArray(entry.scale).map((value) => normalizeText(value)).filter(Boolean),
  };
}

class ActivityCorrectionService {
  constructor({
    ActivityCorrectionModel = ActivityCorrection,
    ActivityPrintRunModel = ActivityPrintRun,
    ActivityPageModel = ActivityPage,
    ActivityBookModel = ActivityBook,
    ensureClassAccessFn = ensureClassAccess,
    ensureStudentAccessInAnyOwnedClassFn = ensureStudentAccessInAnyOwnedClass,
    getAccessibleClassIdsFn = getAccessibleClassIds,
    getActorRolesFn = getActorRoles,
    isPrivilegedActorFn = isPrivilegedActor,
    parseBusinessDateInputFn = parseBusinessDateInput,
    shiftBusinessDateFn = shiftBusinessDate,
    eventEmitter = appEmitter,
  } = {}) {
    this.ActivityCorrectionModel = ActivityCorrectionModel;
    this.ActivityPrintRunModel = ActivityPrintRunModel;
    this.ActivityPageModel = ActivityPageModel;
    this.ActivityBookModel = ActivityBookModel;
    this.ensureClassAccess = ensureClassAccessFn;
    this.ensureStudentAccessInAnyOwnedClass = ensureStudentAccessInAnyOwnedClassFn;
    this.getAccessibleClassIds = getAccessibleClassIdsFn;
    this.getActorRoles = getActorRolesFn;
    this.isPrivilegedActor = isPrivilegedActorFn;
    this.parseBusinessDateInput = parseBusinessDateInputFn;
    this.shiftBusinessDate = shiftBusinessDateFn;
    this.eventEmitter = eventEmitter;
  }

  async resolveQr({ schoolId, actor = {}, qrCodePayload }) {
    this.ensureActorAllowed(actor);

    const resolution = await this.resolvePrintRunItem({
      schoolId,
      actor,
      qrCodePayload,
    });

    const correction = await this.ActivityCorrectionModel.findOne({
      schoolId,
      qrCodePayload: resolution.qrCodePayload,
    }).lean();

    const criteriaTemplate = this.resolveCriteriaTemplate({
      activityPage: resolution.activityPage,
      activityBook: resolution.activityBook,
      snapshot: resolution.printRun.snapshot,
    });

    return {
      type: 'activity',
      activity: {
        activityPrintRunId: toStringId(resolution.printRun._id),
        qrCodePayload: resolution.qrCodePayload,
        activityPageId: toStringId(resolution.printRun.activityPageId),
        bookId: toStringId(resolution.printRun.bookId),
        bookTitle: resolution.printRun.snapshot?.bookTitle || resolution.activityBook?.title || '',
        activityTitle: resolution.printRun.snapshot?.activityTitle || resolution.activityPage?.title || '',
        pageNumber: resolution.item.pageNumber || resolution.printRun.snapshot?.pageNumber || 1,
        subject: resolution.printRun.snapshot?.subject || resolution.activityPage?.subject || resolution.activityBook?.subject || '',
        printDate: formatDateOnly(resolution.printRun.printDate),
      },
      student: {
        id: toStringId(resolution.item.studentId),
        name: resolution.item.studentName || resolution.printRun.snapshot?.studentName || '',
      },
      class: {
        id: toStringId(resolution.printRun.classId),
        name: resolution.printRun.snapshot?.className || '',
      },
      teacher: {
        id: toStringId(resolution.printRun.teacherId),
        name: resolution.printRun.snapshot?.teacherName || '',
      },
      correction: correction
        ? {
            exists: true,
            id: toStringId(correction._id),
            status: correction.status || 'corrected',
            criteria: correction.criteria || [],
            generalObservation: correction.generalObservation || null,
          }
        : {
            exists: false,
            id: null,
            status: 'pending',
            criteria: [],
            generalObservation: null,
          },
      criteriaTemplate,
    };
  }

  async createCorrection({ schoolId, actor = {}, payload = {} }) {
    this.ensureActorAllowed(actor);

    const resolution = await this.resolvePrintRunItem({
      schoolId,
      actor,
      qrCodePayload: payload.qrCodePayload,
    });

    const existing = await this.ActivityCorrectionModel.findOne({
      schoolId,
      qrCodePayload: resolution.qrCodePayload,
    }).lean();

    if (existing) {
      throw createHttpError(
        'Ja existe uma correcao registrada para esta atividade.',
        409,
        'ACTIVITY_CORRECTION_ALREADY_EXISTS'
      );
    }

    const criteriaTemplate = this.resolveCriteriaTemplate({
      activityPage: resolution.activityPage,
      activityBook: resolution.activityBook,
      snapshot: resolution.printRun.snapshot,
    });
    const normalizedCriteria = this.validateCriteriaPayload(
      payload.criteria,
      criteriaTemplate
    );
    const now = new Date();

    try {
      const correction = await this.ActivityCorrectionModel.create({
        schoolId,
        classId: resolution.printRun.classId,
        studentId: resolution.item.studentId,
        teacherId: resolution.printRun.teacherId || null,
        correctedByUserId: extractId(actor.id || actor._id),
        reviewedByUserId: null,
        activityPrintRunId: resolution.printRun._id,
        qrCodePayload: resolution.qrCodePayload,
        activityPrintRunItemId: resolution.item.itemId || null,
        activityPageId: resolution.printRun.activityPageId,
        activityBookId: resolution.printRun.bookId,
        printDate: resolution.printRun.printDate || null,
        correctionDate: now,
        status: 'corrected',
        criteria: normalizedCriteria,
        generalObservation: normalizeText(payload.generalObservation),
        criteriaTemplateSnapshot: criteriaTemplate,
        snapshot: this.buildSnapshot(resolution),
        correctedAt: now,
        reviewedAt: null,
      });

      this.emitCorrectionUpdated({
        schoolId,
        printRun: resolution.printRun,
        correction,
      });

      return { correction: this.serializeCorrection(correction) };
    } catch (error) {
      if (error?.code === 11000) {
        throw createHttpError(
          'Ja existe uma correcao registrada para esta atividade.',
          409,
          'ACTIVITY_CORRECTION_ALREADY_EXISTS'
        );
      }
      throw error;
    }
  }

  async updateCorrection({ schoolId, actor = {}, correctionId, payload = {} }) {
    this.ensureActorAllowed(actor);
    ensureObjectId(correctionId, 'ACTIVITY_CORRECTION_NOT_FOUND', 'Correcao invalida.');

    const correction = await this.ActivityCorrectionModel.findOne({
      _id: correctionId,
      schoolId,
    });

    if (!correction) {
      throw createHttpError('Correcao nao encontrada.', 404, 'ACTIVITY_CORRECTION_NOT_FOUND');
    }

    await this.ensureCorrectionUpdatePermission({ actor, correction });

    const activityPage = correction.activityPageId
      ? await this.ActivityPageModel.findById(correction.activityPageId).lean()
      : null;
    const activityBook = correction.activityBookId
      ? await this.ActivityBookModel.findById(correction.activityBookId).lean()
      : null;

    const criteriaTemplate = this.resolveCriteriaTemplate({
      activityPage,
      activityBook,
      snapshot: correction.snapshot,
      fallbackTemplate: correction.criteriaTemplateSnapshot,
    });

    if (Object.prototype.hasOwnProperty.call(payload, 'criteria')) {
      correction.criteria = this.validateCriteriaPayload(payload.criteria, criteriaTemplate);
      correction.criteriaTemplateSnapshot = criteriaTemplate;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'generalObservation')) {
      correction.generalObservation = normalizeText(payload.generalObservation);
    }

    correction.status = correction.status === 'reviewed' ? 'reviewed' : 'corrected';
    correction.correctedAt = new Date();
    correction.correctionDate = correction.correctedAt;
    await correction.save();

    this.emitCorrectionUpdated({
      schoolId,
      printRun: {
        classId: correction.classId,
        teacherId: correction.teacherId,
        termId: null,
      },
      correction,
    });

    return { correction: this.serializeCorrection(correction) };
  }

  async listPrintRunsForCorrection({ schoolId, actor = {}, filters = {} }) {
    this.ensureActorAllowed(actor);

    const query = await this.buildPrintRunCorrectionQuery({ schoolId, actor, filters });
    const printRuns = await this.ActivityPrintRunModel.find(query)
      .sort({ printDate: -1, createdAt: -1 })
      .lean();

    const qrCodePayloads = printRuns.flatMap((printRun) =>
      toArray(printRun.items)
        .map((item) => item?.qrCodePayload)
        .filter(Boolean)
    );
    const corrections = qrCodePayloads.length > 0
      ? await this.ActivityCorrectionModel.find({
          schoolId,
          qrCodePayload: { $in: qrCodePayloads },
        })
          .select('qrCodePayload status correctedAt correctionDate')
          .lean()
      : [];
    const correctionByQr = new Map(
      corrections.map((correction) => [correction.qrCodePayload, correction])
    );

    const items = printRuns.map((printRun) => {
      const students = toArray(printRun.items).map((item) => {
        const correction = correctionByQr.get(item.qrCodePayload);
        const status = correction && correction.status !== 'voided'
          ? (correction.status || 'corrected')
          : 'pending';
        return {
          studentId: toStringId(item.studentId),
          studentName: item.studentName || '',
          qrCodePayload: item.qrCodePayload,
          pageNumber: item.pageNumber || printRun.snapshot?.pageNumber || 1,
          status,
          correctionId: correction ? toStringId(correction._id) : null,
          correctedAt: correction?.correctedAt || correction?.correctionDate || null,
        };
      });
      const pendingCount = students.filter((student) => student.status === 'pending').length;

      return {
        id: toStringId(printRun._id),
        activityPageId: toStringId(printRun.activityPageId),
        bookId: toStringId(printRun.bookId),
        classId: toStringId(printRun.classId),
        teacherId: toStringId(printRun.teacherId),
        termId: toStringId(printRun.termId),
        termName: printRun.snapshot?.termName || '',
        bookTitle: printRun.snapshot?.bookTitle || '',
        activityTitle: printRun.snapshot?.activityTitle || '',
        subject: printRun.snapshot?.subject || '',
        printDate: formatDateOnly(printRun.printDate),
        totalStudents: students.length,
        pendingCount,
        correctedCount: students.length - pendingCount,
        students,
      };
    });

    return { items, total: items.length };
  }

  async listCorrections({ schoolId, actor = {}, filters = {} }) {
    this.ensureActorAllowed(actor);

    const { page, limit, skip } = normalizePagination(filters);
    const query = await this.buildCorrectionQuery({ schoolId, actor, filters });

    const [items, total] = await Promise.all([
      this.ActivityCorrectionModel.find(query)
        .sort({ correctionDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.ActivityCorrectionModel.countDocuments(query),
    ]);

    return {
      items: items.map((item) => this.serializeCorrection(item)),
      page,
      limit,
      total,
    };
  }

  async listStudentCorrections({ schoolId, actor = {}, studentId, filters = {} }) {
    this.ensureActorAllowed(actor);
    ensureObjectId(studentId, 'INVALID_STUDENT_ID', 'Aluno invalido.');

    if (!this.isPrivilegedActor(actor)) {
      await this.ensureStudentAccessInAnyOwnedClass({
        actor,
        schoolId,
        studentId,
        allowedStatuses: ['Ativa'],
      });
    }

    return this.listCorrections({
      schoolId,
      actor,
      filters: {
        ...filters,
        studentId,
      },
    });
  }

  async listPendingCorrections({ schoolId, actor = {}, filters = {} }) {
    this.ensureActorAllowed(actor);

    const { page, limit, skip } = normalizePagination(filters);
    const query = await this.buildPendingPrintRunQuery({ schoolId, actor, filters });
    const printRuns = await this.ActivityPrintRunModel.find(query)
      .sort({ printDate: -1, createdAt: -1 })
      .lean();

    const qrPayloads = [];
    printRuns.forEach((printRun) => {
      toArray(printRun.items).forEach((item) => {
        if (item?.qrCodePayload) qrPayloads.push(item.qrCodePayload);
      });
    });

    const corrections = qrPayloads.length > 0
      ? await this.ActivityCorrectionModel.find({
          schoolId,
          qrCodePayload: { $in: qrPayloads },
        })
          .select('qrCodePayload status')
          .lean()
      : [];

    const correctionByQr = new Map(
      corrections.map((correction) => [correction.qrCodePayload, correction])
    );

    const pendingItems = [];
    printRuns.forEach((printRun) => {
      toArray(printRun.items).forEach((item) => {
        const existing = correctionByQr.get(item.qrCodePayload);
        if (existing && existing.status !== 'voided') return;

        pendingItems.push({
          qrCodePayload: item.qrCodePayload,
          activityPrintRunId: toStringId(printRun._id),
          studentId: toStringId(item.studentId),
          studentName: item.studentName || '',
          classId: toStringId(printRun.classId),
          className: printRun.snapshot?.className || '',
          activityPageId: toStringId(printRun.activityPageId),
          activityTitle: printRun.snapshot?.activityTitle || '',
          bookTitle: printRun.snapshot?.bookTitle || '',
          printDate: formatDateOnly(printRun.printDate),
        });
      });
    });

    const total = pendingItems.length;
    const items = pendingItems.slice(skip, skip + limit);

    return {
      items,
      page,
      limit,
      total,
    };
  }

  async buildCorrectionQuery({ schoolId, actor, filters }) {
    const query = { schoolId };
    const privileged = this.isPrivilegedActor(actor);

    if (filters.classId) {
      ensureObjectId(filters.classId, 'INVALID_CLASS_ID', 'Turma invalida.');
      if (!privileged) {
        await this.ensureClassAccess(actor, schoolId, filters.classId);
      }
      query.classId = filters.classId;
    } else if (!privileged) {
      const classIds = await this.getAccessibleClassIds(actor, schoolId);
      if (!Array.isArray(classIds) || classIds.length === 0) {
        return { schoolId, _id: { $exists: false } };
      }
      query.classId = { $in: classIds };
    }

    if (filters.activityPageId) {
      ensureObjectId(filters.activityPageId, 'INVALID_ACTIVITY_PAGE_ID', 'ActivityPage invalida.');
      query.activityPageId = filters.activityPageId;
    }

    if (filters.studentId) {
      ensureObjectId(filters.studentId, 'INVALID_STUDENT_ID', 'Aluno invalido.');
      if (!privileged) {
        await this.ensureStudentAccessInAnyOwnedClass({
          actor,
          schoolId,
          studentId: filters.studentId,
          allowedStatuses: ['Ativa'],
        });
      }
      query.studentId = filters.studentId;
    }

    if (filters.status) {
      const status = normalizeText(filters.status).toLowerCase();
      if (!ACTIVITY_CORRECTION_STATUSES.includes(status)) {
        throw createHttpError('status invalido.', 400, 'INVALID_ACTIVITY_CORRECTION_STATUS');
      }
      query.status = status;
    }

    const fromDate = sanitizeDateFilter(filters.from, this.parseBusinessDateInput);
    const toDate = sanitizeDateFilter(filters.to, this.parseBusinessDateInput);
    if (filters.from && !fromDate) {
      throw createHttpError('Data inicial invalida.', 400, 'INVALID_DATE_RANGE');
    }
    if (filters.to && !toDate) {
      throw createHttpError('Data final invalida.', 400, 'INVALID_DATE_RANGE');
    }

    if (fromDate || toDate) {
      query.correctionDate = {};
      if (fromDate) query.correctionDate.$gte = fromDate;
      if (toDate) {
        query.correctionDate.$lt = this.shiftBusinessDate(
          toDate,
          1,
          'America/Sao_Paulo',
          { hour: 0, minute: 0, second: 0, millisecond: 0 }
        );
      }
    }

    return query;
  }

  async buildPendingPrintRunQuery({ schoolId, actor, filters }) {
    const query = { schoolId };
    const privileged = this.isPrivilegedActor(actor);

    if (filters.classId) {
      ensureObjectId(filters.classId, 'INVALID_CLASS_ID', 'Turma invalida.');
      if (!privileged) {
        await this.ensureClassAccess(actor, schoolId, filters.classId);
      }
      query.classId = filters.classId;
    } else if (!privileged) {
      const classIds = await this.getAccessibleClassIds(actor, schoolId);
      if (!Array.isArray(classIds) || classIds.length === 0) {
        return { schoolId, _id: { $exists: false } };
      }
      query.classId = { $in: classIds };
    }

    if (filters.activityPageId) {
      ensureObjectId(filters.activityPageId, 'INVALID_ACTIVITY_PAGE_ID', 'ActivityPage invalida.');
      query.activityPageId = filters.activityPageId;
    }

    const fromDate = sanitizeDateFilter(filters.from, this.parseBusinessDateInput);
    const toDate = sanitizeDateFilter(filters.to, this.parseBusinessDateInput);
    if (filters.from && !fromDate) {
      throw createHttpError('Data inicial invalida.', 400, 'INVALID_DATE_RANGE');
    }
    if (filters.to && !toDate) {
      throw createHttpError('Data final invalida.', 400, 'INVALID_DATE_RANGE');
    }

    if (fromDate || toDate) {
      query.printDate = {};
      if (fromDate) query.printDate.$gte = fromDate;
      if (toDate) {
        query.printDate.$lt = this.shiftBusinessDate(
          toDate,
          1,
          'America/Sao_Paulo',
          { hour: 0, minute: 0, second: 0, millisecond: 0 }
        );
      }
    }

    return query;
  }

  async buildPrintRunCorrectionQuery({ schoolId, actor, filters }) {
    const query = { schoolId, status: 'generated' };
    const privileged = this.isPrivilegedActor(actor);

    if (!filters.classId) {
      throw createHttpError('Informe a turma para listar atividades impressas.', 400, 'INVALID_CLASS_ID');
    }
    ensureObjectId(filters.classId, 'INVALID_CLASS_ID', 'Turma invalida.');
    if (!privileged) await this.ensureClassAccess(actor, schoolId, filters.classId);
    query.classId = filters.classId;

    if (!filters.termId) {
      throw createHttpError('Informe o bimestre para listar atividades impressas.', 400, 'INVALID_TERM_ID');
    }
    ensureObjectId(filters.termId, 'INVALID_TERM_ID', 'Bimestre invalido.');
    query.termId = filters.termId;

    const actorId = extractId(actor.id || actor._id);
    const requestedTeacherId = normalizeText(filters.teacherId);
    if (!privileged) {
      if (!actorId) {
        return { schoolId, _id: { $exists: false } };
      }
      if (requestedTeacherId && !sameId(requestedTeacherId, actorId)) {
        throw createHttpError('Professor invalido para a sessao atual.', 403, 'ACTIVITY_CORRECTION_FORBIDDEN');
      }
      query.teacherId = actorId;
    } else if (requestedTeacherId) {
      ensureObjectId(requestedTeacherId, 'INVALID_TEACHER_ID', 'Professor invalido.');
      query.teacherId = requestedTeacherId;
    }

    const subject = normalizeText(filters.subject);
    if (subject) {
      query['snapshot.subject'] = { $regex: `^${escapeRegex(subject)}$`, $options: 'i' };
    }

    return query;
  }

  emitCorrectionUpdated({ schoolId, printRun = {}, correction }) {
    if (!this.eventEmitter?.emit) return;
    this.eventEmitter.emit('activity:correction-updated', {
      schoolId: toStringId(schoolId),
      school_id: toStringId(schoolId),
      classId: toStringId(printRun.classId),
      teacherId: toStringId(printRun.teacherId),
      termId: toStringId(printRun.termId),
      activityPrintRunId: toStringId(correction.activityPrintRunId),
      qrCodePayload: correction.qrCodePayload,
      correctionId: toStringId(correction._id),
      status: correction.status || 'corrected',
    });
  }

  ensureActorAllowed(actor = {}) {
    const roles = this.getActorRoles(actor);
    if (roles.some((role) => FORBIDDEN_ACTOR_ROLES.has(role))) {
      throw createHttpError(
        'Perfil sem permissao para corrigir atividades.',
        403,
        'ACTIVITY_CORRECTION_FORBIDDEN'
      );
    }
  }

  async ensureCorrectionUpdatePermission({ actor, correction }) {
    if (this.isPrivilegedActor(actor)) return;

    const actorId = extractId(actor.id || actor._id);
    if (actorId && sameId(actorId, correction.correctedByUserId)) {
      return;
    }

    try {
      await this.ensureClassAccess(actor, correction.schoolId, correction.classId);
    } catch (error) {
      throw createHttpError(
        'Voce nao tem permissao para atualizar esta correcao.',
        403,
        'ACTIVITY_CORRECTION_FORBIDDEN'
      );
    }
  }

  async resolvePrintRunItem({ schoolId, actor, qrCodePayload }) {
    const payload = normalizeText(qrCodePayload);
    if (!payload || !payload.startsWith(ACTIVITY_QR_PREFIX)) {
      throw createHttpError('QR Code de atividade invalido.', 400, 'INVALID_ACTIVITY_QR');
    }

    const printRun = await this.ActivityPrintRunModel.findOne({
      schoolId,
      'items.qrCodePayload': payload,
    }).lean();

    if (!printRun) {
      const foreignMatch = await this.ActivityPrintRunModel.findOne({
        'items.qrCodePayload': payload,
      }).select('_id schoolId').lean();

      if (foreignMatch) {
        throw createHttpError(
          'QR Code pertence a outra escola.',
          403,
          'ACTIVITY_QR_SCHOOL_MISMATCH'
        );
      }

      throw createHttpError(
        'QR Code de atividade nao encontrado.',
        404,
        'ACTIVITY_QR_NOT_FOUND'
      );
    }

    try {
      await this.ensureClassAccess(actor, schoolId, printRun.classId);
    } catch (error) {
      throw createHttpError(
        'Voce nao tem permissao para acessar esta atividade.',
        403,
        'ACTIVITY_CORRECTION_FORBIDDEN'
      );
    }

    const item = toArray(printRun.items).find((candidate) => candidate.qrCodePayload === payload);
    if (!item) {
      throw createHttpError(
        'QR Code de atividade nao encontrado.',
        404,
        'ACTIVITY_QR_NOT_FOUND'
      );
    }

    const [activityPage, activityBook] = await Promise.all([
      printRun.activityPageId ? this.ActivityPageModel.findById(printRun.activityPageId).lean() : null,
      printRun.bookId ? this.ActivityBookModel.findById(printRun.bookId).lean() : null,
    ]);

    return {
      qrCodePayload: payload,
      printRun,
      item,
      activityPage,
      activityBook,
    };
  }

  resolveCriteriaTemplate({
    activityPage,
    activityBook,
    snapshot = {},
    fallbackTemplate = null,
  }) {
    const candidateTemplate = toArray(activityPage?.criteriaTemplate).length > 0
      ? activityPage.criteriaTemplate
      : toArray(activityBook?.defaultCriteriaTemplate).length > 0
        ? activityBook.defaultCriteriaTemplate
        : toArray(fallbackTemplate).length > 0
          ? fallbackTemplate
          : this.buildDefaultTemplate(snapshot);

    return candidateTemplate
      .map(cloneTemplateEntry)
      .filter((item) => item.key && item.label)
      .map((item) => ({
        ...item,
        scale: item.scale.length > 0 ? item.scale : [...DEFAULT_CRITERIA_SCALE],
      }));
  }

  buildDefaultTemplate(snapshot = {}) {
    const text = [
      snapshot?.activityTitle,
      snapshot?.bookTitle,
      snapshot?.subject,
      snapshot?.segment,
      snapshot?.grade,
    ]
      .map((value) => normalizeText(value).toLowerCase())
      .join(' ');

    const template = DEFAULT_CRITERIA_TEMPLATE.map((item) => ({
      ...item,
      scale: [...item.scale],
    }));

    if (
      /alfabet|letra|numero|vogal|pre-escola|educacao infantil|1º|1o|1 ano/.test(text)
    ) {
      template.push({
        ...ALFABETIZACAO_CRITERION,
        scale: [...ALFABETIZACAO_CRITERION.scale],
      });
    }

    return template;
  }

  validateCriteriaPayload(criteria, template) {
    if (!Array.isArray(criteria) || criteria.length === 0) {
      throw createHttpError(
        'Informe ao menos um criterio de avaliacao.',
        400,
        'INVALID_ACTIVITY_CRITERIA'
      );
    }

    const templateByKey = new Map(template.map((item) => [item.key, item]));
    const usedKeys = new Set();

    return criteria.map((entry) => {
      const key = normalizeText(entry?.key);
      const value = normalizeText(entry?.value);
      const note = normalizeText(entry?.note);

      if (!key || usedKeys.has(key) || !templateByKey.has(key)) {
        throw createHttpError(
          'Os criterios informados sao invalidos para esta atividade.',
          400,
          'INVALID_ACTIVITY_CRITERIA'
        );
      }

      const templateEntry = templateByKey.get(key);
      if (!templateEntry.scale.includes(value)) {
        throw createHttpError(
          `Valor invalido para o criterio ${templateEntry.label}.`,
          400,
          'INVALID_ACTIVITY_CRITERIA_VALUE'
        );
      }

      usedKeys.add(key);
      return {
        key,
        label: templateEntry.label,
        value,
        note,
      };
    });
  }

  buildSnapshot(resolution) {
    return {
      studentName: resolution.item.studentName || '',
      className: resolution.printRun.snapshot?.className || '',
      teacherName: resolution.printRun.snapshot?.teacherName || '',
      schoolName: resolution.printRun.snapshot?.schoolName || '',
      activityTitle: resolution.printRun.snapshot?.activityTitle || '',
      bookTitle: resolution.printRun.snapshot?.bookTitle || '',
      subject: resolution.printRun.snapshot?.subject || '',
      pageNumber: resolution.item.pageNumber || resolution.printRun.snapshot?.pageNumber || 1,
    };
  }

  serializeCorrection(correction = {}) {
    return {
      id: toStringId(correction._id),
      status: correction.status || 'corrected',
      qrCodePayload: correction.qrCodePayload,
      schoolId: toStringId(correction.schoolId),
      classId: toStringId(correction.classId),
      studentId: toStringId(correction.studentId),
      teacherId: toStringId(correction.teacherId),
      activityPrintRunId: toStringId(correction.activityPrintRunId),
      activityPageId: toStringId(correction.activityPageId),
      activityBookId: toStringId(correction.activityBookId),
      criteria: correction.criteria || [],
      generalObservation: correction.generalObservation || '',
      correctedAt: correction.correctedAt || null,
      reviewedAt: correction.reviewedAt || null,
      snapshot: correction.snapshot || {},
    };
  }
}

module.exports = new ActivityCorrectionService();
module.exports.ActivityCorrectionService = ActivityCorrectionService;
module.exports.ACTIVITY_QR_PREFIX = ACTIVITY_QR_PREFIX;
module.exports.DEFAULT_CRITERIA_SCALE = DEFAULT_CRITERIA_SCALE;
module.exports.DEFAULT_CRITERIA_TEMPLATE = DEFAULT_CRITERIA_TEMPLATE;
