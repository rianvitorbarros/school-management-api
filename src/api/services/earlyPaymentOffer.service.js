const mongoose = require('mongoose');
const Offer = require('../models/earlyPaymentOffer.model');
const Adhesion = require('../models/earlyPaymentAdhesion.model');
const AuditLog = require('../models/auditLog.model');
const GuardianAccessLink = require('../models/guardianAccessLink.model');
const Student = require('../models/student.model');
const Tutor = require('../models/tutor.model');
const ReEnrollmentRequest = require('../models/reEnrollmentRequest.model');
const RegistrationRequest = require('../models/registration-request.model');
const feePlans = require('./academicMonthlyFeePlan.service');

const httpError = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code });
const idOf = (value) => String(value?._id || value || '');
const isId = (value) => mongoose.isValidObjectId(value);
const LIVE = ['INTERESTED', 'CONFIRMED', 'PAID'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const money = (cents) => (cents === null || cents === undefined ? null : Number((cents / 100).toFixed(2)));
const toCents = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(String(value).includes(',') ? String(value).replace(/\./g, '').replace(',', '.') : value);
  if (!Number.isFinite(amount) || amount < 0) throw httpError('Valor inválido.', 400, 'INVALID_AMOUNT');
  return Math.round(amount * 100);
};
const endOfDay = (date) => { const d = new Date(date); d.setHours(23, 59, 59, 999); return d; };

/** Discount for a given monthly fee, never above the fee itself. */
function computeDiscount(offer, originalCents) {
  if (originalCents === null || originalCents === undefined || !Number.isFinite(Number(originalCents))) {
    return { originalAmountCents: null, discountCents: null, finalAmountCents: null };
  }
  const base = Math.max(0, Math.round(Number(originalCents)));
  const raw = offer.discountType === 'FIXED'
    ? Math.round(Number(offer.discountValue) * 100)
    : Math.round(base * Number(offer.discountValue) / 100);
  const discount = Math.min(base, Math.max(0, raw));
  return { originalAmountCents: base, discountCents: discount, finalAmountCents: base - discount };
}

/** An offer is visible to families when active and inside its window. */
function isOpen(offer, now = new Date()) {
  return offer?.status === 'ACTIVE' && new Date(offer.startDate) <= now && endOfDay(offer.endDate) >= now;
}

function serializeOffer(offer, stats) {
  const o = offer.toObject ? offer.toObject() : offer;
  return {
    id: idOf(o), title: o.title, description: o.description || '', academicYear: o.academicYear,
    referenceMonth: o.referenceMonth, referenceLabel: `${MONTHS[(o.referenceMonth || 1) - 1]}/${o.academicYear}`,
    discountType: o.discountType, discountValue: o.discountValue,
    discountLabel: o.discountType === 'FIXED'
      ? `R$ ${Number(o.discountValue).toFixed(2).replace('.', ',')} de desconto`
      : `${String(Number(o.discountValue)).replace('.', ',')}% de desconto`,
    startDate: o.startDate, endDate: o.endDate, paymentDeadline: o.paymentDeadline || null,
    audience: o.audience, status: o.status, isOpen: isOpen(o), maxAdhesions: o.maxAdhesions ?? null,
    createdAt: o.createdAt, updatedAt: o.updatedAt,
    ...(stats ? { stats } : {}),
  };
}

function serializeAdhesion(a) {
  return {
    id: idOf(a), offerId: idOf(a.offerId), source: a.source, studentId: a.studentId ? idOf(a.studentId) : null,
    studentName: a.studentName, guardianName: a.guardianName || '', guardianPhone: a.guardianPhone || '', guardianEmail: a.guardianEmail || '',
    targetGrade: a.targetGrade || '', targetLevel: a.targetLevel || '',
    originalAmount: money(a.originalAmountCents), discountAmount: money(a.discountCents), finalAmount: money(a.finalAmountCents),
    status: a.status, paidAt: a.paidAt || null, notes: a.notes || '', createdAt: a.createdAt, updatedAt: a.updatedAt,
  };
}

function buildStats(adhesions) {
  const live = adhesions.filter((a) => LIVE.includes(a.status));
  const paid = live.filter((a) => a.status === 'PAID');
  const sum = (items, field) => money(items.reduce((total, a) => total + (Number(a[field]) || 0), 0));
  const byStatus = { INTERESTED: 0, CONFIRMED: 0, PAID: 0, CANCELLED: 0 };
  const bySource = { reEnrollment: 0, web: 0, manual: 0 };
  for (const a of adhesions) {
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    if (LIVE.includes(a.status)) bySource[a.source] = (bySource[a.source] || 0) + 1;
  }
  return {
    adhesions: live.length, paid: paid.length, byStatus, bySource,
    discountCommitted: sum(live, 'discountCents'), discountGranted: sum(paid, 'discountCents'),
    anticipatedRevenue: sum(paid, 'finalAmountCents'), expectedRevenue: sum(live, 'finalAmountCents'),
    withoutAmount: live.filter((a) => a.finalAmountCents === null || a.finalAmountCents === undefined).length,
  };
}

function validatePayload(payload, current = {}) {
  const data = { ...current, ...payload };
  const out = {};
  if (payload.title !== undefined) out.title = String(payload.title || '').trim();
  if (payload.description !== undefined) out.description = String(payload.description || '').trim();
  for (const key of ['academicYear', 'referenceMonth']) if (payload[key] !== undefined) out[key] = Number(payload[key]);
  if (payload.discountType !== undefined) out.discountType = payload.discountType;
  if (payload.discountValue !== undefined) out.discountValue = Number(String(payload.discountValue).replace(',', '.'));
  for (const key of ['startDate', 'endDate', 'paymentDeadline']) if (payload[key] !== undefined) out[key] = payload[key] ? new Date(payload[key]) : null;
  if (payload.audience !== undefined) out.audience = payload.audience;
  if (payload.maxAdhesions !== undefined) out.maxAdhesions = payload.maxAdhesions === null || payload.maxAdhesions === '' ? null : Number(payload.maxAdhesions);
  const merged = { ...data, ...out };
  if (!String(merged.title || '').trim()) throw httpError('Informe o título da oferta.', 400, 'INVALID_OFFER');
  if (!Number.isInteger(merged.academicYear) || merged.academicYear < 1900 || merged.academicYear > 2200) throw httpError('Ano letivo inválido.', 400, 'INVALID_OFFER');
  if (!Number.isInteger(merged.referenceMonth) || merged.referenceMonth < 1 || merged.referenceMonth > 12) throw httpError('Mês de referência inválido.', 400, 'INVALID_OFFER');
  if (!['PERCENTAGE', 'FIXED'].includes(merged.discountType)) throw httpError('Tipo de desconto inválido.', 400, 'INVALID_OFFER');
  if (!Number.isFinite(merged.discountValue) || merged.discountValue <= 0) throw httpError('Informe um desconto maior que zero.', 400, 'INVALID_OFFER');
  if (merged.discountType === 'PERCENTAGE' && merged.discountValue > 100) throw httpError('O desconto percentual não pode passar de 100%.', 400, 'INVALID_OFFER');
  if (!merged.startDate || Number.isNaN(new Date(merged.startDate).getTime()) || !merged.endDate || Number.isNaN(new Date(merged.endDate).getTime())) throw httpError('Informe o período da oferta.', 400, 'INVALID_OFFER');
  if (new Date(merged.endDate) < new Date(merged.startDate)) throw httpError('A data final não pode ser anterior à inicial.', 400, 'INVALID_OFFER');
  if (!['ALL', 'RE_ENROLLMENT', 'NEW_ENROLLMENT'].includes(merged.audience || 'ALL')) throw httpError('Público inválido.', 400, 'INVALID_OFFER');
  if (merged.maxAdhesions !== null && merged.maxAdhesions !== undefined && (!Number.isInteger(merged.maxAdhesions) || merged.maxAdhesions < 1)) throw httpError('Limite de adesões inválido.', 400, 'INVALID_OFFER');
  return out;
}

async function audit({ schoolId, actorId, entity, entityId, action, previous, current, reason }) {
  if (!actorId || !entityId) return;
  await AuditLog.create({ school: schoolId, actor: actorId, entity, entityId, action, changes: { previous, current }, reason }).catch(() => {});
}

async function publishedFeeCents(schoolId, year, { level, grade, shift }) {
  if (!level || !grade) return null;
  try {
    const price = await feePlans.publishedForDestination(schoolId, year, { level, grade, shift });
    return price && Number.isFinite(Number(price.cents)) ? Number(price.cents) : null;
  } catch (_) { return null; }
}

class EarlyPaymentOfferService {
  // ---------- Gestão ----------
  async list(schoolId) {
    const offers = await Offer.find({ school_id: schoolId }).sort({ createdAt: -1 }).lean();
    const adhesions = await Adhesion.find({ school_id: schoolId, offerId: { $in: offers.map((o) => o._id) } })
      .select('offerId status source discountCents finalAmountCents').lean();
    const byOffer = new Map();
    for (const a of adhesions) {
      const key = idOf(a.offerId);
      if (!byOffer.has(key)) byOffer.set(key, []);
      byOffer.get(key).push(a);
    }
    const items = offers.map((o) => serializeOffer(o, buildStats(byOffer.get(idOf(o)) || [])));
    return { items, summary: buildStats(adhesions) };
  }

  async _offer(schoolId, offerId) {
    if (!isId(offerId)) throw httpError('Oferta não encontrada.', 404, 'OFFER_NOT_FOUND');
    const offer = await Offer.findOne({ _id: offerId, school_id: schoolId });
    if (!offer) throw httpError('Oferta não encontrada.', 404, 'OFFER_NOT_FOUND');
    return offer;
  }

  async create(schoolId, actorId, payload = {}) {
    const now = new Date();
    const defaults = {
      academicYear: now.getFullYear() + 1, referenceMonth: 1, discountType: 'PERCENTAGE', audience: 'ALL',
    };
    const data = validatePayload({ ...defaults, ...payload }, {});
    const offer = await Offer.create({ ...defaults, ...data, school_id: schoolId, status: payload.status === 'ACTIVE' ? 'ACTIVE' : 'DRAFT', createdBy: actorId || null, updatedBy: actorId || null });
    await audit({ schoolId, actorId, entity: 'EarlyPaymentOffer', entityId: offer._id, action: 'CREATE', previous: null, current: serializeOffer(offer), reason: 'EARLY_PAYMENT_OFFER_CREATED' });
    return serializeOffer(offer, buildStats([]));
  }

  async update(schoolId, actorId, offerId, payload = {}) {
    const offer = await this._offer(schoolId, offerId);
    const previous = serializeOffer(offer);
    const data = validatePayload(payload, offer.toObject());
    const hasAdhesions = await Adhesion.exists({ offerId: offer._id, status: { $in: LIVE } });
    if (hasAdhesions && (data.discountType !== undefined && data.discountType !== offer.discountType || data.discountValue !== undefined && data.discountValue !== offer.discountValue || data.academicYear !== undefined && data.academicYear !== offer.academicYear || data.referenceMonth !== undefined && data.referenceMonth !== offer.referenceMonth)) {
      throw httpError('A oferta já tem adesões. Para mudar o desconto ou o mês, encerre-a e crie uma nova.', 409, 'OFFER_HAS_ADHESIONS');
    }
    Object.assign(offer, data, { updatedBy: actorId || null });
    await offer.save();
    await audit({ schoolId, actorId, entity: 'EarlyPaymentOffer', entityId: offer._id, action: 'UPDATE', previous, current: serializeOffer(offer), reason: 'EARLY_PAYMENT_OFFER_UPDATED' });
    return serializeOffer(offer);
  }

  async setStatus(schoolId, actorId, offerId, status) {
    if (!['DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED'].includes(status)) throw httpError('Status inválido.', 400, 'INVALID_STATUS');
    const offer = await this._offer(schoolId, offerId);
    if (offer.status === 'CLOSED' && status !== 'CLOSED') throw httpError('Uma oferta encerrada não pode ser reaberta. Crie uma nova.', 409, 'OFFER_CLOSED');
    const previous = serializeOffer(offer);
    offer.status = status;
    offer.updatedBy = actorId || null;
    await offer.save();
    await audit({ schoolId, actorId, entity: 'EarlyPaymentOffer', entityId: offer._id, action: 'UPDATE', previous, current: serializeOffer(offer), reason: `EARLY_PAYMENT_OFFER_${status}` });
    return serializeOffer(offer);
  }

  async remove(schoolId, actorId, offerId) {
    const offer = await this._offer(schoolId, offerId);
    if (await Adhesion.exists({ offerId: offer._id })) throw httpError('A oferta já tem adesões; encerre-a em vez de excluir.', 409, 'OFFER_HAS_ADHESIONS');
    await Offer.deleteOne({ _id: offer._id });
    await audit({ schoolId, actorId, entity: 'EarlyPaymentOffer', entityId: offer._id, action: 'DELETE', previous: serializeOffer(offer), current: null, reason: 'EARLY_PAYMENT_OFFER_DELETED' });
    return { deleted: true };
  }

  async adhesions(schoolId, offerId) {
    const offer = await this._offer(schoolId, offerId);
    const items = await Adhesion.find({ school_id: schoolId, offerId: offer._id }).sort({ createdAt: -1 }).lean();
    return { offer: serializeOffer(offer, buildStats(items)), items: items.map(serializeAdhesion) };
  }

  async addManualAdhesion(schoolId, actorId, offerId, payload = {}) {
    const offer = await this._offer(schoolId, offerId);
    if (offer.status === 'CLOSED') throw httpError('A oferta está encerrada.', 409, 'OFFER_CLOSED');
    let student = null;
    if (payload.studentId) {
      if (!isId(payload.studentId)) throw httpError('Aluno inválido.', 400, 'INVALID_STUDENT');
      student = await Student.findOne({ _id: payload.studentId, school_id: schoolId }).select('fullName').lean();
      if (!student) throw httpError('Aluno não encontrado.', 404, 'STUDENT_NOT_FOUND');
    }
    const studentName = String(student?.fullName || payload.studentName || '').trim();
    if (!studentName) throw httpError('Informe o aluno.', 400, 'INVALID_STUDENT');
    const amounts = computeDiscount(offer, toCents(payload.originalAmount));
    return this._create(offer, {
      source: 'manual', studentId: student?._id || null, studentName,
      guardianName: payload.guardianName, guardianPhone: payload.guardianPhone, guardianEmail: payload.guardianEmail,
      targetGrade: payload.targetGrade, targetLevel: payload.targetLevel, notes: payload.notes,
      status: ['CONFIRMED', 'PAID'].includes(payload.status) ? payload.status : 'CONFIRMED',
      paidAt: payload.status === 'PAID' ? new Date() : null, updatedBy: actorId || null, ...amounts,
    }, { actorId, skipWindow: true });
  }

  async updateAdhesion(schoolId, actorId, adhesionId, payload = {}) {
    if (!isId(adhesionId)) throw httpError('Adesão não encontrada.', 404, 'ADHESION_NOT_FOUND');
    const adhesion = await Adhesion.findOne({ _id: adhesionId, school_id: schoolId });
    if (!adhesion) throw httpError('Adesão não encontrada.', 404, 'ADHESION_NOT_FOUND');
    const offer = await this._offer(schoolId, adhesion.offerId);
    const previous = serializeAdhesion(adhesion);
    if (payload.status !== undefined) {
      if (!['INTERESTED', 'CONFIRMED', 'PAID', 'CANCELLED'].includes(payload.status)) throw httpError('Status inválido.', 400, 'INVALID_STATUS');
      adhesion.status = payload.status;
      adhesion.paidAt = payload.status === 'PAID' ? (adhesion.paidAt || new Date()) : null;
    }
    if (payload.originalAmount !== undefined) Object.assign(adhesion, computeDiscount(offer, toCents(payload.originalAmount)));
    if (payload.notes !== undefined) adhesion.notes = String(payload.notes || '').trim();
    adhesion.updatedBy = actorId || null;
    await adhesion.save();
    await audit({ schoolId, actorId, entity: 'EarlyPaymentAdhesion', entityId: adhesion._id, action: 'UPDATE', previous, current: serializeAdhesion(adhesion), reason: 'EARLY_PAYMENT_ADHESION_UPDATED' });
    return serializeAdhesion(adhesion);
  }

  async _create(offer, data, { skipWindow = false } = {}) {
    if (!skipWindow && !isOpen(offer)) throw httpError('Esta oferta não está mais disponível.', 409, 'OFFER_NOT_AVAILABLE');
    if (offer.maxAdhesions) {
      const count = await Adhesion.countDocuments({ offerId: offer._id, status: { $in: LIVE } });
      if (count >= offer.maxAdhesions) throw httpError('As vagas desta oferta já foram preenchidas.', 409, 'OFFER_FULL');
    }
    if (data.studentId) {
      const existing = await Adhesion.findOne({ offerId: offer._id, studentId: data.studentId, status: { $in: LIVE } });
      if (existing) return { adhesion: serializeAdhesion(existing), created: false };
    }
    try {
      const adhesion = await Adhesion.create({ ...data, school_id: offer.school_id, offerId: offer._id });
      return { adhesion: serializeAdhesion(adhesion), created: true };
    } catch (e) {
      if (e?.code === 11000) {
        const existing = await Adhesion.findOne({ offerId: offer._id, studentId: data.studentId, status: { $in: LIVE } });
        if (existing) return { adhesion: serializeAdhesion(existing), created: false };
      }
      throw e;
    }
  }

  // ---------- Matrícula web (público) ----------
  async publicOffers(schoolId, { audience } = {}) {
    if (!isId(schoolId)) return { items: [] };
    const now = new Date();
    const audiences = audience === 'RE_ENROLLMENT' ? ['ALL', 'RE_ENROLLMENT'] : audience === 'NEW_ENROLLMENT' ? ['ALL', 'NEW_ENROLLMENT'] : ['ALL', 'RE_ENROLLMENT', 'NEW_ENROLLMENT'];
    const offers = await Offer.find({ school_id: schoolId, status: 'ACTIVE', audience: { $in: audiences }, startDate: { $lte: now } }).sort({ endDate: 1 }).lean();
    const open = offers.filter((o) => isOpen(o, now));
    const full = new Set();
    for (const o of open.filter((item) => item.maxAdhesions)) {
      if (await Adhesion.countDocuments({ offerId: o._id, status: { $in: LIVE } }) >= o.maxAdhesions) full.add(idOf(o));
    }
    return { items: open.filter((o) => !full.has(idOf(o))).map((o) => serializeOffer(o)) };
  }

  async publicSimulate(schoolId, offerId, { level, grade, shift } = {}) {
    const offer = await this._offer(schoolId, offerId);
    const amounts = computeDiscount(offer, await publishedFeeCents(schoolId, offer.academicYear, { level, grade, shift }));
    return { offer: serializeOffer(offer), originalAmount: money(amounts.originalAmountCents), discountAmount: money(amounts.discountCents), finalAmount: money(amounts.finalAmountCents) };
  }

  async publicAdhesion(schoolId, offerId, payload = {}) {
    const offer = await this._offer(schoolId, offerId);
    if (offer.audience === 'RE_ENROLLMENT') throw httpError('Oferta exclusiva para rematrícula.', 409, 'OFFER_AUDIENCE');
    let registration = null;
    if (payload.registrationRequestId) {
      if (!isId(payload.registrationRequestId)) throw httpError('Solicitação inválida.', 400, 'INVALID_REQUEST');
      registration = await RegistrationRequest.findOne({ _id: payload.registrationRequestId, school_id: schoolId })
        .select('studentData.fullName studentData.intendedGrade tutorData.fullName tutorData.phoneNumber tutorData.email selectedClassSnapshot').lean();
      if (!registration) throw httpError('Solicitação de matrícula não encontrada.', 404, 'REQUEST_NOT_FOUND');
      const duplicate = await Adhesion.findOne({ offerId: offer._id, registrationRequestId: registration._id, status: { $in: LIVE } });
      if (duplicate) return { adhesion: serializeAdhesion(duplicate), created: false };
    }
    const studentName = String(registration?.studentData?.fullName || payload.studentName || '').trim();
    const guardianName = String(registration?.tutorData?.fullName || payload.guardianName || '').trim();
    const guardianPhone = String(registration?.tutorData?.phoneNumber || payload.guardianPhone || '').trim();
    if (!studentName) throw httpError('Informe o nome do aluno.', 400, 'INVALID_STUDENT');
    if (!guardianName || !guardianPhone) throw httpError('Informe o nome e o telefone do responsável.', 400, 'INVALID_GUARDIAN');
    const level = registration?.selectedClassSnapshot?.educationLevel || payload.targetLevel || '';
    const grade = registration?.selectedClassSnapshot?.grade || registration?.studentData?.intendedGrade || payload.targetGrade || '';
    const shift = registration?.selectedClassSnapshot?.shift || payload.targetShift || '';
    const amounts = computeDiscount(offer, await publishedFeeCents(schoolId, offer.academicYear, { level, grade, shift }));
    return this._create(offer, {
      source: 'web', studentName, guardianName, guardianPhone,
      guardianEmail: String(registration?.tutorData?.email || payload.guardianEmail || '').trim(),
      targetGrade: grade, targetLevel: level, registrationRequestId: registration?._id || null, status: 'INTERESTED', ...amounts,
    });
  }

  // ---------- Portal do responsável (rematrícula) ----------
  async _guardianStudents(schoolId, accountId) {
    const links = await GuardianAccessLink.find({ school_id: schoolId, guardianAccessAccountId: accountId, status: 'active' }).select('studentId').lean();
    return new Set(links.map((l) => idOf(l.studentId)));
  }

  async guardianOffers({ schoolId, accountId }) {
    const { items } = await this.publicOffers(schoolId, { audience: 'RE_ENROLLMENT' });
    if (!items.length) return { items: [] };
    const studentIds = [...await this._guardianStudents(schoolId, accountId)];
    const [students, requests, adhesions] = await Promise.all([
      Student.find({ _id: { $in: studentIds }, school_id: schoolId }).select('fullName').lean(),
      ReEnrollmentRequest.find({ school_id: schoolId, studentId: { $in: studentIds }, status: { $in: ['PENDING', 'APPROVED'] } })
        .select('studentId academicYearTo monthlyFeeSnapshotCents targetGradeName targetLevelName targetShiftName').lean(),
      Adhesion.find({ school_id: schoolId, offerId: { $in: items.map((o) => o.id) }, studentId: { $in: studentIds }, status: { $in: LIVE } }).lean(),
    ]);
    const offers = await Offer.find({ _id: { $in: items.map((o) => o.id) } }).lean();
    const offerById = new Map(offers.map((o) => [idOf(o), o]));
    return {
      items: items.map((o) => ({
        ...o,
        students: students.map((s) => {
          const request = requests.find((r) => idOf(r.studentId) === idOf(s) && Number(r.academicYearTo) === Number(o.academicYear));
          const amounts = computeDiscount(offerById.get(o.id), request?.monthlyFeeSnapshotCents ?? null);
          const adhesion = adhesions.find((a) => idOf(a.offerId) === o.id && idOf(a.studentId) === idOf(s));
          return { studentId: idOf(s), fullName: s.fullName, hasReEnrollmentRequest: Boolean(request),
            originalAmount: money(amounts.originalAmountCents), discountAmount: money(amounts.discountCents), finalAmount: money(amounts.finalAmountCents),
            adhesion: adhesion ? serializeAdhesion(adhesion) : null };
        }),
      })),
    };
  }

  async guardianAdhesion({ schoolId, accountId, tutorId }, offerId, { studentId } = {}) {
    const offer = await this._offer(schoolId, offerId);
    if (offer.audience === 'NEW_ENROLLMENT') throw httpError('Oferta exclusiva para novas matrículas.', 409, 'OFFER_AUDIENCE');
    if (!isId(studentId) || !(await this._guardianStudents(schoolId, accountId)).has(String(studentId))) throw httpError('Aluno não vinculado ao responsável.', 403, 'STUDENT_NOT_LINKED');
    const [student, request] = await Promise.all([
      Student.findOne({ _id: studentId, school_id: schoolId }).select('fullName').lean(),
      ReEnrollmentRequest.findOne({ school_id: schoolId, studentId, academicYearTo: offer.academicYear, status: { $in: ['PENDING', 'APPROVED'] } })
        .select('monthlyFeeSnapshotCents targetGradeName targetLevelName guardianNameSnapshot').lean(),
    ]);
    if (!student) throw httpError('Aluno não encontrado.', 404, 'STUDENT_NOT_FOUND');
    const tutor = tutorId && isId(tutorId) ? await Tutor.findById(tutorId).select('fullName phoneNumber email').lean().catch(() => null) : null;
    const amounts = computeDiscount(offer, request?.monthlyFeeSnapshotCents ?? null);
    return this._create(offer, {
      source: 'reEnrollment', studentId: student._id, studentName: student.fullName,
      guardianName: tutor?.fullName || request?.guardianNameSnapshot || '', guardianPhone: tutor?.phoneNumber || '', guardianEmail: tutor?.email || '',
      guardianTutorId: tutorId && isId(tutorId) ? tutorId : null,
      targetGrade: request?.targetGradeName || '', targetLevel: request?.targetLevelName || '',
      reEnrollmentRequestId: request?._id || null, status: 'INTERESTED', ...amounts,
    });
  }
}

module.exports = new EarlyPaymentOfferService();
module.exports.computeDiscount = computeDiscount;
module.exports.isOpen = isOpen;
module.exports.buildStats = buildStats;
