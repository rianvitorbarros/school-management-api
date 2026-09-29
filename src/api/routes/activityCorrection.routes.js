const express = require('express');

const { verifyToken } = require('../middlewares/auth.middleware');
const { verifySchoolAccess } = require('../middlewares/schoolAccess.middleware');
const activityCorrectionService = require('../services/activityCorrection.service');

const router = express.Router();

router.use(verifyToken, verifySchoolAccess);

router.post('/activity-corrections/resolve', async (req, res) => {
  try {
    const schoolId = req.user.school_id || req.user.schoolId;
    const result = await activityCorrectionService.resolveQr({
      schoolId,
      actor: req.user,
      qrCodePayload: req.body?.qrCodePayload,
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || error.statusCode || 500).json({
      message: error.message || 'Erro ao resolver QR Code da atividade.',
      code: error.code || 'ACTIVITY_CORRECTION_ERROR',
    });
  }
});

router.post('/activity-corrections', async (req, res) => {
  try {
    const schoolId = req.user.school_id || req.user.schoolId;
    const result = await activityCorrectionService.createCorrection({
      schoolId,
      actor: req.user,
      payload: req.body,
    });

    return res.status(201).json(result);
  } catch (error) {
    return res.status(error.status || error.statusCode || 500).json({
      message: error.message || 'Erro ao salvar correcao da atividade.',
      code: error.code || 'ACTIVITY_CORRECTION_ERROR',
    });
  }
});

router.patch('/activity-corrections/:correctionId', async (req, res) => {
  try {
    const schoolId = req.user.school_id || req.user.schoolId;
    const result = await activityCorrectionService.updateCorrection({
      schoolId,
      actor: req.user,
      correctionId: req.params.correctionId,
      payload: req.body,
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || error.statusCode || 500).json({
      message: error.message || 'Erro ao atualizar correcao da atividade.',
      code: error.code || 'ACTIVITY_CORRECTION_ERROR',
    });
  }
});

router.get('/activity-corrections/pending', async (req, res) => {
  try {
    const schoolId = req.user.school_id || req.user.schoolId;
    const result = await activityCorrectionService.listPendingCorrections({
      schoolId,
      actor: req.user,
      filters: req.query,
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || error.statusCode || 500).json({
      message: error.message || 'Erro ao listar pendencias de correcao.',
      code: error.code || 'ACTIVITY_CORRECTION_ERROR',
    });
  }
});

router.get('/activity-corrections/print-runs', async (req, res) => {
  try {
    const schoolId = req.user.school_id || req.user.schoolId;
    const result = await activityCorrectionService.listPrintRunsForCorrection({
      schoolId,
      actor: req.user,
      filters: req.query,
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || error.statusCode || 500).json({
      message: error.message || 'Erro ao listar atividades impressas para correcao.',
      code: error.code || 'ACTIVITY_CORRECTION_ERROR',
    });
  }
});

router.get('/activity-corrections', async (req, res) => {
  try {
    const schoolId = req.user.school_id || req.user.schoolId;
    const result = await activityCorrectionService.listCorrections({
      schoolId,
      actor: req.user,
      filters: req.query,
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || error.statusCode || 500).json({
      message: error.message || 'Erro ao listar correcoes de atividades.',
      code: error.code || 'ACTIVITY_CORRECTION_ERROR',
    });
  }
});

router.get('/students/:studentId/activity-corrections', async (req, res) => {
  try {
    const schoolId = req.user.school_id || req.user.schoolId;
    const result = await activityCorrectionService.listStudentCorrections({
      schoolId,
      actor: req.user,
      studentId: req.params.studentId,
      filters: req.query,
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || error.statusCode || 500).json({
      message: error.message || 'Erro ao listar correcoes do aluno.',
      code: error.code || 'ACTIVITY_CORRECTION_ERROR',
    });
  }
});

module.exports = router;
