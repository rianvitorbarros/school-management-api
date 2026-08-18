const crypto = require('crypto');
const reportCardService = require('../services/reportCard.service');
const reportCardHistoryService = require('../services/reportCardHistory.service');
const reportCardExamImportService = require('../services/reportCardExamImport.service');

class ReportCardController {
  async generateClassReportCards(req, res, next) {
    try {
      const schoolId =
        req.user?.school_id ||
        req.user?.schoolId ||
        req.school_id ||
        req.schoolId ||
        req.body.schoolId;

      const { classId, termId, schoolYear } = req.body;

      const result = await reportCardService.generateClassReportCards({
        schoolId,
        classId,
        termId,
        schoolYear,
      });

      return res.status(201).json({
        success: true,
        message: 'Boletins da turma sincronizados com sucesso.',
        data: result,
      });
    } catch (error) {
      console.error('[ReportCardController.generateClassReportCards] Erro:', error);
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Erro interno ao gerar os boletins da turma.',
        details: error.toString()
      });
    }
  }

  async getStudentReportCard(req, res, next) {
    try {
      const schoolId =
        req.user?.school_id ||
        req.user?.schoolId ||
        req.school_id ||
        req.schoolId ||
        req.query.schoolId;

      const { classId, termId, schoolYear, studentId } = req.query;

      const result = await reportCardService.getStudentReportCard({
        schoolId,
        classId,
        termId,
        schoolYear,
        studentId,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('[ReportCardController.getStudentReportCard] Erro:', error);
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Erro interno ao buscar o boletim do aluno.',
        details: error.toString()
      });
    }
  }

  async getStudentHistory(req, res, next) {
    try {
      const schoolId =
        req.user?.school_id ||
        req.user?.schoolId;

      const { studentId, schoolYear } = req.query;

      const result = await reportCardHistoryService.getStudentHistory({
        schoolId,
        studentId,
        schoolYear,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('[ReportCardController.getStudentHistory] Erro:', error);
      return res.status(error.statusCode || 500).json({
        success: false,
        message:
          error.message ||
          'Erro interno ao buscar o historico escolar do aluno.',
        details: error.toString()
      });
    }
  }

  async getReportCardById(req, res, next) {
    try {
      const schoolId =
        req.user?.school_id ||
        req.user?.schoolId ||
        req.school_id ||
        req.schoolId ||
        req.query.schoolId;

      const { reportCardId } = req.params;

      const result = await reportCardService.getReportCardById({
        reportCardId,
        schoolId,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('[ReportCardController.getReportCardById] Erro:', error);
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Erro interno ao buscar o boletim pelo ID.',
        details: error.toString()
      });
    }
  }

  async updateTeacherSubjectScore(req, res, next) {
    try {
      const schoolId =
        req.user?.school_id ||
        req.user?.schoolId;

      const { reportCardId, subjectId } = req.params;
      const {
        score,
        testScore,
        activityScore,
        participationScore,
        observation,
        reason,
        expectedTermId,
        expectedSchoolYear,
        expectedClassId,
        expectedStudentId,
        expectedTeacherId,
      } = req.body;

      const result = await reportCardService.updateTeacherSubjectScore({
        schoolId,
        reportCardId,
        subjectId,
        actor: req.user,
        score,
        testScore,
        activityScore,
        participationScore,
        observation,
        reason,
        expectedContext: {
          expectedTermId,
          expectedSchoolYear,
          expectedClassId,
          expectedStudentId,
          expectedTeacherId,
        },
      });

      return res.status(200).json({
        success: true,
        message: 'Nota lançada com sucesso.',
        data: result,
      });
    } catch (error) {
      console.error('[ReportCardController.updateTeacherSubjectScore] Erro:', error);
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Erro interno ao lançar a nota.',
        details: error.toString()
      });
    }
  }

  async updateTeacherSubjectDevelopmentalAssessment(req, res, next) {
    try {
      const schoolId =
        req.user?.school_id ||
        req.user?.schoolId;

      const { reportCardId, subjectId } = req.params;
      const {
        criteria,
        generalObservation,
        expectedTermId,
        expectedSchoolYear,
        expectedClassId,
        expectedStudentId,
        expectedTeacherId,
      } = req.body;

      const result =
        await reportCardService.updateTeacherSubjectDevelopmentalAssessment({
          schoolId,
          reportCardId,
          subjectId,
          actor: req.user,
          criteria,
          generalObservation,
          expectedContext: {
            expectedTermId,
            expectedSchoolYear,
            expectedClassId,
            expectedStudentId,
            expectedTeacherId,
          },
        });

      return res.status(200).json({
        success: true,
        message: 'Avaliacao descritiva salva com sucesso.',
        data: result,
      });
    } catch (error) {
      console.error(
        '[ReportCardController.updateTeacherSubjectDevelopmentalAssessment] Erro:',
        error
      );
      return res.status(error.statusCode || 500).json({
        success: false,
        message:
          error.message ||
          'Erro interno ao salvar a avaliacao descritiva do boletim.',
        details: error.toString()
      });
    }
  }

  async recalculateReportCardStatus(req, res, next) {
    try {
      const schoolId =
        req.user?.school_id ||
        req.user?.schoolId;

      const { reportCardId } = req.params;

      const result = await reportCardService.recalculateReportCardStatus({
        reportCardId,
        schoolId,
        actor: req.user,
      });

      return res.status(200).json({
        success: true,
        message: 'Status do boletim recalculado com sucesso.',
        data: result,
      });
    } catch (error) {
      console.error('[ReportCardController.recalculateReportCardStatus] Erro:', error);
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Erro interno ao recalcular o status do boletim.',
        details: error.toString()
      });
    }
  }

  async listImportableExams(req, res, next) {
    const startedAt = Date.now();
    const requestId = req.headers['x-request-id'] || req.query.requestId || crypto.randomUUID();
    const perfEnabled = ['true', '1', 'yes', 'sim'].includes(String(req.query.perf || process.env.EXAM_PERF_DEBUG || '').toLowerCase());
    try {
      const schoolId =
        req.user?.school_id ||
        req.user?.schoolId ||
        req.school_id ||
        req.schoolId ||
        req.query.schoolId;

      if (perfEnabled) {
        console.log('[ExamPerfAPI][RequestStart]', {
          requestId,
          endpoint: 'exam_list',
          method: req.method,
          path: req.path,
          query: {
            classId: req.query.classId,
            termId: req.query.termId,
            subjectId: req.query.subjectId || null,
          },
          schoolId: String(schoolId || ''),
          teacherId: String(req.user?._id || req.user?.id || ''),
        });
      }

      const result = await reportCardExamImportService.listImportableExams({
        schoolId,
        actor: req.user,
        classId: req.query.classId,
        subjectId: req.query.subjectId || null,
        termId: req.query.termId || null,
        requestId,
        perfEnabled,
      });

      const payload = {
        success: true,
        data: result,
      };
      if (perfEnabled) {
        console.log('[ExamPerfAPI][RequestEnd]', {
          requestId,
          endpoint: 'exam_list',
          method: req.method,
          path: req.path,
          status: 200,
          durationMs: Date.now() - startedAt,
          responseBytes: Buffer.byteLength(JSON.stringify(payload)),
          examCount: Array.isArray(result) ? result.length : null,
        });
      }

      return res.status(200).json(payload);
    } catch (error) {
      console.error('[ReportCardController.listImportableExams] Erro:', error);
      const status = error.statusCode || 500;
      const payload = {
        success: false,
        message: error.message || 'Erro interno ao listar provas disponiveis.',
        details: error.toString()
      };
      if (perfEnabled) {
        console.log('[ExamPerfAPI][RequestEnd]', {
          requestId,
          endpoint: 'exam_list',
          method: req.method,
          path: req.path,
          status,
          durationMs: Date.now() - startedAt,
          responseBytes: Buffer.byteLength(JSON.stringify(payload)),
        });
      }
      return res.status(status).json(payload);
    }
  }

  async previewExamImport(req, res, next) {
    const startedAt = Date.now();
    const requestId = req.headers['x-request-id'] || req.query.requestId || crypto.randomUUID();
    const perfEnabled = ['true', '1', 'yes', 'sim'].includes(String(req.query.perf || process.env.EXAM_PERF_DEBUG || '').toLowerCase());
    try {
      const schoolId =
        req.user?.school_id ||
        req.user?.schoolId ||
        req.school_id ||
        req.schoolId ||
        req.query.schoolId;

      if (perfEnabled) {
        console.log('[ExamPerfAPI][RequestStart]', {
          requestId,
          endpoint: 'exam_preview',
          method: req.method,
          path: req.path,
          query: {
            examId: req.params.examId,
            classId: req.query.classId,
            termId: req.query.termId,
            subjectId: req.query.subjectId,
            scoreMode: req.query.scoreMode || 'raw',
          },
          schoolId: String(schoolId || ''),
          teacherId: String(req.user?._id || req.user?.id || ''),
        });
      }

      const result = await reportCardExamImportService.previewExamImport({
        schoolId,
        actor: req.user,
        examId: req.params.examId,
        classId: req.query.classId,
        subjectId: req.query.subjectId,
        termId: req.query.termId,
        academicYearId: req.query.targetAcademicYearId || req.query.academicYearId || null,
        scoreMode: req.query.scoreMode || 'raw',
        requestId,
        perfEnabled,
      });

      const payload = {
        success: true,
        data: result,
      };
      if (perfEnabled) {
        console.log('[ExamPerfAPI][RequestEnd]', {
          requestId,
          endpoint: 'exam_preview',
          method: req.method,
          path: req.path,
          status: 200,
          durationMs: Date.now() - startedAt,
          responseBytes: Buffer.byteLength(JSON.stringify(payload)),
        });
      }

      return res.status(200).json(payload);
    } catch (error) {
      console.error('[ReportCardController.previewExamImport] Erro:', error);
      const status = error.statusCode || 500;
      const payload = {
        success: false,
        message: error.message || 'Erro interno ao preparar preview de importacao.',
        details: error.toString()
      };
      if (perfEnabled) {
        console.log('[ExamPerfAPI][RequestEnd]', {
          requestId,
          endpoint: 'exam_preview',
          method: req.method,
          path: req.path,
          status,
          durationMs: Date.now() - startedAt,
          responseBytes: Buffer.byteLength(JSON.stringify(payload)),
        });
      }
      return res.status(status).json(payload);
    }
  }

  async commitExamImport(req, res, next) {
    try {
      const schoolId =
        req.user?.school_id ||
        req.user?.schoolId ||
        req.school_id ||
        req.schoolId ||
        req.body.schoolId;

      const result = await reportCardExamImportService.commitExamImport({
        schoolId,
        actor: req.user,
        examId: req.params.examId,
        classId: req.body.classId,
        subjectId: req.body.subjectId,
        termId: req.body.termId,
        academicYearId: req.body.targetAcademicYearId || req.body.academicYearId || null,
        selectedStudentIds: req.body.selectedStudentIds || null,
        conflictDecisions: req.body.conflictDecisions || {},
        reason: req.body.reason || '',
        scoreMode: req.body.scoreMode || 'raw',
      });

      return res.status(200).json({
        success: true,
        message: 'Importacao de notas da prova concluida.',
        data: result,
      });
    } catch (error) {
      console.error('[ReportCardController.commitExamImport] Erro:', error);
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Erro interno ao importar notas da prova.',
        details: error.toString()
      });
    }
  }
}

module.exports = new ReportCardController();
