const express = require('express');

const { verifyToken } = require('../middlewares/auth.middleware');
const { verifySchoolAccess } = require('../middlewares/schoolAccess.middleware');
const iconPackService = require('../services/iconPack.service');

const router = express.Router();

function handle(fn, fallbackMessage) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      if (res.headersSent) return undefined;
      return res.status(200).json(result);
    } catch (error) {
      const status = error.status || error.statusCode || 500;
      if (status >= 500) {
        console.error('[IconPack]', { code: error.code || null, message: error.message, stack: error.stack });
      }
      return res.status(status).json({
        message: status >= 500 ? fallbackMessage : (error.message || fallbackMessage),
        code: error.code || 'ICON_PACK_ERROR',
      });
    }
  };
}

router.use(verifyToken, verifySchoolAccess);

router.get('/', handle((req) => iconPackService.list(req.query), 'Erro ao listar ícones.'));

router.get('/info', handle(() => iconPackService.getInfo(), 'Erro ao carregar o pacote de ícones.'));

router.get('/:iconId/svg', handle((req, res) => {
  const svg = iconPackService.getSvg(req.params.iconId);
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
  res.status(200).send(svg);
}, 'Erro ao carregar ícone.'));

module.exports = router;
