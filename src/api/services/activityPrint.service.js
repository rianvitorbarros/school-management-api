const crypto = require('crypto');
const mongoose = require('mongoose');

const ActivityBook = require('../models/activityBook.model');
const ActivityPage = require('../models/activityPage.model');
const ActivityPrintRun = require('../models/activityPrintRun.model');
const ClassModel = require('../models/class.model');
const Enrollment = require('../models/enrollment.model');
const Periodo = require('../models/periodo.model');
const School = require('../models/school.model');
const SchoolYear = require('../models/schoolyear.model');
const Student = require('../models/student.model');
const User = require('../models/user.model');
const activityPdfService = require('./activityPdf.service');
const r2StorageService = require('./r2Storage.service');
const {
  ensureClassAccess,
  isPrivilegedActor,
} = require('./classAccess.service');
const { parseBusinessDateInput } = require('../utils/timeContext');

const MAX_BATCH_SIZE = 50;

function createHttpError(message, status = 400, code = 'ACTIVITY_PRINT_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function extractId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  return String(value);
}

function sameId(left, right) {
  return String(left) === String(right);
}

function ensureObjectId(id, code, message) {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    throw createHttpError(message, 400, code);
  }
}

class ActivityPrintService {
  constructor({
    ActivityBookModel = ActivityBook,
    ActivityPageModel = ActivityPage,
    ActivityPrintRunModel = ActivityPrintRun,
    ClassModelRef = ClassModel,
    EnrollmentModel = Enrollment,
    PeriodoModel = Periodo,
    SchoolModel = School,
    SchoolYearModel = SchoolYear,
    StudentModel = Student,
    UserModel = User,
    activityPdfServiceRef = activityPdfService,
    r2StorageServiceRef = r2StorageService,
    ensureClassAccessFn = ensureClassAccess,
    parseBusinessDateInputFn = parseBusinessDateInput,
  } = {}) {
    this.ActivityBookModel = ActivityBookModel;
    this.ActivityPageModel = ActivityPageModel;
    this.ActivityPrintRunModel = ActivityPrintRunModel;
    this.ClassModel = ClassModelRef;
    this.EnrollmentModel = EnrollmentModel;
    this.PeriodoModel = PeriodoModel;
    this.SchoolModel = SchoolModel;
    this.SchoolYearModel = SchoolYearModel;
    this.StudentModel = StudentModel;
    this.UserModel = UserModel;
    this.activityPdfService = activityPdfServiceRef;
    this.r2StorageService = r2StorageServiceRef;
    this.ensureClassAccess = ensureClassAccessFn;
    this.parseBusinessDateInput = parseBusinessDateInputFn;
  }

  async createPrintRun({ activityPageId, payload = {}, actor = {} }) {
    const context = this.buildSchoolContext(actor);
    return this.createPrintRunFromContext({ activityPageId, payload, context });
  }

  // Reuses the production PDF composer without persisting an ActivityPrintRun.
  // The QR payload intentionally has no valid correction prefix.
  async createPreviewPdf({ activityPageId, payload = {}, actor = {} }) {
    const context = this.buildSchoolContext(actor);
    const schoolId = context.schoolId;
    ensureObjectId(schoolId, 'INVALID_SCHOOL', 'Escola invalida.');
    ensureObjectId(activityPageId, 'ACTIVITY_PAGE_NOT_FOUND', 'ActivityPage nao encontrada.');

    const activityPage = await this.ActivityPageModel.findById(activityPageId).lean();
    const activityBook = activityPage
      ? await this.ActivityBookModel.findById(activityPage.bookId).lean()
      : null;
    if (!activityPage || !activityBook || activityBook.status !== 'published' || activityPage.status !== 'published') {
      throw createHttpError('Atividade nao publicada.', 409, 'ACTIVITY_NOT_PUBLISHED');
    }
    if (!activityPage.enabled || activityPage.printable === false || (activityPage.pageType || 'activity') !== 'activity') {
      throw createHttpError('Atividade nao esta disponivel para impressao.', 409, 'ACTIVITY_PAGE_NOT_PRINTABLE');
    }
    if (!this.isBookVisibleToSchool(activityBook, schoolId)) {
      throw createHttpError('Atividade nao disponivel para esta escola.', 403, 'ACTIVITY_NOT_AVAILABLE_FOR_SCHOOL');
    }

    const classId = normalizeText(payload.classId);
    ensureObjectId(classId, 'INVALID_CLASS', 'Turma invalida.');
    const classDoc = await this.resolveClassForContext({ context, schoolId, classId });
    const { teacherDoc } = await this.resolveTeacher({ context, schoolId, teacherId: payload.teacherId });
    const school = await this.SchoolModel.findById(schoolId)
      .select('name legalName logo.contentType +logo.data logoUrl')
      .lean();
    if (!school) throw createHttpError('Escola nao encontrada.', 404, 'INVALID_SCHOOL');
    const printDate = this.parseBusinessDateInput(payload.printDate, 'America/Sao_Paulo');
    if (!printDate) throw createHttpError('printDate invalida.', 400, 'INVALID_PRINT_DATE');

    const isImageSource = String(activityPage.sourceKind || 'pdf-page') === 'image';
    const sourceImageBuffer = isImageSource
      ? await this.r2StorageService.downloadBuffer(activityPage.sourceImageKey)
      : null;
    const originalPdfBuffer = isImageSource
      ? null
      : await this.r2StorageService.downloadBuffer(activityBook.originalPdfKey);
    return this.activityPdfService.generateActivityPrintPdf({
      originalPdfBuffer,
      sourceImageBuffer,
      sourceImageContentType: activityPage.sourceImageContentType,
      activityBook,
      activityPage,
      school,
      classDoc,
      teacher: teacherDoc,
      students: [{ fullName: '____________________________' }],
      printRun: { items: [{ qrCodePayload: 'academyhub-preview' }] },
      printDate,
    });
  }

  async createPlatformPrintTestRun({
    schoolId,
    activityPageId,
    payload = {},
    platformAdmin = {},
  }) {
    const context = this.buildPlatformContext({ schoolId, platformAdmin });
    return this.createPrintRunFromContext({ activityPageId, payload, context });
  }

  buildSchoolContext(actor = {}) {
    return {
      actorType: 'school',
      schoolId: actor.school_id || actor.schoolId,
      requestedByUserId: extractId(actor.id || actor._id),
      requestedByPlatformAdminId: null,
      actorRoles: Array.isArray(actor.roles)
        ? actor.roles
        : actor.role
          ? [actor.role]
          : [],
      canBypassTeacherClassAccess: false,
      actor,
    };
  }

  buildPlatformContext({ schoolId, platformAdmin = {} }) {
    return {
      actorType: 'platform',
      schoolId,
      requestedByUserId: null,
      requestedByPlatformAdminId: extractId(platformAdmin.id || platformAdmin._id),
      actorRoles: platformAdmin.role ? [platformAdmin.role] : [],
      canBypassTeacherClassAccess: true,
      actor: platformAdmin,
    };
  }

  async createPrintRunFromContext({ activityPageId, payload = {}, context = {} }) {
    const schoolId = context.schoolId;
    ensureObjectId(schoolId, 'INVALID_SCHOOL', 'Escola invalida.');
    ensureObjectId(activityPageId, 'ACTIVITY_PAGE_NOT_FOUND', 'ActivityPage nao encontrada.');

    const activityPage = await this.ActivityPageModel.findById(activityPageId).lean();
    if (!activityPage) {
      throw createHttpError('ActivityPage nao encontrada.', 404, 'ACTIVITY_PAGE_NOT_FOUND');
    }

    const activityBook = await this.ActivityBookModel.findById(activityPage.bookId).lean();
    if (!activityBook || activityBook.status === 'archived') {
      throw createHttpError('Caderno de atividades nao encontrado.', 404, 'ACTIVITY_PAGE_NOT_FOUND');
    }

    if (activityPage.enabled !== true) {
      throw createHttpError('ActivityPage desabilitada.', 409, 'ACTIVITY_PAGE_NOT_PRINTABLE');
    }

    if (activityPage.printable === false) {
      throw createHttpError('ActivityPage nao e imprimivel.', 409, 'ACTIVITY_PAGE_NOT_PRINTABLE');
    }

    const pageType = activityPage.pageType || 'activity';
    if (pageType !== 'activity') {
      throw createHttpError('Somente paginas do tipo activity podem ser impressas.', 409, 'ACTIVITY_PAGE_NOT_PRINTABLE');
    }

    if (activityBook.status !== 'published' || activityPage.status !== 'published') {
      throw createHttpError('Atividade nao publicada.', 409, 'ACTIVITY_NOT_PUBLISHED');
    }

    if (!this.isBookVisibleToSchool(activityBook, schoolId)) {
      throw createHttpError('Atividade nao disponivel para esta escola.', 403, 'ACTIVITY_NOT_AVAILABLE_FOR_SCHOOL');
    }

    const classId = normalizeText(payload.classId);
    ensureObjectId(classId, 'INVALID_CLASS', 'Turma invalida.');

    let classDoc;
    try {
      classDoc = await this.resolveClassForContext({ context, schoolId, classId });
    } catch (error) {
      throw createHttpError(error.message || 'Turma invalida.', error.status || error.statusCode || 400, 'INVALID_CLASS');
    }

    const uniqueStudentIds = this.normalizeStudentIds(payload.studentIds);
    if (uniqueStudentIds.length === 0) {
      throw createHttpError('Selecione ao menos um aluno.', 400, 'INVALID_STUDENTS');
    }

    if (uniqueStudentIds.length > MAX_BATCH_SIZE) {
      throw createHttpError(`O lote maximo suportado e ${MAX_BATCH_SIZE} alunos.`, 400, 'INVALID_STUDENTS');
    }

    const students = await this.loadStudentsForClass({
      schoolId,
      classId: classDoc._id,
      studentIds: uniqueStudentIds,
    });

    const { teacherDoc, teacherId } = await this.resolveTeacher({
      context,
      schoolId,
      teacherId: payload.teacherId,
    });

    const school = await this.SchoolModel.findById(schoolId)
      .select('name legalName logo.contentType +logo.data logoUrl')
      .lean();

    if (!school) {
      throw createHttpError('Escola nao encontrada.', 404, 'INVALID_SCHOOL');
    }

    const printDate = this.parseBusinessDateInput(payload.printDate, 'America/Sao_Paulo');
    if (!printDate) {
      throw createHttpError('printDate invalida.', 400, 'INVALID_PRINT_DATE');
    }

    const academicContext = await this.resolveAcademicContext({
      schoolId,
      classDoc,
      printDate,
      requestedTermId: payload.termId,
    });

    const printRun = await this.createPendingPrintRun({
      schoolId,
      context,
      activityBook,
      activityPage,
      classDoc,
      teacherDoc,
      printDate,
      academicContext,
      students,
      school,
    });

    try {
      const isImageSource = String(activityPage.sourceKind || 'pdf-page') === 'image';
      const sourceImageBuffer = isImageSource
        ? await this.r2StorageService.downloadBuffer(activityPage.sourceImageKey)
        : null;
      const originalPdfBuffer = isImageSource
        ? null
        : await this.r2StorageService.downloadBuffer(activityBook.originalPdfKey);
      const generatedPdfBuffer = await this.activityPdfService.generateActivityPrintPdf({
        originalPdfBuffer,
        sourceImageBuffer,
        sourceImageContentType: activityPage.sourceImageContentType,
        activityBook,
        activityPage,
        school,
        classDoc,
        teacher: teacherDoc,
        students,
        printRun,
        printDate,
      });

      const generatedPdfKey = `schools/${schoolId}/generated-activities/${printRun._id}.pdf`;

      try {
        await this.r2StorageService.uploadBuffer({
          key: generatedPdfKey,
          buffer: generatedPdfBuffer,
          contentType: 'application/pdf',
        });
      } catch (error) {
        throw createHttpError(
          `Falha ao enviar PDF final para o R2: ${error.message || 'erro desconhecido'}`,
          502,
          'R2_UPLOAD_FAILED'
        );
      }

      printRun.generatedPdfKey = generatedPdfKey;
      printRun.status = 'generated';
      printRun.errorMessage = '';
      printRun.generatedAt = new Date();
      printRun.failedAt = null;
      printRun.items = printRun.items.map((item) => ({
        ...item,
        status: 'generated',
        errorMessage: '',
      }));
      await printRun.save();

      const { url } = await this.r2StorageService.getSignedDownloadUrl(generatedPdfKey, 900);

      return {
        printRun: {
          id: String(printRun._id),
          activityPageId: String(printRun.activityPageId),
          schoolId: String(printRun.schoolId),
          classId: String(printRun.classId),
          termId: String(printRun.termId),
          academicYearId: String(printRun.academicYearId),
          studentCount: printRun.studentIds.length,
          status: printRun.status,
          generatedPdfKey: printRun.generatedPdfKey,
        },
        downloadUrl: url,
      };
    } catch (error) {
      if (printRun) {
        printRun.status = 'failed';
        printRun.errorMessage = error.message || 'Falha ao gerar PDF da atividade.';
        printRun.failedAt = new Date();
        printRun.items = printRun.items.map((item) => ({
          ...item,
          status: 'failed',
          errorMessage: error.message || 'Falha ao gerar PDF da atividade.',
        }));
        await printRun.save().catch(() => {});
      }

      if (error.code === 'R2_OBJECT_NOT_FOUND') {
        throw createHttpError('PDF original nao encontrado no R2.', 404, 'R2_DOWNLOAD_FAILED');
      }

      if (error.code === 'R2_UPLOAD_FAILED') throw error;
      if (error.code === 'INVALID_SOURCE_PDF' || error.code === 'INVALID_SOURCE_IMAGE') {
        throw createHttpError(error.message, 400, 'PDF_GENERATION_FAILED');
      }

      throw createHttpError(
        error.message || 'Falha ao gerar PDF da atividade.',
        error.status || 500,
        error.code || 'PDF_GENERATION_FAILED'
      );
    }
  }

  async resolveClassForContext({ context, schoolId, classId }) {
    if (context.actorType === 'platform') {
      const classDoc = await this.ClassModel.findOne({
        _id: classId,
        school_id: schoolId,
      }).select('_id name grade shift schoolYear school_id');

      if (!classDoc) {
        throw createHttpError(
          'Turma nao encontrada ou nao pertence a escola selecionada.',
          404,
          'INVALID_CLASS'
        );
      }

      return classDoc;
    }

    return this.ensureClassAccess(context.actor, schoolId, classId);
  }

  isBookVisibleToSchool(activityBook, schoolId) {
    if (!activityBook) return false;
    if (activityBook.visibility === 'global') return true;
    if (activityBook.visibility !== 'restricted') return false;

    return Array.isArray(activityBook.allowedSchoolIds)
      && activityBook.allowedSchoolIds.some((allowedId) => sameId(allowedId, schoolId));
  }

  normalizeStudentIds(studentIds) {
    const values = Array.isArray(studentIds)
      ? studentIds
      : typeof studentIds === 'string'
        ? [studentIds]
        : [];

    const unique = [];
    values.forEach((value) => {
      const id = normalizeText(value);
      if (!id) return;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createHttpError('Lista de alunos invalida.', 400, 'INVALID_STUDENTS');
      }
      if (!unique.includes(id)) unique.push(id);
    });

    return unique;
  }

  async loadStudentsForClass({ schoolId, classId, studentIds }) {
    const enrollments = await this.EnrollmentModel.find({
      school_id: schoolId,
      class: classId,
      student: { $in: studentIds },
      status: 'Ativa',
    })
      .populate('student', 'fullName name school_id')
      .lean();

    if (!Array.isArray(enrollments) || enrollments.length !== studentIds.length) {
      throw createHttpError('Um ou mais alunos nao pertencem a turma informada.', 400, 'INVALID_STUDENTS');
    }

    const byStudentId = new Map(
      enrollments
        .filter((item) => item?.student)
        .map((item) => [String(item.student._id), item.student])
    );

    const students = studentIds.map((studentId) => byStudentId.get(String(studentId))).filter(Boolean);
    if (students.length !== studentIds.length) {
      throw createHttpError('Um ou mais alunos nao pertencem a turma informada.', 400, 'INVALID_STUDENTS');
    }

    return students;
  }

  async resolveTeacher({ context, schoolId, teacherId }) {
    const actor = context.actor || {};
    const actorId = extractId(actor.id || actor._id);

    if (!context.canBypassTeacherClassAccess && !isPrivilegedActor(actor)) {
      if (!actorId) {
        throw createHttpError('Professor invalido.', 403, 'INVALID_TEACHER');
      }

      const teacherDoc = await this.UserModel.findOne({
        _id: actorId,
        school_id: schoolId,
        status: 'Ativo',
      }).select('_id fullName roles school_id').lean();

      if (!teacherDoc) {
        throw createHttpError('Professor invalido.', 403, 'INVALID_TEACHER');
      }

      return { teacherDoc, teacherId: String(teacherDoc._id) };
    }

    if (!teacherId) return { teacherDoc: null, teacherId: null };
    ensureObjectId(teacherId, 'INVALID_TEACHER', 'Professor invalido.');

    const teacherDoc = await this.UserModel.findOne({
      _id: teacherId,
      school_id: schoolId,
      status: 'Ativo',
    }).select('_id fullName roles school_id').lean();

    if (!teacherDoc) {
      throw createHttpError('Professor invalido.', 400, 'INVALID_TEACHER');
    }

    return { teacherDoc, teacherId: String(teacherDoc._id) };
  }

  async resolveAcademicContext({ schoolId, classDoc, printDate, requestedTermId = null }) {
    const academicYear = Number(classDoc?.schoolYear);
    if (!Number.isInteger(academicYear)) {
      throw createHttpError('Turma sem ano letivo valido.', 409, 'INVALID_CLASS_ACADEMIC_CONTEXT');
    }

    const schoolYear = await this.SchoolYearModel.findOne({
      school_id: schoolId,
      year: academicYear,
    }).lean();

    if (!schoolYear) {
      throw createHttpError(
        'Ano letivo da turma nao encontrado para a escola.',
        409,
        'ACADEMIC_YEAR_NOT_FOUND'
      );
    }

    let term;
    if (requestedTermId) {
      ensureObjectId(requestedTermId, 'INVALID_TERM_ID', 'Bimestre invalido.');
      term = await this.PeriodoModel.findOne({
        _id: requestedTermId,
        school_id: schoolId,
        anoLetivoId: schoolYear._id,
        tipo: 'Letivo',
      }).lean();

      if (!term) {
        throw createHttpError(
          'Bimestre nao pertence ao ano letivo da turma.',
          409,
          'INVALID_TERM_FOR_CLASS'
        );
      }
    } else {
      term = await this.PeriodoModel.findOne({
        school_id: schoolId,
        anoLetivoId: schoolYear._id,
        tipo: 'Letivo',
        dataInicio: { $lte: printDate },
        dataFim: { $gte: printDate },
      }).sort({ dataInicio: -1 }).lean();
    }

    if (!term) {
      throw createHttpError(
        'Nao foi encontrado bimestre letivo para a data de impressao e turma selecionadas.',
        409,
        'ACADEMIC_TERM_NOT_FOUND'
      );
    }

    return { schoolYear, term };
  }

  async createPendingPrintRun({
    schoolId,
    context,
    activityBook,
    activityPage,
    classDoc,
    teacherDoc,
    printDate,
    academicContext,
    students,
    school,
  }) {
    const items = students.map((student, index) => ({
      itemId: crypto.randomUUID(),
      studentId: student._id,
      studentName: student.fullName || student.name || '',
      qrCodePayload: `AH-ACTIVITY-1:${crypto.randomUUID()}`,
      pageNumber: index + 1,
      status: 'pending',
      errorMessage: '',
    }));

    const printRun = new this.ActivityPrintRunModel({
      activityPageId: activityPage._id,
      bookId: activityBook._id,
      schoolId,
      classId: classDoc._id,
      termId: academicContext.term._id,
      academicYearId: academicContext.schoolYear._id,
      teacherId: teacherDoc?._id || null,
      requestedByUserId: context.requestedByUserId || null,
      requestedByPlatformAdminId: context.requestedByPlatformAdminId || null,
      printDate,
      studentIds: students.map((student) => student._id),
      generatedPdfKey: '',
      status: 'pending',
      errorMessage: '',
      generatedAt: null,
      failedAt: null,
      snapshot: {
        schoolName: school?.name || school?.legalName || '',
        schoolLogoContentType: school?.logo?.contentType || '',
        className: classDoc?.name || '',
        teacherName: teacherDoc?.fullName || '',
        subject: activityPage?.subject || activityBook?.subject || '',
        bookTitle: activityBook?.title || '',
        activityTitle: activityPage?.title || '',
        pageNumber: activityPage?.pageNumber || 1,
        termName: academicContext.term?.titulo || '',
        academicYear: academicContext.schoolYear?.year || null,
      },
      items,
    });

    await printRun.save();
    return printRun;
  }
}

module.exports = new ActivityPrintService();
module.exports.ActivityPrintService = ActivityPrintService;
module.exports.MAX_BATCH_SIZE = MAX_BATCH_SIZE;
