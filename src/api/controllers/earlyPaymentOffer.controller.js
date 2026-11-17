const service = require('../services/earlyPaymentOffer.service');

const schoolId = (req) => req.user?.schoolId || req.user?.school_id;
const actorId = (req) => req.user?.id || req.user?._id;
const roles = (req) => [...(req.user?.roles || []), req.user?.role].filter(Boolean).map((r) => String(r).toLowerCase());
const canRead = (req) => roles(req).some((r) => ['admin', 'coordenador', 'staff'].includes(r));
const canWrite = (req) => roles(req).some((r) => ['admin', 'coordenador'].includes(r));
const guardian = (req) => ({ schoolId: req.guardian?.schoolId || req.guardian?.school_id, accountId: req.guardian?.accountId, tutorId: req.guardian?.tutorId });
const fail = (res, error, fallback) => res.status(error.statusCode || 500).json({ code: error.code || null, message: error.statusCode ? error.message : fallback });
const guard = (check, message) => (handler) => async (req, res) => {
  if (!check(req)) return res.status(403).json({ message });
  return handler(req, res);
};
const read = guard(canRead, 'Sem permissão para consultar as ofertas.');
const write = guard(canWrite, 'Somente administração e coordenação podem alterar ofertas.');

module.exports = {
  list: read(async (req, res) => { try { res.json(await service.list(schoolId(req))); } catch (e) { fail(res, e, 'Não foi possível carregar as ofertas.'); } }),
  create: write(async (req, res) => { try { res.status(201).json(await service.create(schoolId(req), actorId(req), req.body || {})); } catch (e) { fail(res, e, 'Não foi possível criar a oferta.'); } }),
  update: write(async (req, res) => { try { res.json(await service.update(schoolId(req), actorId(req), req.params.id, req.body || {})); } catch (e) { fail(res, e, 'Não foi possível atualizar a oferta.'); } }),
  setStatus: write(async (req, res) => { try { res.json(await service.setStatus(schoolId(req), actorId(req), req.params.id, req.body?.status)); } catch (e) { fail(res, e, 'Não foi possível alterar o status.'); } }),
  remove: write(async (req, res) => { try { res.json(await service.remove(schoolId(req), actorId(req), req.params.id)); } catch (e) { fail(res, e, 'Não foi possível excluir a oferta.'); } }),
  adhesions: read(async (req, res) => { try { res.json(await service.adhesions(schoolId(req), req.params.id)); } catch (e) { fail(res, e, 'Não foi possível carregar as adesões.'); } }),
  addAdhesion: write(async (req, res) => { try { const r = await service.addManualAdhesion(schoolId(req), actorId(req), req.params.id, req.body || {}); res.status(r.created ? 201 : 200).json(r); } catch (e) { fail(res, e, 'Não foi possível registrar a adesão.'); } }),
  updateAdhesion: write(async (req, res) => { try { res.json(await service.updateAdhesion(schoolId(req), actorId(req), req.params.id, req.body || {})); } catch (e) { fail(res, e, 'Não foi possível atualizar a adesão.'); } }),

  publicList: async (req, res) => { try { res.json(await service.publicOffers(req.params.schoolId, { audience: req.query.audience })); } catch (e) { fail(res, e, 'Não foi possível carregar as ofertas.'); } },
  publicSimulate: async (req, res) => { try { res.json(await service.publicSimulate(req.params.schoolId, req.params.offerId, req.query)); } catch (e) { fail(res, e, 'Não foi possível simular o desconto.'); } },
  publicAdhesion: async (req, res) => { try { const r = await service.publicAdhesion(req.params.schoolId, req.params.offerId, req.body || {}); res.status(r.created ? 201 : 200).json(r); } catch (e) { fail(res, e, 'Não foi possível registrar o interesse.'); } },

  guardianList: async (req, res) => { try { res.json(await service.guardianOffers(guardian(req))); } catch (e) { fail(res, e, 'Não foi possível carregar as ofertas.'); } },
  guardianAdhesion: async (req, res) => { try { const r = await service.guardianAdhesion(guardian(req), req.params.offerId, req.body || {}); res.status(r.created ? 201 : 200).json(r); } catch (e) { fail(res, e, 'Não foi possível registrar a adesão.'); } },
};
