const express = require('express');

const guardianAuthController = require('../controllers/guardianAuth.controller');
const { verifyToken } = require('../middlewares/auth.middleware');
const { verifyGuardianToken } = require('../middlewares/guardianAuth.middleware');

const router = express.Router();

router.post(
  '/guardian-auth/first-access/start',
  guardianAuthController.startFirstAccess
);
router.post(
  '/guardian-auth/first-access/verify-responsible',
  guardianAuthController.verifyResponsible
);
router.post(
  '/guardian-auth/first-access/set-pin',
  guardianAuthController.setPin
);
router.post(
  '/guardian-auth/first-access/link-existing-account',
  guardianAuthController.linkExistingAccount
);
router.post(
  '/guardian-auth/pin-recovery/start',
  guardianAuthController.startPinRecovery
);
router.post(
  '/guardian-auth/pin-recovery/complete',
  guardianAuthController.completePinRecovery
);
router.post('/guardian-auth/login', guardianAuthController.login);
router.get(
  '/guardian-auth/portal/home',
  verifyGuardianToken,
  guardianAuthController.getGuardianPortalHome
);
router.get(
  '/guardian-auth/students/:studentId/schedule',
  verifyGuardianToken,
  guardianAuthController.getGuardianSchedule
);
router.get(
  '/guardian-auth/students/:studentId/attendance',
  verifyGuardianToken,
  guardianAuthController.getGuardianAttendance
);
router.get(
  '/guardian-auth/students/:studentId/activities',
  verifyGuardianToken,
  guardianAuthController.getGuardianActivities
);
router.get(
  '/guardian-auth/invoices',
  verifyGuardianToken,
  guardianAuthController.listGuardianInvoices
);
router.post(
  '/guardian-auth/invoices/batch-print',
  verifyGuardianToken,
  guardianAuthController.batchPrintGuardianInvoices
);

router.get(
  '/students/:studentId/guardian-accesses',
  verifyToken,
  guardianAuthController.listStudentGuardianAccesses
);

router.post(
  '/guardian-access-accounts/:accountId/reset-pin',
  verifyToken,
  guardianAuthController.resetPin
);
router.post('/guardian-access-accounts/:accountId/temporary-access', verifyToken, guardianAuthController.createTemporaryAccess);
router.post('/guardian-access-accounts/:accountId/temporary-access/revoke', verifyToken, guardianAuthController.revokeTemporaryAccess);
router.get(
  '/guardian-access-accounts/:accountId/events',
  verifyToken,
  guardianAuthController.listGuardianAccessEvents
);
router.post(
  '/guardian-access-accounts/:accountId/unlock',
  verifyToken,
  guardianAuthController.unlockAccount
);
router.post(
  '/guardian-access-accounts/:accountId/deactivate',
  verifyToken,
  guardianAuthController.deactivateAccount
);
router.post(
  '/guardian-access-accounts/:accountId/reactivate',
  verifyToken,
  guardianAuthController.reactivateAccount
);

module.exports = router;
