const mongoose = require('mongoose');
const AcademicProgression = require('../models/academicProgression.model');
const ReEnrollmentPeriod = require('../models/reEnrollmentPeriod.model');
const ReEnrollmentRequest = require('../models/reEnrollmentRequest.model');
const GuardianAccessLink = require('../models/guardianAccessLink.model');
const Tutor = require('../models/tutor.model');
const Student = require('../models/student.model');
const Enrollment = require('../models/enrollment.model');
const Class = require('../models/class.model');
const Invoice = require('../models/invoice.model');
const academicMonthlyFeePlanService = require('./academicMonthlyFeePlan.service');

function httpError(message, statusCode = 400, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function idOf(value) { return value?._id ? String(value._id) : value ? String(value) : null; }
function classSnapshot(classDoc) {
  if (!classDoc) return null;
  return { id: idOf(classDoc), name: classDoc.name || '', level: classDoc.level || '', grade: classDoc.grade || '', shift: classDoc.shift || '' };
}
function todayStart() { const now = new Date(); now.setHours(0, 0, 0, 0); return now; }

class ReEnrollmentService {
  async listProgressions(schoolId) { return AcademicProgression.find({ school_id: schoolId }).sort({ level: 1, fromGrade: 1 }).lean(); }
  async createProgression(data, schoolId) {
    try { return await new AcademicProgression({ ...data, school_id: schoolId }).save(); }
    catch (error) { if (error?.code === 11000) throw httpError('Já existe uma progressão para esta série de origem.', 409, 'PROGRESSION_CONFLICT'); throw error; }
  }
  async updateProgression(id, data, schoolId) {
    const item = await AcademicProgression.findOne({ _id: id, school_id: schoolId });
    if (!item) throw httpError('Progressão acadêmica não encontrada.', 404, 'PROGRESSION_NOT_FOUND');
    Object.assign(item, data);
    try { return await item.save(); }
    catch (error) { if (error?.code === 11000) throw httpError('Já existe uma progressão para esta série de origem.', 409, 'PROGRESSION_CONFLICT'); throw error; }
  }
  async deactivateProgression(id, schoolId) {
    return this.updateProgression(id, { active: false }, schoolId);
  }
  async listPeriods(schoolId) { return ReEnrollmentPeriod.find({ school_id: schoolId }).sort({ academicYearTo: -1 }).lean(); }
  async getPeriod(id, schoolId) {
    const item = await ReEnrollmentPeriod.findOne({ _id: id, school_id: schoolId }).lean();
    if (!item) throw httpError('Período de rematrícula não encontrado.', 404, 'PERIOD_NOT_FOUND');
    return item;
  }
  async _assertNoOpenPeriodConflict({ schoolId, academicYearTo, excludingId = null }) {
    const query = { school_id: schoolId, academicYearTo: Number(academicYearTo), status: 'OPEN' };
    if (excludingId) query._id = { $ne: excludingId };
    if (await ReEnrollmentPeriod.exists(query)) throw httpError('Já existe um período aberto para este ano letivo de destino.', 409, 'PERIOD_CONFLICT');
  }
  async createPeriod(data, schoolId, userId) {
    if (data.status === 'OPEN') await this._assertNoOpenPeriodConflict({ schoolId, academicYearTo: data.academicYearTo });
    try { return await new ReEnrollmentPeriod({ ...data, school_id: schoolId, createdBy: userId || null, updatedBy: userId || null }).save(); }
    catch (error) { if (error?.code === 11000) throw httpError('Já existe um período conflitante para este ano letivo.', 409, 'PERIOD_CONFLICT'); throw error; }
  }
  async updatePeriod(id, data, schoolId, userId) {
    const item = await ReEnrollmentPeriod.findOne({ _id: id, school_id: schoolId });
    if (!item) throw httpError('Período de rematrícula não encontrado.', 404, 'PERIOD_NOT_FOUND');
    const targetYear = data.academicYearTo ?? item.academicYearTo;
    const targetStatus = data.status ?? item.status;
    if (targetStatus === 'OPEN') await this._assertNoOpenPeriodConflict({ schoolId, academicYearTo: targetYear, excludingId: item._id });
    Object.assign(item, data, { updatedBy: userId || item.updatedBy || null });
    try { return await item.save(); }
    catch (error) { if (error?.code === 11000) throw httpError('Já existe um período conflitante para este ano letivo.', 409, 'PERIOD_CONFLICT'); throw error; }
  }
  async activatePeriod(id, schoolId, userId) { return this.updatePeriod(id, { status: 'OPEN' }, schoolId, userId); }
  async closePeriod(id, schoolId, userId) { return this.updatePeriod(id, { status: 'CLOSED' }, schoolId, userId); }

  async readiness(schoolId) {
    const period = await ReEnrollmentPeriod.findOne({ school_id: schoolId, status: { $in: ['DRAFT', 'OPEN'] } }).sort({ academicYearTo: -1 }).lean();
    if (!period) return { periodConfigured: false, period: null, progression: { total: 0, missing: 0, missingRules: [] }, students: { active: 0, eligibleForProgression: 0, missingProgression: 0, missingClass: 0 }, ready: false, issues: [{ code: 'PERIOD_NOT_CONFIGURED', message: 'Configure um período de rematrícula para começar.' }] };
    const [progressions, enrollments, targetClasses] = await Promise.all([
      AcademicProgression.find({ school_id: schoolId, active: true }).lean(),
      Enrollment.find({ school_id: schoolId, academicYear: period.academicYearFrom, status: 'Ativa' }).populate('class', 'level grade').lean(),
      Class.find({ school_id: schoolId, schoolYear: period.academicYearTo, status: { $in: ['Planejada', 'Ativa'] } }).select('level grade shift').lean(),
    ]);
    const rules = new Map(progressions.map((rule) => [`${rule.level}::${rule.fromGrade}`, rule]));
    const missingRules = new Map(); let eligible = 0; let missingClass = 0;
    for (const enrollment of enrollments) {
      if (!enrollment.class) { missingClass += 1; continue; }
      const rule = rules.get(`${enrollment.class.level}::${enrollment.class.grade}`);
      if (rule) eligible += 1;
      else missingRules.set(`${enrollment.class.level}::${enrollment.class.grade}`, { level: enrollment.class.level, fromGrade: enrollment.class.grade });
    }
    const missing = missingRules.size;
    const issues = [];
    if (missing) issues.push({ code: 'MISSING_PROGRESSION', message: `${missing} série(s) com alunos ativos não possui(em) progressão configurada.`, rules: [...missingRules.values()] });
    if (missingClass) issues.push({ code: 'MISSING_CLASS', message: `${missingClass} aluno(s) ativo(s) não possui(em) turma/série identificável.` });
    const targetKeys = new Set(targetClasses.map((item) => `${item.level}::${item.grade}`));
    const progressionsWithoutTargetClass = progressions.filter((item) => item.progressionType !== 'TERMINAL' && !targetKeys.has(`${item.level}::${item.toGrade}`)).map((item) => ({ level: item.level, grade: item.toGrade }));
    if (progressionsWithoutTargetClass.length) issues.push({ code: 'NO_TARGET_CLASS', severity: 'warning', message: `${progressionsWithoutTargetClass.length} progressão(ões) ainda não possui(em) turma de destino.`, rules: progressionsWithoutTargetClass });
    const publishedPlans = await require('../models/academicMonthlyFeePlan.model').find({ school_id: schoolId, academicYear: period.academicYearTo, publishedCents: { $ne: null } }).select('level grade shift').lean();
    const publishedKeys = new Set(publishedPlans.map((item) => `${item.level}::${item.grade}::${item.shift}`));
    const missingPrices = targetClasses.filter((item) => !publishedKeys.has(`${item.level}::${item.grade}::${item.shift}`)).map((item) => ({ level: item.level, grade: item.grade, shift: item.shift }));
    const distinctMissingPrices = [...new Map(missingPrices.map((item) => [`${item.level}::${item.grade}::${item.shift}`, item])).values()];
    if (distinctMissingPrices.length) issues.push({ code: 'MISSING_PUBLISHED_MONTHLY_FEE', message: `${distinctMissingPrices.length} configuração(ões) de mensalidade de destino ainda não foi(foram) publicada(s).`, rules: distinctMissingPrices });
    return { periodConfigured: true, period, academicYearFrom: period.academicYearFrom, academicYearTo: period.academicYearTo, progression: { total: progressions.length, missing, missingRules: [...missingRules.values()] }, students: { active: enrollments.length, eligibleForProgression: eligible, missingProgression: enrollments.length - eligible - missingClass, missingClass }, targetClasses: { available: targetClasses.length, progressionsWithoutTargetClass: progressionsWithoutTargetClass.length }, ready: !issues.some((item) => item.severity !== 'warning'), issues };
  }

  async _openPeriod(schoolId, referenceDate = new Date()) {
    const period = await ReEnrollmentPeriod.findOne({ school_id: schoolId, status: 'OPEN', startDate: { $lte: referenceDate }, endDate: { $gte: referenceDate } }).sort({ academicYearTo: 1 });
    return period || null;
  }
  async _assertGuardianLink({ schoolId, accountId, studentId }) {
    const link = await GuardianAccessLink.findOne({ school_id: schoolId, guardianAccessAccountId: accountId, studentId, status: 'active' }).lean();
    if (!link) throw httpError('O responsável não possui vínculo ativo com este aluno.', 403, 'GUARDIAN_STUDENT_FORBIDDEN');
    return link;
  }
  async _financialState(schoolId, studentId) {
    const overdue = await Invoice.find({ school_id: schoolId, student: studentId, dueDate: { $lt: todayStart() }, status: { $nin: ['paid', 'canceled'] } }).select('_id').lean();
    return { blocked: overdue.length > 0, count: overdue.length };
  }
  async _buildEligibility({ schoolId, accountId, tutorId, studentId, period }) {
    await this._assertGuardianLink({ schoolId, accountId, studentId });
    const [student, guardian, enrollment] = await Promise.all([
      Student.findOne({ _id: studentId, school_id: schoolId, isActive: true }).select('fullName').lean(),
      Tutor.findOne({ _id: tutorId, school_id: schoolId }).select('fullName').lean(),
      Enrollment.findOne({ school_id: schoolId, student: studentId, academicYear: period.academicYearFrom, status: 'Ativa' }).populate('class', 'name level grade shift schoolYear status').lean(),
    ]);
    if (!student || !guardian) throw httpError('Aluno ou responsável não encontrado.', 404, 'GUARDIAN_CONTEXT_NOT_FOUND');
    if (!enrollment?.class) return { student, guardian, period, eligibility: 'NO_ACTIVE_ENROLLMENT', currentEnrollment: null, suggestedNextGrade: null, suggestedNextClass: null, request: null };
    const currentClass = enrollment.class;
    const progression = await AcademicProgression.findOne({ school_id: schoolId, level: currentClass.level, fromGrade: currentClass.grade, active: true }).lean();
    if (!progression) return { student, guardian, period, eligibility: 'NO_ACADEMIC_PROGRESSION', currentEnrollment: enrollment, currentClass, suggestedNextGrade: null, suggestedNextClass: null, request: null };
    if (progression.progressionType === 'TERMINAL') return { student, guardian, period, eligibility: 'TERMINAL_PROGRESSION', currentEnrollment: enrollment, currentClass, suggestedNextGrade: null, suggestedNextClass: null, request: null };
    const targetClass = await Class.findOne({ school_id: schoolId, schoolYear: period.academicYearTo, level: currentClass.level, grade: progression.toGrade, status: { $in: ['Planejada', 'Ativa'] }, shift: currentClass.shift }).sort({ name: 1 }).lean()
      || await Class.findOne({ school_id: schoolId, schoolYear: period.academicYearTo, level: currentClass.level, grade: progression.toGrade, status: { $in: ['Planejada', 'Ativa'] } }).sort({ shift: 1, name: 1 }).lean();
    const request = await ReEnrollmentRequest.findOne({ school_id: schoolId, studentId, academicYearTo: period.academicYearTo }).sort({ updatedAt: -1 }).lean();
    const pricing = await academicMonthlyFeePlanService.publishedForDestination(schoolId, period.academicYearTo, { level: currentClass.level, grade: progression.toGrade, shift: targetClass?.shift || currentClass.shift });
    if (request?.status === 'PENDING') return { student, guardian, period, eligibility: 'ALREADY_REQUESTED', currentEnrollment: enrollment, currentClass, suggestedNextGrade: { level: currentClass.level, grade: progression.toGrade }, suggestedNextClass: targetClass, request };
    if (request?.status === 'APPROVED' || request?.status === 'REJECTED') return { student, guardian, period, eligibility: request.status, currentEnrollment: enrollment, currentClass, suggestedNextGrade: { level: currentClass.level, grade: progression.toGrade }, suggestedNextClass: targetClass, request };
    if (!pricing) return { student, guardian, period, eligibility: 'NO_PUBLISHED_MONTHLY_FEE', currentEnrollment: enrollment, currentClass, suggestedNextGrade: { level: currentClass.level, grade: progression.toGrade }, suggestedNextClass: targetClass, request: null };
    const finance = await this._financialState(schoolId, studentId);
    return { student, guardian, period, eligibility: finance.blocked ? 'FINANCIAL_BLOCK' : 'ELIGIBLE', currentEnrollment: enrollment, currentClass, suggestedNextGrade: { level: currentClass.level, grade: progression.toGrade }, suggestedNextClass: targetClass, request: null, financial: finance, pricing };
  }
  _serializeEligibility(item) {
    return { student: { id: idOf(item.student), fullName: item.student?.fullName || '' }, currentEnrollment: item.currentEnrollment ? { id: idOf(item.currentEnrollment), academicYear: item.currentEnrollment.academicYear, status: item.currentEnrollment.status, class: classSnapshot(item.currentClass) } : null, targetAcademicYear: item.period.academicYearTo, suggestedNextGrade: item.suggestedNextGrade, suggestedNextClass: classSnapshot(item.suggestedNextClass), publishedMonthlyFee: item.pricing?.value || null, publishedMonthlyFeeCents: item.pricing?.cents ?? null, pricingVersionId: item.pricing?.versionId || null, pricingVersion: item.pricing?.version ?? null, eligibility: item.eligibility, request: item.request || null };
  }
  async getGuardianEligibility({ schoolId, accountId, tutorId }) {
    const period = await this._openPeriod(schoolId);
    if (!period) return { period: null, items: [] };
    const links = await GuardianAccessLink.find({ school_id: schoolId, guardianAccessAccountId: accountId, status: 'active' }).select('studentId').lean();
    const items = await Promise.all(links.map((link) => this._buildEligibility({ schoolId, accountId, tutorId, studentId: link.studentId, period }).then((item) => this._serializeEligibility(item))));
    return { period: { id: idOf(period), academicYearFrom: period.academicYearFrom, academicYearTo: period.academicYearTo, startDate: period.startDate, endDate: period.endDate }, items };
  }
  async createGuardianRequest({ schoolId, accountId, tutorId, studentId }) {
    if (!studentId || !mongoose.isValidObjectId(studentId)) throw httpError('Aluno inválido.', 400, 'INVALID_STUDENT');
    const period = await this._openPeriod(schoolId);
    if (!period) throw httpError('O período de rematrícula não está aberto.', 409, 'RE_ENROLLMENT_PERIOD_CLOSED');
    const eligibility = await this._buildEligibility({ schoolId, accountId, tutorId, studentId, period });
    if (eligibility.eligibility === 'ALREADY_REQUESTED') return { request: eligibility.request, created: false };
    if (eligibility.eligibility === 'FINANCIAL_BLOCK') throw httpError('Existe pendência financeira vencida que impede a solicitação de rematrícula.', 409, 'RE_ENROLLMENT_FINANCIAL_BLOCK');
    if (eligibility.eligibility !== 'ELIGIBLE') throw httpError('Este aluno não está elegível para rematrícula.', 409, eligibility.eligibility);
    const finance = eligibility.financial || { blocked: false, count: 0 };
    try {
      const request = await new ReEnrollmentRequest({ school_id: schoolId, studentId, studentNameSnapshot: eligibility.student.fullName || '', guardianId: tutorId, guardianNameSnapshot: eligibility.guardian.fullName || '', currentEnrollmentId: eligibility.currentEnrollment._id, academicYearFrom: period.academicYearFrom, academicYearTo: period.academicYearTo, currentClassId: eligibility.currentClass._id, currentClassSnapshot: classSnapshot(eligibility.currentClass), targetGradeName: eligibility.suggestedNextGrade.grade, targetLevelName: eligibility.suggestedNextGrade.level, targetClassId: eligibility.suggestedNextClass?._id || null, targetClassSnapshot: classSnapshot(eligibility.suggestedNextClass), periodId: period._id, financialStatusAtRequest: finance.blocked ? 'OVERDUE' : 'CLEAR', financialOverdueCountAtRequest: finance.count, monthlyFeeSnapshotCents: eligibility.pricing.cents, pricingAcademicYear: period.academicYearTo, pricingVersionId: eligibility.pricing.versionId }).save();
      return { request, created: true };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const existing = await ReEnrollmentRequest.findOne({ school_id: schoolId, studentId, academicYearTo: period.academicYearTo, status: 'PENDING' });
      if (existing) return { request: existing, created: false };
      throw error;
    }
  }
  async listAdminRequests(schoolId, filters = {}) {
    const query = { school_id: schoolId };
    if (filters.status) query.status = filters.status;
    if (filters.academicYearTo) query.academicYearTo = Number(filters.academicYearTo);
    if (filters.currentClassId) query.currentClassId = filters.currentClassId;
    if (filters.targetClassId) query.targetClassId = filters.targetClassId;
    if (filters.from || filters.to) { query.createdAt = {}; if (filters.from) query.createdAt.$gte = new Date(filters.from); if (filters.to) query.createdAt.$lte = new Date(filters.to); }
    if (filters.studentId) query.studentId = filters.studentId;
    if (filters.guardianId) query.guardianId = filters.guardianId;
    const docs = await ReEnrollmentRequest.find(query).populate('studentId', 'fullName').populate('guardianId', 'fullName phoneNumber email').sort({ createdAt: -1 }).lean();
    const search = String(filters.search || '').trim().toLocaleLowerCase();
    return search ? docs.filter((item) => `${item.studentId?.fullName || ''} ${item.guardianId?.fullName || item.guardianNameSnapshot || ''}`.toLocaleLowerCase().includes(search)) : docs;
  }
  async getAdminRequest(id, schoolId) {
    const item = await ReEnrollmentRequest.findOne({ _id: id, school_id: schoolId }).populate('studentId').populate('guardianId', 'fullName phoneNumber email relationship').populate('currentEnrollmentId').populate('approvalEnrollmentId').lean();
    if (!item) throw httpError('Solicitação de rematrícula não encontrada.', 404, 'RE_ENROLLMENT_NOT_FOUND');
    return item;
  }
  async _createTargetEnrollment(request, schoolId, userId, targetClassId) {
    if (request.approvalEnrollmentId) return { enrollment: await Enrollment.findOne({ _id: request.approvalEnrollmentId, school_id: schoolId }), reused: true };
    const targetClass = await Class.findOne({ _id: targetClassId, school_id: schoolId }).lean();
    if (!targetClass) throw httpError('Turma de destino não encontrada para esta escola.', 404, 'TARGET_CLASS_NOT_FOUND');
    if (targetClass.schoolYear !== request.academicYearTo) throw httpError('A turma de destino não pertence ao ano letivo da rematrícula.', 409, 'INVALID_TARGET_CLASS_YEAR');
    if (targetClass.grade !== request.targetGradeName || targetClass.level !== request.targetLevelName) throw httpError('A turma de destino não corresponde à progressão solicitada.', 409, 'INVALID_TARGET_CLASS');
    let enrollment = await Enrollment.findOne({ school_id: schoolId, student: request.studentId, academicYear: request.academicYearTo });
    if (enrollment) {
      if (String(enrollment.class) !== String(targetClass._id)) throw httpError('O aluno já possui uma matrícula em outra turma no ano letivo de destino.', 409, 'TARGET_ENROLLMENT_CONFLICT');
    } else {
      try { enrollment = await new Enrollment({ student: request.studentId, class: targetClass._id, academicYear: request.academicYearTo, school_id: schoolId, agreedFee: request.monthlyFeeSnapshotCents / 100, status: 'Ativa' }).save(); }
      catch (error) {
        if (error?.code !== 11000) throw error;
        enrollment = await Enrollment.findOne({ school_id: schoolId, student: request.studentId, academicYear: request.academicYearTo });
        if (!enrollment || String(enrollment.class) !== String(targetClass._id)) throw httpError('O aluno já possui uma matrícula conflitante no ano letivo de destino.', 409, 'TARGET_ENROLLMENT_CONFLICT');
      }
    }
    request.targetClassId = targetClass._id;
    request.targetClassSnapshot = classSnapshot(targetClass);
    request.approvalEnrollmentId = enrollment._id;
    request.enrollmentCreatedAt = new Date();
    request.enrollmentCreatedBy = userId || null;
    return { enrollment, reused: false };
  }
  async approveRequest(id, schoolId, userId, { targetClassId = null } = {}) {
    const request = await ReEnrollmentRequest.findOne({ _id: id, school_id: schoolId });
    if (!request) throw httpError('Solicitação de rematrícula não encontrada.', 404, 'RE_ENROLLMENT_NOT_FOUND');
    if (request.status !== 'PENDING') throw httpError('Somente solicitações pendentes podem ser aprovadas.', 409, 'RE_ENROLLMENT_NOT_PENDING');
    const finance = await this._financialState(schoolId, request.studentId);
    if (finance.blocked) throw httpError('A aprovação foi bloqueada: há pendência financeira vencida.', 409, 'RE_ENROLLMENT_FINANCIAL_BLOCK');
    const selectedClassId = targetClassId || request.targetClassId;
    const result = selectedClassId ? await this._createTargetEnrollment(request, schoolId, userId, selectedClassId) : { enrollment: null };
    request.status = 'APPROVED'; request.reviewedBy = userId; request.reviewedAt = new Date();
    await request.save();
    return { request, enrollment: result.enrollment };
  }
  async effectivateRequest(id, schoolId, userId, { targetClassId } = {}) {
    if (!targetClassId) throw httpError('Selecione a turma de destino para efetivar a matrícula.', 400, 'TARGET_CLASS_REQUIRED');
    const request = await ReEnrollmentRequest.findOne({ _id: id, school_id: schoolId });
    if (!request) throw httpError('Solicitação de rematrícula não encontrada.', 404, 'RE_ENROLLMENT_NOT_FOUND');
    if (request.status !== 'APPROVED') throw httpError('Somente solicitações aprovadas podem ser efetivadas.', 409, 'RE_ENROLLMENT_NOT_APPROVED');
    const result = await this._createTargetEnrollment(request, schoolId, userId, targetClassId);
    await request.save();
    return { request, enrollment: result.enrollment, reused: result.reused };
  }
  async rejectRequest(id, schoolId, userId, reason) {
    const request = await ReEnrollmentRequest.findOne({ _id: id, school_id: schoolId });
    if (!request) throw httpError('Solicitação de rematrícula não encontrada.', 404, 'RE_ENROLLMENT_NOT_FOUND');
    if (request.status !== 'PENDING') throw httpError('Somente solicitações pendentes podem ser rejeitadas.', 409, 'RE_ENROLLMENT_NOT_PENDING');
    request.status = 'REJECTED'; request.reviewedBy = userId; request.reviewedAt = new Date(); request.rejectionReason = String(reason || '').trim();
    return request.save();
  }
}
module.exports = new ReEnrollmentService();
