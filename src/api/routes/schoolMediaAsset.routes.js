const express = require('express');
const multer = require('multer');

const { verifyToken } = require('../middlewares/auth.middleware');
const { verifySchoolAccess } = require('../middlewares/schoolAccess.middleware');
const mediaAssetService = require('../services/mediaAsset.service');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
}).single('file');

function runUpload(req, res, next) {
  upload(req, res, (error) => {
    if (!error) return next();
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      message: tooLarge ? 'Imagem acima de 8 MB.' : (error.message || 'Upload invalido.'),
      code: error.code || 'MEDIA_ASSET_UPLOAD_ERROR',
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
      if (status >= 500) console.error('[MediaAsset]', {
          code: error.code || null,
          status,
          message: error.message,
          cause: error.cause && !error.cause.config ? error.cause : undefined,
          stack: error.stack,
        });
      return res.status(status).json({
        message: status >= 500 && !error.code ? fallbackMessage : (error.message || fallbackMessage),
        code: error.code || 'MEDIA_ASSET_ERROR',
      });
    }
  };
}

function sendImage(thumbnail) {
  return handle(async (req, res) => {
    const { buffer, contentType } = await mediaAssetService.getContent(
      req.params.assetId,
      req.user,
      { thumbnail }
    );
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.status(200).send(buffer);
  }, 'Erro ao carregar imagem.');
}

router.use(verifyToken, verifySchoolAccess);

router.get('/', handle(
  (req) => mediaAssetService.listAssets(req.user, req.query),
  'Erro ao listar o acervo de imagens.'
));

router.get('/ai/quota', handle(
  (req) => mediaAssetService.getAiQuota(req.user),
  'Erro ao consultar o limite da Iara.'
));

router.post('/ai/generate', handle(
  (req) => mediaAssetService.generateWithAi(req.user, req.body || {}),
  'Erro ao gerar imagem com a Iara.',
  201
));

// Recria o desenho de uma imagem de referencia (campo multipart `file`).
router.post('/ai/generate-from-reference', runUpload, handle(
  (req) => mediaAssetService.generateFromReference(req.user, req.file, req.body || {}),
  'Erro ao gerar imagem com a Iara.',
  201
));

router.post('/', runUpload, handle(
  (req) => mediaAssetService.uploadAsset(req.user, req.file, req.body || {}),
  'Erro ao enviar imagem.',
  201
));

router.get('/:assetId', handle(
  (req) => mediaAssetService.getAsset(req.params.assetId, req.user),
  'Erro ao carregar imagem.'
));

router.patch('/:assetId', handle(
  (req) => mediaAssetService.updateAsset(req.params.assetId, req.user, req.body || {}),
  'Erro ao atualizar imagem.'
));

router.delete('/:assetId', handle(
  (req) => mediaAssetService.archiveAsset(req.params.assetId, req.user),
  'Erro ao remover imagem.'
));

router.get('/:assetId/content', sendImage(false));
router.get('/:assetId/thumbnail', sendImage(true));

module.exports = router;
