const express = require('express');
const cors = require('cors');

// --- Rotas Legadas/Existentes ---
const userRoutes = require('./api/routes/user.routes');
const authRoutes = require('./api/routes/auth.routes'); 
const tutorRoutes = require('./api/routes/tutor.routes');
const studentRoutes = require('./api/routes/student.routes');
const classRoutes = require('./api/routes/class.routes');
const enrollmentRoutes = require('./api/routes/enrollment.routes');
const enrollmentOfferRoutes = require('./api/routes/enrollmentOffer.routes');
const subjectRoutes = require('./api/routes/subject.routes');
const horarioRoutes = require('./api/routes/horario.routes');
const eventoRoutes = require('./api/routes/evento.routes');
const schoolYearRoutes = require('./api/routes/schoolyear.routes');
const periodoRoutes = require('./api/routes/periodo.routes');
const cargaHorariaRoutes = require('./api/routes/cargaHoraria.routes');
const courseLoadRoutes = require('./api/routes/courseLoad.routes');
const invoiceRoutes = require('./api/routes/invoice.routes.js');
const webhookRoutes = require('./api/routes/webhook.routes.js');
const assistantRoutes = require('./api/routes/assistant.routes.js');
const negotiationRoutes = require('./api/routes/negotiation.routes.js'); 
const whatsappRoutes = require('./api/routes/whatsapp.routes');
const schoolRoutes = require('./api/routes/school.routes.js');
const companyRoutes = require('./api/routes/company.routes.js');
const contractRoutes = require('./api/routes/contract.routes.js');
const technicalProgramRoutes = require('./api/routes/technicalProgram.routes.js');
const technicalProgramModuleRoutes = require('./api/routes/technicalProgramModule.routes.js');
const technicalProgramOfferingRoutes = require('./api/routes/technicalProgramOffering.routes.js');
const technicalProgramOfferingModuleRoutes = require('./api/routes/technicalProgramOfferingModule.routes.js');
const technicalSpaceRoutes = require('./api/routes/technicalSpace.routes.js');
const technicalEnrollmentRoutes = require('./api/routes/technicalEnrollment.routes.js');
const technicalEnrollmentOfferingMovementRoutes = require('./api/routes/technicalEnrollmentOfferingMovement.routes.js');
const technicalModuleRecordRoutes = require('./api/routes/technicalModuleRecord.routes.js');
const technicalClassMovementRoutes = require('./api/routes/technicalClassMovement.routes.js');
const resourceOccupancyRoutes = require('./api/routes/resourceOccupancy.routes.js');
const dashboardRoutes = require('./api/routes/dashboard.routes');
const expenseRoutes = require('./api/routes/expense.routes.js');
const officialDocumentRequestRoutes = require('./api/routes/officialDocumentRequest.routes.js');
const officialDocumentRoutes = require('./api/routes/officialDocument.routes.js');
const absenceJustificationRequestRoutes = require('./api/routes/absenceJustificationRequest.routes.js');

// ===================================================================
// [NOVAS IMPORTAÇÕES]
// ===================================================================
const authStudentRoutes = require('./api/routes/authStudent.routes.js');
const assessmentRoutes = require('./api/routes/assessment.routes.js');
const assessmentAttemptRoutes = require('./api/routes/assessmentAttempt.routes.js');
const registrationRequestRoutes = require('./api/routes/registration-request.routes.js');
const attendanceRoutes = require('./api/routes/attendance.routes.js'); // [ADICIONADO - Frequência]
const evaluationRoutes = require('./api/routes/evaluation.routes');
const gradeRoutes = require('./api/routes/grade.routes');
const geminiExamRoutes = require('./api/routes/gemini-exam.routes');
// ===================================================================
const releaseRoutes = require('./api/routes/release.routes');

const analyticsRoutes = require('./api/routes/analytics.routes');

const notificationRoutes = require('./api/routes/notification.routes.js');

const invoiceCompensationRoutes = require('./api/routes/invoiceCompensation.routes.js');
const guardianAuthRoutes = require('./api/routes/guardianAuth.routes.js');

const examRoutes = require('./api/routes/exam.routes.js');
const omrRoutes = require('./api/routes/omr.routes.js');
const reportCardRoutes = require('./api/routes/reportCard.routes.js');
const classActivityRoutes = require('./api/routes/classActivity.routes.js');
const platformRoutes = require('./api/routes/platform.routes.js');
const schoolActivityLibraryRoutes = require('./api/routes/schoolActivityLibrary.routes.js');
const activityCorrectionRoutes = require('./api/routes/activityCorrection.routes.js');

const app = express();
const { parseTrustProxy } = require('./config/trustProxy');

app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

// Configuração CORS
app.use(cors()); 

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- Rota de Health Check ---
app.get('/', (req, res) => {
  res.status(200).json({
    message: '🚀 API do Sistema de Gerenciamento Escolar no ar!',
    status: 'OK'
  });
});

// --- Registro das Rotas ---

// Painel Administrativo Global
app.use('/api/platform', platformRoutes);

// Autenticação
app.use('/api/auth', authRoutes);                 // Login Staff/Admin
app.use('/api/auth/student', authStudentRoutes);  // Login Aluno
app.use('/api', guardianAuthRoutes);

// Funcionalidades Principais
app.use('/api/schools', schoolRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api', contractRoutes);
app.use('/api/technical-programs', technicalProgramRoutes);
app.use('/api/technical-program-modules', technicalProgramModuleRoutes);
app.use('/api/technical-program-offerings', technicalProgramOfferingRoutes);
app.use('/api/technical-program-offering-modules', technicalProgramOfferingModuleRoutes);
app.use('/api/technical-spaces', technicalSpaceRoutes);
app.use('/api/technical-enrollments', technicalEnrollmentRoutes);
app.use('/api/technical-enrollment-offering-movements', technicalEnrollmentOfferingMovementRoutes);
app.use('/api/technical-module-records', technicalModuleRecordRoutes);
app.use('/api/technical-class-movements', technicalClassMovementRoutes);
app.use('/api/official-document-requests', officialDocumentRequestRoutes);
app.use('/api/official-documents', officialDocumentRoutes);
app.use('/api/absence-justification-requests', absenceJustificationRequestRoutes);
app.use('/api/resource-occupancy', resourceOccupancyRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tutors', tutorRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/enrollments', enrollmentRoutes);
app.use('/api/enrollment-offers', enrollmentOfferRoutes);
app.use('/api/subjects', subjectRoutes);
app.use('/api/registration-requests', registrationRequestRoutes);
app.use('/api/attendance', attendanceRoutes); // [ADICIONADO - Rota de Frequência]

// Calendário e Acadêmico
app.use('/api/horarios', horarioRoutes);
app.use('/api/eventos', eventoRoutes);
app.use('/api/school-years', schoolYearRoutes);
app.use('/api/terms', periodoRoutes); 
app.use('/api/carga-horaria', cargaHorariaRoutes);
app.use('/api/course-loads', courseLoadRoutes); 

// Financeiro e Integrações
app.use('/api/invoices', invoiceRoutes);
app.use('/api/webhook', webhookRoutes); 
app.use('/api/assistant', assistantRoutes); 
app.use('/api/negotiations', negotiationRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/dashboard', dashboardRoutes);

// Avaliações
app.use('/api/assessments', assessmentRoutes); 
app.use('/api/attempts', assessmentAttemptRoutes); 
app.use('/api/expenses', expenseRoutes);

app.use('/api/analytics', analyticsRoutes);

app.use('/api/evaluations', evaluationRoutes);
app.use('/api/grades', gradeRoutes);

// ADICIONE ESTA LINHA:
app.use('/api/notifications', notificationRoutes);

app.use('/api/releases', releaseRoutes);

app.use('/api/invoice-compensations', invoiceCompensationRoutes);

app.use('/api/exams', examRoutes);
app.use('/api/omr', omrRoutes);

app.use('/api/gemini-exam', geminiExamRoutes);

app.use('/api/report-cards', reportCardRoutes);

app.use('/api/activities', classActivityRoutes);

app.use('/api/school/activity-library', schoolActivityLibraryRoutes);
app.use('/api/school', activityCorrectionRoutes);

app.use('/api/absence-justifications', require('./api/routes/absenceJustification.routes.js'));

module.exports = app;
