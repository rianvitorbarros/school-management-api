const router = require('express').Router();
const controller = require('../controllers/reEnrollment.controller');
const { verifyToken } = require('../middlewares/auth.middleware');
const { verifyGuardianToken } = require('../middlewares/guardianAuth.middleware');

router.get('/guardian/re-enrollments/eligibility', verifyGuardianToken, controller.guardianEligibility);
router.post('/guardian/re-enrollments', verifyGuardianToken, controller.createGuardianRequest);

router.use('/re-enrollment-periods', verifyToken);
router.get('/re-enrollment-periods', controller.listPeriods);
router.post('/re-enrollment-periods', controller.createPeriod);
router.get('/re-enrollment-periods/:id', controller.getPeriod);
router.patch('/re-enrollment-periods/:id', controller.updatePeriod);
router.post('/re-enrollment-periods/:id/activate', controller.activatePeriod);
router.post('/re-enrollment-periods/:id/close', controller.closePeriod);

router.use('/academic-progressions', verifyToken);
router.get('/academic-progressions', controller.listProgressions);
router.post('/academic-progressions', controller.createProgression);
router.patch('/academic-progressions/:id', controller.updateProgression);
router.post('/academic-progressions/:id/deactivate', controller.deactivateProgression);

router.get('/admin/re-enrollment/readiness', verifyToken, controller.readiness);

router.use('/re-enrollment-requests', verifyToken);
router.get('/re-enrollment-requests', controller.listAdmin);
router.get('/re-enrollment-requests/:id', controller.getAdmin);
router.post('/re-enrollment-requests/:id/approve', controller.approve);
router.post('/re-enrollment-requests/:id/reject', controller.reject);
router.post('/re-enrollment-requests/:id/effectivate', controller.effectivate);

module.exports = router;
