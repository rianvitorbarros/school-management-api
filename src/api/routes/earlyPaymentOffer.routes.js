const router = require('express').Router();
const controller = require('../controllers/earlyPaymentOffer.controller');
const { verifyToken } = require('../middlewares/auth.middleware');
const { verifyGuardianToken } = require('../middlewares/guardianAuth.middleware');

// Público: link de matrícula web
router.get('/public/early-payment-offers/:schoolId', controller.publicList);
router.get('/public/early-payment-offers/:schoolId/:offerId/simulate', controller.publicSimulate);
router.post('/public/early-payment-offers/:schoolId/:offerId/adhesions', controller.publicAdhesion);

// Portal do responsável: rematrícula
router.get('/guardian/early-payment-offers', verifyGuardianToken, controller.guardianList);
router.post('/guardian/early-payment-offers/:offerId/adhesions', verifyGuardianToken, controller.guardianAdhesion);

// Gestão
router.get('/early-payment-offers', verifyToken, controller.list);
router.post('/early-payment-offers', verifyToken, controller.create);
router.patch('/early-payment-offers/:id', verifyToken, controller.update);
router.delete('/early-payment-offers/:id', verifyToken, controller.remove);
router.post('/early-payment-offers/:id/status', verifyToken, controller.setStatus);
router.get('/early-payment-offers/:id/adhesions', verifyToken, controller.adhesions);
router.post('/early-payment-offers/:id/adhesions', verifyToken, controller.addAdhesion);
router.patch('/early-payment-adhesions/:id', verifyToken, controller.updateAdhesion);

module.exports = router;
