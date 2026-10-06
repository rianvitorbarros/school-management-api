const service = require('../services/academicMonthlyFeePlan.service');
const schoolId = (req) => req.user?.schoolId || req.user?.school_id;
const actorId = (req) => req.user?.id || req.user?._id;
const respond = (res, error) => res.status(error.statusCode || 500).json({ code: error.code || null, message: error.message, details: error.details || null });
module.exports = {
  async overview(req, res) { try { res.json(await service.overview(schoolId(req), req.query.academicYear)); } catch (error) { respond(res, error); } },
  async saveDraft(req, res) { try { res.json(await service.saveDraft(schoolId(req), actorId(req), req.body)); } catch (error) { respond(res, error); } },
  async bulkAdjust(req, res) { try { res.json(await service.bulkAdjust(schoolId(req), actorId(req), req.body)); } catch (error) { respond(res, error); } },
  async publish(req, res) { try { res.json(await service.publish(schoolId(req), actorId(req), req.body.academicYear)); } catch (error) { respond(res, error); } },
  async published(req, res) { try { res.json(await service.publishedForDestination(schoolId(req), req.query.academicYear, req.query)); } catch (error) { respond(res, error); } },
};
