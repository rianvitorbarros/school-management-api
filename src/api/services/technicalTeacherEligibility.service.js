const TechnicalProgramModule = require('../models/technicalProgramModule.model');
const TechnicalProgram = require('../models/technicalProgram.model');
const UserService = require('./user.service');
const { ApiError } = require('../utils/apiError');
const { normalizeReferenceId } = require('../utils/technicalScheduleSlot');

const hasValue = (value) => value !== undefined && value !== null && value !== '';

const toSerializable = (doc) => {
    if (!doc) {
        return null;
    }

    return doc.toObject ? doc.toObject({ virtuals: true }) : doc;
};

class TechnicalTeacherEligibilityService {
    async getEligibleTeachersBySubjectId(subjectId, schoolId) {
        if (!hasValue(subjectId)) {
            return [];
        }

        const subjectRefId = normalizeReferenceId(subjectId);
        if (!subjectRefId) {
            return [];
        }

        const teachers = (await UserService.getAllUsers(schoolId))
            .filter((teacher) => teacher.status === 'Ativo' && teacher.roles?.includes('Professor'))
            .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));

        return teachers
            .filter((teacher) => {
                if (!Array.isArray(teacher.staffProfiles) || teacher.staffProfiles.length === 0) {
                    return false;
                }

                return teacher.staffProfiles.some((profile) => {
                    if (!profile || !Array.isArray(profile.enabledSubjects) || profile.enabledSubjects.length === 0) {
                        return false;
                    }

                    return profile.enabledSubjects.some((enabledSubjectId) => normalizeReferenceId(enabledSubjectId) === subjectRefId);
                });
            })
            .map((teacher) => ({
                _id: normalizeReferenceId(teacher._id),
                teacherId: normalizeReferenceId(teacher._id),
                fullName: teacher.fullName,
                email: teacher.email,
                roles: teacher.roles,
                status: teacher.status
            }));
    }

    async getTechnicalProgramModuleSchedulingContext(moduleId, schoolId) {
        const module = await TechnicalProgramModule.findOne({
            _id: moduleId,
            school_id: schoolId
        })
            .populate([
                { path: 'technicalProgramId', select: 'name totalWorkloadHours status' },
                { path: 'subjectId', select: 'name level' }
            ]);

        if (!module) {
            throw new ApiError({
                message: 'Modulo tecnico nao encontrado ou nao pertence a esta escola.',
                code: 'NOT_FOUND',
                status: 404
            });
        }

        const program = module.technicalProgramId && module.technicalProgramId._id
            ? module.technicalProgramId
            : await TechnicalProgram.findOne({
                _id: module.technicalProgramId,
                school_id: schoolId
            }).select('name totalWorkloadHours status');

        const blockingReasons = [];

        if (!program) {
            blockingReasons.push({
                code: 'PROGRAM_NOT_FOUND',
                message: 'Programa tecnico nao encontrado ou nao pertence a esta escola.'
            });
        } else if (program.status !== 'Ativo') {
            blockingReasons.push({
                code: 'PROGRAM_INACTIVE',
                message: 'Programa tecnico inativo.'
            });
        }

        if (module.status !== 'Ativo') {
            blockingReasons.push({
                code: 'MODULE_INACTIVE',
                message: 'Modulo tecnico inativo.'
            });
        }

        const subject = module.subjectId && module.subjectId._id ? module.subjectId : null;
        if (!subject) {
            blockingReasons.push({
                code: 'MISSING_SUBJECT',
                message: 'O modulo precisa de subjectId para entrar em grade.'
            });
        }

        const eligibleTeachers = subject
            ? await this.getEligibleTeachersBySubjectId(subject._id, schoolId)
            : [];

        if (subject && eligibleTeachers.length === 0) {
            blockingReasons.push({
                code: 'NO_ELIGIBLE_TEACHERS',
                message: 'Nao existem professores elegiveis para este modulo.'
            });
        }

        return {
            module: toSerializable(module),
            program: toSerializable(program),
            subject: toSerializable(subject),
            canEnterGrade: blockingReasons.length === 0,
            eligibleTeachers,
            blockingReasons
        };
    }
}

module.exports = new TechnicalTeacherEligibilityService();
