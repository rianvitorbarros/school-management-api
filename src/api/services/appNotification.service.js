const AppNotification = require('../models/appNotification.model');

const STAFF_TARGET_ROLES = ['Admin', 'Coordenador', 'Gestor', 'Secretaria'];

const ABSENCE_GUARDIAN_STATUS_EVENTS = new Set([
  'absence_justification_request_approved',
  'absence_justification_request_partially_approved',
  'absence_justification_request_rejected',
  'absence_justification_request_needs_information',
  'absence_justification_request_cancelled',
  'absence_justification_request_applied',
]);

const OFFICIAL_DOCUMENT_GUARDIAN_STATUS_EVENTS = new Set([
  'official_document_request_created',
  'official_document_request_approved',
  'official_document_request_rejected',
  'official_document_request_cancelled',
  'official_document_preparing',
  'official_document_awaiting_signature',
  'official_document_signed',
  'official_document_published',
  'official_document_downloaded',
  'official_document_replaced',
  'official_document_cancelled',
]);

function idValue(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

function idList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(idValue).filter(Boolean))];
}

function textValue(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function normalizeRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'staff') return 'secretaria';
  if (normalized === 'coordinator') return 'coordenador';
  return normalized;
}

function normalizeRoles(roles = []) {
  return [...new Set(roles.map(normalizeRole).filter(Boolean))];
}

function roleVariantsForQuery(roles = []) {
  const variants = new Set();
  const aliases = {
    admin: ['Admin', 'Administrador', 'administrador'],
    coordenador: ['Coordenador', 'Coordinator', 'coordinator'],
    gestor: ['Gestor'],
    secretaria: ['Secretaria', 'Staff', 'staff'],
    professor: ['Professor', 'Teacher', 'teacher'],
  };

  for (const role of roles) {
    const raw = String(role || '').trim();
    if (!raw) continue;

    const normalized = normalizeRole(raw);
    variants.add(raw);
    variants.add(normalized);
    for (const alias of aliases[normalized] || []) {
      variants.add(alias);
    }
  }

  return [...variants].filter(Boolean);
}

function documentTypeLabel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const labels = {
    enrollment_confirmation: 'Declaração de Matrícula',
    enrollment_declaration: 'Declaração de Matrícula',
    declaration_of_enrollment: 'Declaração de Matrícula',
    enrollment_status: 'Declaração de Matrícula',
    currently_enrolled_declaration: 'Declaração Cursando',
    enrollment_status_declaration: 'Declaração Cursando',
    attendance_declaration: 'Declaração de Frequência Escolar',
    school_attendance_declaration: 'Declaração de Frequência Escolar',
    student_attendance_declaration: 'Declaração de Frequência Escolar',
    transfer_declaration: 'Declaração de Transferência',
    transfer_statement: 'Declaração de Transferência',
    nothing_pending: 'Declaração Nada Consta',
    nothing_owed_declaration: 'Declaração Nada Consta',
    no_debt_declaration: 'Declaração Nada Consta',
    income_tax: 'Declaração para IRPF',
    income_tax_declaration: 'Declaração para IRPF',
    irpf_declaration: 'Declaração para IRPF',
    payment_receipt: 'Recibo de Pagamento',
    school_transcript: 'Histórico Escolar',
    transcript: 'Histórico Escolar',
    completion_certificate: 'Certificado de Conclusão',
    report_card: 'Boletim',
  };
  return labels[normalized] || normalized.replace(/_/g, ' ') || 'um documento';
}

function requestSnapshot(payload = {}) {
  return payload.request && typeof payload.request === 'object' ? payload.request : {};
}

function studentNameFrom(payload = {}) {
  const request = requestSnapshot(payload);
  return textValue(
    payload.studentName,
    request.studentName,
    request.studentId?.fullName,
    payload.student?.fullName
  );
}

function classNameFrom(payload = {}) {
  const request = requestSnapshot(payload);
  return textValue(payload.className, request.className, request.classId?.name);
}

function guardianNameFrom(payload = {}) {
  const request = requestSnapshot(payload);
  return textValue(
    payload.guardianName,
    request.guardianName,
    request.guardianId?.fullName,
    request.createdBy?.name
  );
}

function guardianTargetsFrom(payload = {}) {
  const request = requestSnapshot(payload);
  const ids = [
    ...idList(payload.targetGuardianIds),
    ...idList(payload.guardianIds),
    ...idList(request.targetGuardianIds),
  ];

  if (request.requesterType === 'guardian') {
    const requesterId = idValue(request.requesterId || payload.requesterId);
    if (requesterId) ids.push(requesterId);
  }

  const guardianId = idValue(payload.guardianId || request.guardianId);
  if (guardianId) ids.push(guardianId);

  return [...new Set(ids.filter(Boolean))];
}

function staffTargetsFrom(payload = {}) {
  const targetRoles = idList(payload.targetRoles || []).length
    ? payload.targetRoles
    : STAFF_TARGET_ROLES;
  return normalizeRoles(targetRoles);
}

function buildAbsenceStaffNotification(eventName, payload) {
  if (eventName !== 'absence_justification_request_created') return null;

  const studentName = studentNameFrom(payload) || 'Aluno';
  const className = classNameFrom(payload);
  const guardianName = guardianNameFrom(payload);
  const details = [studentName, className, guardianName && `Responsável: ${guardianName}`]
    .filter(Boolean)
    .join(' • ');

  return {
    audience: 'staff',
    targetRoles: staffTargetsFrom(payload),
    type: eventName,
    domain: 'academic',
    priority: 'warning',
    title: 'Nova solicitação de abono',
    summary: details || 'Um responsável enviou uma solicitação de abono.',
    routeKey: 'staff.absenceJustificationRequests',
    entity: 'absence_justification_request',
    entityId: textValue(payload.requestId, requestSnapshot(payload)._id, requestSnapshot(payload).id),
    threadKey: `attendance:${textValue(payload.requestId, requestSnapshot(payload)._id, requestSnapshot(payload).id)}`,
    metadata: {
      requestId: textValue(payload.requestId, requestSnapshot(payload)._id, requestSnapshot(payload).id),
      studentId: idValue(payload.studentId || requestSnapshot(payload).studentId),
      classId: idValue(payload.classId || requestSnapshot(payload).classId),
      status: textValue(payload.status, payload.toStatus),
      sourceEvent: eventName,
    },
  };
}

function buildAbsenceGuardianNotification(eventName, payload) {
  if (!ABSENCE_GUARDIAN_STATUS_EVENTS.has(eventName)) return null;

  const targetGuardianIds = guardianTargetsFrom(payload);
  if (!targetGuardianIds.length) return null;

  const studentName = studentNameFrom(payload) || 'o aluno';
  const descriptors = {
    absence_justification_request_approved: ['Abono aprovado', `A escola aprovou a solicitação de abono de ${studentName}.`, 'success'],
    absence_justification_request_partially_approved: ['Abono aprovado parcialmente', `A escola aprovou parte do período solicitado para ${studentName}.`, 'warning'],
    absence_justification_request_rejected: ['Abono recusado', `A escola respondeu a solicitação de abono de ${studentName}.`, 'warning'],
    absence_justification_request_needs_information: ['Complemento solicitado', `A escola pediu mais informações sobre o abono de ${studentName}.`, 'warning'],
    absence_justification_request_cancelled: ['Solicitação cancelada', `A solicitação de abono de ${studentName} foi encerrada.`, 'warning'],
    absence_justification_request_applied: ['Abono aplicado', `Uma falta real de ${studentName} foi coberta pela solicitação aprovada.`, 'success'],
  };
  const [title, summary, priority] = descriptors[eventName] || descriptors.absence_justification_request_rejected;
  const requestId = textValue(payload.requestId, requestSnapshot(payload)._id, requestSnapshot(payload).id);

  return {
    audience: 'guardian',
    targetGuardianIds,
    type: eventName,
    domain: 'academic',
    priority,
    title,
    summary,
    routeKey: 'guardian.attendance',
    entity: 'absence_justification_request',
    entityId: requestId,
    threadKey: `attendance:${requestId}`,
    metadata: {
      requestId,
      studentId: idValue(payload.studentId || requestSnapshot(payload).studentId),
      status: textValue(payload.status, payload.toStatus),
      sourceEvent: eventName,
    },
  };
}

function buildDocumentStaffNotification(eventName, payload) {
  if (eventName !== 'official_document_request_created') return null;
  if (payload.action === 'created_by_school') return null;

  const request = requestSnapshot(payload);
  const documentType = textValue(payload.documentType, request.documentType);
  const documentLabel = documentTypeLabel(documentType);
  const studentName = studentNameFrom(payload) || 'Aluno';
  const requesterName = guardianNameFrom(payload);
  const actor = payload.action === 'created_by_student'
    ? 'Aluno'
    : requesterName || 'Responsável';
  const requestId = textValue(payload.requestId, request._id, request.id);

  return {
    audience: 'staff',
    targetRoles: staffTargetsFrom(payload),
    type: eventName,
    domain: 'documents',
    priority: 'info',
    title: 'Nova solicitação de documento',
    summary: `${actor} solicitou ${documentLabel} para ${studentName}.`,
    routeKey: 'staff.officialDocumentRequests',
    entity: 'official_document_request',
    entityId: requestId,
    threadKey: `documents:${requestId}`,
    metadata: {
      requestId,
      documentRequestId: requestId,
      studentId: idValue(payload.studentId || request.studentId),
      documentType,
      documentLabel,
      studentName,
      requesterName,
      status: textValue(payload.status, payload.toStatus),
      sourceEvent: eventName,
    },
  };
}

function buildDocumentGuardianNotification(eventName, payload) {
  if (!OFFICIAL_DOCUMENT_GUARDIAN_STATUS_EVENTS.has(eventName)) return null;

  const targetGuardianIds = guardianTargetsFrom(payload);
  if (!targetGuardianIds.length) return null;

  const request = requestSnapshot(payload);
  const documentType = textValue(payload.documentType, request.documentType);
  const titleLabel = documentTypeLabel(documentType);
  const requestId = textValue(payload.requestId, request._id, request.id);
  const documentId = textValue(payload.documentId, payload.document?._id, payload.document?.id);

  const descriptors = {
    official_document_request_created: ['Pedido registrado', `A solicitação de ${titleLabel} foi enviada para a escola.`, 'info'],
    official_document_request_approved: ['Solicitação aprovada', `A escola aprovou o pedido de ${titleLabel}.`, 'success'],
    official_document_request_rejected: ['Solicitação recusada', `A escola respondeu o pedido de ${titleLabel}.`, 'warning'],
    official_document_request_cancelled: ['Solicitação cancelada', `O pedido de ${titleLabel} foi encerrado.`, 'warning'],
    official_document_preparing: ['Documento em preparação', `A escola está preparando o PDF de ${titleLabel}.`, 'info'],
    official_document_awaiting_signature: ['Aguardando assinatura', `O documento ${titleLabel} está na etapa de assinatura.`, 'info'],
    official_document_signed: ['Documento assinado', `O PDF de ${titleLabel} foi assinado pela escola.`, 'success'],
    official_document_published: ['Documento disponível', `O PDF oficial de ${titleLabel} já pode ser aberto ou baixado.`, 'success'],
    official_document_downloaded: ['Download registrado', `O acesso ao documento ${titleLabel} foi registrado.`, 'info'],
    official_document_replaced: ['Nova versão disponível', `A escola atualizou a versão do documento ${titleLabel}.`, 'info'],
    official_document_cancelled: ['Documento cancelado', `O protocolo de ${titleLabel} foi encerrado.`, 'warning'],
  };

  const [title, summary, priority] = descriptors[eventName] || descriptors.official_document_request_created;

  return {
    audience: 'guardian',
    targetGuardianIds,
    type: eventName,
    domain: 'documents',
    priority,
    title,
    summary,
    routeKey: 'guardian.documents',
    entity: eventName.startsWith('official_document_request_')
      ? 'official_document_request'
      : 'official_document',
    entityId: requestId || documentId,
    threadKey: `documents:${requestId || documentId || documentType}`,
    metadata: {
      requestId,
      documentId,
      studentId: idValue(payload.studentId || request.studentId),
      documentType,
      status: textValue(payload.status, payload.toStatus),
      sourceEvent: eventName,
    },
  };
}

function buildRegistrationStaffNotification(eventName, payload) {
  if (eventName !== 'registration:created') return null;

  const request = payload && typeof payload === 'object' ? payload : {};
  const requestId = textValue(payload.requestId, request._id, request.id);
  const studentData = request.studentData || {};
  const tutorData = request.tutorData || {};
  const selectedClass = request.selectedClassSnapshot || {};
  const candidateName = textValue(studentData.fullName, payload.studentName, 'Aluno');
  const className = textValue(
    selectedClass.name,
    studentData.intendedGrade,
    payload.className
  );
  const responsibleName = textValue(tutorData.fullName, payload.responsibleName);
  const summary = [
    candidateName,
    className,
    responsibleName && `Responsável: ${responsibleName}`,
  ]
    .filter(Boolean)
    .join(' • ');

  return {
    audience: 'staff',
    targetRoles: staffTargetsFrom(payload),
    type: 'registration_request_created',
    domain: 'academic',
    priority: 'info',
    title: 'Nova solicitação de matrícula',
    summary: summary || 'Uma nova solicitação foi enviada pelo formulário público.',
    routeKey: 'staff.registrationRequests',
    entity: 'registration_request',
    entityId: requestId,
    threadKey: `registration:${requestId}`,
    metadata: {
      requestId,
      enrollmentRequestId: requestId,
      registrationRequestId: requestId,
      studentName: candidateName,
      className,
      responsibleName,
      sourceEvent: eventName,
      action: 'open_registration_request_review',
    },
  };
}

function removeEmptyMetadata(metadata = {}) {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
  );
}

function buildNotifications(eventName, payload) {
  return [
    buildAbsenceStaffNotification(eventName, payload),
    buildAbsenceGuardianNotification(eventName, payload),
    buildDocumentStaffNotification(eventName, payload),
    buildDocumentGuardianNotification(eventName, payload),
    buildRegistrationStaffNotification(eventName, payload),
  ].filter(Boolean);
}

function readAtForViewer(notification, viewer) {
  const viewerId = String(viewer.viewerId || '');
  const receipt = (notification.readBy || []).find(
    (item) => item.viewerType === viewer.viewerType && String(item.viewerId) === viewerId
  );
  return receipt?.readAt || null;
}

function serialize(notification, viewer = null) {
  const raw = notification.toObject ? notification.toObject() : notification;
  return {
    id: String(raw._id),
    type: raw.type,
    domain: raw.domain,
    priority: raw.priority || 'info',
    title: raw.title,
    summary: raw.summary || '',
    routeKey: raw.routeKey || '',
    entity: raw.entity || '',
    entityId: raw.entityId || '',
    threadKey: raw.threadKey || '',
    metadata: raw.metadata || {},
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    readAt: viewer ? readAtForViewer(raw, viewer) : null,
  };
}

class AppNotificationService {
  async createFromRealtimeEvent(eventName, payload = {}) {
    const schoolId = idValue(payload.schoolId || payload.school_id);
    if (!eventName || !schoolId) return [];

    const notifications = buildNotifications(eventName, payload).map((item) => ({
      ...item,
      schoolId,
      targetRoles: item.targetRoles || [],
      targetUserIds: item.targetUserIds || [],
      targetGuardianIds: item.targetGuardianIds || [],
      targetStudentIds: item.targetStudentIds || [],
      metadata: removeEmptyMetadata(item.metadata || {}),
    }));

    if (!notifications.length) return [];
    return AppNotification.insertMany(notifications, { ordered: false });
  }

  buildViewerQuery(viewer) {
    const schoolId = idValue(viewer.schoolId || viewer.school_id);
    if (!schoolId) {
      const error = new Error('Escola não informada para consulta de notificações.');
      error.statusCode = 400;
      throw error;
    }

    if (viewer.viewerType === 'guardian') {
      const guardianId = idValue(viewer.viewerId || viewer.tutorId);
      return {
        schoolId,
        audience: 'guardian',
        targetGuardianIds: guardianId,
      };
    }

    const viewerId = idValue(viewer.viewerId || viewer.id || viewer._id);
    const roles = roleVariantsForQuery(viewer.roles || (viewer.role ? [viewer.role] : []));
    const effectiveRoles = roles.length ? roles : roleVariantsForQuery(STAFF_TARGET_ROLES);
    const orClauses = [
      { targetRoles: { $in: effectiveRoles } },
      { targetRoles: { $size: 0 }, targetUserIds: { $size: 0 } },
    ];

    if (viewerId) {
      orClauses.unshift({ targetUserIds: viewerId });
    }

    return {
      schoolId,
      audience: 'staff',
      $or: orClauses,
    };
  }

  async listForViewer(viewer, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 30, 1), 60);
    const query = this.buildViewerQuery(viewer);
    if (options.cursor) {
      query.createdAt = { $lt: new Date(options.cursor) };
    }

    const items = await AppNotification.find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const pageItems = items.slice(0, limit);
    return {
      items: pageItems.map((item) => serialize(item, viewer)),
      nextCursor: items.length > limit ? items[limit - 1]?.createdAt : null,
      unreadCount: await this.countUnreadForViewer(viewer),
    };
  }

  async countUnreadForViewer(viewer) {
    const query = this.buildViewerQuery(viewer);
    query.readBy = {
      $not: {
        $elemMatch: {
          viewerType: viewer.viewerType,
          viewerId: idValue(viewer.viewerId),
        },
      },
    };
    return AppNotification.countDocuments(query);
  }

  async markAsRead(notificationId, viewer) {
    const query = {
      ...this.buildViewerQuery(viewer),
      _id: notificationId,
    };
    const notification = await AppNotification.findOne(query);
    if (!notification) return null;

    const viewerId = idValue(viewer.viewerId);
    const existing = (notification.readBy || []).find(
      (item) => item.viewerType === viewer.viewerType && String(item.viewerId) === viewerId
    );
    if (!existing) {
      notification.readBy.push({
        viewerType: viewer.viewerType,
        viewerId,
        readAt: new Date(),
      });
      await notification.save();
    }

    return serialize(notification, viewer);
  }

  async markAllAsRead(viewer, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 60, 1), 100);
    const query = this.buildViewerQuery(viewer);
    query.readBy = {
      $not: {
        $elemMatch: {
          viewerType: viewer.viewerType,
          viewerId: idValue(viewer.viewerId),
        },
      },
    };

    const notifications = await AppNotification.find(query)
      .sort({ createdAt: -1 })
      .limit(limit);

    const now = new Date();
    await Promise.all(
      notifications.map((notification) => {
        notification.readBy.push({
          viewerType: viewer.viewerType,
          viewerId: idValue(viewer.viewerId),
          readAt: now,
        });
        return notification.save();
      })
    );

    return { updated: notifications.length };
  }
}

module.exports = new AppNotificationService();
