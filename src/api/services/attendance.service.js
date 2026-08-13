const mongoose = require('mongoose');

const Attendance = require('../models/attendance.model');
const Enrollment = require('../models/enrollment.model');
const Student = require('../models/student.model');
const {
  createHttpError,
  ensureClassAccess,
  extractId,
  isPrivilegedActor,
} = require('./classAccess.service');
const absenceJustificationService = require('./absenceJustification.service');

const DEFAULT_JUSTIFICATION_DEADLINE_DAYS = Number(
  process.env.ATTENDANCE_JUSTIFICATION_DEADLINE_DAYS || 3
);
const ATTENDANCE_TIME_ZONE =
  process.env.ATTENDANCE_TIME_ZONE || process.env.SCHOOL_TIME_ZONE || 'America/Sao_Paulo';

const ABSENCE_STATES = {
  NONE: 'NONE',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
};

function createAttendanceError(message, statusCode = 400, extra = {}) {
  const error = createHttpError(message, statusCode);
  Object.assign(error, extra);
  return error;
}

function parseLocalDate(dateValue) {
  if (!dateValue) return new Date();

  if (typeof dateValue === 'string') {
    const datePart = dateValue.split('T')[0];
    const [year, month, day] = datePart.split('-');

    if (year && month && day) {
      return new Date(year, Number.parseInt(month, 10) - 1, Number.parseInt(day, 10));
    }
  }

  return new Date(dateValue);
}

function startOfDay(dateValue) {
  const date = parseLocalDate(dateValue);
  date.setHours(0, 0, 0, 0);
  return date;
}

function formatDateKey(dateValue) {
  const date = startOfDay(dateValue);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateKeyInTimeZone(dateValue, timeZone = ATTENDANCE_TIME_ZONE) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(dateValue));

    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  } catch (_) {
    return timeZone === 'America/Sao_Paulo'
      ? formatDateKey(dateValue)
      : formatDateKeyInTimeZone(dateValue, 'America/Sao_Paulo');
  }
}

function endOfDay(dateValue) {
  const date = parseLocalDate(dateValue);
  date.setHours(23, 59, 59, 999);
  return date;
}

function addDays(dateValue, days) {
  const date = parseLocalDate(dateValue);
  date.setDate(date.getDate() + days);
  return date;
}

function normalizeStatus(status) {
  return String(status || 'PRESENT').toUpperCase() === 'ABSENT'
    ? 'ABSENT'
    : 'PRESENT';
}

function normalizeAbsenceState(state) {
  const normalized = String(state || ABSENCE_STATES.NONE).toUpperCase();
  return ABSENCE_STATES[normalized] || ABSENCE_STATES.NONE;
}

function compareDateOnly(left, right) {
  const leftKey = formatDateKey(left);
  const rightKey = right ? formatDateKey(right) : formatDateKeyInTimeZone(new Date());

  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function getAttendancePermissions(actor, targetDate) {
  const comparison = compareDateOnly(targetDate, null);
  const isRetroactive = comparison < 0;
  const isFuture = comparison > 0;
  const hasAdministrativePermission = isPrivilegedActor(actor);
  const canUseDailyFlow = !isRetroactive && !isFuture;
  const canModify = hasAdministrativePermission || canUseDailyFlow;

  let permissionReason = null;
  if (!canModify && isRetroactive) {
    permissionReason = 'Você não tem permissão para alterar chamadas retroativas.';
  } else if (!canModify && isFuture) {
    permissionReason = 'Você não tem permissão para alterar chamadas fora do dia atual.';
  }

  return {
    canCreate: canModify,
    canEdit: canModify,
    isRetroactive,
    isFuture,
    hasAdministrativePermission,
    permissionReason,
  };
}

function roundRate(value) {
  return Math.round(value * 100) / 100;
}

function buildAttendanceSummary(payload) {
  const records = Array.isArray(payload?.records) ? payload.records : [];

  const presentCount = records.filter(
    (record) => normalizeStatus(record.status) === 'PRESENT'
  ).length;
  const absentCount = records.filter(
    (record) => normalizeStatus(record.status) === 'ABSENT'
  ).length;
  const pendingCount = records.filter(
    (record) =>
      normalizeStatus(record.status) === 'ABSENT' &&
      normalizeAbsenceState(record.absenceState) === ABSENCE_STATES.PENDING
  ).length;
  const approvedCount = records.filter(
    (record) =>
      normalizeStatus(record.status) === 'ABSENT' &&
      normalizeAbsenceState(record.absenceState) === ABSENCE_STATES.APPROVED
  ).length;
  const rejectedCount = records.filter(
    (record) =>
      normalizeStatus(record.status) === 'ABSENT' &&
      normalizeAbsenceState(record.absenceState) === ABSENCE_STATES.REJECTED
  ).length;
  const expiredCount = records.filter(
    (record) =>
      normalizeStatus(record.status) === 'ABSENT' &&
      normalizeAbsenceState(record.absenceState) === ABSENCE_STATES.EXPIRED
  ).length;

  return {
    ...payload,
    totalStudents: records.length,
    presentCount,
    absentCount,
    pendingCount,
    approvedCount,
    rejectedCount,
    expiredCount,
    presenceRate: records.length === 0 ? 0 : roundRate(presentCount / records.length),
  };
}

function buildAttendanceResponse(document) {
  if (!document) return null;

  const payload =
    typeof document.toObject === 'function'
      ? document.toObject({ virtuals: false })
      : { ...document };

  return buildAttendanceSummary(payload);
}

function buildDeadlineForAbsence(targetDate) {
  return endOfDay(addDays(targetDate, DEFAULT_JUSTIFICATION_DEADLINE_DAYS));
}

async function populateAttendance(attendanceId) {
  return Attendance.findById(attendanceId).populate(
    'records.studentId',
    'fullName photoUrl profilePictureUrl'
  );
}

async function expireOverdueAbsencesForClass(schoolId, classId) {
  const now = new Date();

  await Attendance.updateMany(
    {
      schoolId,
      classId,
      'records.status': 'ABSENT',
      'records.absenceState': { $in: [ABSENCE_STATES.NONE] },
      'records.justificationDeadlineAt': { $lt: now },
    },
    {
      $set: {
        'records.$[record].absenceState': ABSENCE_STATES.EXPIRED,
        'records.$[record].justificationUpdatedAt': now,
        'metadata.syncedAt': now,
      },
    },
    {
      arrayFilters: [
        {
          'record.status': 'ABSENT',
          'record.absenceState': { $in: [ABSENCE_STATES.NONE] },
          'record.justificationDeadlineAt': { $lt: now },
        },
      ],
    }
  );
}

function buildRecentRecordLabel(status, absenceState) {
  if (status === 'PRESENT') {
    return 'Presente';
  }

  if (absenceState === ABSENCE_STATES.APPROVED) {
    return 'Falta justificada';
  }

  if (absenceState === ABSENCE_STATES.PENDING) {
    return 'Falta aguardando justificativa';
  }

  if (absenceState === ABSENCE_STATES.REJECTED) {
    return 'Falta com justificativa recusada';
  }

  if (absenceState === ABSENCE_STATES.EXPIRED) {
    return 'Falta sem justificativa';
  }

  return 'Falta';
}

function getStudentRecordFromAttendance(entry, studentId) {
  const targetStudentId = String(studentId);
  const records = Array.isArray(entry?.records) ? entry.records : [];

  return records.find((record) => extractId(record.studentId) === targetStudentId) || null;
}

function buildStudentSnapshot(student) {
  if (!student) return null;

  return {
    id: extractId(student._id || student.id || student),
    fullName: student.fullName || student.name || 'Aluno',
    photoUrl: student.photoUrl || student.profilePictureUrl || null,
  };
}

function buildClassSnapshot(classDoc) {
  if (!classDoc) return null;

  return {
    id: extractId(classDoc._id || classDoc.id || classDoc),
    name: classDoc.name || 'Turma',
    grade: classDoc.grade || null,
    shift: classDoc.shift || null,
    schoolYear: classDoc.schoolYear || null,
  };
}

function normalizeReportRange(startDate, endDate) {
  const start = startDate ? startOfDay(startDate) : null;
  const end = endDate ? endOfDay(endDate) : null;

  if (start && Number.isNaN(start.getTime())) {
    throw createAttendanceError('Data inicial invalida.', 400);
  }

  if (end && Number.isNaN(end.getTime())) {
    throw createAttendanceError('Data final invalida.', 400);
  }

  if (start && end && start > end) {
    throw createAttendanceError('A data inicial nao pode ser posterior a data final.', 400);
  }

  const today = endOfDay(new Date());
  if ((start && start > today) || (end && end > today)) {
    throw createAttendanceError('Nao e permitido consultar frequencia em periodo futuro.', 400);
  }

  return { start, end };
}

function eachWeekday(startDate, endDate) {
  const days = [];
  const cursor = startOfDay(startDate);
  const limit = startOfDay(endDate);

  while (cursor <= limit) {
    const dayOfWeek = cursor.getDay();
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      days.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

function buildJustificationSnapshot(record) {
  const justification = record?.justificationId;
  if (!justification || typeof justification !== 'object') {
    return record?.justificationId
      ? { id: extractId(record.justificationId), hasAttachment: false }
      : null;
  }

  const document = justification.document || {};

  return {
    id: extractId(justification._id || justification.id),
    status: justification.status || null,
    documentType: justification.documentType || null,
    notes: justification.notes || '',
    hasAttachment: Boolean(document.fileName || document.size),
    attachmentFileName: document.fileName || null,
    coverageStartDate: justification.coverageStartDate
      ? formatDateKey(justification.coverageStartDate)
      : null,
    coverageEndDate: justification.coverageEndDate
      ? formatDateKey(justification.coverageEndDate)
      : null,
  };
}

function buildReportRecord(entry, studentRecord) {
  const status = normalizeStatus(studentRecord.status);
  const absenceState =
    status === 'ABSENT'
      ? normalizeAbsenceState(studentRecord.absenceState)
      : ABSENCE_STATES.NONE;

  return {
    attendanceId: extractId(entry._id),
    date: formatDateKey(entry.date),
    status,
    absenceState,
    label: buildRecentRecordLabel(status, absenceState),
    observation: studentRecord.observation || '',
    justification: buildJustificationSnapshot(studentRecord),
    updatedAt: studentRecord.justificationUpdatedAt || entry.updatedAt || entry.date,
  };
}

function buildSummaryFromRecords(records) {
  const totalRecords = records.length;
  const presentCount = records.filter((record) => record.status === 'PRESENT').length;
  const absentCount = records.filter((record) => record.status === 'ABSENT').length;
  const justifiedAbsences = records.filter(
    (record) =>
      record.status === 'ABSENT' && record.absenceState === ABSENCE_STATES.APPROVED
  ).length;
  const pendingJustifications = records.filter(
    (record) =>
      record.status === 'ABSENT' && record.absenceState === ABSENCE_STATES.PENDING
  ).length;
  const rejectedJustifications = records.filter(
    (record) =>
      record.status === 'ABSENT' && record.absenceState === ABSENCE_STATES.REJECTED
  ).length;
  const expiredJustifications = records.filter(
    (record) =>
      record.status === 'ABSENT' && record.absenceState === ABSENCE_STATES.EXPIRED
  ).length;

  return {
    totalRecords,
    totalClasses: totalRecords,
    presentCount,
    absentCount,
    justifiedAbsences,
    pendingJustifications,
    rejectedJustifications,
    expiredJustifications,
    presenceRate: totalRecords === 0 ? 0 : roundRate(presentCount / totalRecords),
    presencePercentage: totalRecords === 0 ? 0 : roundRate((presentCount / totalRecords) * 100),
  };
}

async function getFirstAttendanceInfo(schoolId, classId, actor) {
  const classDoc = await ensureClassAccess(actor, schoolId, classId);

  const firstAttendance = await Attendance.findOne({
    schoolId: new mongoose.Types.ObjectId(schoolId),
    classId: new mongoose.Types.ObjectId(classId),
  })
    .sort({ date: 1, createdAt: 1 })
    .select('date')
    .lean();

  return {
    classId: extractId(classDoc._id),
    firstAttendanceDate: firstAttendance?.date
      ? formatDateKey(firstAttendance.date)
      : null,
    hasAttendance: Boolean(firstAttendance),
  };
}

async function assertPeriodWithinAttendanceWindow(schoolId, classId, actor, startDate, endDate) {
  const firstInfo = await getFirstAttendanceInfo(schoolId, classId, actor);

  if (!firstInfo.hasAttendance) {
    throw createAttendanceError('Esta turma ainda nao possui chamadas registradas.', 404, {
      code: 'attendance_not_found_for_class',
    });
  }

  const firstDate = startOfDay(firstInfo.firstAttendanceDate);
  if (startDate && startDate < firstDate) {
    throw createAttendanceError(
      `Os registros de chamada desta turma começam em ${formatDateKey(firstDate)}.`,
      400,
      {
        code: 'attendance_period_before_first_record',
        firstAttendanceDate: formatDateKey(firstDate),
      }
    );
  }

  return {
    firstInfo,
    start: startDate || firstDate,
    end: endDate || endOfDay(new Date()),
  };
}

async function ensureStudentClassHistoryAccess({ schoolId, classId, studentId, actor }) {
  const classDoc = await ensureClassAccess(actor, schoolId, classId);

  if (!studentId || !mongoose.Types.ObjectId.isValid(studentId)) {
    throw createAttendanceError('Aluno invalido.', 400);
  }

  const enrollment = await Enrollment.findOne({
    school_id: schoolId,
    class: classDoc._id,
    student: studentId,
  })
    .select('_id student class status academicYear enrollmentDate')
    .populate('student', 'fullName photoUrl profilePictureUrl')
    .lean();

  const attendanceExists = await Attendance.exists({
    schoolId,
    classId,
    'records.studentId': new mongoose.Types.ObjectId(studentId),
  });

  if (!enrollment && !attendanceExists) {
    throw createAttendanceError('Aluno nao encontrado no historico desta turma.', 404);
  }

  const student =
    enrollment?.student ||
    (await Student.findOne({ _id: studentId, school_id: schoolId })
      .select('fullName photoUrl profilePictureUrl')
      .lean());

  return { classDoc, enrollment, student };
}

async function expireOverdueAbsencesByStudent(schoolId, studentId, classId = null) {
  const now = new Date();
  const query = {
    schoolId,
    'records.status': 'ABSENT',
    'records.studentId': new mongoose.Types.ObjectId(studentId),
    'records.absenceState': { $in: [ABSENCE_STATES.NONE] },
    'records.justificationDeadlineAt': { $lt: now },
  };

  if (classId) {
    query.classId = classId;
  }

  await Attendance.updateMany(
    query,
    {
      $set: {
        'records.$[record].absenceState': ABSENCE_STATES.EXPIRED,
        'records.$[record].justificationUpdatedAt': now,
        'metadata.syncedAt': now,
      },
    },
    {
      arrayFilters: [
        {
          'record.studentId': new mongoose.Types.ObjectId(studentId),
          'record.status': 'ABSENT',
          'record.absenceState': { $in: [ABSENCE_STATES.NONE] },
          'record.justificationDeadlineAt': { $lt: now },
        },
      ],
    }
  );
}

async function createOrUpdate(data, actor) {
  await ensureClassAccess(actor, data.schoolId, data.classId);

  const targetStart = startOfDay(data.date || new Date());
  const targetEnd = endOfDay(data.date || new Date());

  const query = {
    schoolId: data.schoolId,
    classId: data.classId,
    date: { $gte: targetStart, $lte: targetEnd },
  };

  const existingAttendance = await Attendance.findOne(query).select('+appliedOperationIds');
  const standardPermissions = getAttendancePermissions(actor, targetStart);
  const clientUpdatedAt = data.clientUpdatedAt ? new Date(data.clientUpdatedAt) : null;
  const isRecentOfflineOperation = Boolean(
    data.operationId &&
    clientUpdatedAt &&
    !Number.isNaN(clientUpdatedAt.getTime()) &&
    formatDateKeyInTimeZone(clientUpdatedAt) === formatDateKey(targetStart) &&
    Date.now() - clientUpdatedAt.getTime() <= 30 * 24 * 60 * 60 * 1000
  );
  const permissions = isRecentOfflineOperation
    ? { ...standardPermissions, canCreate: true, canEdit: true, permissionReason: null }
    : standardPermissions;

  const operationId = String(data.operationId || '').trim();
  const requestedBaseVersion = Number.isInteger(Number(data.baseVersion))
    ? Number(data.baseVersion)
    : null;
  const existingVersion = Number(existingAttendance?.version) || 1;

  if (operationId && existingAttendance?.appliedOperationIds?.includes(operationId)) {
    return {
      ...buildAttendanceResponse(await populateAttendance(existingAttendance._id)),
      sync: { status: 'duplicate', operationId },
    };
  }

  if (operationId && existingAttendance && requestedBaseVersion !== existingVersion) {
    throw createAttendanceError(
      'A chamada foi alterada no servidor depois que esta versao foi carregada.',
      409,
      {
        code: 'ATTENDANCE_VERSION_CONFLICT',
        serverVersion: existingVersion,
        serverAttendance: buildAttendanceResponse(await populateAttendance(existingAttendance._id)),
      }
    );
  }

  if (operationId && !existingAttendance && requestedBaseVersion !== 0) {
    throw createAttendanceError('A versao-base da nova chamada deve ser zero.', 409, {
      code: 'ATTENDANCE_VERSION_CONFLICT',
      serverVersion: 0,
    });
  }

  if (existingAttendance && !permissions.canEdit) {
    throw createHttpError(
      permissions.permissionReason || 'Você não tem permissão para editar esta chamada.',
      403
    );
  }

  if (!existingAttendance && !permissions.canCreate) {
    throw createHttpError(
      permissions.permissionReason || 'Você não tem permissão para criar esta chamada.',
      403
    );
  }

  const existingByStudentId = new Map(
    (existingAttendance?.records || []).map((record) => [String(record.studentId), record])
  );

  const normalizedRecords = (data.records || []).map((record) => {
    const studentId = extractId(record.studentId);
    const status = normalizeStatus(record.status);
    const existingRecord = existingByStudentId.get(String(studentId));

    const merged = {
      studentId,
      status,
      observation: record.observation || '',
    };

    if (status === 'ABSENT') {
      merged.absenceState = existingRecord?.absenceState || ABSENCE_STATES.NONE;
      merged.justificationId = existingRecord?.justificationId || null;
      merged.justificationDeadlineAt =
        existingRecord?.justificationDeadlineAt || buildDeadlineForAbsence(targetStart);
      merged.justificationUpdatedAt = existingRecord?.justificationUpdatedAt || null;
    } else {
      merged.absenceState = ABSENCE_STATES.NONE;
      merged.justificationId = null;
      merged.justificationDeadlineAt = null;
      merged.justificationUpdatedAt = null;
    }

    return merged;
  });

  const update = {
    schoolId: data.schoolId,
    classId: data.classId,
    teacherId: data.teacherId,
    date: targetStart,
    records: normalizedRecords,
    metadata: {
      device: data.metadata?.device || existingAttendance?.metadata?.device || 'mobile',
      syncedAt: new Date(),
    },
  };

  let result;
  const nextVersion = existingAttendance ? existingVersion + 1 : 1;
  update.version = nextVersion;
  try {
    if (existingAttendance) {
      const guardedQuery = operationId
        ? {
            _id: existingAttendance._id,
            $or: [{ version: existingVersion }, ...(existingAttendance.version == null ? [{ version: { $exists: false } }] : [])],
            appliedOperationIds: { $ne: operationId },
          }
        : { _id: existingAttendance._id };
      const updateCommand = { $set: update };
      if (operationId) updateCommand.$addToSet = { appliedOperationIds: operationId };
      result = await Attendance.findOneAndUpdate(guardedQuery, updateCommand, {
        new: true,
        runValidators: true,
      });
      if (!result && operationId) {
        const latest = await Attendance.findById(existingAttendance._id).select('+appliedOperationIds');
        if (latest?.appliedOperationIds?.includes(operationId)) {
          return {
            ...buildAttendanceResponse(await populateAttendance(latest._id)),
            sync: { status: 'duplicate', operationId },
          };
        }
        throw createAttendanceError('A chamada mudou durante a sincronizacao.', 409, {
          code: 'ATTENDANCE_VERSION_CONFLICT',
          serverVersion: latest?.version,
          serverAttendance: latest ? buildAttendanceResponse(await populateAttendance(latest._id)) : null,
        });
      }
    } else {
      result = await Attendance.create({
        ...update,
        ...(operationId ? { appliedOperationIds: [operationId] } : {}),
      });
    }
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const latest = await Attendance.findOne(query).select('+appliedOperationIds');
    if (operationId && latest?.appliedOperationIds?.includes(operationId)) {
      return {
        ...buildAttendanceResponse(await populateAttendance(latest._id)),
        sync: { status: 'duplicate', operationId },
      };
    }
    throw createAttendanceError('Ja existe uma versao mais recente desta chamada.', 409, {
      code: 'ATTENDANCE_VERSION_CONFLICT',
      serverVersion: latest?.version,
      serverAttendance: latest ? buildAttendanceResponse(await populateAttendance(latest._id)) : null,
    });
  }

  await absenceJustificationService.applyApprovedRequestCoverageToAttendance(result, actor);
  await expireOverdueAbsencesForClass(data.schoolId, data.classId);

  return {
    ...buildAttendanceResponse(await populateAttendance(result._id)),
    ...(operationId ? { sync: { status: 'applied', operationId } } : {}),
  };
}

async function getDailyList(schoolId, classId, dateString, actor) {
  await ensureClassAccess(actor, schoolId, classId);

  const targetStart = startOfDay(dateString || new Date());
  const targetEnd = endOfDay(dateString || new Date());

  await expireOverdueAbsencesForClass(schoolId, classId);

  const existingAttendance = await Attendance.findOne({
    schoolId,
    classId,
    date: { $gte: targetStart, $lte: targetEnd },
  }).populate('records.studentId', 'fullName photoUrl profilePictureUrl');

  if (existingAttendance) {
    const permissions = getAttendancePermissions(actor, targetStart);
    return {
      type: 'saved',
      date: formatDateKey(targetStart),
      ...permissions,
      canCreate: false,
      data: buildAttendanceResponse(existingAttendance),
    };
  }

  const enrollments = await Enrollment.find({
    school_id: schoolId,
    class: classId,
    status: 'Ativa',
  }).populate('student', 'fullName photoUrl profilePictureUrl');

  const proposedList = {
    schoolId,
    classId,
    date: targetStart,
    records: enrollments
      .filter((enrollment) => enrollment.student)
      .map((enrollment) => ({
        studentId: enrollment.student,
        status: 'PRESENT',
        observation: '',
        absenceState: ABSENCE_STATES.NONE,
        justificationId: null,
        justificationDeadlineAt: null,
        justificationUpdatedAt: null,
      })),
  };

  const permissions = getAttendancePermissions(actor, targetStart);
  return {
    type: 'proposed',
    date: formatDateKey(targetStart),
    ...permissions,
    canEdit: false,
    data: buildAttendanceSummary(proposedList),
  };
}

async function getClassHistory(schoolId, classId, actor) {
  await ensureClassAccess(actor, schoolId, classId);

  await expireOverdueAbsencesForClass(schoolId, classId);

  const history = await Attendance.find({
    schoolId: new mongoose.Types.ObjectId(schoolId),
    classId: new mongoose.Types.ObjectId(classId),
  })
    .sort({ date: -1, updatedAt: -1 })
    .populate('records.studentId', 'fullName photoUrl profilePictureUrl');

  return history.map((entry) => buildAttendanceResponse(entry));
}

async function getHistoryByStudent(schoolId, studentId, options = {}) {
  const { classId = null, actor = null } = options;

  if (!studentId || !mongoose.Types.ObjectId.isValid(studentId)) {
    throw createHttpError('Aluno invalido.', 400);
  }

  if (classId) {
    await ensureClassAccess(actor, schoolId, classId);
  }

  await expireOverdueAbsencesByStudent(schoolId, studentId, classId);

  const query = {
    schoolId,
    'records.studentId': new mongoose.Types.ObjectId(studentId),
  };

  if (classId) {
    query.classId = classId;
  }

  return Attendance.find(query)
    .sort({ date: -1, updatedAt: -1 })
    .select('date classId records.$ metadata updatedAt');
}

async function getStudentClassHistoryReport({
  schoolId,
  classId,
  studentId,
  actor,
  startDate = null,
  endDate = null,
}) {
  const { classDoc, student } = await ensureStudentClassHistoryAccess({
    schoolId,
    classId,
    studentId,
    actor,
  });
  const range = normalizeReportRange(startDate, endDate);
  const window = await assertPeriodWithinAttendanceWindow(
    schoolId,
    classId,
    actor,
    range.start,
    range.end
  );

  await expireOverdueAbsencesByStudent(schoolId, studentId, classId);

  const attendances = await Attendance.find({
    schoolId: new mongoose.Types.ObjectId(schoolId),
    classId: new mongoose.Types.ObjectId(classId),
    date: { $gte: window.start, $lte: window.end },
    'records.studentId': new mongoose.Types.ObjectId(studentId),
  })
    .sort({ date: -1, updatedAt: -1 })
    .populate(
      'records.justificationId',
      'status notes document.fileName document.mimeType document.size documentType coverageStartDate coverageEndDate'
    )
    .lean();

  const records = attendances
    .map((entry) => {
      const studentRecord = getStudentRecordFromAttendance(entry, studentId);
      if (!studentRecord) return null;
      return buildReportRecord(entry, studentRecord);
    })
    .filter(Boolean);

  return {
    class: buildClassSnapshot(classDoc),
    student: buildStudentSnapshot(student),
    period: {
      startDate: formatDateKey(window.start),
      endDate: formatDateKey(window.end),
      firstAttendanceDate: window.firstInfo.firstAttendanceDate,
    },
    summary: buildSummaryFromRecords(records),
    records,
  };
}

async function getClassAttendanceReport({
  schoolId,
  classId,
  actor,
  startDate,
  endDate,
}) {
  const classDoc = await ensureClassAccess(actor, schoolId, classId);
  const range = normalizeReportRange(startDate, endDate);

  if (!range.start || !range.end) {
    throw createAttendanceError('Informe startDate e endDate para gerar o relatorio.', 400);
  }

  const window = await assertPeriodWithinAttendanceWindow(
    schoolId,
    classId,
    actor,
    range.start,
    range.end
  );

  await expireOverdueAbsencesForClass(schoolId, classId);

  const attendances = await Attendance.find({
    schoolId: new mongoose.Types.ObjectId(schoolId),
    classId: new mongoose.Types.ObjectId(classId),
    date: { $gte: window.start, $lte: window.end },
  })
    .sort({ date: 1, updatedAt: 1 })
    .populate('records.studentId', 'fullName photoUrl profilePictureUrl')
    .populate(
      'records.justificationId',
      'status notes document.fileName document.mimeType document.size documentType coverageStartDate coverageEndDate'
    )
    .lean();

  const activeEnrollments = await Enrollment.find({
    school_id: schoolId,
    class: classId,
    status: 'Ativa',
  })
    .populate('student', 'fullName photoUrl profilePictureUrl')
    .lean();

  const studentsById = new Map();
  for (const enrollment of activeEnrollments) {
    if (!enrollment.student) continue;
    studentsById.set(extractId(enrollment.student), buildStudentSnapshot(enrollment.student));
  }

  const attendanceByDate = new Map();
  for (const attendance of attendances) {
    const dateKey = formatDateKey(attendance.date);
    attendanceByDate.set(dateKey, attendance);
    for (const record of attendance.records || []) {
      const id = extractId(record.studentId);
      if (id && !studentsById.has(id)) {
        studentsById.set(id, buildStudentSnapshot(record.studentId));
      }
    }
  }

  const days = eachWeekday(window.start, window.end).map((date) => {
    const dateKey = formatDateKey(date);
    return {
      date: dateKey,
      hasAttendance: attendanceByDate.has(dateKey),
    };
  });

  const students = [...studentsById.values()]
    .filter(Boolean)
    .sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || ''), 'pt-BR'));

  const rows = students.map((student) => {
    const cells = days.map((day) => {
      const attendance = attendanceByDate.get(day.date);
      if (!attendance) {
        return {
          date: day.date,
          status: 'NO_ATTENDANCE',
          label: 'Sem chamada',
          observation: '',
          absenceState: ABSENCE_STATES.NONE,
          justification: null,
        };
      }

      const record = getStudentRecordFromAttendance(attendance, student.id);
      if (!record) {
        return {
          date: day.date,
          status: 'NOT_LISTED',
          label: 'Nao listado',
          observation: '',
          absenceState: ABSENCE_STATES.NONE,
          justification: null,
        };
      }

      return buildReportRecord(attendance, record);
    });

    const analyzedCells = cells.filter(
      (cell) => cell.status === 'PRESENT' || cell.status === 'ABSENT'
    );
    const summary = buildSummaryFromRecords(analyzedCells);

    return {
      student,
      cells,
      summary,
    };
  });

  return {
    class: buildClassSnapshot(classDoc),
    period: {
      startDate: formatDateKey(window.start),
      endDate: formatDateKey(window.end),
      firstAttendanceDate: window.firstInfo.firstAttendanceDate,
    },
    summary: {
      totalStudents: students.length,
      totalAttendanceDays: attendances.length,
      totalWeekdays: days.length,
    },
    days,
    rows,
    legend: {
      PRESENT: 'Presente',
      ABSENT: 'Falta',
      JUSTIFIED_ABSENCE: 'Falta justificada',
      NO_ATTENDANCE: 'Sem chamada registrada',
      NOT_LISTED: 'Aluno nao listado na chamada',
    },
  };
}

async function getStudentRecentHistorySummary({
  schoolId,
  classId,
  studentId,
  actor,
  limit = 7,
  skipAccessCheck = false,
}) {
  if (!studentId || !mongoose.Types.ObjectId.isValid(studentId)) {
    throw createHttpError('Aluno invalido.', 400);
  }

  if (!skipAccessCheck) {
    await ensureClassAccess(actor, schoolId, classId);
  }

  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 7, 15));

  await expireOverdueAbsencesByStudent(schoolId, studentId, classId);

  const history = await Attendance.find({
    schoolId,
    classId,
    'records.studentId': new mongoose.Types.ObjectId(studentId),
  })
    .sort({ date: -1, updatedAt: -1 })
    .limit(normalizedLimit)
    .select('date records metadata updatedAt')
    .lean();

  const records = history
    .map((entry) => {
      const studentRecord = getStudentRecordFromAttendance(entry, studentId);
      if (!studentRecord) return null;

      const status = normalizeStatus(studentRecord.status);
      const absenceState =
        status === 'ABSENT'
          ? normalizeAbsenceState(studentRecord.absenceState)
          : ABSENCE_STATES.NONE;

      return {
        date: entry.date,
        status,
        absenceState,
        label: buildRecentRecordLabel(status, absenceState),
        observation: studentRecord.observation || '',
        updatedAt: studentRecord.justificationUpdatedAt || entry.updatedAt || entry.date,
      };
    })
    .filter(Boolean);

  const presentCount = records.filter((record) => record.status === 'PRESENT').length;
  const absentCount = records.filter((record) => record.status === 'ABSENT').length;
  const justifiedAbsences = records.filter(
    (record) =>
      record.status === 'ABSENT' && record.absenceState === ABSENCE_STATES.APPROVED
  ).length;
  const pendingJustifications = records.filter(
    (record) =>
      record.status === 'ABSENT' && record.absenceState === ABSENCE_STATES.PENDING
  ).length;
  const rejectedJustifications = records.filter(
    (record) =>
      record.status === 'ABSENT' && record.absenceState === ABSENCE_STATES.REJECTED
  ).length;
  const expiredJustifications = records.filter(
    (record) =>
      record.status === 'ABSENT' && record.absenceState === ABSENCE_STATES.EXPIRED
  ).length;

  return {
    window: {
      type: 'last_records',
      requestedSize: normalizedLimit,
      returnedRecords: records.length,
    },
    summary: {
      totalRecords: records.length,
      presentCount,
      absentCount,
      justifiedAbsences,
      pendingJustifications,
      rejectedJustifications,
      expiredJustifications,
      presenceRate: records.length === 0 ? 0 : roundRate(presentCount / records.length),
      lastRecordedAt: records[0]?.date || null,
    },
    records,
  };
}

module.exports = {
  ABSENCE_STATES,
  buildAttendanceResponse,
  buildAttendanceSummary,
  createOrUpdate,
  formatDateKey,
  getAttendancePermissions,
  getDailyList,
  getFirstAttendanceInfo,
  getClassHistory,
  getHistoryByStudent,
  getStudentClassHistoryReport,
  getClassAttendanceReport,
  getStudentRecentHistorySummary,
};
