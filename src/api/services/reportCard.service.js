const mongoose = require('mongoose');

const ReportCard = require('../models/reportCard.model');
const Enrollment = require('../models/enrollment.model');
const Student = require('../models/student.model');
const ClassModel = require('../models/class.model');
const Subject = require('../models/subject.model');
const Horario = require('../models/horario.model');
const School = require('../models/school.model');
const Tutor = require('../models/tutor.model'); // Adicionado o model de Tutor
const {
  evaluationModeForClass,
} = require('../utils/reportCardEvaluationMode.helper');
const {
  getCriteriaForSubjectName,
  getDefaultEarlyChildhoodArea,
  getDefaultEarlyChildhoodAreas,
  isDefaultEarlyChildhoodAreaId,
} = require('../utils/earlyChildhoodCriteria.helper');
const {
  canEditReportCardSubject,
  extractId,
  getActorId,
  getPrimaryReportCardEditRole,
} = require('./reportCardPermission.service');

const DEVELOPMENTAL_STATUSES = new Set([
  'autonomy',
  'support',
  'developing',
  'not_worked',
]);

class ReportCardService {
  _createError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  _normalizeMinimumAverage(school) {
    const value =
      school?.minimumAverage ??
      school?.academicConfig?.minimumAverage ??
      7.0;

    const parsed = Number(value);
    if (Number.isNaN(parsed)) return 7.0;

    return parsed;
  }

  // Mantido como fallback caso algum aluno tenha o nome do responsável salvo direto nele
  _extractResponsibleName(student) {
    return (
      student?.responsible_name ||
      student?.responsibleName ||
      student?.guardianName ||
      student?.guardian_name ||
      student?.tutorName ||
      student?.mother_name ||
      student?.father_name ||
      ''
    );
  }

  _dedupeSubjectsFromHorario(horarios = []) {
    const uniqueMap = new Map();

    for (const horario of horarios) {
      const subjectId = horario?.subjectId?._id || horario?.subjectId;
      const teacherId = horario?.teacherId?._id || horario?.teacherId;

      if (!subjectId || !teacherId) continue;

      const subjectName =
        horario?.subjectId?.name ||
        horario?.subjectName ||
        'Disciplina';

      const teacherName =
        horario?.teacherId?.name ||
        horario?.teacherId?.full_name ||
        horario?.teacherId?.fullName ||
        horario?.teacherName ||
        '';

      const key = `${String(subjectId)}::${String(teacherId)}`;

      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, {
          subjectId,
          subjectNameSnapshot: subjectName,
          teacherId,
          teacherNameSnapshot: teacherName,
          testScore: null,
          activityScore: null,
          participationScore: null,
          score: null,
          status: 'Pendente',
          observation: '',
          filledBy: null,
          filledAt: null,
        });
      }
    }

    return Array.from(uniqueMap.values());
  }

  _buildDefaultEarlyChildhoodSubjects() {
    return getDefaultEarlyChildhoodAreas().map((area) => ({
      subjectId: area.areaId,
      areaId: area.areaId,
      subjectNameSnapshot: area.subjectName,
      teacherId: null,
      teacherNameSnapshot: '',
      testScore: null,
      activityScore: null,
      participationScore: null,
      score: null,
      status: 'Pendente',
      observation: '',
      filledBy: null,
      filledAt: null,
    }));
  }

  _criteriaWithPendingStatus(criteria = []) {
    return criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      description: criterion.description,
      status: null,
      updatedAt: null,
    }));
  }

  _calculateSubjectStatus(score, minimumAverage) {
    if (score === null || score === undefined || score === '') {
      return 'Pendente';
    }

    const numericScore = Number(score);
    if (Number.isNaN(numericScore)) {
      return 'Pendente';
    }

    return numericScore >= minimumAverage
      ? 'Acima da Média'
      : 'Abaixo da Média';
  }

  _calculateNumericReportCardStatus(subjects = []) {
    if (!subjects.length) return 'Rascunho';

    const filledCount = subjects.filter(
      (item) => item.score !== null && item.score !== undefined
    ).length;

    if (filledCount === 0) return 'Rascunho';
    if (filledCount < subjects.length) return 'Parcial';
    return 'Completo';
  }

  _calculateDevelopmentalAssessmentCompletion(criteria = []) {
    if (!criteria.length) return 'pending';

    const filledCount = criteria.filter(
      (item) =>
        item.status !== null &&
        item.status !== undefined &&
        item.status !== ''
    ).length;

    if (filledCount === 0) return 'pending';
    if (filledCount < criteria.length) return 'in_progress';
    return 'completed';
  }

  _calculateDevelopmentalReportCardStatus(assessments = [], subjectCount = 0) {
    const expectedCount = subjectCount || assessments.length;
    if (!expectedCount || !assessments.length) return 'Rascunho';

    const startedCount = assessments.filter((item) => {
      const status = this._calculateDevelopmentalAssessmentCompletion(
        item.criteria || []
      );
      return status === 'in_progress' || status === 'completed';
    }).length;

    const completedCount = assessments.filter(
      (item) =>
        this._calculateDevelopmentalAssessmentCompletion(item.criteria || []) ===
        'completed'
    ).length;

    if (startedCount === 0) return 'Rascunho';
    if (completedCount < expectedCount) return 'Parcial';
    return 'Completo';
  }

  _calculateReportCardStatus(reportCard) {
    if (reportCard?.evaluationMode === 'developmental') {
      return this._calculateDevelopmentalReportCardStatus(
        reportCard.developmentalAssessments || [],
        (reportCard.subjects || []).length
      );
    }

    return this._calculateNumericReportCardStatus(reportCard?.subjects || []);
  }

  _validateExpectedContext(reportCard, expectedContext = {}) {
    const checks = [
      {
        label: 'expectedTermId',
        expected: expectedContext.expectedTermId,
        actual: extractId(reportCard?.termId),
      },
      {
        label: 'expectedClassId',
        expected: expectedContext.expectedClassId,
        actual: extractId(reportCard?.classId),
      },
      {
        label: 'expectedStudentId',
        expected: expectedContext.expectedStudentId,
        actual: extractId(reportCard?.studentId),
      },
    ];

    for (const check of checks) {
      if (
        check.expected !== undefined &&
        check.expected !== null &&
        String(check.expected).trim() !== '' &&
        String(check.expected) !== String(check.actual)
      ) {
        throw this._createError(
          'Contexto do boletim divergente. Atualize a tela e tente novamente.',
          409
        );
      }
    }

    if (
      expectedContext.expectedSchoolYear !== undefined &&
      expectedContext.expectedSchoolYear !== null &&
      String(expectedContext.expectedSchoolYear).trim() !== '' &&
      Number(expectedContext.expectedSchoolYear) !== Number(reportCard?.schoolYear)
    ) {
      throw this._createError(
        'Contexto do boletim divergente. Atualize a tela e tente novamente.',
        409
      );
    }
  }

  _findSubjectIndex(reportCard, subjectId, { actor = null, expectedTeacherId = null } = {}) {
    const candidates = [];

    (reportCard.subjects || []).forEach((item, index) => {
      if (String(item.subjectId) === String(subjectId)) {
        candidates.push({ item, index });
      }
    });

    if (!candidates.length) return -1;

    if (expectedTeacherId !== null && expectedTeacherId !== undefined) {
      const expectedTeacher = String(expectedTeacherId || '');
      const found = candidates.find(({ item }) => String(extractId(item.teacherId) || '') === expectedTeacher);
      return found ? found.index : -1;
    }

    const actorId = getActorId(actor);
    if (actorId) {
      const linked = candidates.find(({ item }) => String(extractId(item.teacherId) || '') === String(actorId));
      if (linked) return linked.index;
    }

    return candidates.length === 1 ? candidates[0].index : -2;
  }

  _findDevelopmentalSubjectIndex(reportCard, subjectId, { actor = null, expectedTeacherId = null } = {}) {
    const candidates = [];

    (reportCard.subjects || []).forEach((item, index) => {
      const sameArea =
        String(item.areaId || '') === String(subjectId) ||
        String(item.subjectId || '') === String(subjectId);
      if (sameArea) {
        candidates.push({ item, index });
      }
    });

    if (!candidates.length) return -1;

    if (expectedTeacherId !== null && expectedTeacherId !== undefined) {
      const expectedTeacher = String(expectedTeacherId || '');
      const found = candidates.find(({ item }) => String(extractId(item.teacherId) || '') === expectedTeacher);
      return found ? found.index : -1;
    }

    const actorId = getActorId(actor);
    if (actorId) {
      const linked = candidates.find(({ item }) => String(extractId(item.teacherId) || '') === String(actorId));
      if (linked) return linked.index;
    }

    return candidates.length === 1 ? candidates[0].index : -2;
  }

  _assertCanEditSubject({ actor, reportCard, subjectEntry }) {
    const permission = canEditReportCardSubject({
      actor,
      reportCard,
      subjectItem: subjectEntry,
    });

    if (!permission.allowed) {
      throw this._createError(
        permission.message || 'Você não tem permissão para editar esta disciplina neste boletim.',
        permission.reason === 'school_mismatch' ? 403 : 403
      );
    }

    return permission;
  }

  _applyManualEditMetadata(target, actor, editedAt = new Date()) {
    const actorId = getActorId(actor);
    const role = getPrimaryReportCardEditRole(actor);

    target.filledBy = actorId;
    target.filledAt = editedAt;
    target.lastEditedBy = actorId;
    target.lastEditedAt = editedAt;
    target.lastEditedRole = role;
    target.lastEditedSource = 'manual_report_card_edit';
  }

  _scoreSnapshot(subjectEntry) {
    return {
      score: subjectEntry?.score ?? null,
      testScore: subjectEntry?.testScore ?? null,
      activityScore: subjectEntry?.activityScore ?? null,
      participationScore: subjectEntry?.participationScore ?? null,
      observation: subjectEntry?.observation || '',
    };
  }

  _appendScoreHistory({
    subjectEntry,
    actor,
    source,
    reason = '',
    previous,
    current,
    changedAt = new Date(),
  }) {
    if (!Array.isArray(subjectEntry.scoreHistory)) {
      subjectEntry.scoreHistory = [];
    }
    subjectEntry.scoreHistory.push({
      actorId: getActorId(actor),
      actorNameSnapshot:
        actor?.fullName || actor?.name || actor?.full_name || actor?.email || '',
      actorRole: getPrimaryReportCardEditRole(actor),
      source,
      reason: String(reason || '').trim(),
      changedAt,
      previous,
      current,
    });
  }

  _mergeSubjects(existingSubjects = [], generatedSubjects = [], minimumAverage = 7) {
    const existingMap = new Map();

    for (const item of existingSubjects) {
      const key = `${String(item.subjectId)}::${String(item.teacherId)}`;
      existingMap.set(key, item);
    }

    return generatedSubjects.map((generated) => {
      const key = `${String(generated.subjectId)}::${String(generated.teacherId)}`;
      const existing = existingMap.get(key);

      if (!existing) return generated;

      const mergedScore =
        existing.score !== null && existing.score !== undefined
          ? existing.score
          : null;

      return {
        subjectId: generated.subjectId,
        areaId: existing.areaId || generated.areaId || '',
        subjectNameSnapshot:
          existing.subjectNameSnapshot || generated.subjectNameSnapshot,
        teacherId: generated.teacherId,
        teacherNameSnapshot:
          existing.teacherNameSnapshot || generated.teacherNameSnapshot,
        testScore: existing.testScore !== undefined ? existing.testScore : null,
        testScoreSource: existing.testScoreSource || null,
        activityScore: existing.activityScore !== undefined ? existing.activityScore : null,
        participationScore: existing.participationScore !== undefined ? existing.participationScore : null,
        score: mergedScore,
        status: this._calculateSubjectStatus(mergedScore, minimumAverage),
        observation: existing.observation || '',
        filledBy: existing.filledBy || null,
        filledAt: existing.filledAt || null,
        lastEditedBy: existing.lastEditedBy || null,
        lastEditedAt: existing.lastEditedAt || null,
        lastEditedRole: existing.lastEditedRole || '',
        lastEditedSource: existing.lastEditedSource || '',
        scoreHistory: existing.scoreHistory || [],
      };
    });
  }

  _mergeDevelopmentalAssessments(existingAssessments = [], generatedSubjects = []) {
    const existingMap = new Map();

    for (const item of existingAssessments || []) {
      const key = `${String(item.areaId || item.subjectId)}::${String(item.teacherId || '')}`;
      existingMap.set(key, item);
    }

    return generatedSubjects.map((generated) => {
      const areaId = generated.areaId || String(generated.subjectId || '');
      const key = `${String(areaId)}::${String(generated.teacherId || '')}`;
      const existing = existingMap.get(key);
      const defaultArea = getDefaultEarlyChildhoodArea(areaId);
      const defaultCriteria = defaultArea
        ? defaultArea.criteria
        : getCriteriaForSubjectName(generated.subjectNameSnapshot);

      if (!existing) {
        return {
          subjectId: generated.subjectId,
          areaId,
          subjectName: generated.subjectNameSnapshot,
          teacherId: generated.teacherId || null,
          teacherName: generated.teacherNameSnapshot || '',
          criteria: this._criteriaWithPendingStatus(defaultCriteria),
          generalObservation: '',
          completionStatus: 'pending',
          filledBy: null,
          filledAt: null,
        };
      }

      const criteria = (existing.criteria && existing.criteria.length)
        ? existing.criteria
        : this._criteriaWithPendingStatus(defaultCriteria);

      return {
        subjectId: existing.subjectId || generated.subjectId,
        areaId,
        subjectName: existing.subjectName || generated.subjectNameSnapshot,
        teacherId: existing.teacherId || generated.teacherId || null,
        teacherName: existing.teacherName || generated.teacherNameSnapshot || '',
        criteria,
        generalObservation: existing.generalObservation || '',
        completionStatus: this._calculateDevelopmentalAssessmentCompletion(criteria),
        filledBy: existing.filledBy || null,
        filledAt: existing.filledAt || null,
      };
    });
  }

  _normalizeDevelopmentalCriteria(criteria = []) {
    if (!Array.isArray(criteria)) {
      throw this._createError('criteria deve ser uma lista.', 400);
    }

    const seenIds = new Set();

    return criteria.map((criterion) => {
      const criterionId = String(criterion?.criterionId || '').trim();
      const description = String(criterion?.description || '').trim();
      const rawStatus =
        criterion?.status === null || criterion?.status === undefined
          ? null
          : String(criterion.status).trim();

      if (!criterionId) {
        throw this._createError('Todo criterio precisa de criterionId.', 400);
      }

      if (seenIds.has(criterionId)) {
        throw this._createError(`criterionId duplicado: ${criterionId}.`, 400);
      }
      seenIds.add(criterionId);

      if (!description) {
        throw this._createError('Todo criterio precisa de description.', 400);
      }

      if (rawStatus && !DEVELOPMENTAL_STATUSES.has(rawStatus)) {
        throw this._createError(`Status invalido para criterio: ${rawStatus}.`, 400);
      }

      return {
        criterionId,
        description,
        status: rawStatus || null,
        updatedAt: rawStatus ? new Date() : null,
      };
    });
  }

  async generateClassReportCards({
    schoolId,
    classId,
    termId,
    schoolYear,
  }) {
    if (!schoolId) {
      throw this._createError('schoolId é obrigatório.', 400);
    }

    if (!classId) {
      throw this._createError('classId é obrigatório.', 400);
    }

    if (!termId) {
      throw this._createError('termId é obrigatório.', 400);
    }

    if (!schoolYear) {
      throw this._createError('schoolYear é obrigatório.', 400);
    }

    console.log(`\n--- [ReportCardService] Iniciando geração de boletins ---`);
    console.log(`Parâmetros recebidos -> Escola: ${schoolId}, Turma: ${classId}, Período: ${termId}, Ano: ${schoolYear}`);

    console.log('[ReportCardsAPI][SyncStart]', {
      schoolId: String(schoolId),
      classId: String(classId),
      termId: String(termId),
      schoolYear: Number(schoolYear),
    });

    const school = await School.findOne({ _id: schoolId });
    if (!school) {
      throw this._createError('Escola não encontrada.', 404);
    }

    const classData = await ClassModel.findOne({
      _id: classId,
      school_id: schoolId,
    });

    if (!classData) {
      throw this._createError('Turma não encontrada para esta escola.', 404);
    }

    console.log(`Turma localizada: ${classData.name} (ID: ${classData._id})`);

    console.log('[ReportCardsAPI][SyncClass]', {
      classId: String(classData._id),
      className: classData.name,
      schoolYear: classData.schoolYear,
    });

    const enrollments = await Enrollment.find({
      school_id: schoolId,
      class: classId,
      academicYear: Number(schoolYear),
      status: 'Ativa' 
    }).populate('student');

    if (!enrollments.length) {
      console.log(`[ERRO] Nenhuma matrícula 'Ativa' encontrada para a turma ${classData.name} no ano ${schoolYear}.`);
      throw this._createError(
        `Nenhuma matrícula ativa encontrada para a turma "${classData.name}" no ano letivo de ${schoolYear}. Verifique no menu de alunos se existem matrículas ativas para esta turma neste ano.`,
        404
      );
    }

    console.log(`Matrículas ativas encontradas: ${enrollments.length}`);

    console.log('[ReportCardsAPI][SyncEnrollments]', {
      classId: String(classId),
      schoolYear: Number(schoolYear),
      activeEnrollments: enrollments.length,
    });

    const evaluationMode = evaluationModeForClass(classData);

    let horarios = await Horario.find({
      school_id: schoolId,
      classId: classId, 
      termId: termId,
    })
      .populate('subjectId')
      .populate('teacherId');

    if (!horarios.length) {
      console.log(`[AVISO] Sem horário no período ${termId}. Buscando qualquer horário global da turma...`);
      console.log('[ReportCardsAPI][SyncScheduleFallback]', {
        classId: String(classId),
        termId: String(termId),
        reason: 'no_term_schedule',
      });
      horarios = await Horario.find({
        school_id: schoolId,
        classId: classId,
      })
        .populate('subjectId')
        .populate('teacherId');
    }

    if (!horarios.length && evaluationMode !== 'developmental') {
      console.log(`[ERRO] A grade horária está completamente vazia para a turma ${classData.name}.`);
      throw this._createError(
        `Nenhuma disciplina vinculada à turma "${classData.name}" foi encontrada. Acesse 'Gestão Acadêmica > Horários' e certifique-se de que existem aulas cadastradas para esta turma.`,
        404
      );
    }

    const minimumAverage = this._normalizeMinimumAverage(school);
    let generatedSubjects = this._dedupeSubjectsFromHorario(horarios);

    if (evaluationMode === 'developmental' && !generatedSubjects.length) {
      generatedSubjects = this._buildDefaultEarlyChildhoodSubjects();
    }

    if (!generatedSubjects.length) {
      throw this._createError(
        'Não foi possível extrair disciplinas únicas a partir do horário cadastrado.',
        400
      );
    }

    console.log(`Disciplinas únicas extraídas do horário: ${generatedSubjects.length}`);

    console.log('[ReportCardsAPI][SyncSubjects]', {
      classId: String(classId),
      termId: String(termId),
      subjects: generatedSubjects.length,
    });

    const results = [];
    let existingCount = 0;
    let createdCount = 0;
    let updatedCount = 0;
    let ignoredCount = 0;

    for (const enrollment of enrollments) {
      const student = enrollment.student;

      if (!student?._id) {
        ignoredCount += 1;
        continue;
      }

      // --- BUSCA DO NOME DO RESPONSÁVEL ---
      // Procura um tutor que tenha esse aluno na lista de filhos ('students')
    //   const tutor = await Tutor.findOne({ school_id: schoolId, students: student._id });
    const tutor = await Tutor.findOne({ 
        school_id: schoolId, 
        students: { $in: [student._id] } 
      });  
    const fallbackName = this._extractResponsibleName(student);
      
      const responsibleNameSnapshot = tutor 
        ? tutor.fullName 
        : (fallbackName && fallbackName.trim() !== '' ? fallbackName : '');
      // ------------------------------------

      const existingReportCard = await ReportCard.findOne({
        school_id: schoolId,
        schoolYear,
        termId,
        classId,
        studentId: student._id,
      });

      if (!existingReportCard) {
        const subjects = generatedSubjects.map((item) => ({
          ...item,
          status: 'Pendente',
        }));

        const created = await ReportCard.create({
          school_id: schoolId,
          schoolYear,
          termId,
          classId,
          studentId: student._id,
          enrollmentId: enrollment._id,
          gradingType: evaluationMode,
          evaluationMode,
          minimumAverage,
          status: evaluationMode === 'developmental'
            ? 'Rascunho'
            : this._calculateNumericReportCardStatus(subjects),
          responsibleNameSnapshot, // Salva o nome localizado!
          subjects,
          developmentalAssessments: evaluationMode === 'developmental'
            ? this._mergeDevelopmentalAssessments([], subjects)
            : [],
        });

        results.push(created);
        createdCount += 1;
        continue;
      }

      existingCount += 1;
      existingReportCard.minimumAverage = minimumAverage;
      existingReportCard.gradingType = evaluationMode;
      existingReportCard.evaluationMode = evaluationMode;
      // Atualiza o nome do responsável se estiver vazio ou caso o tutor tenha mudado
      existingReportCard.responsibleNameSnapshot = responsibleNameSnapshot;

      existingReportCard.subjects = this._mergeSubjects(
        existingReportCard.subjects || [],
        generatedSubjects,
        minimumAverage
      );

      existingReportCard.developmentalAssessments =
        evaluationMode === 'developmental'
          ? this._mergeDevelopmentalAssessments(
              existingReportCard.developmentalAssessments || [],
              existingReportCard.subjects || []
            )
          : [];

      existingReportCard.status = this._calculateReportCardStatus(existingReportCard);

      await existingReportCard.save();
      results.push(existingReportCard);
      updatedCount += 1;
    }

    console.log('[ReportCardsAPI][SyncResult]', {
      schoolId: String(schoolId),
      classId: String(classId),
      className: classData.name,
      termId: String(termId),
      schoolYear: Number(schoolYear),
      existing: existingCount,
      created: createdCount,
      updated: updatedCount,
      ignored: ignoredCount,
      total: results.length,
    });

    console.log(`--- [ReportCardService] Processamento concluído. Boletins gerados/atualizados: ${results.length} ---\n`);

    // Retorna populando o nome do aluno para o Flutter
    return await ReportCard.populate(results, [
      { path: 'studentId', select: 'name fullName full_name' }
    ]);
  }

  async ensureReportCardsForClassTerm(payload) {
    return this.generateClassReportCards(payload);
  }

  async getStudentReportCard({
    schoolId,
    classId,
    termId,
    schoolYear,
    studentId,
  }) {
    if (!schoolId || !classId || !termId || !schoolYear || !studentId) {
      throw this._createError(
        'schoolId, classId, termId, schoolYear e studentId são obrigatórios.',
        400
      );
    }

    const reportCard = await ReportCard.findOne({
      school_id: schoolId,
      classId,
      termId,
      schoolYear,
      studentId,
    })
      .populate('studentId')
      .populate('classId')
      .populate('termId')
      .populate('subjects.teacherId')
      .populate('releasedBy');

    if (!reportCard) {
      throw this._createError('Boletim não encontrado.', 404);
    }

    return reportCard;
  }

  async getReportCardById({ reportCardId, schoolId }) {
    if (!reportCardId || !schoolId) {
      throw this._createError('reportCardId e schoolId são obrigatórios.', 400);
    }

    const reportCard = await ReportCard.findOne({
      _id: reportCardId,
      school_id: schoolId,
    })
      .populate('studentId')
      .populate('classId')
      .populate('termId')
      .populate('subjects.teacherId')
      .populate('releasedBy');

    if (!reportCard) {
      throw this._createError('Boletim não encontrado.', 404);
    }

    return reportCard;
  }

  async updateTeacherSubjectScore({
    schoolId,
    reportCardId,
    subjectId,
    actor,
    score,
    testScore,
    activityScore,
    participationScore,
    observation,
    reason,
    expectedContext = {},
  }) {
    if (!schoolId || !reportCardId || !subjectId || !getActorId(actor)) {
      throw this._createError(
        'schoolId, reportCardId, subjectId e actor sao obrigatorios.',
        400
      );
    }

    let finalScore = null;
    let tScore = null;
    let aScore = null;
    let pScore = null;

    if (testScore !== undefined || activityScore !== undefined || participationScore !== undefined) {
      tScore = (testScore !== null && testScore !== '') ? Number(testScore) : null;
      aScore = (activityScore !== null && activityScore !== '') ? Number(activityScore) : null;
      pScore = (participationScore !== null && participationScore !== '') ? Number(participationScore) : null;

      if (
        (tScore !== null && Number.isNaN(tScore)) ||
        (aScore !== null && Number.isNaN(aScore)) ||
        (pScore !== null && Number.isNaN(pScore))
      ) {
        throw this._createError('As notas informadas devem ser valores numéricos válidos.', 400);
      }

      if (tScore !== null || aScore !== null || pScore !== null) {
        finalScore = (tScore || 0) + (aScore || 0) + (pScore || 0);
        
        if (finalScore > 10) {
          throw this._createError(`A soma das notas (Prova, Atividades, Participação) deu ${finalScore} e não pode ultrapassar 10.`, 400);
        }
      }
    } 
    else if (score !== undefined && score !== null && score !== '') {
      finalScore = Number(score);
      if (Number.isNaN(finalScore) || finalScore < 0 || finalScore > 10) {
        throw this._createError('A nota deve estar entre 0 e 10.', 400);
      }
    }

    if (finalScore === null) {
      throw this._createError('Nenhuma nota foi informada.', 400);
    }

    const reportCard = await ReportCard.findOne({
      _id: reportCardId,
      school_id: schoolId,
    });

    if (!reportCard) {
      throw this._createError('Boletim não encontrado.', 404);
    }

    this._validateExpectedContext(reportCard, expectedContext);

    const subjectIndex = this._findSubjectIndex(reportCard, subjectId, {
      actor,
      expectedTeacherId: expectedContext.expectedTeacherId,
    });

    if (subjectIndex === -1) {
      throw this._createError(
        'Disciplina nao encontrada neste boletim.',
        404
      );
    }

    if (subjectIndex === -2) {
      throw this._createError(
        'Mais de uma disciplina correspondente foi encontrada. Atualize a tela e tente novamente.',
        409
      );
    }

    const subjectEntry = reportCard.subjects[subjectIndex];
    this._assertCanEditSubject({ actor, reportCard, subjectEntry });

    const previousSnapshot = this._scoreSnapshot(subjectEntry);
    const isOverwrite =
      previousSnapshot.score !== null &&
      Number(previousSnapshot.score) !== Number(finalScore);
    const normalizedReason = String(reason || observation || '').trim();
    const editingComponents =
      testScore !== undefined ||
      activityScore !== undefined ||
      participationScore !== undefined;
    if (isOverwrite && !editingComponents && !normalizedReason) {
      throw this._createError(
        'Informe o motivo da alteração para substituir uma nota existente.',
        400
      );
    }

    if (editingComponents) {
      reportCard.subjects[subjectIndex].testScore = tScore;
      reportCard.subjects[subjectIndex].activityScore = aScore;
      reportCard.subjects[subjectIndex].participationScore = pScore;
    }
    reportCard.subjects[subjectIndex].score = finalScore;
    if (observation !== undefined) {
      reportCard.subjects[subjectIndex].observation = observation || '';
    }
    const changedAt = new Date();
    this._applyManualEditMetadata(
      reportCard.subjects[subjectIndex],
      actor,
      changedAt
    );
    
    reportCard.subjects[subjectIndex].status = this._calculateSubjectStatus(
      finalScore,
      reportCard.minimumAverage
    );

    reportCard.evaluationMode = 'numeric';
    reportCard.gradingType = 'numeric';
    reportCard.status = this._calculateReportCardStatus(reportCard);

    this._appendScoreHistory({
      subjectEntry: reportCard.subjects[subjectIndex],
      actor,
      source: 'manual_report_card_edit',
      reason: normalizedReason,
      previous: previousSnapshot,
      current: this._scoreSnapshot(reportCard.subjects[subjectIndex]),
      changedAt,
    });

    await reportCard.save();

    return reportCard;
  }

  async updateTeacherSubjectDevelopmentalAssessment({
    schoolId,
    reportCardId,
    subjectId,
    actor,
    criteria,
    generalObservation,
    expectedContext = {},
  }) {
    if (!schoolId || !reportCardId || !subjectId || !getActorId(actor)) {
      throw this._createError(
        'schoolId, reportCardId, subjectId e actor sao obrigatorios.',
        400
      );
    }

    const normalizedCriteria = this._normalizeDevelopmentalCriteria(criteria);

    const reportCard = await ReportCard.findOne({
      _id: reportCardId,
      school_id: schoolId,
    });

    if (!reportCard) {
      throw this._createError('Boletim nao encontrado.', 404);
    }

    this._validateExpectedContext(reportCard, expectedContext);

    const isRealSubjectId = mongoose.Types.ObjectId.isValid(subjectId);
    const defaultArea = getDefaultEarlyChildhoodArea(subjectId);

    const [classData, student, subject] = await Promise.all([
      ClassModel.findOne({ _id: reportCard.classId, school_id: schoolId }),
      Student.findOne({ _id: reportCard.studentId, school_id: schoolId }),
      isRealSubjectId
        ? Subject.findOne({ _id: subjectId, school_id: schoolId })
        : Promise.resolve(null),
    ]);

    if (!classData) {
      throw this._createError('Turma nao encontrada para esta escola.', 404);
    }
    if (!student) {
      throw this._createError('Aluno nao encontrado para esta escola.', 404);
    }
    if (evaluationModeForClass(classData) !== 'developmental') {
      throw this._createError(
        'Esta turma usa boletim numerico. Use o endpoint de notas.',
        400
      );
    }

    if (!subject && !defaultArea) {
      throw this._createError('Disciplina ou area infantil nao encontrada.', 404);
    }

    if (!isRealSubjectId && !isDefaultEarlyChildhoodAreaId(subjectId)) {
      throw this._createError('Area infantil invalida.', 400);
    }

    const subjectIndex = this._findDevelopmentalSubjectIndex(reportCard, subjectId, {
      actor,
      expectedTeacherId: expectedContext.expectedTeacherId,
    });

    if (subjectIndex === -1) {
      throw this._createError(
        'Disciplina ou area nao encontrada neste boletim.',
        404
      );
    }

    if (subjectIndex === -2) {
      throw this._createError(
        'Mais de uma area correspondente foi encontrada. Atualize a tela e tente novamente.',
        409
      );
    }

    reportCard.evaluationMode = 'developmental';
    reportCard.gradingType = 'developmental';

    const subjectEntry = reportCard.subjects[subjectIndex];
    this._assertCanEditSubject({ actor, reportCard, subjectEntry });
    const completionStatus = this._calculateDevelopmentalAssessmentCompletion(
      normalizedCriteria
    );
    const now = new Date();
    const areaId = subjectEntry.areaId || defaultArea?.areaId || '';

    const assessment = {
      subjectId: subjectEntry.subjectId || null,
      areaId,
      subjectName:
        subjectEntry.subjectNameSnapshot || subject?.name || defaultArea?.subjectName,
      teacherId: subjectEntry.teacherId || null,
      teacherName: subjectEntry.teacherNameSnapshot || '',
      criteria: normalizedCriteria,
      generalObservation: String(generalObservation || '').trim(),
      completionStatus,
      filledBy: getActorId(actor),
      filledAt: now,
      lastEditedBy: getActorId(actor),
      lastEditedAt: now,
      lastEditedRole: getPrimaryReportCardEditRole(actor),
      lastEditedSource: 'manual_report_card_edit',
    };

    const assessmentIndex = (reportCard.developmentalAssessments || []).findIndex(
      (item) => {
        const itemKey = item.areaId || item.subjectId;
        const assessmentKey = areaId || subjectId;
        const sameArea = String(itemKey || '') === String(assessmentKey || '');
        const teacherId = item.teacherId ? String(item.teacherId) : '';
        return sameArea && teacherId === String(extractId(subjectEntry.teacherId) || '');
      }
    );

    if (assessmentIndex === -1) {
      reportCard.developmentalAssessments.push(assessment);
    } else {
      reportCard.developmentalAssessments[assessmentIndex] = assessment;
    }
    reportCard.markModified('developmentalAssessments');

    reportCard.subjects[subjectIndex].observation = assessment.generalObservation;
    this._applyManualEditMetadata(reportCard.subjects[subjectIndex], actor, now);
    reportCard.subjects[subjectIndex].status =
      completionStatus === 'completed'
        ? 'Preenchido'
        : completionStatus === 'in_progress'
          ? 'Em Revisão'
          : 'Pendente';

    reportCard.status = this._calculateReportCardStatus(reportCard);

    await reportCard.save();

    return this.getReportCardById({ reportCardId, schoolId });
  }

  async recalculateReportCardStatus({ reportCardId, schoolId, actor }) {
    if (!reportCardId || !schoolId || !getActorId(actor)) {
      throw this._createError('reportCardId e schoolId são obrigatórios.', 400);
    }

    const reportCard = await ReportCard.findOne({
      _id: reportCardId,
      school_id: schoolId,
    });

    if (!reportCard) {
      throw this._createError('Boletim não encontrado.', 404);
    }

    const canRecalculate = (reportCard.subjects || []).some((subjectEntry) =>
      canEditReportCardSubject({
        actor,
        reportCard,
        subjectItem: subjectEntry,
      }).allowed
    );

    if (!canRecalculate) {
      throw this._createError(
        'Voce nao tem permissao para recalcular o status deste boletim.',
        403
      );
    }

    if (reportCard.evaluationMode === 'developmental') {
      reportCard.developmentalAssessments = (
        reportCard.developmentalAssessments || []
      ).map((item) => ({
        ...(item.toObject ? item.toObject() : item),
        completionStatus: this._calculateDevelopmentalAssessmentCompletion(
          item.criteria || []
        ),
      }));
    } else {
      reportCard.subjects = (reportCard.subjects || []).map((item) => ({
        ...(item.toObject ? item.toObject() : item),
        status: this._calculateSubjectStatus(
          item.score,
          reportCard.minimumAverage
        ),
      }));
    }

    reportCard.status = this._calculateReportCardStatus(reportCard);

    await reportCard.save();

    return reportCard;
  }
}

module.exports = new ReportCardService();
