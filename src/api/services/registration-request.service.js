const mongoose = require('mongoose');
const RegistrationRequest = require('../models/registration-request.model');
const Student = require('../models/student.model');
const Tutor = require('../models/tutor.model');
const Class = require('../models/class.model');
const Enrollment = require('../models/enrollment.model');
const School = require('../models/school.model');
const enrollmentOfferService = require('./enrollmentOffer.service');
const {
  isValidCpf,
  normalizeCpf,
} = require('../utils/guardianAccess.util');

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ''));
}

function sameId(a, b) {
  return String(a || '') === String(b || '');
}

function toPlainData(value) {
  if (!value || typeof value !== 'object') return value;
  if (typeof value.toObject === 'function') {
    return value.toObject({ depopulate: true });
  }
  return { ...value };
}

function parseTimeToMinutes(value) {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesToTime(value) {
  const normalized = ((value % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function calculateEndTime(scheduleSettings = {}) {
  const startMinutes = parseTimeToMinutes(scheduleSettings.defaultStartTime);
  const duration = Number(scheduleSettings.defaultPeriodDuration);
  const numberOfPeriods = Number(scheduleSettings.defaultNumberOfPeriods);

  if (
    startMinutes === null ||
    !Number.isFinite(duration) ||
    !Number.isFinite(numberOfPeriods) ||
    duration <= 0 ||
    numberOfPeriods <= 0
  ) {
    return null;
  }

  const breaks = Array.isArray(scheduleSettings.defaultBreaks)
    ? scheduleSettings.defaultBreaks
        .map((item) => ({
          start: parseTimeToMinutes(item.startTime),
          end: parseTimeToMinutes(item.endTime),
        }))
        .filter((item) => item.start !== null && item.end !== null && item.end > item.start)
        .sort((a, b) => a.start - b.start)
    : [];

  let currentMinutes = startMinutes;
  let periodsAdded = 0;
  let guard = 0;
  const pendingBreaks = [...breaks];

  while (periodsAdded < numberOfPeriods && guard < 200) {
    guard += 1;

    if (pendingBreaks.length > 0 && pendingBreaks[0].start === currentMinutes) {
      currentMinutes = pendingBreaks.shift().end;
      continue;
    }

    currentMinutes += duration;
    periodsAdded += 1;
  }

  if (periodsAdded !== numberOfPeriods) return null;
  return minutesToTime(currentMinutes);
}

function getPublicStartTime(classDoc) {
  const value = classDoc?.scheduleSettings?.defaultStartTime;
  return parseTimeToMinutes(value) === null ? null : value;
}

function buildPublicClassPayload(classDoc, availabilityStatus) {
  const startTime = getPublicStartTime(classDoc);

  return {
    id: String(classDoc._id),
    name: classDoc.name,
    schoolYear: classDoc.schoolYear,
    educationLevel: classDoc.level || null,
    grade: classDoc.grade || null,
    shift: classDoc.shift || null,
    startTime,
    endTime: startTime ? calculateEndTime(classDoc.scheduleSettings || {}) : null,
    monthlyFee: classDoc.monthlyFee,
    availabilityStatus,
  };
}

function buildSelectedClassSnapshot(publicClass) {
  return {
    id: publicClass.id,
    name: publicClass.name,
    schoolYear: publicClass.schoolYear,
    educationLevel: publicClass.educationLevel,
    grade: publicClass.grade,
    shift: publicClass.shift,
    startTime: publicClass.startTime,
    endTime: publicClass.endTime,
    monthlyFee: publicClass.monthlyFee,
  };
}

function normalizeEmailField(value, label) {
  if (value === undefined || value === null) return value;

  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!emailRegex.test(normalized)) {
    throw createHttpError(`${label} invalido.`, 400);
  }

  return normalized;
}

function normalizeCpfField(value, label, { required = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw createHttpError(`${label} e obrigatorio.`, 400);
    return null;
  }

  const normalized = normalizeCpf(value);
  if (!normalized || !isValidCpf(normalized)) {
    throw createHttpError(`${label} invalido.`, 400);
  }

  return normalized;
}

function normalizeAddress(address = null) {
  if (!address || typeof address !== 'object') return address;

  const baseAddress = toPlainData(address);
  const cep = baseAddress.cep || baseAddress.zipCode || '';

  return {
    ...baseAddress,
    cep: String(cep || '').trim(),
  };
}

function normalizeNameField(value) {
  if (value === undefined || value === null) return value;
  return String(value || '').trim();
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return value;
  return String(value || '').trim();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function joinParts(parts) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' | ');
}

function normalizeParentData(parentData = null, label) {
  if (!parentData || typeof parentData !== 'object') return undefined;

  const baseParent = toPlainData(parentData) || {};
  const notInRegistry = baseParent.notInRegistry === true;

  const normalized = {
    ...baseParent,
    fullName: normalizeNameField(baseParent.fullName),
    rg: normalizeOptionalString(baseParent.rg),
    birthDate: baseParent.birthDate || null,
    phoneNumber: normalizeOptionalString(baseParent.phoneNumber),
    profession: normalizeOptionalString(baseParent.profession),
    relationship: normalizeOptionalString(baseParent.relationship),
    address: normalizeAddress(baseParent.address),
    notInRegistry,
    isPrimaryResponsible: baseParent.isPrimaryResponsible === true,
    authorizedPickup: baseParent.authorizedPickup === true,
  };

  if (notInRegistry) {
    normalized.fullName = normalized.fullName || 'Nao informado';
    normalized.cpf = null;
    normalized.email = null;
    normalized.rg = null;
    normalized.phoneNumber = null;
    normalized.profession = null;
    normalized.address = undefined;
    return normalized;
  }

  normalized.cpf = normalizeCpfField(baseParent.cpf, `CPF ${label}`, {
    required: false,
  });
  normalized.email = normalizeEmailField(baseParent.email, `E-mail ${label}`);

  return normalized;
}

function normalizeParentsData(parents = null) {
  if (!parents || typeof parents !== 'object') return undefined;

  const baseParents = toPlainData(parents) || {};
  const mother = normalizeParentData(baseParents.mother, 'da mae');
  const father = normalizeParentData(baseParents.father, 'do pai');

  if (!mother && !father) return undefined;

  return {
    ...(mother ? { mother } : {}),
    ...(father ? { father } : {}),
  };
}

function normalizePrimaryResponsibleType(value) {
  if (!value) return null;
  const normalized = String(value || '').trim().toLowerCase();
  return ['mother', 'father', 'other'].includes(normalized) ? normalized : null;
}

function normalizeHealthInfo(healthInfo = null) {
  const baseHealth = healthInfo && typeof healthInfo === 'object'
    ? toPlainData(healthInfo)
    : {};

  const allergies = normalizeStringArray(baseHealth.allergies);
  const disabilities = normalizeStringArray(baseHealth.disabilities);
  const neurodevelopmentalConditions = normalizeStringArray(
    baseHealth.neurodevelopmentalConditions
  );
  const foodRestrictions = normalizeStringArray(baseHealth.foodRestrictions);

  const medicationDetails = joinParts([
    baseHealth.continuousMedicationName,
    baseHealth.continuousMedicationGuidance,
    baseHealth.medicationDetails,
  ]);
  const allergyDetails = joinParts([
    allergies.join(', '),
    baseHealth.allergyDetails,
  ]);
  const disabilityDetails = joinParts([
    disabilities.join(', '),
    baseHealth.accessibilityNeeds,
    baseHealth.disabilityDetails,
  ]);
  const visionProblemDetails = joinParts([
    baseHealth.wearsGlasses ? 'Usa oculos ou lente de contato' : '',
    baseHealth.usesGlassesDaily ? 'Uso diario' : '',
    baseHealth.needsFrontSeat ? 'Precisa sentar mais perto do quadro' : '',
    baseHealth.glassesUseDetails,
    baseHealth.visionProblemDetails,
  ]);
  const foodObservations = joinParts([
    foodRestrictions.join(', '),
    baseHealth.foodRestrictionDetails,
    baseHealth.foodObservations,
  ]);

  const hasHealthCondition =
    baseHealth.hasHealthCondition === true || baseHealth.hasHealthProblem === true;
  const usesContinuousMedication =
    baseHealth.usesContinuousMedication === true || baseHealth.takesMedication === true;
  const hasAllergies =
    baseHealth.hasAllergies === true ||
    baseHealth.hasAllergy === true ||
    allergies.length > 0;
  const hasDisability =
    baseHealth.hasDisability === true || disabilities.length > 0;
  const wearsGlasses =
    baseHealth.wearsGlasses === true || baseHealth.hasVisionProblem === true;
  const hasNeurodevelopmentalCondition =
    baseHealth.hasNeurodevelopmentalCondition === true ||
    neurodevelopmentalConditions.length > 0;
  const hasFoodRestriction =
    baseHealth.hasFoodRestriction === true || foodRestrictions.length > 0;
  const hasMedicationAllergy =
    baseHealth.hasMedicationAllergy === true ||
    allergies.some((item) => item.toLowerCase().includes('medicamento'));

  const emergencyContact = baseHealth.emergencyContact && typeof baseHealth.emergencyContact === 'object'
    ? {
        name: normalizeOptionalString(baseHealth.emergencyContact.name) || '',
        phoneNumber: normalizeOptionalString(baseHealth.emergencyContact.phoneNumber) || '',
        relationship: normalizeOptionalString(baseHealth.emergencyContact.relationship) || '',
      }
    : undefined;

  return {
    ...baseHealth,
    hasHealthCondition,
    healthConditionDetails: normalizeOptionalString(
      baseHealth.healthConditionDetails || baseHealth.healthProblemDetails
    ) || '',
    hasHealthProblem: hasHealthCondition,
    healthProblemDetails: normalizeOptionalString(
      baseHealth.healthProblemDetails || baseHealth.healthConditionDetails
    ) || '',
    usesContinuousMedication,
    continuousMedicationName: normalizeOptionalString(baseHealth.continuousMedicationName) || '',
    continuousMedicationGuidance: normalizeOptionalString(baseHealth.continuousMedicationGuidance) || '',
    takesMedication: usesContinuousMedication,
    medicationDetails: medicationDetails || '',
    hasAllergies,
    allergies,
    hasAllergy: hasAllergies,
    allergyDetails: allergyDetails || '',
    hasMedicationAllergy,
    medicationAllergyDetails: normalizeOptionalString(baseHealth.medicationAllergyDetails) || '',
    hasDisability,
    disabilities,
    accessibilityNeeds: normalizeOptionalString(baseHealth.accessibilityNeeds) || '',
    disabilityDetails: disabilityDetails || '',
    hasVisionProblem: wearsGlasses,
    wearsGlasses,
    usesGlassesDaily: baseHealth.usesGlassesDaily === true,
    needsFrontSeat: baseHealth.needsFrontSeat === true,
    glassesUseDetails: normalizeOptionalString(baseHealth.glassesUseDetails) || '',
    visionProblemDetails: visionProblemDetails || '',
    hasNeurodevelopmentalCondition,
    neurodevelopmentalConditions,
    neurodevelopmentalDetails: normalizeOptionalString(baseHealth.neurodevelopmentalDetails) || '',
    hasFoodRestriction,
    foodRestrictions,
    foodRestrictionDetails: normalizeOptionalString(baseHealth.foodRestrictionDetails) || '',
    foodObservations: foodObservations || '',
    emergencyContact,
    feverMedication: normalizeOptionalString(baseHealth.feverMedication) || '',
    generalNotes: normalizeOptionalString(baseHealth.generalNotes) || '',
  };
}

function normalizeStudentData(studentData = {}, registrationType) {
  const baseStudentData = toPlainData(studentData) || {};
  const normalizedParents = normalizeParentsData(baseStudentData.parents);
  const normalized = {
    ...baseStudentData,
    address: normalizeAddress(baseStudentData.address),
    parents: normalizedParents,
    primaryResponsibleType: normalizePrimaryResponsibleType(
      baseStudentData.primaryResponsibleType
    ),
    healthInfo: normalizeHealthInfo(baseStudentData.healthInfo),
  };

  const studentCpfRequired = registrationType === 'ADULT_STUDENT';
  normalized.cpf = normalizeCpfField(baseStudentData.cpf, 'CPF do aluno', {
    required: studentCpfRequired,
  });
  normalized.email = normalizeEmailField(baseStudentData.email, 'E-mail do aluno');
  normalized.motherName = normalizeNameField(
    baseStudentData.motherName ||
      baseStudentData.mother_name ||
      normalizedParents?.mother?.fullName
  );
  normalized.fatherName = normalizeNameField(
    baseStudentData.fatherName ||
      baseStudentData.father_name ||
      normalizedParents?.father?.fullName
  );

  return normalized;
}

function normalizeTutorData(tutorData = null, registrationType) {
  if (!tutorData || typeof tutorData !== 'object') return tutorData;

  const baseTutorData = toPlainData(tutorData);
  const normalized = {
    ...baseTutorData,
    address: normalizeAddress(baseTutorData.address),
  };

  const tutorCpfRequired = registrationType === 'MINOR_STUDENT';
  normalized.cpf = normalizeCpfField(baseTutorData.cpf, 'CPF do responsavel', {
    required: tutorCpfRequired,
  });
  normalized.email = normalizeEmailField(baseTutorData.email, 'E-mail do responsavel');
  normalized.fullName = normalizeNameField(baseTutorData.fullName);
  normalized.rg = normalizeOptionalString(baseTutorData.rg);
  normalized.phoneNumber = normalizeOptionalString(baseTutorData.phoneNumber);
  normalized.profession = normalizeOptionalString(baseTutorData.profession);
  normalized.relationship = normalizeOptionalString(baseTutorData.relationship);

  return normalized;
}

class RegistrationRequestService {
  async _assertSchoolExists(schoolId) {
    if (!schoolId || !isObjectId(schoolId)) {
      throw createHttpError('Escola nao encontrada.', 404);
    }

    const school = await School.findById(schoolId).select('_id');
    if (!school) {
      throw createHttpError('Escola nao encontrada.', 404);
    }

    return school;
  }

  async _getClassAvailability(classDoc) {
    if (!classDoc || classDoc.status !== 'Ativa') {
      return 'unavailable';
    }

    if (!classDoc.capacity) {
      return 'available';
    }

    const activeEnrollments = await Enrollment.countDocuments({
      class: classDoc._id,
      status: 'Ativa',
      school_id: classDoc.school_id,
    });

    return activeEnrollments >= classDoc.capacity ? 'unavailable' : 'available';
  }

  async _getSelectableClassOrThrow(classId, schoolId) {
    if (!classId || !isObjectId(classId)) {
      throw createHttpError('Turma nao encontrada.', 404);
    }

    const classDoc = await Class.findById(classId);
    if (!classDoc) {
      throw createHttpError('Turma nao encontrada.', 404);
    }

    if (!sameId(classDoc.school_id, schoolId)) {
      throw createHttpError('Turma nao pertence a esta escola.', 404);
    }

    if (classDoc.status !== 'Ativa') {
      throw createHttpError('Turma inativa para solicitacao de matricula.', 409);
    }

    const availabilityStatus = await this._getClassAvailability(classDoc);
    if (availabilityStatus !== 'available') {
      throw createHttpError('Turma indisponivel para novas solicitacoes.', 409);
    }

    const publicClass = buildPublicClassPayload(classDoc, availabilityStatus);

    return {
      classDoc,
      publicClass,
      snapshot: buildSelectedClassSnapshot(publicClass),
    };
  }

  async listPublicClasses(schoolId) {
    await this._assertSchoolExists(schoolId);

    const classes = await Class.find({
      school_id: schoolId,
      status: 'Ativa',
    }).sort({ schoolYear: -1, grade: 1, name: 1, shift: 1 });

    const publicClasses = await Promise.all(
      classes.map(async (classDoc) => {
        const availabilityStatus = await this._getClassAvailability(classDoc);
        return buildPublicClassPayload(classDoc, availabilityStatus);
      })
    );

    return publicClasses;
  }

  async listPublicOffers(schoolId, classId = null) {
    return enrollmentOfferService.listPublicOffers(schoolId, classId);
  }

  async getPublicContext(schoolId) {
    if (!schoolId || !isObjectId(schoolId)) {
      throw createHttpError('Escola nao encontrada.', 404);
    }

    const school = await School.findById(schoolId).select('name logoUrl logo.contentType');
    if (!school) {
      throw createHttpError('Escola nao encontrada.', 404);
    }

    return {
      school: {
        id: String(school._id),
        name: school.name,
        logoUrl: school.logoUrl || (school.logo?.contentType ? `/api/schools/${school._id}/logo` : null),
      },
    };
  }

  async createPublicRequest(data) {
    const {
      school_id,
      registrationType,
      studentData,
      tutorData,
      selectedClassId,
      selectedEnrollmentOfferId,
      requestedPermanenceClassId,
      permanenceNotes,
      origin,
      onlyMinors,
    } = data;

    if (!school_id) throw createHttpError('O ID da escola e obrigatorio.', 400);
    await this._assertSchoolExists(school_id);

    if (!['ADULT_STUDENT', 'MINOR_STUDENT'].includes(registrationType)) {
      throw createHttpError('Tipo de solicitacao invalido.', 400);
    }

    if (onlyMinors === true && registrationType !== 'MINOR_STUDENT') {
      throw createHttpError('Este link aceita apenas solicitacoes para menores de idade.', 400);
    }

    const normalizedStudentData = normalizeStudentData(studentData || {}, registrationType);
    const normalizedTutorData = normalizeTutorData(tutorData, registrationType);
    const requestedYear = data.academicYearTo == null ? null : Number(data.academicYearTo);
    if (requestedYear != null && (!Number.isInteger(requestedYear) || requestedYear < 1900 || requestedYear > 2200)) {
      throw createHttpError('Informe um ano letivo de destino valido.', 400);
    }

    let selectedClass = null;
    if (selectedClassId) {
      selectedClass = await this._getSelectableClassOrThrow(selectedClassId, school_id);
    }
    if (selectedClass && requestedYear != null && selectedClass.classDoc.schoolYear !== requestedYear) {
      throw createHttpError('A turma selecionada nao pertence ao ano letivo solicitado.', 409);
    }

    if (selectedEnrollmentOfferId && !selectedClass) {
      throw createHttpError('Selecione uma turma antes de escolher a oferta.', 400);
    }

    let selectedOffer = null;
    if (selectedEnrollmentOfferId) {
      selectedOffer = await enrollmentOfferService.getApplicableOfferOrThrow({
        offerId: selectedEnrollmentOfferId,
        schoolId: school_id,
        classId: selectedClass.classDoc._id,
        publicOnly: true,
      });
    }

    let requestedPermanenceClass = null;
    if (requestedPermanenceClassId) {
      requestedPermanenceClass = await enrollmentOfferService.getPermanenceClassOrThrow(
        requestedPermanenceClassId,
        school_id
      );
    }

    const newRequest = new RegistrationRequest({
      academicYearTo: requestedYear ?? selectedClass?.classDoc?.schoolYear,
      school_id,
      registrationType,
      studentData: normalizedStudentData,
      tutorData: normalizedTutorData,
      selectedClassId: selectedClass?.classDoc?._id || undefined,
      selectedClassSnapshot: selectedClass?.snapshot || undefined,
      selectedEnrollmentOfferId: selectedOffer?.offer?._id || undefined,
      selectedEnrollmentOfferSnapshot: selectedOffer?.snapshot || undefined,
      requestedRegime: selectedOffer?.requestedRegime || 'regular',
      requestedPermanenceClassId: requestedPermanenceClass?._id || undefined,
      requestedPermanenceClassSnapshot: requestedPermanenceClass
        ? enrollmentOfferService.buildPermanenceClassSnapshot(requestedPermanenceClass)
        : undefined,
      permanenceNotes: normalizeOptionalString(permanenceNotes),
      origin,
      onlyMinors,
      status: 'PENDING',
    });

    return await newRequest.save();
  }

  // [ALTERADO] Renomeado de listPendingRequests para listAllRequests
  // Removemos o filtro de status. Retorna tudo da escola.
  async listAllRequests(schoolId) {
    return await RegistrationRequest.find({
      school_id: schoolId,
      // status: 'PENDING' <--- REMOVIDO
    }).sort({ createdAt: -1 });
  }

  async updateRequestData(requestId, schoolId, studentData, tutorData) {
    const request = await RegistrationRequest.findOne({ _id: requestId, school_id: schoolId });

    if (!request) throw new Error('Solicitacao nao encontrada.');
    if (request.status !== 'PENDING') throw new Error('Apenas solicitacoes pendentes podem ser editadas.');

    if (studentData) {
      request.studentData = { ...(toPlainData(request.studentData) || {}), ...studentData };
    }

    if (tutorData) {
      request.tutorData = request.tutorData
        ? { ...(toPlainData(request.tutorData) || {}), ...tutorData }
        : tutorData;
    }

    request.markModified('studentData');
    if (tutorData) request.markModified('tutorData');

    return await request.save();
  }

  async _findExistingTutor(tutorData, schoolId) {
    const cpfNormalized = normalizeCpf(tutorData?.cpf);
    if (!cpfNormalized) return null;

    return await Tutor.findOne({
      school_id: schoolId,
      $or: [
        { cpfNormalized },
        { cpf: cpfNormalized },
        { cpf: tutorData.cpf },
      ],
    });
  }

  async _createEnrollmentForApprovedRequest(student, classDoc, schoolId, options = {}) {
    const existingEnrollment = await Enrollment.findOne({
      student: student._id,
      academicYear: classDoc.schoolYear,
      school_id: schoolId,
    });

    if (existingEnrollment) {
      if (
        sameId(existingEnrollment.class, classDoc._id) &&
        existingEnrollment.status === 'Ativa'
      ) {
        throw createHttpError('Aluno ja possui matricula ativa nesta turma.', 409);
      }

      throw createHttpError(
        `Aluno ja possui matricula no ano letivo ${classDoc.schoolYear}.`,
        409
      );
    }

    const availabilityStatus = await this._getClassAvailability(classDoc);
    if (availabilityStatus !== 'available') {
      throw createHttpError('Turma indisponivel para novas matriculas.', 409);
    }

    const enrollmentOffer = options.enrollmentOffer || null;
    const permanenceClass = options.permanenceClass || null;
    const enrollmentRegime = options.enrollmentRegime || 'regular';
    const agreedFee = enrollmentOfferService.calculateAgreedFee(classDoc, enrollmentOffer);

    const enrollment = new Enrollment({
      student: student._id,
      class: classDoc._id,
      academicYear: classDoc.schoolYear,
      agreedFee,
      school_id: schoolId,
      enrollmentRegime,
      enrollmentOfferId: enrollmentOffer?._id || undefined,
      enrollmentOfferSnapshot: options.enrollmentOfferSnapshot || undefined,
      permanenceClassId: permanenceClass?._id || undefined,
      permanenceClassSnapshot: options.permanenceClassSnapshot || undefined,
      permanenceNotes: normalizeOptionalString(options.permanenceNotes) || '',
      status: 'Ativa',
    });

    try {
      return await enrollment.save();
    } catch (error) {
      if (error && error.code === 11000) {
        throw createHttpError(
          `Aluno ja possui matricula no ano letivo ${classDoc.schoolYear}.`,
          409
        );
      }

      throw createHttpError('Erro ao criar matricula do aluno.', 400);
    }
  }

  async approveRequest(
    requestId,
    schoolId,
    userId,
    finalStudentData,
    finalTutorData,
    options = {}
  ) {
    let createdTutor = null;
    let createdStudent = null;
    let createdEnrollment = null;
    let shouldCleanupTutor = false;

    try {
      const request = await RegistrationRequest.findOne({ _id: requestId, school_id: schoolId });

      if (!request) throw new Error('Solicitacao nao encontrada.');
      if (request.status === 'APPROVED') throw new Error('Esta solicitacao ja foi aprovada.');

      const sourceStudentData = finalStudentData
        ? {
            ...(toPlainData(request.studentData) || {}),
            ...finalStudentData,
          }
        : request.studentData || {};
      const sourceTutorData = finalTutorData
        ? {
            ...(toPlainData(request.tutorData) || {}),
            ...finalTutorData,
          }
        : request.tutorData;

      const sData = normalizeStudentData(sourceStudentData, request.registrationType);
      const tData = normalizeTutorData(sourceTutorData, request.registrationType);

      const selectedClassId =
        options.finalSelectedClassId || request.selectedClassId || null;
      let selectedClass = null;

      if (selectedClassId) {
        selectedClass = await this._getSelectableClassOrThrow(selectedClassId, schoolId);
      }
      if (selectedClass && request.academicYearTo && selectedClass.classDoc.schoolYear !== request.academicYearTo) {
        throw createHttpError('A turma selecionada nao pertence ao ano letivo solicitado.', 409);
      }

      const selectedOfferId =
        options.finalSelectedEnrollmentOfferId || request.selectedEnrollmentOfferId || null;
      let selectedOffer = null;

      if (selectedOfferId) {
        if (!selectedClass) {
          throw createHttpError('Selecione uma turma antes de aprovar a oferta.', 400);
        }

        selectedOffer = await enrollmentOfferService.getApplicableOfferOrThrow({
          offerId: selectedOfferId,
          schoolId,
          classId: selectedClass.classDoc._id,
          publicOnly: false,
        });
      }

      const requestedPermanenceClassId =
        options.finalPermanenceClassId || request.requestedPermanenceClassId || null;
      let permanenceClass = null;
      let permanenceClassSnapshot = undefined;
      const permanenceClassMode = selectedOffer?.offer?.permanenceClassMode || 'none';

      if (requestedPermanenceClassId && !selectedOffer) {
        throw createHttpError(
          'Turma de permanencia so pode ser informada quando houver oferta de permanencia.',
          400
        );
      }

      if (selectedOffer && permanenceClassMode === 'required' && !requestedPermanenceClassId) {
        throw createHttpError(
          'Selecione uma turma de permanencia para aprovar esta matricula.',
          400
        );
      }

      if (selectedOffer && permanenceClassMode === 'none' && requestedPermanenceClassId) {
        throw createHttpError(
          'Esta oferta nao usa turma de permanencia no contraturno.',
          400
        );
      }

      if (requestedPermanenceClassId) {
        permanenceClass = await enrollmentOfferService.getPermanenceClassOrThrow(
          requestedPermanenceClassId,
          schoolId
        );
        permanenceClassSnapshot = enrollmentOfferService.buildPermanenceClassSnapshot(
          permanenceClass
        );
      }

      const currentYear = new Date().getFullYear();
      const randomPart = Math.floor(100000 + Math.random() * 900000);
      const generatedEnrollment = `${currentYear}${randomPart}`;

      if (request.registrationType === 'MINOR_STUDENT') {
        if (!tData || !tData.cpf) throw new Error('Dados do tutor incompletos.');

        const existingTutor = await this._findExistingTutor(tData, schoolId);

        if (existingTutor) {
          createdTutor = existingTutor;
        } else {
          createdTutor = await new Tutor({
            ...tData,
            school_id: schoolId,
          }).save();
          shouldCleanupTutor = true;
        }

        createdStudent = await new Student({
          ...sData,
          mother_name: sData.motherName || sData.mother_name || '',
          father_name: sData.fatherName || sData.father_name || '',
          parents: sData.parents,
          primaryResponsibleType: sData.primaryResponsibleType,
          enrollmentNumber: generatedEnrollment,
          healthInfo: sData.healthInfo,
          authorizedPickups: sData.authorizedPickups,
          address: sData.address,
          school_id: schoolId,
          financialResp: 'TUTOR',
          financialTutorId: createdTutor._id,
          tutors: [{
            tutorId: createdTutor._id,
            relationship: tData.relationship || 'Outro',
          }],
        }).save();
      } else {
        createdStudent = await new Student({
          ...sData,
          mother_name: sData.motherName || sData.mother_name || '',
          father_name: sData.fatherName || sData.father_name || '',
          parents: sData.parents,
          primaryResponsibleType: sData.primaryResponsibleType,
          enrollmentNumber: generatedEnrollment,
          healthInfo: sData.healthInfo,
          authorizedPickups: sData.authorizedPickups,
          address: sData.address,
          school_id: schoolId,
          financialResp: 'STUDENT',
          tutors: [],
        }).save();
      }

      if (selectedClass) {
        try {
          createdEnrollment = await this._createEnrollmentForApprovedRequest(
            createdStudent,
            selectedClass.classDoc,
            schoolId,
            {
              enrollmentOffer: selectedOffer?.offer || null,
              enrollmentOfferSnapshot: selectedOffer?.snapshot || undefined,
              enrollmentRegime: selectedOffer?.requestedRegime || 'regular',
              permanenceClass,
              permanenceClassSnapshot,
              permanenceNotes:
                options.permanenceNotes !== undefined
                  ? options.permanenceNotes
                  : request.permanenceNotes,
            }
          );
        } catch (error) {
          throw createHttpError(
            error.message || 'Erro ao criar matricula do aluno.',
            error.statusCode || 400
          );
        }

        request.selectedClassId = selectedClass.classDoc._id;
        request.selectedClassSnapshot = selectedClass.snapshot;
        request.markModified('selectedClassSnapshot');

        if (selectedOffer) {
          request.selectedEnrollmentOfferId = selectedOffer.offer._id;
          request.selectedEnrollmentOfferSnapshot = selectedOffer.snapshot;
          request.requestedRegime = selectedOffer.requestedRegime;
          request.markModified('selectedEnrollmentOfferSnapshot');
        }

        if (permanenceClass) {
          request.requestedPermanenceClassId = permanenceClass._id;
          request.requestedPermanenceClassSnapshot = permanenceClassSnapshot;
          request.markModified('requestedPermanenceClassSnapshot');
        }

        if (options.permanenceNotes !== undefined) {
          request.permanenceNotes = normalizeOptionalString(options.permanenceNotes);
        }
      }

      request.status = 'APPROVED';
      request.approvedStudentId = createdStudent._id;
      if (!request.academicYearTo && selectedClass) request.academicYearTo = selectedClass.classDoc.schoolYear;
      request.reviewedBy = userId;
      await request.save();

      return {
        success: true,
        message: selectedClass
          ? 'Solicitacao aprovada e matricula criada com sucesso!'
          : 'Matricula aprovada com sucesso!',
        student: createdStudent,
        enrollment: createdEnrollment,
      };
    } catch (error) {
      if (createdEnrollment && createdEnrollment._id) {
        await Enrollment.deleteOne({ _id: createdEnrollment._id }).catch(() => {});
      }

      if (createdStudent && createdStudent._id) {
        await Student.deleteOne({ _id: createdStudent._id }).catch(() => {});
      }

      if (shouldCleanupTutor && createdTutor && createdTutor._id) {
        await Tutor.deleteOne({ _id: createdTutor._id }).catch(() => {});
      }

      console.error('Erro no Service approveRequest:', error);
      throw error;
    }
  }

  async rejectRequest(requestId, schoolId, userId, reason) {
    const request = await RegistrationRequest.findOne({ _id: requestId, school_id: schoolId });
    if (!request) throw new Error('Solicitacao nao encontrada.');

    request.status = 'REJECTED';
    request.rejectionReason = reason;
    request.reviewedBy = userId;

    return await request.save();
  }
}

module.exports = new RegistrationRequestService();
