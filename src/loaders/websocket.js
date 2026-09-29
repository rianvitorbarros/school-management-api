const { WebSocketServer } = require('ws');
const url = require('url'); // [NOVO] Necessário para ler parâmetros da URL
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const appEmitter = require('./eventEmitter');
const School = require('../api/models/school.model');
const {
    OFFICIAL_DOCUMENT_REALTIME_EVENTS,
} = require('../api/services/officialDocumentRealtime.service');
const {
    ABSENCE_JUSTIFICATION_REQUEST_EVENTS,
} = require('../api/services/absenceJustification.service');

let wss; // InstÃ¢ncia do servidor WebSocket
const JWT_SECRET = process.env.JWT_SECRET;

function normalizeRole(decodedPayload) {
    if (!decodedPayload) return null;
    if (decodedPayload.role) return decodedPayload.role;
    if (Array.isArray(decodedPayload.roles)) return decodedPayload.roles.join(',');
    return null;
}

function verifySocketToken(token) {
    if (!token || !JWT_SECRET) return null;

    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return { invalid: true, error: error.message };
    }
}

async function getSchoolName(schoolId) {
    if (!schoolId) return null;

    try {
        const school = await School.findById(schoolId).select('name').lean();
        return school?.name || null;
    } catch (_) {
        return null;
    }
}

function initWebSocket(httpServer) {
    // Liga o servidor WebSocket ao servidor HTTP existente
    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', async (ws, req) => {
        const socketId = randomUUID();
        const connectedAt = new Date().toISOString();
        const parameters = url.parse(req.url, true);
        const authHeader = req.headers.authorization || req.headers.Authorization || '';
        const headerToken = String(authHeader).startsWith('Bearer ')
            ? String(authHeader).slice('Bearer '.length).trim()
            : null;
        const token = headerToken || parameters.query.token;
        const decodedToken = verifySocketToken(token);

        if (decodedToken?.invalid) {
            console.warn('[WebSocket] Conexao rejeitada: token invalido', {
                socketId,
                reason: decodedToken.error,
                timestamp: connectedAt,
            });
            ws.close(1008, 'invalid_token');
            return;
        }

        const tokenSchoolId = decodedToken?.school_id || decodedToken?.schoolId;
        const querySchoolId = parameters.query.schoolId || parameters.query.school_id;
        const schoolId = tokenSchoolId || querySchoolId;

        if (!schoolId) {
            console.warn('[WebSocket] Conexao rejeitada: schoolId nao informado', {
                socketId,
                userId: decodedToken?.id || decodedToken?._id || null,
                userName: decodedToken?.fullName || decodedToken?.name || null,
                role: normalizeRole(decodedToken),
                timestamp: connectedAt,
            });
            ws.close(1008, 'missing_school_id');
            return;
        }

        if (tokenSchoolId && querySchoolId && String(tokenSchoolId) !== String(querySchoolId)) {
            console.warn('[WebSocket] Conexao rejeitada: schoolId divergente do token', {
                socketId,
                userId: decodedToken?.id || decodedToken?._id || null,
                userName: decodedToken?.fullName || decodedToken?.name || null,
                role: normalizeRole(decodedToken),
                tokenSchoolId: String(tokenSchoolId),
                querySchoolId: String(querySchoolId),
                timestamp: connectedAt,
            });
            ws.close(1008, 'school_mismatch');
            return;
        }

        const schoolName = await getSchoolName(schoolId);

        ws.socketId = socketId;
        ws.schoolId = String(schoolId);
        ws.userId = decodedToken?.id || decodedToken?._id || null;
        ws.userName = decodedToken?.fullName || decodedToken?.name || null;
        ws.role = normalizeRole(decodedToken);
        ws.schoolName = schoolName;

        console.log('[WebSocket] Connect', {
            socketId,
            userId: ws.userId,
            userName: ws.userName,
            role: ws.role,
            schoolId: ws.schoolId,
            schoolName: ws.schoolName,
            authMode: decodedToken ? 'token' : 'school_query',
            timestamp: connectedAt,
        });

        ws.on('close', (code, reasonBuffer) => {
            const reason = reasonBuffer?.toString() || null;
            console.log('[WebSocket] Disconnect', {
                socketId: ws.socketId,
                userId: ws.userId,
                userName: ws.userName,
                role: ws.role,
                schoolId: ws.schoolId,
                reason: reason || `code_${code}`,
                code,
                timestamp: new Date().toISOString(),
            });
        });
    });

    // --- A MÃGICA ACONTECE AQUI ---
    registerAppListeners();

    console.log('🚀 Servidor WebSocket inicializado com isolamento por escola (Multitenancy).');
}

function registerAppListeners() {
    // --- [NOVO] Solicitações de Matrícula (Web) ---
    appEmitter.on('registration:created', (request) => {
        console.log('Evento: registration:created');
        broadcast({ type: 'NEW_REGISTRATION_REQUEST', payload: request }, request.school_id);
    });

    // --- Alunos ---
    appEmitter.on('student:created', (student) => {
        console.log('Evento: student:created');
        broadcast({ type: 'NEW_STUDENT', payload: student }, student.school_id);
    });

    appEmitter.on('student:updated', (student) => {
        console.log('Evento: student:updated');
        broadcast({ type: 'UPDATED_STUDENT', payload: student }, student.school_id);
    });

    appEmitter.on('student:deleted', (payload) => {
        // ATENÇÃO: O payload de delete DEVE conter { id: ..., school_id: ... }
        console.log('Evento: student:deleted');
        broadcast({ type: 'DELETED_STUDENT', payload: payload }, payload.school_id);
    });

    // --- Usuários ---
    appEmitter.on('user:created', (user) => {
        console.log('Evento: user:created');
        broadcast({ type: 'NEW_USER', payload: user }, user.school_id);
    });

    appEmitter.on('user:updated', (user) => {
        console.log('Evento: user:updated');
        broadcast({ type: 'UPDATED_USER', payload: user }, user.school_id);
    });

    appEmitter.on('user:deleted', (payload) => {
        console.log('Evento: user:deleted');
        broadcast({ type: 'DELETED_USER', payload: payload }, payload.school_id);
    });

    // --- [NOVO] Turmas ---
    appEmitter.on('class:created', (classDoc) => {
        console.log('Evento: class:created');
        broadcast({ type: 'NEW_CLASS', payload: classDoc }, classDoc.school_id);
    });
    appEmitter.on('class:updated', (classDoc) => {
        console.log('Evento: class:updated');
        broadcast({ type: 'UPDATED_CLASS', payload: classDoc }, classDoc.school_id);
    });
    appEmitter.on('class:deleted', (payload) => {
        console.log('Evento: class:deleted');
        broadcast({ type: 'DELETED_CLASS', payload: payload }, payload.school_id);
    });

    // --- [NOVO] Matrículas ---
    appEmitter.on('enrollment:created', (enrollmentDoc) => {
        console.log('Evento: enrollment:created');
        broadcast({ type: 'NEW_ENROLLMENT', payload: enrollmentDoc }, enrollmentDoc.school_id);
    });
    appEmitter.on('enrollment:updated', (enrollmentDoc) => {
        console.log('Evento: enrollment:updated');
        broadcast({ type: 'UPDATED_ENROLLMENT', payload: enrollmentDoc }, enrollmentDoc.school_id);
    });
    appEmitter.on('enrollment:deleted', (payload) => {
        console.log('Evento: enrollment:deleted');
        broadcast({ type: 'DELETED_ENROLLMENT', payload: payload }, payload.school_id);
    });

    // --- [NOVO] Disciplinas ---
    appEmitter.on('subject:created', (subject) => {
        console.log('Evento: subject:created');
        broadcast({ type: 'NEW_SUBJECT', payload: subject }, subject.school_id);
    });
    appEmitter.on('subject:updated', (subject) => {
        console.log('Evento: subject:updated');
        broadcast({ type: 'UPDATED_SUBJECT', payload: subject }, subject.school_id);
    });
    appEmitter.on('subject:deleted', (payload) => {
        console.log('Evento: subject:deleted');
        broadcast({ type: 'DELETED_SUBJECT', payload: payload }, payload.school_id);
    });

    // --- [NOVO] Horários ---
    appEmitter.on('horario:created', (horario) => {
        console.log('Evento: horario:created');
        broadcast({ type: 'NEW_HORARIO', payload: horario }, horario.school_id);
    });
    appEmitter.on('horario:updated', (horario) => {
        console.log('Evento: horario:updated');
        broadcast({ type: 'UPDATED_HORARIO', payload: horario }, horario.school_id);
    });
    appEmitter.on('horario:deleted', (payload) => {
        console.log('Evento: horario:deleted');
        broadcast({ type: 'DELETED_HORARIO', payload: payload }, payload.school_id);
    });

    // --- [NOVO] Eventos (Calendário) ---
    appEmitter.on('evento:created', (evento) => {
        console.log('Evento: evento:created');
        broadcast({ type: 'NEW_EVENTO', payload: evento }, evento.school_id);
    });
    appEmitter.on('evento:updated', (evento) => {
        console.log('Evento: evento:updated');
        broadcast({ type: 'UPDATED_EVENTO', payload: evento }, evento.school_id);
    });
    appEmitter.on('evento:deleted', (payload) => {
        console.log('Evento: evento:deleted');
        broadcast({ type: 'DELETED_EVENTO', payload: payload }, payload.school_id);
    });

    // --- Faturas (Invoice) ---
    appEmitter.on('invoice:created', (invoice) => {
        console.log('Evento: invoice:created');
        broadcast({ type: 'NEW_INVOICE', payload: invoice }, invoice.school_id);
    });

    appEmitter.on('invoice:paid', (invoice) => {
        console.log('Evento: invoice:paid');
        broadcast({ type: 'PAID_INVOICE', payload: invoice }, invoice.school_id);
    });

    appEmitter.on('invoice:updated', (invoice) => {
        console.log('Evento: invoice:updated');
        broadcast({ type: 'UPDATED_INVOICE', payload: invoice }, invoice.school_id);
    });
    // --- [NOVO] Chamada (Attendance) ---
    appEmitter.on('attendance_updated', (payload) => {
        console.log('Evento: attendance_updated');
        broadcast({ type: 'ATTENDANCE_UPDATED', payload: payload }, payload.school_id);
    });

    appEmitter.on('assessment:published', (assessment) => {
        console.log('📡 Evento: assessment:published');
        // O Front vai receber type: 'NEW_ASSESSMENT'
        broadcast({ type: 'NEW_ASSESSMENT', payload: assessment }, assessment.school_id);
    });

    appEmitter.on('exam:sheet-corrected', (payload) => {
        console.log('Evento: exam:sheet-corrected');
        broadcast(
            { type: 'exam:sheet-corrected', payload },
            payload.schoolId || payload.school_id
        );
    });

    appEmitter.on('report-card:exam-imported', (payload) => {
        console.log('Evento: report-card:exam-imported');
        broadcast(
            { type: 'REPORT_CARD_EXAM_IMPORTED', payload },
            payload.schoolId || payload.school_id
        );
    });

    appEmitter.on('report-card:updated', (payload) => {
        console.log('Evento: report-card:updated');
        broadcast(
            { type: 'REPORT_CARD_UPDATED', payload },
            payload.schoolId || payload.school_id
        );
    });

    // --- [NOVO] Notificações (Automação) ---
    appEmitter.on('notification:created', (log) => {
        // Quando entra na fila
        broadcast({ type: 'NEW_NOTIFICATION', payload: log }, log.school_id);
    });

    appEmitter.on('notification:updated', (log) => {
        // Quando muda status (Enviado/Falha/Processando)
        broadcast({ type: 'UPDATED_NOTIFICATION', payload: log }, log.school_id);
    });

    Object.values(OFFICIAL_DOCUMENT_REALTIME_EVENTS).forEach((eventName) => {
        appEmitter.on(eventName, (payload) => {
            console.log(`Evento: ${eventName}`);
            broadcast({ type: eventName, payload }, payload.schoolId || payload.school_id);
        });
    });

    Object.values(ABSENCE_JUSTIFICATION_REQUEST_EVENTS).forEach((eventName) => {
        appEmitter.on(eventName, (payload) => {
            console.log(`Evento: ${eventName}`);
            broadcast({ type: eventName, payload }, payload.schoolId || payload.school_id);
        });
    });

    appEmitter.on('activity:correction-updated', (payload) => {
        console.log('Evento: activity:correction-updated');
        broadcast(
            { type: 'activity:correction-updated', payload },
            payload.schoolId || payload.school_id
        );
    });

    ['re_enrollment:created', 're_enrollment:approved', 're_enrollment:rejected'].forEach((eventName) => {
        appEmitter.on(eventName, (payload) => {
            broadcast({ type: eventName, payload }, payload.schoolId || payload.school_id);
        });
    });
}

/**
 * Envia a mensagem APENAS para clientes conectados na mesma escola do evento.
 * @param {Object} data - Objeto da mensagem { type, payload }
 * @param {String|Number} targetSchoolId - O ID da escola de destino
 */
function broadcast(data, targetSchoolId) {
    if (!wss) return;
    if (!targetSchoolId) {
        console.error('⚠️ ERRO BROADCAST: Tentativa de enviar evento sem school_id:', data.type);
        return;
    }

    const message = JSON.stringify(data);
    const targetIdString = String(targetSchoolId); // Garante comparação String vs String
    let delivered = 0;

    wss.clients.forEach((client) => {
        // Verifica conexão aberta E se pertence à mesma escola
        if (client.readyState === client.OPEN && client.schoolId === targetIdString) {
            client.send(message);
            delivered += 1;
        }
    });

    if (
        String(data.type || '').startsWith('official_document_') ||
        String(data.type || '').startsWith('absence_justification_') ||
        data.type === 'exam:sheet-corrected' ||
        data.type === 'activity:correction-updated' ||
        data.type === 'REPORT_CARD_EXAM_IMPORTED' ||
        data.type === 'REPORT_CARD_UPDATED'
    ) {
        console.log('[WebSocket] Broadcast notificacao desktop', {
            type: data.type,
            schoolId: targetIdString,
            delivered,
            requestId: data.payload?.requestId || data.payload?.request?._id || null,
            examId: data.payload?.examId || null,
            teacherId: data.payload?.teacherId || null,
            sheetId: data.payload?.sheetId || null,
            importBatchId: data.payload?.importBatchId || null,
            updatedCount: data.payload?.updatedCount ?? null,
            audience: data.payload?.audience || null,
            targetRoles: data.payload?.targetRoles || null,
            timestamp: new Date().toISOString(),
        });
    }
}

module.exports = { initWebSocket, broadcast };
