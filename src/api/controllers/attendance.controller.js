const attendanceService = require('../services/attendance.service');
const appEmitter = require('../../loaders/eventEmitter');
const User = require('../models/user.model');
const admin = require('../../config/firebase');

function sendAttendanceError(res, error, fallbackMessage) {
  const statusCode = error.statusCode || (error.name === 'CastError' ? 400 : 500);
  const message = error.message || fallbackMessage;
  return res.status(statusCode).json({
    code: error.code || null,
    message,
    ...(error.firstAttendanceDate ? { firstAttendanceDate: error.firstAttendanceDate } : {}),
    ...(error.serverVersion != null ? { serverVersion: error.serverVersion } : {}),
    ...(error.serverAttendance ? { serverAttendance: error.serverAttendance } : {}),
  });
}

exports.saveAttendance = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const teacherId = req.user.id;
    const teacherName = req.user.fullName || 'Professor';

    const attendanceData = {
      ...req.body,
      schoolId,
      teacherId
    };

    const result = await attendanceService.createOrUpdate(attendanceData, req.user);

    if (result?.sync?.status !== 'duplicate') appEmitter.emit('attendance_updated', {
      classId: req.body.classId,
      school_id: schoolId,
      date: result?.date || req.body.date || null
    });

    if (result?.sync?.status !== 'duplicate') try {
      const managers = await User.find({
        school_id: schoolId,
        roles: { $in: ['Admin', 'Coordenador'] },
        fcmToken: { $exists: true, $ne: [] }
      }).select('fcmToken');

      const tokens = managers.flatMap((user) => user.fcmToken || []);

      if (tokens.length > 0) {
        const message = {
          notification: {
            title: 'Chamada Realizada ✅',
            body: `${teacherName} finalizou a chamada da turma.`
          },
          data: {
            type: 'ATTENDANCE_COMPLETED',
            classId: String(req.body.classId),
            teacherId: String(teacherId),
            date: String(result?.date || req.body.date || '')
          },
          tokens
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`✅ Push enviado: ${response.successCount} sucessos, ${response.failureCount} falhas.`);
      }
    } catch (pushError) {
      console.error('⚠️ Erro ao enviar Push Notification (Não crítico):', pushError);
    }

    return res.status(200).json({
      message: 'Chamada salva com sucesso!',
      data: result
    });
  } catch (error) {
    console.error('Erro ao salvar chamada:', error);
    return sendAttendanceError(res, error, 'Erro interno ao processar chamada.');
  }
};

exports.getHistory = async (req, res) => {
  try {
    const { classId } = req.params;
    const result = await attendanceService.getClassHistory(
      req.user.schoolId,
      classId,
      req.user
    );
    return res.status(200).json(result);
  } catch (error) {
    console.error('Erro ao buscar histórico:', error);
    return sendAttendanceError(res, error, 'Erro ao buscar histórico.');
  }
};

exports.getStudentHistory = async (req, res) => {
  try {
    const { classId, studentId } = req.params;
    const result = await attendanceService.getStudentClassHistoryReport({
      schoolId: req.user.schoolId,
      classId,
      studentId,
      actor: req.user,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error('Erro ao buscar histórico do aluno:', error);
    return sendAttendanceError(res, error, 'Erro ao buscar histórico do aluno.');
  }
};

exports.getClassFirstAttendanceDate = async (req, res) => {
  try {
    const { classId } = req.params;
    const result = await attendanceService.getFirstAttendanceInfo(
      req.user.schoolId,
      classId,
      req.user
    );
    return res.status(200).json(result);
  } catch (error) {
    console.error('Erro ao buscar primeira chamada da turma:', error);
    return sendAttendanceError(res, error, 'Erro ao buscar primeira chamada da turma.');
  }
};

exports.getClassAttendanceReport = async (req, res) => {
  try {
    const { classId } = req.params;
    const result = await attendanceService.getClassAttendanceReport({
      schoolId: req.user.schoolId,
      classId,
      actor: req.user,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error('Erro ao gerar relatorio de frequencia da turma:', error);
    return sendAttendanceError(res, error, 'Erro ao gerar relatorio de frequencia da turma.');
  }
};

exports.getAttendanceSheet = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { classId } = req.params;
    const { date } = req.query;

    if (!classId) {
      return res.status(400).json({ message: 'ID da turma é obrigatório.' });
    }

    const result = await attendanceService.getDailyList(
      schoolId,
      classId,
      date,
      req.user
    );

    return res.status(200).json(result);
  } catch (error) {
    console.error('Erro ao buscar lista de chamada:', error);
    return sendAttendanceError(res, error, 'Erro ao buscar dados.');
  }
};
