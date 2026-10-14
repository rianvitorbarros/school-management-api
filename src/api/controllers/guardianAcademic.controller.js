const service = require('../services/guardianAcademic.service');
exports.getPerformance = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    return res.json(await service.getPerformance({ schoolId: req.guardian?.schoolId || req.guardian?.school_id,
      accountId: req.guardian?.accountId, studentId: req.params.studentId }));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'Não foi possível consultar as notas.' });
  }
};
