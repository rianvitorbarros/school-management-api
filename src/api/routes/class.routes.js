const express = require('express');

const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
const ClassController = require('../controllers/class.controller');
const studentController = require('../controllers/student.controller');
const classActivityController = require('../controllers/classActivity.controller');

router.post('/', authMiddleware.verifyToken, ClassController.create);
router.get('/', authMiddleware.verifyToken, ClassController.getAll);
router.get('/occupancy', authMiddleware.verifyToken, require('../controllers/classOccupancy.controller').get);
router.get('/occupancy/:classId/students', authMiddleware.verifyToken, require('../controllers/classOccupancy.controller').get);
router.post(
  '/:classId/activities',
  authMiddleware.verifyToken,
  classActivityController.createForClass
);
router.get(
  '/:classId/activities',
  authMiddleware.verifyToken,
  classActivityController.listByClass
);
router.get(
  '/:classId/students/:studentId/teacher-summary',
  authMiddleware.verifyToken,
  studentController.getTeacherSummary
);
router.get('/:id', authMiddleware.verifyToken, ClassController.getById);
router.patch('/:id', authMiddleware.verifyToken, ClassController.update);
router.delete('/:id', authMiddleware.verifyToken, ClassController.delete);

module.exports = router;
