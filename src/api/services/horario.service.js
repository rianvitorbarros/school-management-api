// src/api/services/horario.service.js
const Horario = require('../models/horario.model');
const User = require('../models/user.model');
const StaffProfile = require('../models/staffProfile.model');
const Subject = require('../models/subject.model');
const Class = require('../models/class.model');
const Term = require('../models/periodo.model'); // Importa o modelo Periodo como Term
const School = require('../models/school.model');
const mongoose = require('mongoose');
const crypto = require('crypto');

const defaultPopulation = [
    { 
        path: 'teacherId',
        select: 'fullName email' 
    },
    { 
        path: 'subjectId',
        select: 'name level' 
    },
    {
        path: 'classId',
        select: 'name grade schoolYear shift level room status school_id'
    },
    {
        path: 'termId', // [NOVO] Popula o Período
        select: 'titulo dataInicio dataFim' 
    }
];

const SCHEDULE_MODES = {
    PERIOD_SPECIFIC: 'period_specific',
    SHARED_ACROSS_PERIODS: 'shared_across_periods',
};

function isTruthy(value) {
    return value === true || String(value || '').toLowerCase() === 'true';
}

function normalizeId(value) {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
}

function asObject(document) {
    return typeof document?.toObject === 'function'
        ? document.toObject({ virtuals: false })
        : { ...document };
}

function formatTermName(term) {
    return term?.titulo || term?.name || null;
}

class HorarioService {

    _sanitizeFilter(filter = {}) {
        const query = { ...filter };
        delete query.resolveInherited;

        if (query.class) {
            query.classId = query.class;
            delete query.class;
        }

        return query;
    }

    async _getRegularWeeklyScheduleMode(schoolId) {
        const school = await School.findById(schoolId)
            .select('academicSettings.regularWeeklyScheduleMode')
            .lean();

        return school?.academicSettings?.regularWeeklyScheduleMode ||
            SCHEDULE_MODES.PERIOD_SPECIFIC;
    }

    async _getTermsInSameYear(targetTerm, schoolId) {
        return Term.find({
            school_id: schoolId,
            anoLetivoId: targetTerm.anoLetivoId,
            tipo: 'Letivo',
        })
            .select('_id titulo dataInicio dataFim anoLetivoId tipo')
            .sort({ dataInicio: 1 })
            .lean();
    }

    async _findBaseScheduleForTerm({ query, targetTerm, schoolId }) {
        const terms = await this._getTermsInSameYear(targetTerm, schoolId);
        const targetStart = new Date(targetTerm.dataInicio).getTime();

        const previousTerms = terms
            .filter((term) => String(term._id) !== String(targetTerm._id))
            .filter((term) => new Date(term.dataInicio).getTime() < targetStart)
            .sort((left, right) => new Date(right.dataInicio) - new Date(left.dataInicio));

        const fallbackTerms = terms
            .filter((term) => String(term._id) !== String(targetTerm._id))
            .sort((left, right) => new Date(left.dataInicio) - new Date(right.dataInicio));

        for (const candidates of [previousTerms, fallbackTerms]) {
            for (const term of candidates) {
                const horarios = await Horario.find({
                    ...query,
                    school_id: schoolId,
                    termId: term._id,
                })
                    .populate(defaultPopulation)
                    .sort({ dayOfWeek: 1, startTime: 1 });

                if (horarios.length > 0) {
                    return { term, horarios };
                }
            }
        }

        return { term: null, horarios: [] };
    }

    _decorateOwnSchedules(horarios, targetTerm) {
        return horarios.map((horario) => ({
            ...asObject(horario),
            isInherited: false,
            resolvedFromTermId: normalizeId(horario.termId),
            resolvedFromTermName: formatTermName(horario.termId),
            targetTermId: normalizeId(targetTerm?._id || horario.termId),
        }));
    }

    _decorateInheritedSchedules(horarios, sourceTerm, targetTerm) {
        const sourceTermId = normalizeId(sourceTerm?._id);
        const targetTermId = normalizeId(targetTerm?._id);

        return horarios.map((horario) => {
            const object = asObject(horario);
            return {
                ...object,
                termId: targetTermId,
                isInherited: true,
                resolvedFromTermId: sourceTermId,
                resolvedFromTermName: formatTermName(sourceTerm),
                targetTermId,
                sourceTermId,
                sourceHorarioId: normalizeId(object._id),
            };
        });
    }

    async resolveEffectiveHorarios(filter = {}, schoolId) {
        const query = this._sanitizeFilter(filter);
        const targetTermId = query.termId;

        if (!targetTermId) {
            return this.getHorarios(query, schoolId);
        }

        const targetTerm = await Term.findOne({ _id: targetTermId, school_id: schoolId }).lean();
        if (!targetTerm) {
            throw new Error('Período (Bimestre) não encontrado ou não pertence à sua escola.');
        }

        const ownHorarios = await Horario.find({ ...query, school_id: schoolId })
            .populate(defaultPopulation)
            .sort({ dayOfWeek: 1, startTime: 1 });

        const mode = await this._getRegularWeeklyScheduleMode(schoolId);
        if (mode !== SCHEDULE_MODES.SHARED_ACROSS_PERIODS) {
            return this._decorateOwnSchedules(ownHorarios, targetTerm);
        }

        const sourceQuery = { ...query };
        delete sourceQuery.termId;

        const { term: sourceTerm, horarios } = await this._findBaseScheduleForTerm({
            query: sourceQuery,
            targetTerm,
            schoolId,
        });

        if (!sourceTerm || horarios.length === 0) {
            return this._decorateOwnSchedules(ownHorarios, targetTerm);
        }

        const classesWithOwnSchedule = new Set(
            ownHorarios
                .map((horario) => normalizeId(horario.classId))
                .filter(Boolean),
        );
        const inheritedWithoutOverrides = horarios.filter((horario) => {
            const classId = normalizeId(horario.classId);
            return classId && !classesWithOwnSchedule.has(classId);
        });

        return [
            ...this._decorateOwnSchedules(ownHorarios, targetTerm),
            ...this._decorateInheritedSchedules(
                inheritedWithoutOverrides,
                sourceTerm,
                targetTerm,
            ),
        ].sort((left, right) => {
            const dayDifference = Number(left.dayOfWeek) - Number(right.dayOfWeek);
            if (dayDifference !== 0) return dayDifference;
            return String(left.startTime).localeCompare(String(right.startTime));
        });
    }

    async _validateCopyContext({ sourceTermId, targetTermId, classId, schoolId }) {
        if (!sourceTermId || !targetTermId || !classId) {
            throw new Error('sourceTermId, targetTermId e classId são obrigatórios.');
        }

        if (String(sourceTermId) === String(targetTermId)) {
            throw new Error('O período de origem e destino precisam ser diferentes.');
        }

        const [sourceTerm, targetTerm, classDoc] = await Promise.all([
            Term.findOne({ _id: sourceTermId, school_id: schoolId }).lean(),
            Term.findOne({ _id: targetTermId, school_id: schoolId }).lean(),
            Class.findOne({ _id: classId, school_id: schoolId }).lean(),
        ]);

        if (!sourceTerm) throw new Error('Período de origem não encontrado ou não pertence à sua escola.');
        if (!targetTerm) throw new Error('Período de destino não encontrado ou não pertence à sua escola.');
        if (!classDoc) throw new Error('Turma não encontrada ou não pertence à sua escola.');
        if (String(sourceTerm.anoLetivoId) !== String(targetTerm.anoLetivoId)) {
            throw new Error('Os períodos de origem e destino precisam pertencer ao mesmo ano letivo.');
        }

        return { sourceTerm, targetTerm, classDoc };
    }

    async _assertNoCopyConflicts({ sourceHorarios, targetTermId, classId, schoolId }) {
        for (const horario of sourceHorarios) {
            const [classConflict, teacherConflict] = await Promise.all([
                Horario.findOne({
                    school_id: schoolId,
                    classId,
                    termId: targetTermId,
                    dayOfWeek: horario.dayOfWeek,
                    startTime: horario.startTime,
                }).select('_id'),
                Horario.findOne({
                    school_id: schoolId,
                    teacherId: horario.teacherId,
                    termId: targetTermId,
                    dayOfWeek: horario.dayOfWeek,
                    startTime: horario.startTime,
                }).select('_id classId'),
            ]);

            if (classConflict) {
                throw new Error('Conflito: já existe aula para esta turma no período de destino.');
            }

            if (teacherConflict) {
                throw new Error('Conflito: professor já possui aula no mesmo dia e horário no período de destino.');
            }
        }
    }

    _buildCopyPayload(horario, { targetTermId, schoolId, origin, copyBatchId, performedByUserId }) {
        return {
            termId: targetTermId,
            classId: horario.classId,
            school_id: schoolId,
            subjectId: horario.subjectId,
            teacherId: horario.teacherId,
            dayOfWeek: horario.dayOfWeek,
            startTime: horario.startTime,
            endTime: horario.endTime,
            room: horario.room,
            scheduleOrigin: origin,
            sourceTermId: horario.termId,
            sourceHorarioId: horario._id,
            copyBatchId,
            ...(origin === 'materialized_override'
                ? {
                    materializedAt: new Date(),
                    materializedBy: performedByUserId || null,
                }
                : {}),
        };
    }

    async _copyPeriodSchedule({
        sourceTermId,
        targetTermId,
        classId,
        schoolId,
        overwrite = false,
        origin = 'copied',
        performedByUserId = null,
    }) {
        const { sourceTerm, targetTerm } = await this._validateCopyContext({
            sourceTermId,
            targetTermId,
            classId,
            schoolId,
        });

        const targetExists = await Horario.exists({
            school_id: schoolId,
            termId: targetTermId,
            classId,
        });

        if (targetExists && !overwrite) {
            return {
                copiedCount: 0,
                status: 'already_exists',
                message: 'O período de destino já possui grade para esta turma. Nenhum horário foi duplicado.',
                sourceTermId: normalizeId(sourceTerm._id),
                targetTermId: normalizeId(targetTerm._id),
                copyBatchId: null,
                horarios: [],
            };
        }

        if (targetExists && overwrite) {
            return {
                copiedCount: 0,
                status: 'already_exists',
                message: 'O perÃ­odo de destino jÃ¡ possui grade para esta turma. Para preservar histÃ³rico, nenhum horÃ¡rio existente foi removido.',
                sourceTermId: normalizeId(sourceTerm._id),
                targetTermId: normalizeId(targetTerm._id),
                copyBatchId: null,
                horarios: [],
            };
        }

        const sourceHorarios = await Horario.find({
            school_id: schoolId,
            termId: sourceTermId,
            classId,
        }).sort({ dayOfWeek: 1, startTime: 1 });

        if (sourceHorarios.length === 0) {
            return {
                copiedCount: 0,
                status: 'source_empty',
                message: 'Nenhum horário encontrado no período de origem para esta turma.',
                sourceTermId: normalizeId(sourceTerm._id),
                targetTermId: normalizeId(targetTerm._id),
                copyBatchId: null,
                horarios: [],
            };
        }

        await this._assertNoCopyConflicts({
            sourceHorarios,
            targetTermId,
            classId,
            schoolId,
        });

        const copyBatchId = crypto.randomUUID();
        const payload = sourceHorarios.map((horario) =>
            this._buildCopyPayload(horario, {
                targetTermId,
                schoolId,
                origin,
                copyBatchId,
                performedByUserId,
            })
        );

        const created = await Horario.insertMany(payload);
        const horarios = await Horario.find({ _id: { $in: created.map((item) => item._id) } })
            .populate(defaultPopulation)
            .sort({ dayOfWeek: 1, startTime: 1 });

        return {
            copiedCount: horarios.length,
            status: 'copied',
            message: `${horarios.length} horário(s) copiado(s) com sucesso.`,
            sourceTermId: normalizeId(sourceTerm._id),
            targetTermId: normalizeId(targetTerm._id),
            copyBatchId,
            horarios,
        };
    }

    async copyPeriodSchedule(data, schoolId, actor = {}) {
        return this._copyPeriodSchedule({
            ...data,
            schoolId,
            overwrite: isTruthy(data.overwrite),
            origin: 'copied',
            performedByUserId: normalizeId(actor.id || actor._id),
        });
    }

    async materializePeriodSchedule(data, schoolId, actor = {}) {
        const { targetTermId, classId } = data;
        let { sourceTermId } = data;

        if (!targetTermId || !classId) {
            throw new Error('targetTermId e classId são obrigatórios.');
        }

        const existing = await Horario.find({
            school_id: schoolId,
            termId: targetTermId,
            classId,
        })
            .populate(defaultPopulation)
            .sort({ dayOfWeek: 1, startTime: 1 });

        if (existing.length > 0) {
            return {
                copiedCount: 0,
                status: 'already_materialized',
                message: 'Este bimestre já possui grade própria para a turma.',
                sourceTermId: sourceTermId || null,
                targetTermId,
                copyBatchId: null,
                horarios: existing,
            };
        }

        if (!sourceTermId) {
            const targetTerm = await Term.findOne({ _id: targetTermId, school_id: schoolId }).lean();
            if (!targetTerm) {
                throw new Error('Período de destino não encontrado ou não pertence à sua escola.');
            }

            const { term: baseTerm } = await this._findBaseScheduleForTerm({
                query: { classId },
                targetTerm,
                schoolId,
            });

            if (!baseTerm) {
                return {
                    copiedCount: 0,
                    status: 'source_empty',
                    message: 'Não há grade herdada disponível para materializar neste bimestre.',
                    sourceTermId: null,
                    targetTermId,
                    copyBatchId: null,
                    horarios: [],
                };
            }

            sourceTermId = normalizeId(baseTerm._id);
        }

        return this._copyPeriodSchedule({
            sourceTermId,
            targetTermId,
            classId,
            schoolId,
            overwrite: false,
            origin: 'materialized_override',
            performedByUserId: normalizeId(actor.id || actor._id),
        });
    }

    /**
     * Valida se todas as referências pertencem à escola do usuário E se o professor pode lecionar a disciplina.
     */
    async _validateReferences(data, schoolId) {
        const { teacherId, subjectId, classId, termId } = data;

        // 1. Valida Habilitação do Professor (já faz parte da validação anterior)
        await this._validateTeacherAbility(teacherId, subjectId);

        // 2. Valida Referências de Turma, Disciplina e Período (Scope Check)
        const [classExists, subjectExists, termExists] = await Promise.all([
            Class.findOne({ _id: classId, school_id: schoolId }),
            Subject.findOne({ _id: subjectId, school_id: schoolId }),
            Term.findOne({ _id: termId, school_id: schoolId }),
        ]);

        if (!classExists) throw new Error('Turma não encontrada ou não pertence à sua escola.');
        if (!subjectExists) throw new Error('Disciplina não encontrada ou não pertence à sua escola.');
        if (!termExists) throw new Error('Período (Bimestre) não encontrado ou não pertence à sua escola.');
        
        // [OPCIONAL] Se Turma, Disciplina e Período já têm school_id, 
        // a aula é implicitamente segura. Mas o check é bom.
    }

    /**
     * Valida se um professor está habilitado para lecionar uma disciplina. (Mantido)
     */
    async _validateTeacherAbility(teacherId, subjectId) {
        const teacher = await User.findById(teacherId).populate({
            path: 'staffProfiles',
            model: 'StaffProfile'
        });

        if (!teacher || !teacher.staffProfiles || teacher.staffProfiles.length === 0) {
            throw new Error('Professor não encontrado ou não possui um perfil de funcionário.');
        }

        const isEnabled = teacher.staffProfiles.some(profile => 
            profile.enabledSubjects && profile.enabledSubjects.includes(subjectId)
        );

        if (!isEnabled) {
            throw new Error(`Professor(a) ${teacher.fullName} não está habilitado(a) para lecionar esta disciplina.`);
        }
        
        return true; 
    }

    /**
     * Cria múltiplos horários (em lote).
     */
    async createMultipleHorarios(horariosData, schoolId) {
        if (!Array.isArray(horariosData) || horariosData.length === 0) {
            throw new Error('Dados de entrada inválidos.');
        }

        const horariosWithSchool = horariosData.map(aula => ({
            ...aula,
            school_id: schoolId // Injeta o ID da escola
        }));

        // 1. Valida todas as referências ANTES de inserir (a validação de professor é mais pesada)
        for (const aula of horariosWithSchool) {
             await this._validateReferences(aula, schoolId);
             
             // --- CORREÇÃO DE CONFLITO EM LOTE ---
             // Antes de inserir, verifica se JÁ existe conflito NO MESMO PERÍODO
             // (O insertMany com ordered: false pegaria pelo unique index, mas precisamos validar a lógica do termId)
             const conflict = await Horario.findOne({
                 school_id: schoolId,
                 classId: aula.classId,
                 termId: aula.termId, // Valida no mesmo termo!
                 dayOfWeek: aula.dayOfWeek,
                 startTime: aula.startTime
             });
             
             if (conflict) {
                 throw new Error(`Conflito: Já existe aula na ${aula.dayOfWeek} às ${aula.startTime} neste período.`);
             }
        }

        // 2. Inserir no Banco
        try {
            const createdHorarios = await Horario.insertMany(horariosWithSchool, { ordered: false });
            
            // 3. Popular e retornar os criados com sucesso
            const createdIds = createdHorarios.map(h => h._id);
            const populatedHorarios = await Horario.find({ _id: { $in: createdIds } })
                                                   .populate(defaultPopulation);
                                                   
            return populatedHorarios;

        } catch (error) {
            // Lida com erros de duplicata
            if (error.name === 'MongoBulkWriteError' && error.code === 11000) {
                console.warn('Aviso de BulkWrite: Alguns horários duplicados foram ignorados.');
                if (error.result && error.result.insertedIds && error.result.insertedIds.length > 0) {
                    const insertedIds = error.result.insertedIds.map(doc => doc._id);
                    const populated = await Horario.find({ _id: { $in: insertedIds } }).populate(defaultPopulation);
                    return populated;
                }
                return []; 
            }
            throw error;
        }
    }

    /**
     * Cria um novo horário (aula) para uma turma.
     */
    async createHorario(horarioData, schoolId) {
        const dataToCreate = { ...horarioData, school_id: schoolId };

        // 1. Validações cruzadas de segurança e habilidade
        await this._validateReferences(dataToCreate, schoolId);

        // --- CORREÇÃO MANUAL DE CONFLITO ---
        // O índice único do banco pode não estar cobrindo o termId se foi criado antigo.
        // Vamos forçar a verificação aqui.
        const conflict = await Horario.findOne({
            school_id: schoolId,
            classId: dataToCreate.classId,
            termId: dataToCreate.termId, // <--- O PULO DO GATO
            dayOfWeek: dataToCreate.dayOfWeek,
            startTime: dataToCreate.startTime
        });

        if (conflict) {
             throw new Error('Conflito de horário: Já existe uma aula cadastrada para esta turma, neste dia e horário (neste período).');
        }

        // 2. Salva no Banco
        try {
            const newHorario = new Horario(dataToCreate);
            await newHorario.save();
            
            await newHorario.populate(defaultPopulation);
            return newHorario;
            
        } catch (error) {
            if (error.code === 11000) {
                // Se cair aqui, é porque o índice único do banco pegou algo que nossa query manual não viu
                throw new Error(`Conflito de horário (Banco): Já existe uma aula cadastrada.`);
            }
            throw error;
        }
    }

    /**
     * Busca horários com base em filtros, limitados pela escola.
     */
    async getHorarios(filter = {}, schoolId) {
        if (isTruthy(filter.resolveInherited)) {
            return this.resolveEffectiveHorarios(filter, schoolId);
        }

        filter = this._sanitizeFilter(filter);

        // Filtro obrigatório por escola
        const query = { ...filter, school_id: schoolId }; 

        return await Horario.find(query)
            .populate(defaultPopulation)
            .sort({ dayOfWeek: 1, startTime: 1 });
    }

    /**
     * Busca um horário específico por ID, limitado pela escola.
     */
    async getHorarioById(id, schoolId) {
        // Busca o horário garantindo que pertence à escola
        const horario = await Horario.findOne({ _id: id, school_id: schoolId }).populate(defaultPopulation);

        if (!horario) {
            throw new Error('Horário não encontrado ou não pertence à sua escola.');
        }
        return horario;
    }

    /**
     * Atualiza um horário.
     */
    async updateHorario(id, updateData, schoolId) {
        const existingHorario = await Horario.findOne({ _id: id, school_id: schoolId });
        if (!existingHorario) {
            throw new Error('Horário não encontrado ou não pertence à sua escola.');
        }
        
        // Se houver tentativa de mudar o teacher, subject, class ou term, validamos as novas referências
        if (updateData.teacherId || updateData.subjectId || updateData.classId || updateData.termId) {
            
            const combinedData = {
                teacherId: updateData.teacherId || existingHorario.teacherId,
                subjectId: updateData.subjectId || existingHorario.subjectId,
                classId: updateData.classId || existingHorario.classId,
                termId: updateData.termId || existingHorario.termId,
            };

            await this._validateReferences(combinedData, schoolId);
        }

        // Validação Manual de Conflito na Atualização
        if (updateData.startTime || updateData.dayOfWeek) {
             const checkTerm = updateData.termId || existingHorario.termId;
             const checkClass = updateData.classId || existingHorario.classId;
             const checkDay = updateData.dayOfWeek || existingHorario.dayOfWeek;
             const checkTime = updateData.startTime || existingHorario.startTime;

             const conflict = await Horario.findOne({
                 school_id: schoolId,
                 classId: checkClass,
                 termId: checkTerm,
                 dayOfWeek: checkDay,
                 startTime: checkTime,
                 _id: { $ne: id } // Exclui o próprio
             });

             if (conflict) {
                 throw new Error('Conflito na atualização: Horário já ocupado neste período.');
             }
        }
        
        // Garante que o school_id não pode ser alterado via updateData
        delete updateData.school_id;

        try {
            const updatedHorario = await Horario.findOneAndUpdate(
                { _id: id, school_id: schoolId }, // Query de atualização segura
                updateData, 
                { new: true, runValidators: true }
            ).populate(defaultPopulation);
            
            return updatedHorario;

        } catch (error) {
            if (error.code === 11000) {
                throw new Error('Conflito de horário: A atualização resultou em um horário duplicado (Turma/Dia/Hora).');
            }
            throw error;
        }
    }

    /**
     * Deleta um horário.
     */
    async deleteHorario(id, schoolId) {
        const deletedHorario = await Horario.findOneAndDelete({ _id: id, school_id: schoolId }).populate(defaultPopulation);
        if (!deletedHorario) {
            throw new Error('Horário não encontrado ou não pertence à sua escola para deletar.');
        }
        return deletedHorario;
    }
}

module.exports = new HorarioService();
