const service = require('../services/classOccupancy.service');

function authorize(req) {
  const roles = [...(req.user?.roles || []), req.user?.role].filter(Boolean).map(r => String(r).toLowerCase());
  return roles.some(r => ['admin', 'coordenador', 'staff'].includes(r));
}
async function get(req, res) {
  if (!authorize(req)) return res.status(403).json({ message: 'Sem permissão para consultar a ocupação de turmas.' });
  try {
    const data = await service.load(req.user.school_id || req.user.schoolId, req.query.academicYear);
    if (req.params.classId) {
      const row = data.rows.find(r => r.id === req.params.classId);
      if (!row) return res.status(404).json({ message: 'Turma não encontrada neste ano e escola.' });
      return res.json({ confirmed: row.confirmedStudents, pending: row.pendingStudents });
    }
    // Personal data is requested only when opening a class roster.
    return res.json({ ...data, rows: data.rows.map(({ confirmedStudents, pendingStudents, ...row }) => row) });
  } catch (e) { return res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : 'Não foi possível consultar a ocupação. Tente novamente.' }); }
}
module.exports = { get, authorize };
