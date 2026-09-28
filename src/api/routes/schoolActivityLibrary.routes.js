const express = require('express');

const { verifyToken } = require('../middlewares/auth.middleware');
const { verifySchoolAccess } = require('../middlewares/schoolAccess.middleware');
const activityLibraryService = require('../services/activityLibrary.service');
const activityPrintService = require('../services/activityPrint.service');

const router = express.Router();

router.use(verifyToken, verifySchoolAccess);

router.get('/', async (req, res) => {
  try {
    const schoolId = req.user.school_id || req.user.schoolId;
    const result = await activityLibraryService.listSchoolLibrary(schoolId, req.query);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || error.statusCode || 500).json({
      message: error.message || 'Erro ao listar biblioteca de atividades.',
      code: error.code || 'SCHOOL_ACTIVITY_LIBRARY_ERROR',
    });
  }
});

router.get('/books/:bookId/download-url', async (req, res) => {
  try {
    const schoolId = req.user.school_id || req.user.schoolId;
    const expiresIn = Number.parseInt(req.query?.expiresIn, 10) || 300;
    const result = await activityLibraryService.getSchoolBookDownloadUrl(
      schoolId,
      req.params.bookId,
      expiresIn,
    );

    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || error.statusCode || 500).json({
      message: error.message || 'Erro ao obter PDF original do caderno.',
      code: error.code || 'SCHOOL_ACTIVITY_LIBRARY_ERROR',
    });
  }
});

router.post('/:activityPageId/print', async (req, res) => {
  try {
    const result = await activityPrintService.createPrintRun({
      activityPageId: req.params.activityPageId,
      payload: req.body,
      actor: req.user,
    });

    return res.status(201).json(result);
  } catch (error) {
    return res.status(error.status || error.statusCode || 500).json({
      message: error.message || 'Erro ao gerar impressao da atividade.',
      code: error.code || 'ACTIVITY_PRINT_ERROR',
    });
  }
});

router.post('/:activityPageId/preview', async (req, res) => {
  try {
    const pdf = await activityPrintService.createPreviewPdf({
      activityPageId: req.params.activityPageId,
      payload: req.body,
      actor: req.user,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).send(pdf);
  } catch (error) {
    return res.status(error.status || error.statusCode || 500).json({
      message: error.message || 'Erro ao gerar pre-visualizacao da atividade.',
      code: error.code || 'ACTIVITY_PREVIEW_ERROR',
    });
  }
});

module.exports = router;
