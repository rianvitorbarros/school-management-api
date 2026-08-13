const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { verifyTokenOptional } = require('../middlewares/auth.middleware');

router.post('/login', authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', verifyTokenOptional, authController.logout);

module.exports = router;
