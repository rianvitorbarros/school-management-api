const express = require('express');
const multer = require('multer');

const { verifyToken } = require('../middlewares/auth.middleware');
const { verifySchoolAccess } = require('../middlewares/schoolAccess.middleware');
const activityDesignService = require('../services/activityDesign.service');

const router = express.Router();

const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
}).single('file');

const publishUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20, fieldSize: 2 * 1024 * 1024 },
}).array('pages', 20);

function runUpload(middleware) {
  return (req, res, next) => middleware(req, res, (error) => {
    if (!error) return next();
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      message: tooLarge ? 'Arquivo acima do tamanho permitido.' : (error.message || 'Upload invalido.'),
      code: error.code || 'ACTIVITY_DESIGN_UPLOAD_ERROR',
    });
  });
}

function handle(fn, fallbackMessage, successStatus = 200) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      if (res.headersSent) return undefined;
      return res.status(successStatus).json(result);
    } catch (error) {
      const status = error.status || error.statusCode || 500;
      if (status >= 500) {
        console.error('[ActivityDesign]', {
          code: error.code || null,
          status,
          message: error.message,
          cause: error.cause && !error.cause.config ? error.cause : undefined,
          stack: error.stack,
        });
      }
      return res.status(status).json({
        message: status >= 500 ? fallbackMessage : (error.message || fallbackMessage),
        code: error.code || 'ACTIVITY_DESIGN_ERROR',
      });
    }
  };
}

router.use(verifyToken, verifySchoolAccess);

router.get('/config', handle(
  () => activityDesignService.getEditorConfig(),
  'Erro ao carregar configuracao do editor.'
));

router.get('/', handle(
  (req) => activityDesignService.listDesigns(req.user, req.query),
  'Erro ao listar atividades criadas.'
));

router.post('/', handle(
  (req) => activityDesignService.createDesign(req.user, req.body || {}),
  'Erro ao criar atividade.',
  201
));

router.get('/:designId', handle(
  (req) => activityDesignService.getDesign(req.params.designId, req.user),
  'Erro ao carregar atividade.'
));

router.put('/:designId', handle(
  (req) => activityDesignService.updateDesign(req.params.designId, req.user, req.body || {}),
  'Erro ao salvar atividade.'
));

router.post('/:designId/duplicate', handle(
  (req) => activityDesignService.duplicateDesign(req.params.designId, req.user),
  'Erro ao duplicar atividade.',
  201
));

router.delete('/:designId', handle(
  (req) => activityDesignService.archiveDesign(req.params.designId, req.user),
  'Erro ao arquivar atividade.'
));

router.post('/:designId/assets', runUpload(assetUpload), handle(
  (req) => activityDesignService.uploadAsset(req.params.designId, req.user, req.file),
  'Erro ao enviar imagem.',
  201
));

router.post('/:designId/assets/from-library', handle(
  (req) => activityDesignService.attachLibraryAsset(
    req.params.designId,
    req.user,
    req.body?.mediaAssetId
  ),
  'Erro ao adicionar imagem do acervo.',
  201
));

router.post('/:designId/assets/from-icon', handle(async (req) => {
  // eslint-disable-next-line global-require
  const iconPackService = require('../services/iconPack.service');
  const media = await iconPackService.ensureMediaAsset(req.body?.iconId);
  return activityDesignService.attachLibraryAsset(req.params.designId, req.user, String(media._id));
}, 'Erro ao adicionar ícone.', 201));

router.get('/:designId/assets/:assetId/content', handle(async (req, res) => {
  const { buffer, contentType } = await activityDesignService.getAssetContent(
    req.params.designId,
    req.params.assetId,
    req.user
  );
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  res.status(200).send(buffer);
}, 'Erro ao carregar imagem.'));

router.post('/:designId/publish', runUpload(publishUpload), handle(
  (req) => activityDesignService.publishDesign(req.params.designId, req.user, {
    files: req.files || [],
    revision: req.body?.revision,
  }),
  'Erro ao publicar atividade.'
));

module.exports = router;
