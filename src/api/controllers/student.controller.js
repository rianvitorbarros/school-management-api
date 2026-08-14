// src/api/controllers/student.controller.js
const StudentService = require('../services/student.service');
const AcademicHistoryService = require('../services/academicHistory.service');
const User = require('../models/user.model');
const appEmitter = require('../../loaders/eventEmitter'); 

// Helper de verificação de SchoolId
const getSchoolId = (req) => {
    if (!req.user || !req.user.school_id) {
        throw new Error('Usuário não autenticado ou não associado a uma escola.');
    }
    return req.user.school_id;
};

// Helper para parsear campos que vêm como String no Multipart
const parseMultipartBody = (body) => {
    const parsed = { ...body };
    
    // Removemos o campo 'reason' do objeto parsed para que ele não tente ser salvo dentro do documento do aluno
    // O 'reason' é usado apenas para o Log de Auditoria
    if (parsed.reason) delete parsed.reason;

    const jsonFields = ['address', 'tutors', 'healthInfo', 'authorizedPickups', 'accessCredentials'];

    jsonFields.forEach(field => {
        if (parsed[field] && typeof parsed[field] === 'string') {
            try {
                if (parsed[field] === 'null' || parsed[field] === 'undefined') {
                    parsed[field] = null;
                } else {
                    parsed[field] = JSON.parse(parsed[field]);
                }
            } catch (e) {
                console.error(`Erro ao fazer parse do campo ${field}:`, e.message);
            }
        }
    });

    if (parsed.isActive === 'true') parsed.isActive = true;
    if (parsed.isActive === 'false') parsed.isActive = false;
    
    return parsed;
};

class StudentController {

    async getPhoto(req, res) {
        try {
            const schoolId = getSchoolId(req);
            const { id } = req.params;
            
            const photo = await StudentService.getStudentPhoto(id, schoolId);
            
            res.set('Content-Type', photo.contentType);
            res.send(photo.data);
        } catch (error) {
            if (error.message.includes('não encontrado') || error.message.includes('Foto não encontrada')) {
                 return res.status(404).json({ message: 'Foto não encontrada.' });
            }
            res.status(500).json({ message: 'Erro ao buscar foto.', error: error.message });
        }
    }

    async updateTutorRelationship(req, res) {
        try {
            const schoolId = getSchoolId(req);
            const { studentId, tutorId } = req.params;
            const { relationship } = req.body;

            if (!relationship) {
                 return res.status(400).json({ message: 'O campo "relationship" é obrigatório.' });
            }
            
            console.log(`[API] PUT /students/${studentId}/tutors/${tutorId}`);

            // [AUDITORIA] Passamos req.user como último parâmetro
            const { updatedLink, student } = await StudentService.updateTutorRelationship(
                studentId,
                tutorId,
                relationship,
                schoolId,
                req.user 
            );
            
            appEmitter.emit('student:updated', student);
            
            res.status(200).json(updatedLink); 

        } catch (error) {
            console.error(`[API] Erro ao atualizar relacionamento: ${error.message}`);
            if (error.message.includes('não encontrado')) return res.status(404).json({ message: error.message });
            if (error.message.includes('não autenticado')) return res.status(403).json({ message: error.message });
            res.status(500).json({ message: 'Erro interno ao atualizar relacionamento.', error: error.message });
        }
    }
 
    async create(req, res, next) {
        try {
            const schoolId = getSchoolId(req);
            const creatorId = req.user.id; 

            console.log('--- [DEBUG API] CREATE STUDENT ---');
            
            let studentData = parseMultipartBody(req.body);
            
            studentData = {
                ...studentData,
                creator: creatorId 
            };

            // [AUDITORIA] Passamos req.user para vincular a criação ao usuário logado
            const newStudent = await StudentService.createStudent(studentData, schoolId, req.file, req.user);
            console.log('✅ SUCESSO: Aluno criado.');

            const creatorDoc = await User.findById(creatorId);
            const creatorName = creatorDoc ? creatorDoc.fullName : 'Usuário';

            const payload = {
                creator: {
                    id: req.user.id,
                    fullName: creatorName
                },
                student: newStudent 
            };

            appEmitter.emit('student:created', payload); 
            
            res.status(201).json(newStudent);

        } catch (error) {
            console.error('❌ ERRO CREATE:', error.message);
            if (error.message.includes('não autenticado')) return res.status(403).json({ message: error.message });
            next(error); 
        }
    }

    async getAll(req, res) {
        try {
            const schoolId = getSchoolId(req);
            const students = await StudentService.getAllStudents(schoolId);
            res.status(200).json(students);
        } catch (error) {
            if (error.message.includes('não autenticado')) return res.status(403).json({ message: error.message });
            res.status(500).json({ message: 'Erro ao buscar alunos', error: error.message });
        }
    }

    async getById(req, res) {
        try {
            const schoolId = getSchoolId(req);
            const { id } = req.params;
            
            const student = await StudentService.getStudentById(id, schoolId);
            res.status(200).json(student);
            
        } catch (error) {
            if (error.message.includes('não autenticado')) return res.status(403).json({ message: error.message });
            if (error.message.includes('não encontrado')) return res.status(404).json({ message: error.message });
            res.status(500).json({ message: 'Erro ao buscar aluno', error: error.message });
        }
    }

    async getTeacherSummary(req, res) {
        try {
            const schoolId = getSchoolId(req);
            const { classId, studentId } = req.params;

            const summary = await StudentService.getTeacherSummary({
                schoolId,
                classId,
                studentId,
                currentUser: req.user
            });

            res.status(200).json(summary);
        } catch (error) {
            const statusCode = error.statusCode || (error.message.includes('nao encontrado') ? 404 : 400);
            res.status(statusCode).json({
                message: error.message || 'Erro ao buscar resumo do aluno para o professor.'
            });
        }
    }

    async update(req, res) {
        try {
            const schoolId = getSchoolId(req);
            const { id } = req.params;

            console.log(`--- [DEBUG API] UPDATE STUDENT ${id} ---`);

            // Extraímos o motivo da alteração para a auditoria
            const reason = req.body.reason || null;

            const updateData = parseMultipartBody(req.body);

            // [AUDITORIA] Passamos user e reason para o Service
            const student = await StudentService.updateStudent(
                id, 
                updateData, 
                schoolId, 
                req.file, 
                req.user, // Actor
                reason    // Justificativa
            );
            
            res.status(200).json(student);

        } catch (error) {
            if (error.message.includes('não autenticado')) return res.status(403).json({ message: error.message });
             if (error.message.includes('não encontrado')) return res.status(404).json({ message: error.message });
            res.status(400).json({ message: 'Erro ao atualizar aluno', error: error.message });
        }
    }

    async delete(req, res) {
        try {
            const schoolId = getSchoolId(req);
            const { id } = req.params;
            
            // O motivo pode vir no body, mesmo num DELETE (dependendo do client), ou ser undefined
            const reason = req.body.reason || 'Exclusão solicitada via sistema';

            // [AUDITORIA] Passamos user e reason
            const student = await StudentService.deleteStudent(id, schoolId, req.user, reason);
            
            res.status(200).json({ message: 'Aluno deletado com sucesso' });
            
        } catch (error) {
            if (error.message.includes('não autenticado')) return res.status(403).json({ message: error.message });
             if (error.message.includes('não encontrado')) return res.status(404).json({ message: error.message });
            res.status(500).json({ message: 'Erro ao deletar aluno', error: error.message });
        }
    }

    async getUpcomingBirthdays(req, res) {
        try {
            const schoolId = getSchoolId(req);
            const students = await StudentService.getUpcomingBirthdays(schoolId);
            res.status(200).json(students);
        } catch (error) {
            if (error.message.includes('não autenticado')) return res.status(403).json({ message: error.message });
            res.status(500).json({ message: 'Erro ao buscar aniversariantes', error: error.message });
        }
    }

    async addAcademicRecord(req, res, next) {
        try {
            const schoolId = getSchoolId(req);
            const { studentId } = req.params;
            const recordData = req.body; 

            if (!recordData.gradeLevel || !recordData.schoolYear || !recordData.finalResult) {
                return res.status(400).json({ message: 'Campos obrigatórios (gradeLevel, schoolYear, finalResult) não fornecidos.' });
            }

            const history = await AcademicHistoryService.createRecord({
                schoolId, studentId, recordData, actor: req.user
            });
            res.status(201).json(history);

        } catch (error) {
            if (error.message.includes('não autenticado')) return res.status(403).json({ message: error.message });
             if (error.message.includes('não encontrado')) return res.status(404).json({ message: error.message });
            next(error);
        }
    }

    async updateAcademicRecord(req, res, next) {
        try {
            const schoolId = getSchoolId(req);
            const { studentId, recordId } = req.params;
            const updatedData = req.body;

            const history = await AcademicHistoryService.updateRecord({
                schoolId, studentId, recordId, recordData: updatedData, actor: req.user
            });
            res.status(200).json(history);

        } catch (error) {
            if (error.message.includes('não autenticado')) return res.status(403).json({ message: error.message });
             if (error.message.includes('não encontrado')) return res.status(404).json({ message: error.message });
            next(error);
        }
    }

    async deleteAcademicRecord(req, res, next) {
        try {
            const schoolId = getSchoolId(req);
            const { studentId, recordId } = req.params;

            const history = await AcademicHistoryService.deleteRecord({
                schoolId, studentId, recordId, actor: req.user
            });
            res.status(200).json(history);

        } catch (error) {
             if (error.message.includes('não autenticado')) return res.status(403).json({ message: error.message });
             if (error.message.includes('não encontrado')) return res.status(404).json({ message: error.message });
            next(error);
        }
    }

    async getAcademicHistoryContext(req, res, next) {
        try {
            const schoolId = getSchoolId(req);
            const context = await AcademicHistoryService.getContext({
                schoolId,
                studentId: req.params.studentId,
                schoolYear: req.query.schoolYear,
                enrollmentId: req.query.enrollmentId,
            });
            res.status(200).json(context);
        } catch (error) {
            next(error);
        }
    }

    async previewAcademicHistoryImport(req, res, next) {
        try {
            const schoolId = getSchoolId(req);
            const preview = await AcademicHistoryService.previewImport({
                schoolId,
                studentId: req.params.studentId,
                schoolYear: req.body.schoolYear,
                enrollmentId: req.body.enrollmentId,
            });
            res.status(200).json(preview);
        } catch (error) {
            next(error);
        }
    }

    async importAcademicHistory(req, res, next) {
        try {
            const schoolId = getSchoolId(req);
            const history = await AcademicHistoryService.createRecord({
                schoolId,
                studentId: req.params.studentId,
                recordData: req.body,
                actor: req.user,
                imported: true,
            });
            res.status(201).json(history);
        } catch (error) {
            next(error);
        }
    }
}

module.exports = new StudentController();
