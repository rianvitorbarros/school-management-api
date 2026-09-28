const reEnrollmentService = require('../services/reEnrollment.service');
const appEmitter = require('../../loaders/eventEmitter');
const appNotificationService = require('../services/appNotification.service');

function schoolId(req) { return req.user?.schoolId || req.user?.school_id || req.guardian?.schoolId || req.guardian?.school_id; }
function guardian(req) { return { schoolId: schoolId(req), accountId: req.guardian?.accountId, tutorId: req.guardian?.tutorId }; }
function sendError(res, error, fallback) { return res.status(error.statusCode || 500).json({ code: error.code || null, message: error.message || fallback }); }
function notificationPayload(request) {
  return {
    school_id: request.school_id,
    requestId: request._id,
    studentId: request.studentId,
    guardianId: request.guardianId,
    studentName: request.studentNameSnapshot || request.studentId?.fullName || '',
    responsibleName: request.guardianNameSnapshot || request.guardianId?.fullName || '',
    currentClassName: request.currentClassSnapshot?.name || '',
    targetClassName: request.targetClassSnapshot?.name || request.targetGradeName || '',
    status: request.status,
  };
}

class ReEnrollmentController {
  async guardianEligibility(req, res) {
    try { return res.json(await reEnrollmentService.getGuardianEligibility(guardian(req))); }
    catch (error) { return sendError(res, error, 'Não foi possível consultar a elegibilidade de rematrícula.'); }
  }
  async createGuardianRequest(req, res) {
    try {
      const result = await reEnrollmentService.createGuardianRequest({ ...guardian(req), studentId: req.body?.studentId });
      if (result.created) {
        const payload = notificationPayload(result.request);
        appEmitter.emit('re_enrollment:created', payload);
        appNotificationService.createFromRealtimeEvent('re_enrollment:created', payload).catch(() => {});
      }
      return res.status(result.created ? 201 : 200).json({ request: result.request, created: result.created });
    } catch (error) { return sendError(res, error, 'Não foi possível criar a solicitação de rematrícula.'); }
  }
  async listAdmin(req, res) {
    try { return res.json(await reEnrollmentService.listAdminRequests(schoolId(req), req.query || {})); }
    catch (error) { return sendError(res, error, 'Não foi possível listar as solicitações de rematrícula.'); }
  }
  async getAdmin(req, res) {
    try { return res.json(await reEnrollmentService.getAdminRequest(req.params.id, schoolId(req))); }
    catch (error) { return sendError(res, error, 'Não foi possível carregar a solicitação de rematrícula.'); }
  }
  async approve(req, res) {
    try {
      const result = await reEnrollmentService.approveRequest(req.params.id, schoolId(req), req.user?.id || req.user?._id, req.body || {});
      const payload = notificationPayload(result.request);
      appEmitter.emit('re_enrollment:approved', payload);
      appNotificationService.createFromRealtimeEvent('re_enrollment:approved', payload).catch(() => {});
      return res.json(result);
    } catch (error) { return sendError(res, error, 'Não foi possível aprovar a rematrícula.'); }
  }
  async reject(req, res) {
    try {
      const request = await reEnrollmentService.rejectRequest(req.params.id, schoolId(req), req.user?.id || req.user?._id, req.body?.reason);
      const payload = notificationPayload(request);
      appEmitter.emit('re_enrollment:rejected', payload);
      appNotificationService.createFromRealtimeEvent('re_enrollment:rejected', payload).catch(() => {});
      return res.json({ request });
    } catch (error) { return sendError(res, error, 'Não foi possível rejeitar a rematrícula.'); }
  }
  async effectivate(req, res) {
    try { return res.json(await reEnrollmentService.effectivateRequest(req.params.id, schoolId(req), req.user?.id || req.user?._id, req.body || {})); }
    catch (error) { return sendError(res, error, 'Não foi possível efetivar a matrícula de rematrícula.'); }
  }
  async listPeriods(req, res) { try { return res.json(await reEnrollmentService.listPeriods(schoolId(req))); } catch (e) { return sendError(res, e, 'Não foi possível listar períodos.'); } }
  async getPeriod(req, res) { try { return res.json(await reEnrollmentService.getPeriod(req.params.id, schoolId(req))); } catch (e) { return sendError(res, e, 'Não foi possível carregar período.'); } }
  async createPeriod(req, res) { try { return res.status(201).json(await reEnrollmentService.createPeriod(req.body, schoolId(req), req.user?.id || req.user?._id)); } catch (e) { return sendError(res, e, 'Não foi possível criar período.'); } }
  async updatePeriod(req, res) { try { return res.json(await reEnrollmentService.updatePeriod(req.params.id, req.body, schoolId(req), req.user?.id || req.user?._id)); } catch (e) { return sendError(res, e, 'Não foi possível atualizar período.'); } }
  async activatePeriod(req, res) { try { return res.json(await reEnrollmentService.activatePeriod(req.params.id, schoolId(req), req.user?.id || req.user?._id)); } catch (e) { return sendError(res, e, 'Não foi possível abrir período.'); } }
  async closePeriod(req, res) { try { return res.json(await reEnrollmentService.closePeriod(req.params.id, schoolId(req), req.user?.id || req.user?._id)); } catch (e) { return sendError(res, e, 'Não foi possível encerrar período.'); } }
  async listProgressions(req, res) { try { return res.json(await reEnrollmentService.listProgressions(schoolId(req))); } catch (e) { return sendError(res, e, 'Não foi possível listar progressões.'); } }
  async createProgression(req, res) { try { return res.status(201).json(await reEnrollmentService.createProgression(req.body, schoolId(req))); } catch (e) { return sendError(res, e, 'Não foi possível criar progressão.'); } }
  async updateProgression(req, res) { try { return res.json(await reEnrollmentService.updateProgression(req.params.id, req.body, schoolId(req))); } catch (e) { return sendError(res, e, 'Não foi possível atualizar progressão.'); } }
  async deactivateProgression(req, res) { try { return res.json(await reEnrollmentService.deactivateProgression(req.params.id, schoolId(req))); } catch (e) { return sendError(res, e, 'Não foi possível desativar progressão.'); } }
  async readiness(req, res) { try { return res.json(await reEnrollmentService.readiness(schoolId(req))); } catch (e) { return sendError(res, e, 'Não foi possível preparar o diagnóstico de rematrícula.'); } }
}
module.exports = new ReEnrollmentController();
