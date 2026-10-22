const service = require('../services/registration-request.service');
const appEmitter = require('../../loaders/eventEmitter');
const AppNotificationService = require('../services/appNotification.service');

const ensureRegistrationRequestEditorAccess = (user = {}) => {
    const roles = [
        ...(Array.isArray(user.roles) ? user.roles : []),
        user.role,
        user.profile,
        user.userType,
    ]
        .map((role) => String(role || '').trim().toLowerCase())
        .filter(Boolean);

    if (!roles.some((role) => ['admin', 'coordenador', 'gestor', 'secretaria'].includes(role))) {
        const error = new Error('Somente perfis administrativos podem editar solicitações de matrícula.');
        error.statusCode = 403;
        throw error;
    }
};

const getStatusFromError = (error, fallback = 400) => {
    if (error && error.statusCode) return error.statusCode;
    if (error && error.name === 'ValidationError') return 400;
    return fallback;
};

// --- [NOVO] Função Auxiliar para Normalizar Parentesco ---
const normalizeRelationship = (tutors) => {
    if (!tutors || !Array.isArray(tutors)) return tutors;
    
    const mapRel = {
        'pai': 'Pai',
        'mãe': 'Mãe', 'mae': 'Mãe',
        'avó': 'Avó/Avô', 'avô': 'Avó/Avô', 'avo': 'Avó/Avô',
        'tio': 'Tio/Tia', 'tia': 'Tio/Tia',
        'conjuge': 'Cônjuge', 'cônjuge': 'Cônjuge',
        'outro': 'Outro'
    };

    return tutors.map(t => {
        if (t.relationship) {
            const lower = t.relationship.toLowerCase().trim();
            if (mapRel[lower]) {
                t.relationship = mapRel[lower];
            } else {
                // Capitaliza primeira letra se não achar no mapa
                t.relationship = t.relationship.charAt(0).toUpperCase() + t.relationship.slice(1).toLowerCase();
            }
        }
        return t;
    });
};
// ---------------------------------------------------------

exports.listPublicClasses = async (req, res) => {
    try {
        const { schoolId } = req.params;
        const classes = await service.listPublicClasses(schoolId, req.query.academicYear);
        return res.json(classes);
    } catch (error) {
        console.error('Erro listPublicClasses:', error);
        return res
            .status(getStatusFromError(error, 500))
            .json({ message: error.message || 'Erro ao buscar turmas disponiveis.' });
    }
};

exports.listPublicOffers = async (req, res) => {
    try {
        const { schoolId } = req.params;
        const { classId } = req.query;
        const offers = await service.listPublicOffers(schoolId, classId);
        return res.json(offers);
    } catch (error) {
        console.error('Erro listPublicOffers:', error);
        return res
            .status(getStatusFromError(error, 500))
            .json({ message: error.message || 'Erro ao buscar ofertas disponiveis.' });
    }
};

exports.getPublicContext = async (req, res) => {
    try {
        const { schoolId } = req.params;
        const context = await service.getPublicContext(schoolId);
        return res.json(context);
    } catch (error) {
        console.error('Erro getPublicContext:', error);
        return res
            .status(getStatusFromError(error, 500))
            .json({ message: error.message || 'Erro ao buscar dados da escola.' });
    }
};

exports.createRequest = async (req, res) => {
    try {
        const result = await service.createPublicRequest(req.body);
        appEmitter.emit('registration:created', result);
        AppNotificationService.createFromRealtimeEvent('registration:created', result).catch((error) => {
            console.warn('[AppNotification] Falha ao persistir solicitação de matrícula', {
                requestId: result?._id,
                schoolId: result?.school_id,
                error: error?.message || error,
            });
        });
        return res.status(201).json({ 
            message: 'Solicitação enviada com sucesso! Aguarde a aprovação.',
            requestId: result._id 
        });
    } catch (error) {
        console.error('Erro createRequest:', error);
        return res
            .status(getStatusFromError(error, 500))
            .json({ message: error.message || 'Erro ao processar solicitacao.' });
    }
};

exports.listAll = async (req, res) => {
    try {
        const { schoolId } = req.user;
        const requests = await service.listAllRequests(schoolId);
        return res.json(requests);
    } catch (error) {
        console.error('Erro listAll:', error);
        return res.status(500).json({ message: 'Erro ao buscar solicitações.' });
    }
};

exports.updateRequestData = async (req, res) => {
    try {
        const { requestId } = req.params;
        const { schoolId, id: userId } = req.user;
        ensureRegistrationRequestEditorAccess(req.user);

        const result = await service.updateRequestData(requestId, schoolId, userId, req.body);
        return res.json({ message: 'Dados da solicitação atualizados.', request: result });
    } catch (error) {
        console.error('Erro updateRequestData:', error);
        return res.status(getStatusFromError(error, 400)).json({ message: error.message || 'Erro ao atualizar dados.' });
    }
};

exports.approveRequest = async (req, res) => {
    try {
        const { requestId } = req.params;
        const { schoolId, id: userId } = req.user;
        let {
            finalStudentData,
            finalTutorData,
            finalSelectedClassId,
            finalSelectedEnrollmentOfferId,
            finalPermanenceClassId,
            permanenceNotes,
        } = req.body;

        // [CORREÇÃO] Sanitização preventiva no Controller
        if (finalStudentData && finalStudentData.tutors) {
            finalStudentData.tutors = normalizeRelationship(finalStudentData.tutors);
        }

        const result = await service.approveRequest(
            requestId,
            schoolId,
            userId,
            finalStudentData,
            finalTutorData,
            {
                finalSelectedClassId,
                finalSelectedEnrollmentOfferId,
                finalPermanenceClassId,
                permanenceNotes,
            }
        );
        return res.json(result);
    } catch (error) {
        console.error('Erro approveRequest:', error);
        return res
            .status(getStatusFromError(error, 400))
            .json({ message: error.message || 'Erro ao aprovar matricula.' });
    }
};

exports.rejectRequest = async (req, res) => {
    try {
        const { requestId } = req.params;
        const { reason } = req.body;
        const { schoolId, id: userId } = req.user;

        await service.rejectRequest(requestId, schoolId, userId, reason);
        return res.json({ message: 'Solicitação rejeitada.' });
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Erro ao rejeitar.' });
    }
};
