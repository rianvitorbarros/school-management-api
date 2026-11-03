const TechnicalProgramOfferingModule = require('../models/technicalProgramOfferingModule.model');
const TechnicalProgramOffering = require('../models/technicalProgramOffering.model');
const TechnicalProgramModule = require('../models/technicalProgramModule.model');
const TechnicalSpace = require('../models/technicalSpace.model');
const User = require('../models/user.model');
const UserService = require('./user.service');
const {
    normalizeReferenceId,
    normalizeTeacherIds,
    stripPublicationState,
    resolveSlotPublicationState
} = require('../utils/technicalScheduleSlot');
const {
    hasValue,
    parseDate,
    parseTimeToMinutes,
    calculateDurationMinutes,
    computeModuleDerivedValues
} = require('./technicalOfferingMath.helper');

const slotsOverlap = (slotA, slotB) => {
    if (slotA.weekday !== slotB.weekday) {
        return false;
    }

    const startA = parseTimeToMinutes(slotA.startTime);
    const endA = parseTimeToMinutes(slotA.endTime);
    const startB = parseTimeToMinutes(slotB.startTime);
    const endB = parseTimeToMinutes(slotB.endTime);

    if (startA === null || endA === null || startB === null || endB === null) {
        return false;
    }

    return startA < endB && startB < endA;
};

const sharesTeachers = (slotA, slotB) => {
    const teacherIdsA = Array.isArray(slotA.teacherIds) ? slotA.teacherIds.map(String) : [];
    const teacherIdsB = Array.isArray(slotB.teacherIds) ? slotB.teacherIds.map(String) : [];

    return teacherIdsA.some((teacherId) => teacherIdsB.includes(teacherId));
};

const sharesSpace = (slotA, slotB) => {
    if (!hasValue(slotA.spaceId) || !hasValue(slotB.spaceId)) {
        return false;
    }

    return String(slotA.spaceId) === String(slotB.spaceId);
};

const getCurrentScheduleSlot = (currentSlots, nextSlot, index) => {
    if (!Array.isArray(currentSlots) || currentSlots.length === 0) {
        return null;
    }

    if (hasValue(nextSlot?._id)) {
        const normalizedNextSlotId = normalizeReferenceId(nextSlot._id);
        const byId = currentSlots.find((currentSlot) => normalizeReferenceId(currentSlot?._id) === normalizedNextSlotId);
        if (byId) {
            return byId;
        }
    }

    const byIndex = currentSlots[index] || null;
    if (!byIndex) {
        return null;
    }

    const sameWeekday = Number(byIndex.weekday) === Number(nextSlot.weekday);
    const sameStartTime = String(byIndex.startTime || '').trim() === String(nextSlot.startTime || '').trim();
    const sameEndTime = String(byIndex.endTime || '').trim() === String(nextSlot.endTime || '').trim();
    const sameSpace = normalizeReferenceId(byIndex.spaceId) === normalizeReferenceId(nextSlot.spaceId);
    const sameTeachers = JSON.stringify([...normalizeTeacherIds(byIndex)].sort()) === JSON.stringify([...normalizeTeacherIds(nextSlot)].sort());
    const sameStatus = String(byIndex.status || '') === String(nextSlot.status || '');

    if (sameWeekday && sameStartTime && sameEndTime && sameSpace && sameTeachers && sameStatus) {
        return byIndex;
    }

    return null;
};

const buildPopulation = () => ([
        {
        path: 'technicalProgramOfferingId',
        select: 'technicalProgramId name code status plannedStartDate plannedEndDate actualStartDate actualEndDate shift capacity defaultSpaceId notes',
        populate: [
            { path: 'technicalProgramId', select: 'name totalWorkloadHours status' },
            { path: 'defaultSpaceId', select: 'name type capacity status' }
        ]
    },
    {
        path: 'technicalProgramModuleId',
        select: 'technicalProgramId subjectId name description moduleOrder workloadHours status',
        populate: [
            { path: 'technicalProgramId', select: 'name totalWorkloadHours status' },
            { path: 'subjectId', select: 'name level' }
        ]
    },
    {
        path: 'prerequisiteModuleIds',
        select: 'technicalProgramId name moduleOrder workloadHours status',
        populate: [
            { path: 'technicalProgramId', select: 'name totalWorkloadHours status' }
        ]
    },
    {
        path: 'scheduleSlots.teacherIds',
        select: 'fullName email roles status'
    },
    {
        path: 'scheduleSlots.publishedByUserId',
        select: 'fullName email roles status'
    },
    {
        path: 'scheduleSlots.publicationRevertedByUserId',
        select: 'fullName email roles status'
    },
    {
        path: 'scheduleSlots.spaceId',
        select: 'name type capacity status'
    }
]);

class TechnicalProgramOfferingModuleService {
    async _validateOfferingScheduleConflicts(technicalProgramOfferingId, schoolId, scheduleSlots, excludingModuleId = null) {
        if (!Array.isArray(scheduleSlots) || scheduleSlots.length === 0) {
            return;
        }

        const siblingModules = await TechnicalProgramOfferingModule.find({
            technicalProgramOfferingId,
            school_id: schoolId,
            ...(excludingModuleId ? { _id: { $ne: excludingModuleId } } : {})
        }).select('scheduleSlots');

        for (const sibling of siblingModules) {
            for (const siblingSlot of sibling.scheduleSlots || []) {
                for (const slot of scheduleSlots) {
                    if (!slotsOverlap(slot, siblingSlot)) {
                        continue;
                    }

                    if (sharesTeachers(slot, siblingSlot) || sharesSpace(slot, siblingSlot)) {
                        throw new Error('Ja existe conflito de horario, professor ou espaco com outra execucao de modulo nesta oferta.');
                    }
                }
            }
        }
    }

    async _validateTeachers(teacherIds, schoolId) {
        if (!Array.isArray(teacherIds) || teacherIds.length === 0) {
            return [];
        }

        const uniqueTeacherIds = [...new Set(teacherIds.map(String))];
        const teachers = (await Promise.all(uniqueTeacherIds.map((id) => UserService.getUserById(id, schoolId).catch(() => null))))
            .filter((teacher) => teacher && teacher.status === 'Ativo' && teacher.roles?.includes('Professor'));

        if (teachers.length !== uniqueTeacherIds.length) {
            throw new Error('Um ou mais professores informados nao foram encontrados, nao pertencem a escola ou nao estao habilitados como Professor.');
        }

        return teachers.map((teacher) => teacher._id);
    }

    async _validateScheduleSlots(scheduleSlots, schoolId, defaultSpaceId, currentSlots = [], performedByUserId = null) {
        if (scheduleSlots !== undefined && !Array.isArray(scheduleSlots)) {
            throw new Error('scheduleSlots precisa ser um array quando informado.');
        }

        if (!Array.isArray(scheduleSlots)) {
            return [];
        }

        const normalizedSlots = [];
        const slotChecks = [];
        for (const [index, slot] of scheduleSlots.entries()) {
            if (slot.teacherIds !== undefined && !Array.isArray(slot.teacherIds)) {
                throw new Error('teacherIds do slot precisa ser um array quando informado.');
            }

            const normalizedSlotInput = stripPublicationState(slot);
            const weekday = Number(slot.weekday);
            const startTime = typeof slot.startTime === 'string' ? slot.startTime.trim() : '';
            const endTime = typeof slot.endTime === 'string' ? slot.endTime.trim() : '';

            if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
                throw new Error('Cada slot da agenda precisa informar weekday entre 1 e 7.');
            }

            const durationMinutes = calculateDurationMinutes(startTime, endTime);
            if (!durationMinutes) {
                throw new Error('Cada slot da agenda precisa ter horario inicial/final valido e horario final maior que o inicial.');
            }

            let spaceId = slot.spaceId || defaultSpaceId || null;
            if (hasValue(spaceId)) {
                const space = await TechnicalSpace.findOne({ _id: spaceId, school_id: schoolId });
                if (!space) {
                    throw new Error(`Espaco tecnico ${spaceId} nao encontrado ou nao pertence a esta escola.`);
                }
            } else {
                spaceId = null;
            }

            const teacherIds = await this._validateTeachers(normalizeTeacherIds(slot), schoolId);
            const currentSlot = getCurrentScheduleSlot(currentSlots, slot, index);
            const publicationState = resolveSlotPublicationState({
                currentSlot,
                nextSlot: {
                    ...normalizedSlotInput,
                    weekday,
                    startTime,
                    endTime,
                    teacherIds,
                    spaceId,
                    durationMinutes,
                    status: slot.status || 'Ativo'
                },
                performedByUserId
            });

            normalizedSlots.push({
                ...(slot?._id ? { _id: slot._id } : {}),
                weekday,
                startTime,
                endTime,
                teacherIds,
                spaceId,
                durationMinutes,
                notes: slot.notes,
                status: slot.status || 'Ativo',
                ...publicationState
            });

            slotChecks.push({
                weekday,
                startMinutes: parseTimeToMinutes(startTime),
                endMinutes: parseTimeToMinutes(endTime)
            });
        }

        const orderedSlots = [...slotChecks].sort((a, b) => {
            if (a.weekday !== b.weekday) {
                return a.weekday - b.weekday;
            }

            if (a.startMinutes !== b.startMinutes) {
                return a.startMinutes - b.startMinutes;
            }

            return a.endMinutes - b.endMinutes;
        });

        for (let index = 1; index < orderedSlots.length; index += 1) {
            const previous = orderedSlots[index - 1];
            const current = orderedSlots[index];

            if (previous.weekday === current.weekday && current.startMinutes < previous.endMinutes) {
                throw new Error('Os slots da agenda nao podem se sobrepor no mesmo dia.');
            }
        }

        return normalizedSlots;
    }

    async createTechnicalProgramOfferingModule(moduleData, schoolId) {
        const {
            technicalProgramOfferingId,
            technicalProgramModuleId,
            executionOrder,
            moduleOrderSnapshot,
            plannedWorkloadHours,
            prerequisiteModuleIds,
            scheduleSlots,
            estimatedStartDate,
            estimatedEndDate,
            status
        } = moduleData;

        const offering = await TechnicalProgramOffering.findOne({
            _id: technicalProgramOfferingId,
            school_id: schoolId
        });
        if (!offering) {
            throw new Error(`Oferta tecnica ${technicalProgramOfferingId} nao encontrada ou nao pertence a esta escola.`);
        }

        const programModule = await TechnicalProgramModule.findOne({
            _id: technicalProgramModuleId,
            school_id: schoolId
        });
        if (!programModule) {
            throw new Error(`Modulo tecnico ${technicalProgramModuleId} nao encontrado ou nao pertence a esta escola.`);
        }

        if (String(offering.technicalProgramId) !== String(programModule.technicalProgramId)) {
            throw new Error('O modulo tecnico nao pertence ao mesmo programa da oferta.');
        }

        const hasEstimatedStartDate = Object.prototype.hasOwnProperty.call(moduleData, 'estimatedStartDate');
        const normalizedEstimatedStartDate = hasEstimatedStartDate ? parseDate(estimatedStartDate) : null;
        if (hasEstimatedStartDate && estimatedStartDate !== null && !normalizedEstimatedStartDate) {
            throw new Error('estimatedStartDate precisa ser uma data valida quando informada.');
        }
        const hasEstimatedEndDate = Object.prototype.hasOwnProperty.call(moduleData, 'estimatedEndDate');
        const normalizedEstimatedEndDate = hasEstimatedEndDate
            ? (estimatedEndDate !== null ? parseDate(estimatedEndDate) : null)
            : null;
        if (hasEstimatedEndDate && estimatedEndDate !== null && !normalizedEstimatedEndDate) {
            throw new Error('estimatedEndDate precisa ser uma data valida quando informada.');
        }

        const normalizedPrerequisites = [];
        if (Array.isArray(prerequisiteModuleIds) && prerequisiteModuleIds.length > 0) {
            const uniquePrerequisites = [...new Set(prerequisiteModuleIds.map(String))];
            const prerequisites = await TechnicalProgramModule.find({
                _id: { $in: uniquePrerequisites },
                school_id: schoolId
            });

            if (prerequisites.length !== uniquePrerequisites.length) {
                throw new Error('Um ou mais pre-requisitos informados nao foram encontrados ou nao pertencem a esta escola.');
            }

            for (const prerequisite of prerequisites) {
                if (String(prerequisite.technicalProgramId) !== String(programModule.technicalProgramId)) {
                    throw new Error('Os pre-requisitos precisam pertencer ao mesmo programa tecnico do modulo.');
                }
            }

            normalizedPrerequisites.push(...uniquePrerequisites);
        }

        const normalizedScheduleSlots = await this._validateScheduleSlots(scheduleSlots || [], schoolId, offering.defaultSpaceId);
        await this._validateOfferingScheduleConflicts(technicalProgramOfferingId, schoolId, normalizedScheduleSlots);
        const finalPlannedWorkloadHours = hasValue(plannedWorkloadHours) ? Number(plannedWorkloadHours) : Number(programModule.workloadHours);
        const finalEstimatedStartDate = hasEstimatedStartDate
            ? normalizedEstimatedStartDate
            : (offering.actualStartDate || offering.plannedStartDate);
        const estimatedStartDateSource = hasEstimatedStartDate ? 'Manual' : 'Oferta';
        const derivedValues = computeModuleDerivedValues(
            finalPlannedWorkloadHours,
            normalizedScheduleSlots,
            finalEstimatedStartDate
        );
        const finalEstimatedEndDate = hasEstimatedEndDate
            ? normalizedEstimatedEndDate
            : derivedValues.estimatedEndDate;

        if (finalEstimatedStartDate && finalEstimatedEndDate && finalEstimatedEndDate < finalEstimatedStartDate) {
            throw new Error('estimatedEndDate nao pode ser anterior a estimatedStartDate.');
        }

        const finalExecutionOrder = hasValue(executionOrder) ? Number(executionOrder) : Number(moduleOrderSnapshot || programModule.moduleOrder);
        const finalModuleOrderSnapshot = hasValue(moduleOrderSnapshot) ? Number(moduleOrderSnapshot) : Number(programModule.moduleOrder);

        if (!Number.isInteger(finalExecutionOrder) || finalExecutionOrder < 1) {
            throw new Error('A ordem de execucao precisa ser um numero inteiro maior que zero.');
        }

        if (!Number.isInteger(finalModuleOrderSnapshot) || finalModuleOrderSnapshot < 1) {
            throw new Error('A ordem de snapshot do modulo precisa ser um numero inteiro maior que zero.');
        }

        if (!Number.isFinite(finalPlannedWorkloadHours) || finalPlannedWorkloadHours < 0) {
            throw new Error('A carga horaria planejada precisa ser um numero valido.');
        }

        try {
            const newModule = new TechnicalProgramOfferingModule({
                technicalProgramOfferingId,
                technicalProgramModuleId,
                executionOrder: finalExecutionOrder,
                moduleOrderSnapshot: finalModuleOrderSnapshot,
                plannedWorkloadHours: finalPlannedWorkloadHours,
                plannedWeeklyMinutes: derivedValues.plannedWeeklyMinutes,
                estimatedWeeks: derivedValues.estimatedWeeks,
                estimatedStartDate: derivedValues.estimatedStartDate,
                estimatedStartDateSource,
                estimatedEndDate: finalEstimatedEndDate,
                prerequisiteModuleIds: normalizedPrerequisites,
                scheduleSlots: normalizedScheduleSlots,
                status: status || 'Planejado',
                notes: moduleData.notes,
                school_id: schoolId
            });

            await newModule.save();
            await newModule.populate(buildPopulation());
            return newModule;
        } catch (error) {
            if (error.code === 11000) {
                throw new Error('Ja existe uma execucao deste modulo nesta oferta ou a ordem de execucao ja foi utilizada.');
            }
            throw error;
        }
    }

    async getAllTechnicalProgramOfferingModules(filter = {}, schoolId) {
        const query = { ...filter };
        delete query.school_id;

        return await TechnicalProgramOfferingModule.find({
            ...query,
            school_id: schoolId
        })
            .populate(buildPopulation())
            .sort({ executionOrder: 1, createdAt: 1 });
    }

    async getTechnicalProgramOfferingModuleById(id, schoolId) {
        const module = await TechnicalProgramOfferingModule.findOne({
            _id: id,
            school_id: schoolId
        }).populate(buildPopulation());

        if (!module) {
            throw new Error('Execucao do modulo da oferta nao encontrada ou nao pertence a esta escola.');
        }

        return module;
    }

    async updateTechnicalProgramOfferingModule(id, updateData, schoolId, performedByUserId = null) {
        delete updateData.school_id;
        delete updateData.technicalProgramOfferingId;
        delete updateData.technicalProgramModuleId;
        delete updateData.moduleOrderSnapshot;
        delete updateData.estimatedStartDateSource;

        const currentModule = await TechnicalProgramOfferingModule.findOne({
            _id: id,
            school_id: schoolId
        });

        if (!currentModule) {
            throw new Error('Execucao do modulo da oferta nao encontrada para atualizar.');
        }

        const hasEstimatedEndDate = Object.prototype.hasOwnProperty.call(updateData, 'estimatedEndDate');
        const normalizedEstimatedEndDate = hasEstimatedEndDate
            ? (updateData.estimatedEndDate !== null ? parseDate(updateData.estimatedEndDate) : null)
            : currentModule.estimatedEndDate;
        if (hasEstimatedEndDate && updateData.estimatedEndDate !== null && !normalizedEstimatedEndDate) {
            throw new Error('estimatedEndDate precisa ser uma data valida quando informada.');
        }

        let normalizedPlannedWorkloadHours = currentModule.plannedWorkloadHours;
        if (updateData.plannedWorkloadHours !== undefined) {
            normalizedPlannedWorkloadHours = Number(updateData.plannedWorkloadHours);
            if (!Number.isFinite(normalizedPlannedWorkloadHours) || normalizedPlannedWorkloadHours < 0) {
                throw new Error('A carga horaria planejada precisa ser um numero valido.');
            }
            updateData.plannedWorkloadHours = normalizedPlannedWorkloadHours;
        }

        if (updateData.executionOrder !== undefined) {
            const nextExecutionOrder = Number(updateData.executionOrder);
            if (!Number.isInteger(nextExecutionOrder) || nextExecutionOrder < 1) {
                throw new Error('A ordem de execucao precisa ser um numero inteiro maior que zero.');
            }
            const conflict = await TechnicalProgramOfferingModule.findOne({
                _id: { $ne: id },
                technicalProgramOfferingId: currentModule.technicalProgramOfferingId,
                executionOrder: nextExecutionOrder,
                school_id: schoolId
            });

            if (conflict) {
                throw new Error('Ja existe outra execucao nesta oferta com a mesma ordem.');
            }
        }

        if (Object.prototype.hasOwnProperty.call(updateData, 'scheduleSlots')) {
            const offering = await TechnicalProgramOffering.findOne({
                _id: currentModule.technicalProgramOfferingId,
                school_id: schoolId
            });

            if (!offering) {
                throw new Error('Oferta tecnica relacionada nao encontrada para recalcular a agenda.');
            }

            const normalizedScheduleSlots = await this._validateScheduleSlots(
                updateData.scheduleSlots,
                schoolId,
                offering.defaultSpaceId,
                Array.isArray(currentModule.scheduleSlots) ? currentModule.scheduleSlots : [],
                performedByUserId
            );
            await this._validateOfferingScheduleConflicts(currentModule.technicalProgramOfferingId, schoolId, normalizedScheduleSlots, id);
            const hasEstimatedStartDate = Object.prototype.hasOwnProperty.call(updateData, 'estimatedStartDate');
            const normalizedEstimatedStartDate = hasEstimatedStartDate
                ? parseDate(updateData.estimatedStartDate)
                : currentModule.estimatedStartDate;

            if (hasEstimatedStartDate && updateData.estimatedStartDate !== null && !normalizedEstimatedStartDate) {
                throw new Error('estimatedStartDate precisa ser uma data valida quando informada.');
            }

            const nextEstimatedStartDateSource = hasEstimatedStartDate
                ? 'Manual'
                : currentModule.estimatedStartDateSource;
            const baseEstimatedStartDate = nextEstimatedStartDateSource === 'Oferta'
                ? (offering.actualStartDate || offering.plannedStartDate)
                : normalizedEstimatedStartDate;

            const derivedValues = computeModuleDerivedValues(
                normalizedPlannedWorkloadHours,
                normalizedScheduleSlots,
                baseEstimatedStartDate
            );

            const nextEstimatedEndDate = hasEstimatedEndDate
                ? normalizedEstimatedEndDate
                : derivedValues.estimatedEndDate;
            if (derivedValues.estimatedStartDate && nextEstimatedEndDate && nextEstimatedEndDate < derivedValues.estimatedStartDate) {
                throw new Error('estimatedEndDate nao pode ser anterior a estimatedStartDate.');
            }

            updateData.scheduleSlots = normalizedScheduleSlots;
            updateData.plannedWeeklyMinutes = derivedValues.plannedWeeklyMinutes;
            updateData.estimatedWeeks = derivedValues.estimatedWeeks;
            updateData.estimatedStartDate = derivedValues.estimatedStartDate;
            updateData.estimatedStartDateSource = nextEstimatedStartDateSource;
            updateData.estimatedEndDate = nextEstimatedEndDate;
        } else if (Object.prototype.hasOwnProperty.call(updateData, 'estimatedStartDate')) {
            const offering = await TechnicalProgramOffering.findOne({
                _id: currentModule.technicalProgramOfferingId,
                school_id: schoolId
            });

            if (!offering) {
                throw new Error('Oferta tecnica relacionada nao encontrada para recalcular as datas da execucao.');
            }

            const normalizedEstimatedStartDate = updateData.estimatedStartDate !== null
                ? parseDate(updateData.estimatedStartDate)
                : null;

            if (updateData.estimatedStartDate !== null && !normalizedEstimatedStartDate) {
                throw new Error('estimatedStartDate precisa ser uma data valida quando informada.');
            }

            const nextEstimatedStartDateSource = updateData.estimatedStartDate === null
                ? 'Oferta'
                : 'Manual';
            const baseEstimatedStartDate = nextEstimatedStartDateSource === 'Oferta'
                ? (offering.actualStartDate || offering.plannedStartDate)
                : normalizedEstimatedStartDate;

            const derivedValues = computeModuleDerivedValues(
                normalizedPlannedWorkloadHours,
                Array.isArray(currentModule.scheduleSlots) ? currentModule.scheduleSlots : [],
                baseEstimatedStartDate
            );

            const nextEstimatedEndDate = hasEstimatedEndDate
                ? normalizedEstimatedEndDate
                : derivedValues.estimatedEndDate;
            if (derivedValues.estimatedStartDate && nextEstimatedEndDate && nextEstimatedEndDate < derivedValues.estimatedStartDate) {
                throw new Error('estimatedEndDate nao pode ser anterior a estimatedStartDate.');
            }

            updateData.estimatedStartDate = derivedValues.estimatedStartDate;
            updateData.estimatedStartDateSource = nextEstimatedStartDateSource;
            updateData.estimatedWeeks = derivedValues.estimatedWeeks;
            updateData.plannedWeeklyMinutes = derivedValues.plannedWeeklyMinutes;
            updateData.estimatedEndDate = nextEstimatedEndDate;
        } else if (updateData.plannedWorkloadHours !== undefined) {
            const offering = await TechnicalProgramOffering.findOne({
                _id: currentModule.technicalProgramOfferingId,
                school_id: schoolId
            });

            if (!offering) {
                throw new Error('Oferta tecnica relacionada nao encontrada para recalcular a agenda.');
            }

            const baseEstimatedStartDate = currentModule.estimatedStartDateSource === 'Oferta'
                ? (offering.actualStartDate || offering.plannedStartDate)
                : currentModule.estimatedStartDate;

            const derivedValues = computeModuleDerivedValues(
                normalizedPlannedWorkloadHours,
                Array.isArray(currentModule.scheduleSlots) ? currentModule.scheduleSlots : [],
                baseEstimatedStartDate
            );

            const nextEstimatedEndDate = hasEstimatedEndDate
                ? normalizedEstimatedEndDate
                : derivedValues.estimatedEndDate;
            if (derivedValues.estimatedStartDate && nextEstimatedEndDate && nextEstimatedEndDate < derivedValues.estimatedStartDate) {
                throw new Error('estimatedEndDate nao pode ser anterior a estimatedStartDate.');
            }

            updateData.plannedWeeklyMinutes = derivedValues.plannedWeeklyMinutes;
            updateData.estimatedWeeks = derivedValues.estimatedWeeks;
            updateData.estimatedStartDate = derivedValues.estimatedStartDate;
            updateData.estimatedStartDateSource = currentModule.estimatedStartDateSource;
            updateData.estimatedEndDate = nextEstimatedEndDate;
        } else if (hasEstimatedEndDate) {
            const baseEstimatedStartDate = currentModule.estimatedStartDate;
            if (baseEstimatedStartDate && normalizedEstimatedEndDate && normalizedEstimatedEndDate < baseEstimatedStartDate) {
                throw new Error('estimatedEndDate nao pode ser anterior a estimatedStartDate.');
            }
            updateData.estimatedEndDate = normalizedEstimatedEndDate;
        }

        if (updateData.prerequisiteModuleIds !== undefined) {
            const normalizedPrerequisites = [];
            if (Array.isArray(updateData.prerequisiteModuleIds) && updateData.prerequisiteModuleIds.length > 0) {
                const uniquePrerequisites = [...new Set(updateData.prerequisiteModuleIds.map(String))];
                const prerequisites = await TechnicalProgramModule.find({
                    _id: { $in: uniquePrerequisites },
                    school_id: schoolId
                });

                if (prerequisites.length !== uniquePrerequisites.length) {
                    throw new Error('Um ou mais pre-requisitos informados nao foram encontrados ou nao pertencem a esta escola.');
                }

                const offering = await TechnicalProgramOffering.findOne({
                    _id: currentModule.technicalProgramOfferingId,
                    school_id: schoolId
                });

                if (!offering) {
                    throw new Error('Oferta tecnica relacionada nao encontrada para validar pre-requisitos.');
                }

                for (const prerequisite of prerequisites) {
                    if (String(prerequisite.technicalProgramId) !== String(offering.technicalProgramId)) {
                        throw new Error('Os pre-requisitos precisam pertencer ao mesmo programa tecnico da oferta.');
                    }
                }

                normalizedPrerequisites.push(...uniquePrerequisites);
            }
            updateData.prerequisiteModuleIds = normalizedPrerequisites;
        }

        if (updateData.status === undefined) {
            updateData.status = currentModule.status;
        }

        const updatedModule = await TechnicalProgramOfferingModule.findOneAndUpdate(
            { _id: id, school_id: schoolId },
            { $set: updateData },
            { new: true, runValidators: true }
        ).populate(buildPopulation());

        if (!updatedModule) {
            throw new Error('Execucao do modulo da oferta nao encontrada para atualizar.');
        }

        return updatedModule;
    }

    async inactivateTechnicalProgramOfferingModule(id, schoolId) {
        const module = await TechnicalProgramOfferingModule.findOneAndUpdate(
            { _id: id, school_id: schoolId },
            { status: 'Cancelado' },
            { new: true, runValidators: true }
        ).populate(buildPopulation());

        if (!module) {
            throw new Error('Execucao do modulo da oferta nao encontrada para inativar.');
        }

        return module;
    }
}

module.exports = new TechnicalProgramOfferingModuleService();
