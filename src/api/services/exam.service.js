const Exam = require('../models/exam.model');
const ExamSheet = require('../models/exam-sheet.model');
const Enrollment = require('../models/enrollment.model');
const Evaluation = require('../models/evaluation.model');
const ClassGrade = require('../models/grade.model');
const Class = require('../models/class.model');
const Periodo = require('../models/periodo.model');
const SchoolYearService = require('./schoolyear.service');
const mongoose = require('mongoose');
const crypto = require('crypto');
const appEmitter = require('../../loaders/eventEmitter');
const {
    ensureClassAccess,
    isPrivilegedActor,
    extractId,
    createHttpError,
} = require('./classAccess.service');

const getObjectIdString = (value) => {
    if (!value) return '';
    if (value._id) return String(value._id);
    return String(value);
};

const toBooleanQuery = (value) => {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === null) return false;
    return ['true', '1', 'yes', 'sim'].includes(String(value).toLowerCase());
};

class ExamService {
    _ensureValidObjectId(value, label) {
        if (!value || !mongoose.Types.ObjectId.isValid(value)) {
            throw createHttpError(`${label} invalido.`, 400);
        }
    }

    async _getReadableExam(examId, schoolId, actor) {
        this._ensureValidObjectId(examId, 'ID da prova');

        const exam = await Exam.findOne({ _id: examId, school_id: schoolId })
            .populate('class_id', 'name school_id')
            .populate('subject_id', 'name')
            .populate('teacher_id', 'fullName name')
            .populate('termId', 'titulo dataInicio dataFim anoLetivoId')
            .lean();

        if (!exam) {
            throw createHttpError('Prova nao encontrada.', 404);
        }

        const classId = getObjectIdString(exam.class_id);
        await ensureClassAccess(actor, schoolId, classId);

        if (!isPrivilegedActor(actor)) {
            const actorId = extractId(actor?.id || actor?._id);
            const examTeacherId = getObjectIdString(exam.teacher_id);
            if (!actorId || actorId !== examTeacherId) {
                throw createHttpError('Prova nao encontrada ou sem permissao de acesso.', 404);
            }
        }

        return exam;
    }

    _normalizeStoredAnswer(answer, examQuestion = null) {
        const rawNumber = answer?.questionNumber ?? answer?.question ?? null;
        const questionNumber = Number(rawNumber);
        const markedOption =
            answer?.markedOption ?? answer?.studentAnswer ?? answer?.studentMarked ?? null;
        const correctAnswer = answer?.correctAnswer ?? examQuestion?.correctAnswer ?? null;
        const rawStatus = String(answer?.status || '').trim().toLowerCase();
        const hasCorrectness = typeof answer?.isCorrect === 'boolean';

        let status = 'unavailable';
        if (rawStatus === 'multiple' || rawStatus === 'ambiguous' || rawStatus === 'uncertain' || rawStatus === 'not_detected') {
            status = rawStatus;
        } else if (rawStatus === 'blank' || !markedOption) {
            status = 'blank';
        } else if (hasCorrectness) {
            status = answer.isCorrect ? 'correct' : 'incorrect';
        } else if (rawStatus) {
            status = rawStatus;
        }

        return {
            questionNumber: Number.isFinite(questionNumber) ? questionNumber : null,
            questionText: examQuestion?.text || null,
            markedOption: markedOption || null,
            correctAnswer: correctAnswer || null,
            isCorrect: hasCorrectness ? answer.isCorrect : null,
            status,
            confidence: typeof answer?.confidence === 'number' ? answer.confidence : null,
            maxPoints: typeof examQuestion?.weight === 'number' ? examQuestion.weight : null,
            earnedPoints:
                status === 'correct' && typeof examQuestion?.weight === 'number'
                    ? examQuestion.weight
                    : status === 'correct'
                        ? 1
                        : 0,
        };
    }

    _getStoredAnswerExamQuestion(exam, questionNumber) {
        if (!Number.isFinite(questionNumber) || questionNumber <= 0) return null;
        const questions = Array.isArray(exam?.questions) ? exam.questions : [];
        const orderedQuestions =
            exam?.correctionType === 'BUBBLE_SHEET'
                ? questions.filter((question) => question?.type === 'OBJECTIVE')
                : questions;
        return orderedQuestions[questionNumber - 1] || null;
    }

    _buildQuestionInsights(sheets, exam) {
        if (exam.correctionType !== 'BUBBLE_SHEET') {
            return {
                available: false,
                correctedSheetsWithAnswers: 0,
                averageAccuracy: null,
                questions: [],
            };
        }

        const insightByQuestion = new Map();
        const sheetsWithAnswers = sheets.filter(
            (sheet) => Array.isArray(sheet?.answers) && sheet.answers.length > 0
        );

        for (const sheet of sheetsWithAnswers) {
            for (const answer of sheet.answers) {
                const number = Number(answer?.questionNumber ?? answer?.question ?? 0);
                if (!Number.isFinite(number) || number <= 0) continue;

                const examQuestion = this._getStoredAnswerExamQuestion(exam, number);
                const normalized = this._normalizeStoredAnswer(answer, examQuestion);
                const current = insightByQuestion.get(number) || {
                    questionNumber: number,
                    questionText: examQuestion?.text || null,
                    correct: 0,
                    wrong: 0,
                    blank: 0,
                    unavailable: 0,
                    responses: 0,
                };

                current.responses += 1;
                if (normalized.status === 'correct') {
                    current.correct += 1;
                } else if (normalized.status === 'blank') {
                    current.blank += 1;
                } else if (
                ['incorrect', 'multiple', 'ambiguous', 'uncertain', 'not_detected'].includes(normalized.status)
                ) {
                    current.wrong += 1;
                } else {
                    current.unavailable += 1;
                }

                insightByQuestion.set(number, current);
            }
        }

        const questions = [...insightByQuestion.values()]
            .map((item) => ({
                ...item,
                correctPercentage:
                    item.responses > 0
                        ? Math.round((item.correct / item.responses) * 10000) / 100
                        : null,
                errorPercentage:
                    item.responses > 0
                        ? Math.round(((item.wrong + item.blank) / item.responses) * 10000) / 100
                        : null,
            }))
            .sort((left, right) => left.questionNumber - right.questionNumber);

        const totalResponses = questions.reduce((sum, item) => sum + item.responses, 0);
        const totalCorrect = questions.reduce((sum, item) => sum + item.correct, 0);

        return {
            available: questions.length > 0,
            correctedSheetsWithAnswers: sheetsWithAnswers.length,
            averageAccuracy:
                totalResponses > 0
                    ? Math.round((totalCorrect / totalResponses) * 10000) / 100
                    : null,
            questions,
        };
    }

    _buildStoredAnswerSummary(sheet, exam) {
        const answers = Array.isArray(sheet?.answers) ? sheet.answers : [];
        if (answers.length === 0 || exam.correctionType !== 'BUBBLE_SHEET') {
            return {
                correctAnswers: null,
                wrongAnswers: null,
                blankAnswers: null,
                detailsAvailable: false,
            };
        }

        const normalized = answers.map((answer) => {
            const number = Number(answer?.questionNumber ?? answer?.question ?? 0);
            const examQuestion = this._getStoredAnswerExamQuestion(exam, number);
            return this._normalizeStoredAnswer(answer, examQuestion);
        });

        return {
            correctAnswers: normalized.filter((answer) => answer.status === 'correct').length,
            wrongAnswers: normalized.filter((answer) =>
                ['incorrect', 'multiple', 'ambiguous', 'uncertain', 'not_detected'].includes(answer.status)
            ).length,
            blankAnswers: normalized.filter((answer) => answer.status === 'blank').length,
            detailsAvailable: normalized.length > 0,
        };
    }

    _finiteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    _isDateInsidePeriod(date, period) {
        if (!date || !period?.dataInicio || !period?.dataFim) return true;
        const referenceDate = new Date(date);
        const startDate = new Date(period.dataInicio);
        const endDate = new Date(period.dataFim);
        if (
            Number.isNaN(referenceDate.getTime()) ||
            Number.isNaN(startDate.getTime()) ||
            Number.isNaN(endDate.getTime())
        ) {
            return true;
        }
        return referenceDate >= startDate && referenceDate <= endDate;
    }

    _serializeTermContext(period, resolution) {
        return {
            termId: period?._id ? getObjectIdString(period._id) : null,
            termName: period?.titulo || null,
            termResolution: {
                status: resolution?.status || 'missing',
                source: resolution?.source || 'none',
                resolvedAt: resolution?.resolvedAt || new Date(),
                message: resolution?.message || null,
            },
        };
    }

    async _findPeriodByDate({ schoolId, applicationDate, schoolYearId = null }) {
        const referenceDate = applicationDate ? new Date(applicationDate) : new Date();
        if (Number.isNaN(referenceDate.getTime())) return null;

        const query = {
            school_id: schoolId,
            tipo: 'Letivo',
            dataInicio: { $lte: referenceDate },
            dataFim: { $gte: referenceDate },
        };

        if (schoolYearId) {
            query.anoLetivoId = schoolYearId;
        }

        return Periodo.findOne(query).sort({ dataInicio: -1 }).lean();
    }

    async resolveExamTermContext({
        schoolId,
        termId = null,
        applicationDate = null,
        schoolYearId = null,
        legacy = false,
    } = {}) {
        const now = new Date();

        if (termId) {
            if (!mongoose.Types.ObjectId.isValid(termId)) {
                throw createHttpError('termId invalido.', 400);
            }

            const explicitPeriod = await Periodo.findOne({
                _id: termId,
                school_id: schoolId,
            }).lean();

            if (!explicitPeriod) {
                throw createHttpError('Periodo da prova nao encontrado.', 400);
            }

            const inferredByDate = applicationDate
                ? await this._findPeriodByDate({ schoolId, applicationDate, schoolYearId })
                : null;
            const dateMatchesExplicit = this._isDateInsidePeriod(applicationDate, explicitPeriod);
            const conflictsWithDate =
                inferredByDate &&
                getObjectIdString(inferredByDate._id) !== getObjectIdString(explicitPeriod._id);

            return this._serializeTermContext(explicitPeriod, {
                status: dateMatchesExplicit && !conflictsWithDate ? 'explicit' : 'conflict',
                source: 'payload',
                resolvedAt: now,
                message:
                    dateMatchesExplicit && !conflictsWithDate
                        ? null
                        : 'O periodo informado diverge da data de aplicacao da prova.',
            });
        }

        const periodByApplicationDate = await this._findPeriodByDate({
            schoolId,
            applicationDate,
            schoolYearId,
        });

        if (periodByApplicationDate) {
            return this._serializeTermContext(periodByApplicationDate, {
                status: 'inferred',
                source: legacy ? 'legacy_inference' : 'applicationDate',
                resolvedAt: now,
                message: legacy
                    ? 'Periodo inferido pela data de aplicacao de uma prova antiga.'
                    : null,
            });
        }

        if (legacy) {
            return this._serializeTermContext(null, {
                status: 'missing',
                source: 'legacy_inference',
                resolvedAt: now,
                message: 'Nao foi possivel inferir o periodo da prova antiga pela data de aplicacao.',
            });
        }

        const currentPeriod = await this._findPeriodByDate({
            schoolId,
            applicationDate: new Date(),
            schoolYearId,
        });

        if (currentPeriod) {
            return this._serializeTermContext(currentPeriod, {
                status: 'inferred',
                source: 'current_period',
                resolvedAt: now,
                message: 'Periodo resolvido pelo periodo letivo atual.',
            });
        }

        return this._serializeTermContext(null, {
            status: 'missing',
            source: 'none',
            resolvedAt: now,
            message: 'Nao foi possivel resolver o periodo da prova.',
        });
    }

    async _resolveStoredExamTermContext(exam, schoolId) {
        const source = typeof exam?.toObject === 'function' ? exam.toObject() : exam;
        const termId = source?.termId?._id || source?.termId || null;
        const populatedTerm = source?.termId?._id ? source.termId : null;

        if (termId && populatedTerm) {
            const context = await this.resolveExamTermContext({
                schoolId,
                termId,
                applicationDate: source.applicationDate,
                schoolYearId: source.schoolyear_id,
            });
            return {
                ...context,
                termName: populatedTerm.titulo || context.termName,
            };
        }

        return this.resolveExamTermContext({
            schoolId,
            termId,
            applicationDate: source?.applicationDate,
            schoolYearId: source?.schoolyear_id,
            legacy: !termId,
        });
    }

    _logInfo(message, meta = null) {
        if (meta) {
            console.log(`[EXAM SERVICE] ${message}`, meta);
            return;
        }
        console.log(`[EXAM SERVICE] ${message}`);
    }

    _logExamPerfStep({ enabled = false, requestId, endpoint, step, durationMs, count = null, extra = null }) {
        if (!enabled && !['true', '1', 'yes', 'sim'].includes(String(process.env.EXAM_PERF_DEBUG || '').toLowerCase())) {
            return;
        }
        console.log('[ExamPerfAPI][Step]', {
            requestId,
            endpoint,
            step,
            durationMs,
            count,
            ...(extra || {}),
        });
    }

    async _measureExamPerfStep({ enabled = false, requestId, endpoint, step, countFromResult = null }, action) {
        const startedAt = Date.now();
        const result = await action();
        const count = typeof countFromResult === 'function'
            ? countFromResult(result)
            : Array.isArray(result)
                ? result.length
                : countFromResult;
        this._logExamPerfStep({
            enabled,
            requestId,
            endpoint,
            step,
            durationMs: Date.now() - startedAt,
            count,
        });
        return result;
    }

    _logWarn(message, meta = null) {
        if (meta) {
            console.warn(`[EXAM SERVICE WARN] ${message}`, meta);
            return;
        }
        console.warn(`[EXAM SERVICE WARN] ${message}`);
    }

    _logError(message, meta = null) {
        if (meta) {
            console.error(`[EXAM SERVICE ERROR] ${message}`, meta);
            return;
        }
        console.error(`[EXAM SERVICE ERROR] ${message}`);
    }

    _getObjectiveQuestions(exam) {
        const questions = Array.isArray(exam?.questions) ? exam.questions : [];
        const objectiveQuestions = questions.filter((q) => q && q.type === 'OBJECTIVE');

        this._logInfo('Filtrando questões objetivas da prova.', {
            totalQuestions: questions.length,
            objectiveQuestions: objectiveQuestions.length,
            examId: exam?._id?.toString?.() || null,
        });

        return objectiveQuestions;
    }

    _ensureBubbleSheetSupport(exam) {
        const objectiveQuestions = this._getObjectiveQuestions(exam);

        if (objectiveQuestions.length <= 0) {
            throw new Error('A prova do tipo BUBBLE_SHEET precisa ter ao menos 1 questão objetiva.');
        }

        if (objectiveQuestions.length > 40) {
            throw new Error(
                'A versao atual da leitura OMR suporta ate 40 questoes objetivas por prova.'
            );
        }

        return objectiveQuestions;
    }

    _buildBubbleSheetOmrLayout({ objectiveQuestionsCount }) {
        const totalQuestions = Number(objectiveQuestionsCount || 0);

        if (totalQuestions <= 0) {
            this._logWarn('Não foi possível construir layout OMR: totalQuestions <= 0.');
            return null;
        }

        if (totalQuestions > 40) {
            throw new Error(
                'A versao atual do layout OMR suporta ate 40 questoes objetivas.'
            );
        }

        const blocks = totalQuestions <= 20
            ? [
                {
                    startQuestion: 1,
                    endQuestion: totalQuestions,
                    columns: 5,
                },
            ]
            : [
                {
                    startQuestion: 1,
                    endQuestion: 20,
                    columns: 5,
                },
                {
                    startQuestion: 21,
                    endQuestion: totalQuestions,
                    columns: 5,
                },
            ];

        const layout = {
            version: 'ACADEMYHUB_OMR_V2',
            layoutVersion: 'academyhub-omr-v2',
            generatedAt: new Date().toISOString(),
            correctionType: 'BUBBLE_SHEET',
            totalQuestions,
            totalOptionsPerQuestion: 5,
            choices: ['A', 'B', 'C', 'D', 'E'],
            blocks,
            engine: {
                name: 'ACADEMYHUB_PYTHON_V2',
                supportsDynamicQuestions: true,
                supportsTwoColumns: true,
                maxSupportedQuestions: 40,
            },
        };

        this._logInfo('Layout OMR construído com sucesso.', {
            version: layout.version,
            totalQuestions: layout.totalQuestions,
        });

        return layout;
    }

    async _attachOmrLayoutToExamIfNeeded(exam) {
        if (!exam) {
            this._logWarn('_attachOmrLayoutToExamIfNeeded chamado sem exam.');
            return exam;
        }

        exam.settings = exam.settings || {};

        if (exam.correctionType !== 'BUBBLE_SHEET') {
            this._logInfo('Prova não é do tipo BUBBLE_SHEET. Limpando layout OMR se existir.', {
                examId: exam._id?.toString?.() || null,
                correctionType: exam.correctionType,
            });

            exam.settings.omrLayout = null;
            return exam;
        }

        const objectiveQuestions = this._ensureBubbleSheetSupport(exam);
        const omrLayout = this._buildBubbleSheetOmrLayout({
            objectiveQuestionsCount: objectiveQuestions.length,
        });

        exam.settings.omrLayout = omrLayout;

        this._logInfo('Layout OMR anexado à prova.', {
            examId: exam._id?.toString?.() || null,
            totalObjectiveQuestions: objectiveQuestions.length,
            hasLayout: !!omrLayout,
        });

        return exam;
    }

    async getExamOmrLayout(examId, schoolId) {
        this._logInfo('Buscando layout OMR da prova.', { examId, schoolId });

        const exam = await Exam.findOne({ _id: examId, school_id: schoolId });
        if (!exam) {
            this._logError('Prova não encontrada ao buscar layout OMR.', { examId, schoolId });
            throw new Error('Prova não encontrada.');
        }

        if (exam.correctionType !== 'BUBBLE_SHEET') {
            this._logWarn('Tentativa de obter layout OMR para prova de tipo incorreto.', {
                examId,
                correctionType: exam.correctionType,
            });
            throw new Error('A prova informada não é do tipo BUBBLE_SHEET.');
        }

        exam.settings = exam.settings || {};

        if (!exam.settings.omrLayout) {
            this._logWarn('Prova sem layout OMR persistido. Gerando automaticamente.', {
                examId,
                schoolId,
            });
            await this._attachOmrLayoutToExamIfNeeded(exam);
            await exam.save();
        }

        return exam.settings.omrLayout;
    }

    _normalizeOmrAnswerStatus(answer = {}) {
        const rawStatus = String(answer.status || answer.debugStatus || '').trim().toLowerCase();
        if (rawStatus === 'multiple') return 'multiple';
        if (rawStatus === 'blank') return 'blank';
        if (rawStatus === 'ambiguous' || rawStatus === 'uncertain' || rawStatus === 'low_confidence') {
            return 'uncertain';
        }
        if (rawStatus === 'not_detected' || rawStatus === 'anchor_failed' || rawStatus === 'out_of_bounds') {
            return 'not_detected';
        }
        return 'marked';
    }

    _normalizeOmrStudentAnswer(answer = {}, omrStatus = null) {
        const marked =
            answer.marked ??
            answer.selected ??
            answer.answer ??
            answer.studentAnswer ??
            answer.markedOption ??
            null;

        if (omrStatus === 'blank') return null;
        if (omrStatus === 'multiple') return 'MULTIPLE';
        if (omrStatus === 'uncertain') return 'UNCERTAIN';
        if (omrStatus === 'not_detected') return 'NOT_DETECTED';
        return marked || null;
    }

    _roundGrade(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return 0;
        return Math.round(number * 10000) / 10000;
    }

    _resolveExamMaxGrade(exam, fallback = null) {
        const examTotalValue = this._finiteNumber(exam?.totalValue);
        if (examTotalValue !== null && examTotalValue > 0) {
            return examTotalValue;
        }

        const questions = Array.isArray(exam?.questions) ? exam.questions : [];
        const objectiveQuestions = questions.filter((question) => question?.type === 'OBJECTIVE');
        const sourceQuestions = objectiveQuestions.length ? objectiveQuestions : questions;
        const weightedTotal = sourceQuestions.reduce((sum, question) => {
            const weight = this._finiteNumber(question?.weight);
            return sum + (weight !== null && weight > 0 ? weight : 1);
        }, 0);

        if (weightedTotal > 0) {
            return this._roundGrade(weightedTotal);
        }

        const fallbackValue = this._finiteNumber(fallback);
        if (fallbackValue !== null && fallbackValue > 0) {
            return fallbackValue;
        }

        return 10;
    }

    _validateGradeWithinMax({ grade, objectiveGrade = null, maxGrade }) {
        const resolvedMaxGrade = this._finiteNumber(maxGrade);
        const normalizedGrade = this._finiteNumber(grade);
        const normalizedObjectiveGrade = this._finiteNumber(objectiveGrade);

        if (resolvedMaxGrade === null || resolvedMaxGrade <= 0) {
            throw new Error('Valor maximo da prova invalido.');
        }

        if (normalizedGrade === null || normalizedGrade < 0 || normalizedGrade > resolvedMaxGrade) {
            throw new Error(`Digite uma nota valida entre 0 e ${this._roundGrade(resolvedMaxGrade)}.`);
        }

        if (
            normalizedObjectiveGrade !== null &&
            (normalizedObjectiveGrade < 0 || normalizedObjectiveGrade > resolvedMaxGrade)
        ) {
            throw new Error(`Digite uma nota objetiva valida entre 0 e ${this._roundGrade(resolvedMaxGrade)}.`);
        }

        return {
            grade: this._roundGrade(normalizedGrade),
            objectiveGrade:
                normalizedObjectiveGrade === null ? null : this._roundGrade(normalizedObjectiveGrade),
            maxGrade: this._roundGrade(resolvedMaxGrade),
        };
    }

    buildBubbleSheetCorrection(exam, omrAnswers) {
        const objectiveQuestions = this._ensureBubbleSheetSupport(exam);

        const maxGrade = this._resolveExamMaxGrade(exam);
        const totalQuestions = objectiveQuestions.length;
        const totalPossiblePoints = objectiveQuestions.reduce((sum, question) => {
            const weight = this._finiteNumber(question?.weight);
            return sum + (weight !== null && weight > 0 ? weight : 1);
        }, 0) || totalQuestions || 1;
        const pointsPerRawPoint = maxGrade / totalPossiblePoints;

        let rawEarnedPoints = 0;
        let correctCount = 0;
        let wrongCount = 0;
        let blankCount = 0;
        let multipleCount = 0;
        let uncertainCount = 0;
        let notDetectedCount = 0;
        const correctionDetails = [];
        const persistableAnswers = [];
        const questionResults = [];
        const studentAnswers = {};
        const answerKey = {};

        for (const answer of omrAnswers || []) {
            const qIndex = Number(answer.question || 0) - 1;
            if (qIndex < 0 || qIndex >= objectiveQuestions.length) {
                continue;
            }

            const dbQuestion = objectiveQuestions[qIndex];
            const questionNumber = qIndex + 1;
            const omrStatus = this._normalizeOmrAnswerStatus(answer);
            const studentAnswer = this._normalizeOmrStudentAnswer(answer, omrStatus);
            const markedOption = ['A', 'B', 'C', 'D', 'E'].includes(studentAnswer)
                ? studentAnswer
                : null;
            const correctAnswer = dbQuestion.correctAnswer ?? null;
            const isCorrect = !!markedOption && !!correctAnswer && markedOption === correctAnswer;
            const rawQuestionPoints = this._finiteNumber(dbQuestion.weight);
            const maxQuestionPoints = rawQuestionPoints !== null && rawQuestionPoints > 0
                ? rawQuestionPoints
                : 1;
            const normalizedQuestionPoints = this._roundGrade(maxQuestionPoints * pointsPerRawPoint);
            const earnedPoints = isCorrect ? normalizedQuestionPoints : 0;

            let questionStatus = 'wrong';
            if (isCorrect) {
                questionStatus = 'correct';
                correctCount += 1;
                rawEarnedPoints += maxQuestionPoints;
            } else if (omrStatus === 'blank') {
                questionStatus = 'blank';
                blankCount += 1;
            } else if (omrStatus === 'multiple') {
                questionStatus = 'multiple';
                multipleCount += 1;
            } else if (omrStatus === 'uncertain') {
                questionStatus = 'uncertain';
                uncertainCount += 1;
            } else if (omrStatus === 'not_detected') {
                questionStatus = 'not_detected';
                notDetectedCount += 1;
            } else {
                wrongCount += 1;
            }

            studentAnswers[String(questionNumber)] = studentAnswer;
            answerKey[String(questionNumber)] = correctAnswer;

            const markedAlternatives = Array.isArray(answer.markedAlternatives)
                ? answer.markedAlternatives.filter((item) => ['A', 'B', 'C', 'D', 'E'].includes(item))
                : [];

            const questionResult = {
                questionNumber,
                questionId: dbQuestion._id,
                correctAnswer,
                studentAnswer,
                isCorrect,
                status: questionStatus,
                omrStatus,
                confidence: answer.confidence ?? null,
                points: earnedPoints,
                maxPoints: normalizedQuestionPoints,
            };

            if (markedAlternatives.length) {
                questionResult.markedAlternatives = markedAlternatives;
            }

            questionResults.push(questionResult);

            correctionDetails.push({
                questionNumber,
                questionId: dbQuestion._id,
                studentMarked: studentAnswer,
                studentAnswer,
                correctAnswer,
                status: questionStatus,
                omrStatus,
                markedAlternatives,
                debugStatus: answer.debugStatus || null,
                reason: answer.reason || null,
                confidence: answer.confidence ?? null,
                isCorrect,
                earnedPoints,
                maxPoints: normalizedQuestionPoints,
            });

            persistableAnswers.push({
                question_id: dbQuestion._id,
                questionNumber,
                markedOption: studentAnswer,
                correctAnswer,
                status: omrStatus === 'marked' ? 'ok' : omrStatus,
                omrStatus,
                markedAlternatives,
                debugStatus: answer.debugStatus || null,
                reason: answer.reason || null,
                confidence: answer.confidence ?? null,
                isCorrect,
                earnedPoints,
                maxPoints: normalizedQuestionPoints,
            });
        }

        const objectiveGrade = this._roundGrade(rawEarnedPoints * pointsPerRawPoint);
        const totalGrade = objectiveGrade;
        const detailsPayload = {
            maxGrade,
            grade: totalGrade,
            objectiveGrade,
            totalQuestions,
            correctCount,
            wrongCount,
            blankCount,
            multipleCount,
            uncertainCount,
            notDetectedCount,
            studentAnswers,
            answerKey,
            questionResults,
        };

        return {
            grade: totalGrade,
            objectiveGrade,
            maxGrade,
            totalQuestions,
            correctCount,
            wrongCount,
            blankCount,
            multipleCount,
            uncertainCount,
            notDetectedCount,
            studentAnswers,
            answerKey,
            questionResults,
            correctionDetails,
            correctionDetailsPayload: detailsPayload,
            persistableAnswers,
        };
    }

    async verifyExamSheet(qrCodeUuid, schoolId) {
        this._logInfo('Verificando folha de prova por QR Code.', { qrCodeUuid, schoolId });

        const sheet = await ExamSheet.findOne({
            qr_code_uuid: qrCodeUuid,
            school_id: schoolId,
        }).populate('student_id');

        if (!sheet) {
            this._logWarn('QR Code inválido ao verificar folha.', { qrCodeUuid, schoolId });
            throw new Error('QR Code inválido.');
        }

        const exam = await Exam.findById(sheet.exam_id).populate('class_id subject_id');

        const omrLayout = exam.settings?.omrLayout || null;
        const objectiveQuestionsCount = Array.isArray(exam.questions)
            ? exam.questions.filter((question) => question?.type === 'OBJECTIVE').length
            : null;

        return {
            studentName: sheet.student_id.fullName || sheet.student_id.name,
            examTitle: exam.title,
            subjectName: exam.subject_id.name,
            className: exam.class_id.name,
            correctionType: exam.correctionType,
            examVersion: sheet.examVersion || 'STANDARD',
            examId: exam._id,
            maxGrade: this._resolveExamMaxGrade(exam),
            totalValue: this._resolveExamMaxGrade(exam),
            maxScore: this._resolveExamMaxGrade(exam),
            hasOmrLayout: !!omrLayout,
            totalQuestions: omrLayout?.totalQuestions ?? objectiveQuestionsCount,
            totalOptionsPerQuestion: omrLayout?.totalOptionsPerQuestion ?? null,
        };
    }

    /**
     * Cria a avaliação da prova no Diário de notas (uma por prova), para a
     * nota da correção aparecer no Diário e no app dos responsáveis.
     * Falhas não impedem salvar a prova, mas ficam registradas no log.
     */
    async _ensureGradebookEvaluation(exam, schoolId) {
        if (!exam || getObjectIdString(exam.settings?.evaluationId)) return exam;
        try {
            const termInfo = await SchoolYearService.findTermByDate(schoolId, exam.applicationDate);
            const evaluation = await Evaluation.create({
                school: schoolId,
                classInfo: exam.class_id?._id || exam.class_id,
                teacher: exam.teacher_id?._id || exam.teacher_id,
                subject: exam.subject_id?._id || exam.subject_id,
                title: exam.title,
                type: 'EXAM',
                date: exam.applicationDate,
                maxScore: exam.totalValue,
                term: termInfo.termName,
                schoolYear: termInfo.schoolYearId,
            });
            exam.settings = exam.settings || {};
            exam.settings.evaluationId = evaluation._id;
            if (typeof exam.markModified === 'function') exam.markModified('settings');
            await exam.save();
        } catch (error) {
            this._logWarn('Falha ao criar a avaliação da prova no Diário de notas.', {
                examId: getObjectIdString(exam._id),
                error: error?.message || String(error),
            });
        }
        return exam;
    }

    /** Mantém título, data e valor da avaliação do Diário iguais aos da prova. */
    async _syncGradebookEvaluation(exam, schoolId) {
        const evaluationId = getObjectIdString(exam?.settings?.evaluationId);
        if (!evaluationId) return;
        try {
            const termInfo = await SchoolYearService.findTermByDate(schoolId, exam.applicationDate);
            await Evaluation.updateOne(
                { _id: evaluationId, school: schoolId },
                {
                    $set: {
                        title: exam.title,
                        date: exam.applicationDate,
                        maxScore: exam.totalValue,
                        subject: exam.subject_id?._id || exam.subject_id,
                        term: termInfo.termName,
                        schoolYear: termInfo.schoolYearId,
                    },
                }
            );
        } catch (error) {
            this._logWarn('Falha ao atualizar a avaliação da prova no Diário de notas.', {
                examId: getObjectIdString(exam?._id),
                error: error?.message || String(error),
            });
        }
    }

    /** Lança (ou atualiza) no Diário a nota da folha corrigida. */
    async _syncSheetGradeToGradebook(exam, sheet, schoolId, grade) {
        const evaluationId = getObjectIdString(exam?.settings?.evaluationId);
        const value = Number(grade);
        if (!evaluationId || !sheet?.student_id || !Number.isFinite(value) || value < 0) return;
        try {
            const studentId = sheet.student_id?._id || sheet.student_id;
            const enrollment = await Enrollment.findOne({
                school_id: schoolId,
                class: exam.class_id?._id || exam.class_id,
                student: studentId,
                status: 'Ativa',
            }).select('_id').lean();
            if (!enrollment) {
                this._logWarn('Aluno sem matrícula ativa na turma; nota não lançada no Diário.', {
                    examId: getObjectIdString(exam._id),
                    studentId: getObjectIdString(studentId),
                });
                return;
            }
            await ClassGrade.findOneAndUpdate(
                { evaluation: evaluationId, student: studentId },
                {
                    $set: {
                        enrollment: enrollment._id,
                        value,
                        updatedAt: new Date(),
                    },
                },
                { upsert: true, setDefaultsOnInsert: true }
            );
        } catch (error) {
            this._logWarn('Falha ao lançar a nota da prova no Diário de notas.', {
                examId: getObjectIdString(exam?._id),
                sheetId: getObjectIdString(sheet?._id),
                error: error?.message || String(error),
            });
        }
    }

    async createExam(data, schoolId) {
        this._logInfo('Criando prova.', {
            schoolId,
            title: data?.title,
            correctionType: data?.correctionType,
        });

        const termContext = await this.resolveExamTermContext({
            schoolId,
            termId: data?.termId || data?.periodId || null,
            applicationDate: data?.applicationDate,
            schoolYearId: data?.schoolyear_id || data?.schoolYearId || null,
        });

        const exam = new Exam({
            ...data,
            school_id: schoolId,
            termId: termContext.termId || null,
            termResolution: termContext.termResolution,
            // Cada prova tem a sua própria avaliação no Diário (uma cópia não
            // pode herdar a da prova original).
            settings: { ...(data?.settings || {}), evaluationId: null },
        });
        await this._attachOmrLayoutToExamIfNeeded(exam);

        const savedExam = await exam.save();

        await this._ensureGradebookEvaluation(savedExam, schoolId);

        return await this.getExamByIdForResponse(savedExam._id, schoolId);
    }

    async updateExam(examId, updateData, schoolId) {
        this._logInfo('Atualizando prova.', { examId, schoolId });

        const exam = await Exam.findOne({ _id: examId, school_id: schoolId });
        if (!exam) {
            this._logError('Prova não encontrada para atualização.', { examId, schoolId });
            throw new Error('Prova não encontrada.');
        }

        Object.assign(exam, updateData);

        if (
            Object.prototype.hasOwnProperty.call(updateData, 'termId') ||
            Object.prototype.hasOwnProperty.call(updateData, 'periodId') ||
            Object.prototype.hasOwnProperty.call(updateData, 'applicationDate') ||
            Object.prototype.hasOwnProperty.call(updateData, 'schoolyear_id') ||
            Object.prototype.hasOwnProperty.call(updateData, 'schoolYearId')
        ) {
            const termContext = await this.resolveExamTermContext({
                schoolId,
                termId: updateData.termId || updateData.periodId || exam.termId || null,
                applicationDate: exam.applicationDate,
                schoolYearId: exam.schoolyear_id || updateData.schoolYearId || null,
            });
            exam.termId = termContext.termId || null;
            exam.termResolution = termContext.termResolution;
        }

        await this._attachOmrLayoutToExamIfNeeded(exam);

        const savedExam = await exam.save();
        await this._syncGradebookEvaluation(savedExam, schoolId);
        return await this.getExamByIdForResponse(savedExam._id, schoolId);
    }

    async duplicateExam(examId, schoolId) {
        this._logInfo('Duplicando prova.', { examId, schoolId });

        const original = await Exam.findOne({ _id: examId, school_id: schoolId }).lean();
        if (!original) {
            this._logError('Prova original não encontrada para duplicação.', { examId, schoolId });
            throw new Error('Prova não encontrada.');
        }

        delete original._id;
        original.title += ' [Cópia]';

        return await this.createExam(original, schoolId);
    }

    async getExamSheetsByExamId(examId, schoolId) {
        this._logInfo('Buscando folhas da prova.', { examId, schoolId });

        const exam = await Exam.findOne({ _id: examId, school_id: schoolId });
        if (!exam) {
            this._logError('Prova não encontrada ao listar folhas.', { examId, schoolId });
            throw new Error('Prova não encontrada.');
        }

        const sheets = await ExamSheet.find({
            exam_id: examId,
            school_id: schoolId,
        }).populate('student_id');

        return {
            examTitle: exam.title,
            correctionType: exam.correctionType,
            sheets: sheets.map((s) => ({
                id: s._id,
                qrCodeUuid: s.qr_code_uuid,
                studentName: s.student_id?.fullName || s.student_id?.name || 'Aluno sem nome',
                status: s.status,
                grade: s.grade,
            })),
        };
    }

    async _ensureClassBelongsToSchool(classId, schoolId) {
        const normalizedClassId = getObjectIdString(classId);
        if (!normalizedClassId) {
            throw new Error('Turma obrigatÃ³ria.');
        }

        const classDoc = await Class.findOne({
            _id: normalizedClassId,
            school_id: schoolId,
        });

        if (!classDoc) {
            throw new Error('Turma nÃ£o encontrada ou nÃ£o pertence Ã  escola.');
        }

        return classDoc;
    }

    _normalizeQuestionPreviewText(question) {
        if (!question) return null;

        if (question.image?.url && !question.text) {
            return 'QuestÃ£o com imagem';
        }

        const rawText = question.text || question.questionText || question.statement || '';
        const normalized = String(rawText)
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!normalized && question.image?.url) {
            return 'ConteÃºdo visual disponÃ­vel';
        }

        if (!normalized) return null;

        return normalized.length > 130 ? `${normalized.slice(0, 127).trim()}...` : normalized;
    }

    _buildExamPreviewPayload(exam) {
        const questions = Array.isArray(exam?.questions) ? exam.questions : [];
        const previewQuestions = questions
            .slice(0, 3)
            .map((question) => this._normalizeQuestionPreviewText(question))
            .filter(Boolean);

        return {
            questionsCount: questions.length,
            previewQuestions,
            hasImages: questions.some((question) => Boolean(question?.image?.url)),
            hasEssayQuestions: questions.some((question) => question?.type === 'DISSERTATIVE'),
            hasObjectiveQuestions: questions.some((question) => question?.type === 'OBJECTIVE'),
            contentPreviewAvailable: previewQuestions.length > 0,
        };
    }

    _serializeExamForList(exam, { includeQuestions = true } = {}) {
        const source = typeof exam?.toObject === 'function' ? exam.toObject() : { ...exam };
        const preview = this._buildExamPreviewPayload(source);

        if (!includeQuestions) {
            delete source.questions;
        }

        return {
            ...source,
            ...preview,
        };
    }

    async _serializeExamForResponse(exam, schoolId, { includeQuestions = true } = {}) {
        if (!exam) return null;

        return {
            ...this._serializeExamForList(exam, { includeQuestions }),
            ...(await this._resolveStoredExamTermContext(exam, schoolId)),
        };
    }

    async getExams(query, schoolId) {
        const filter = { school_id: schoolId };

        if (query?.class_id) {
            const classDoc = await this._ensureClassBelongsToSchool(query.class_id, schoolId);
            filter.class_id = classDoc._id;
        }

        if (query?.subject_id) filter.subject_id = query.subject_id;
        if (query?.teacher_id) filter.teacher_id = query.teacher_id;
        if (query?.status) filter.status = query.status;

        if (query?.search) {
            filter.title = { $regex: String(query.search).trim(), $options: 'i' };
        }

        const includeQuestions = query?.includeQuestions === undefined
            ? true
            : toBooleanQuery(query.includeQuestions);

        const exams = await Exam.find(filter)
            .sort({ applicationDate: -1, createdAt: -1 })
            .populate('class_id subject_id teacher_id termId reusedFromExamId reusedFromClassId reusedBy settings.evaluationId');

        return Promise.all(exams.map(async (exam) => ({
            ...this._serializeExamForList(exam, { includeQuestions }),
            ...(await this._resolveStoredExamTermContext(exam, schoolId)),
        })));
    }

    async getReusableExams(query, schoolId) {
        const targetClass = await this._ensureClassBelongsToSchool(query?.targetClassId, schoolId);

        const filter = {
            school_id: schoolId,
            class_id: { $ne: targetClass._id },
        };

        if (query?.sourceClassId) {
            const sourceClass = await this._ensureClassBelongsToSchool(query.sourceClassId, schoolId);
            filter.class_id = sourceClass._id;
        }

        if (query?.subject_id || query?.subjectId) {
            filter.subject_id = query.subject_id || query.subjectId;
        }

        if (query?.teacher_id || query?.teacherId) {
            filter.teacher_id = query.teacher_id || query.teacherId;
        }

        if (query?.status) filter.status = query.status;

        if (query?.search) {
            filter.title = { $regex: String(query.search).trim(), $options: 'i' };
        }

        const includeQuestions = query?.includeQuestions === undefined
            ? true
            : toBooleanQuery(query.includeQuestions);

        const exams = await Exam.find(filter)
            .sort({ applicationDate: -1, createdAt: -1 })
            .populate('class_id subject_id teacher_id termId reusedFromExamId reusedFromClassId reusedBy settings.evaluationId');

        return Promise.all(exams.map(async (exam) => ({
            ...this._serializeExamForList(exam, { includeQuestions }),
            ...(await this._resolveStoredExamTermContext(exam, schoolId)),
        })));
    }

    async getExamById(id, schoolId) {
        return await Exam.findOne({
            _id: id,
            school_id: schoolId,
        }).populate('class_id subject_id teacher_id termId reusedFromExamId reusedFromClassId reusedBy settings.evaluationId');
    }

    async getExamByIdForResponse(id, schoolId) {
        const exam = await this.getExamById(id, schoolId);
        return this._serializeExamForResponse(exam, schoolId);
    }

    async reuseExamForClass(sourceExamId, targetClassId, schoolId, userId, reuseFromAnotherClass = false) {
        this._logInfo('Reutilizando prova para outra turma.', {
            sourceExamId,
            targetClassId,
            schoolId,
        });

        const [sourceExam, targetClass] = await Promise.all([
            Exam.findOne({ _id: sourceExamId, school_id: schoolId }).lean(),
            this._ensureClassBelongsToSchool(targetClassId, schoolId),
        ]);

        if (!sourceExam) {
            this._logError('Prova de origem nÃ£o encontrada para reutilizaÃ§Ã£o.', {
                sourceExamId,
                schoolId,
            });
            throw new Error('Prova de origem nÃ£o encontrada.');
        }

        const sourceClassId = getObjectIdString(sourceExam.class_id);
        const destinationClassId = getObjectIdString(targetClass._id);

        if (sourceClassId !== destinationClassId && reuseFromAnotherClass !== true) {
            throw new Error('Confirme explicitamente a reutilizaÃ§Ã£o de prova de outra turma.');
        }

        const reusedExam = new Exam({
            school_id: schoolId,
            teacher_id: sourceExam.teacher_id,
            class_id: targetClass._id,
            subject_id: sourceExam.subject_id,
            schoolyear_id: sourceExam.schoolyear_id || null,
            termId: sourceExam.termId || null,
            termResolution: sourceExam.termResolution || {
                status: 'missing',
                source: 'none',
                resolvedAt: null,
                message: null,
            },
            title: sourceExam.title,
            applicationDate: sourceExam.applicationDate || new Date(),
            totalValue: sourceExam.totalValue,
            correctionType: sourceExam.correctionType,
            questions: Array.isArray(sourceExam.questions) ? sourceExam.questions : [],
            status: 'DRAFT',
            settings: {
                evaluationId: null,
                omrLayout: null,
            },
            reusedFromExamId: sourceExam._id,
            reusedFromClassId: sourceExam.class_id,
            reusedAt: new Date(),
            reusedBy: userId || null,
        });

        await this._attachOmrLayoutToExamIfNeeded(reusedExam);
        await reusedExam.save();
        await this._ensureGradebookEvaluation(reusedExam, schoolId);

        return await this.getExamByIdForResponse(reusedExam._id, schoolId);
    }

    async getExamResults(examId, schoolId, actor, options = {}) {
        const requestId = options.requestId || null;
        const perfEnabled = Boolean(options.perfEnabled);
        const endpoint = 'exam_results';
        const exam = await this._measureExamPerfStep(
            { enabled: perfEnabled, requestId, endpoint, step: 'load_exam', countFromResult: 1 },
            () => this._getReadableExam(examId, schoolId, actor)
        );
        const classId = getObjectIdString(exam.class_id);

        const enrollments = await this._measureExamPerfStep(
            { enabled: perfEnabled, requestId, endpoint, step: 'load_students' },
            () => Enrollment.find({
                class: classId,
                school_id: schoolId,
                status: 'Ativa',
            })
                .populate('student', 'fullName name')
                .select('_id student status')
                .lean()
        );

        const studentIds = enrollments
            .map((enrollment) => getObjectIdString(enrollment.student))
            .filter(Boolean);

        const sheets = await this._measureExamPerfStep(
            { enabled: perfEnabled, requestId, endpoint, step: 'load_sheets' },
            () => studentIds.length > 0
                ? ExamSheet.find({
                    exam_id: exam._id,
                    school_id: schoolId,
                    student_id: { $in: studentIds },
                })
                    .select('_id exam_id student_id status grade maxGrade answers updatedAt createdAt')
                    .lean()
                : []
        );

        const sheetByStudent = new Map(
            sheets.map((sheet) => [getObjectIdString(sheet.student_id), sheet])
        );

        const gradeByStudent = new Map();
        const evaluationId = getObjectIdString(exam.settings?.evaluationId);
        if (evaluationId && studentIds.length > 0) {
                const evaluation = await this._measureExamPerfStep(
                    { enabled: perfEnabled, requestId, endpoint, step: 'load_evaluation', countFromResult: 1 },
                    () => Evaluation.findOne({
                        _id: evaluationId,
                        school: schoolId,
                        classInfo: classId,
                    })
                        .select('_id')
                        .lean()
                );

                if (evaluation) {
                const grades = await this._measureExamPerfStep(
                    { enabled: perfEnabled, requestId, endpoint, step: 'load_gradebook_grades' },
                    () => ClassGrade.find({
                        evaluation: evaluation._id,
                        student: { $in: studentIds },
                    })
                        .select('_id student enrollment value updatedAt')
                        .lean()
                );

                for (const grade of grades) {
                    gradeByStudent.set(getObjectIdString(grade.student), grade);
                }
            }
        }

        const maxScore = this._finiteNumber(exam.totalValue);
        const totalQuestions = Array.isArray(exam.questions) ? exam.questions.length : 0;

        const computeStopwatch = Date.now();
        const students = enrollments
            .map((enrollment) => {
                const studentId = getObjectIdString(enrollment.student);
                const sheet = sheetByStudent.get(studentId) || null;
                const gradeRecord = gradeByStudent.get(studentId) || null;
                const sheetScore = this._finiteNumber(sheet?.grade);
                const gradebookScore = this._finiteNumber(gradeRecord?.value);
                const score = sheetScore ?? gradebookScore;
                const hasGradeDivergence =
                    sheetScore !== null &&
                    gradebookScore !== null &&
                    Math.abs(sheetScore - gradebookScore) > 0.001;
                const corrected = score !== null;
                const answerSummary = this._buildStoredAnswerSummary(sheet, exam);
                const correctionType = sheet
                    ? (exam.correctionType === 'BUBBLE_SHEET' ? 'omr' : 'manual')
                    : (gradebookScore !== null ? 'manual' : null);
                const correctedAt = sheetScore !== null
                    ? (sheet.updatedAt || sheet.createdAt || null)
                    : (gradeRecord?.updatedAt || null);

                return {
                    studentId,
                    studentName:
                        enrollment.student?.fullName ||
                        enrollment.student?.name ||
                        'Aluno sem nome',
                    enrollmentId: getObjectIdString(enrollment._id),
                    status: corrected ? 'corrected' : 'pending',
                    score,
                    maxScore,
                    percentage:
                        score !== null && maxScore !== null && maxScore > 0
                            ? Math.round((score / maxScore) * 10000) / 100
                            : null,
                    correctAnswers: answerSummary.correctAnswers,
                    wrongAnswers: answerSummary.wrongAnswers,
                    blankAnswers: answerSummary.blankAnswers,
                    totalQuestions,
                    correctionType,
                    correctionSource: sheetScore !== null
                        ? 'exam_sheet'
                        : (gradebookScore !== null ? 'gradebook' : null),
                    examSheetScore: sheetScore,
                    gradebookScore,
                    hasGradeDivergence,
                    gradeDivergenceMessage: hasGradeDivergence
                        ? 'Atencao: existe divergencia entre a correcao da prova e o diario.'
                        : null,
                    correctedAt,
                    sheetId: sheet ? getObjectIdString(sheet._id) : null,
                    sheetStatus: sheet?.status || null,
                    detailsAvailable: answerSummary.detailsAvailable,
                };
            })
            .sort((left, right) => left.studentName.localeCompare(right.studentName, 'pt-BR'));
        this._logExamPerfStep({
            enabled: perfEnabled,
            requestId,
            endpoint,
            step: 'compute_results',
            durationMs: Date.now() - computeStopwatch,
            count: students.length,
        });

        const correctedScores = students
            .map((student) => student.score)
            .filter((score) => typeof score === 'number' && Number.isFinite(score));
        const insightsStopwatch = Date.now();
        const insights = this._buildQuestionInsights(sheets, exam);
        this._logExamPerfStep({
            enabled: perfEnabled,
            requestId,
            endpoint,
            step: 'compute_insights',
            durationMs: Date.now() - insightsStopwatch,
            count: insights?.questions?.length || 0,
        });
        const termContext = await this._measureExamPerfStep(
            { enabled: perfEnabled, requestId, endpoint, step: 'resolve_term', countFromResult: 1 },
            () => this._resolveStoredExamTermContext(exam, schoolId)
        );

        return {
            exam: {
                id: getObjectIdString(exam._id),
                title: exam.title,
                subjectId: getObjectIdString(exam.subject_id),
                subject: exam.subject_id?.name || '',
                classId,
                className: exam.class_id?.name || '',
                teacherId: getObjectIdString(exam.teacher_id),
                applicationDate: exam.applicationDate || null,
                termId: termContext.termId,
                termName: termContext.termName,
                termResolution: termContext.termResolution,
                totalQuestions,
                totalPoints: maxScore,
                totalValue: maxScore,
                status: exam.status,
                correctionType: exam.correctionType,
            },
            summary: {
                totalStudents: students.length,
                corrected: correctedScores.length,
                pending: students.length - correctedScores.length,
                averageScore: correctedScores.length > 0
                    ? Math.round(
                        (correctedScores.reduce((sum, score) => sum + score, 0) /
                            correctedScores.length) * 100
                    ) / 100
                    : null,
                highestScore: correctedScores.length > 0 ? Math.max(...correctedScores) : null,
                lowestScore: correctedScores.length > 0 ? Math.min(...correctedScores) : null,
            },
            insights,
            students,
        };
    }

    async getExamResultDetails(examId, sheetId, schoolId, actor) {
        const exam = await this._getReadableExam(examId, schoolId, actor);
        this._ensureValidObjectId(sheetId, 'ID da folha');

        const sheet = await ExamSheet.findOne({
            _id: sheetId,
            exam_id: exam._id,
            school_id: schoolId,
        })
            .populate('student_id', 'fullName name')
            .lean();

        if (!sheet) {
            throw createHttpError('Correcao nao encontrada.', 404);
        }

        const classId = getObjectIdString(exam.class_id);
        const enrollment = await Enrollment.findOne({
            school_id: schoolId,
            class: classId,
            student: sheet.student_id?._id || sheet.student_id,
            status: 'Ativa',
        })
            .select('_id')
            .lean();

        if (!enrollment) {
            throw createHttpError('Aluno nao encontrado na turma ativa da prova.', 404);
        }

        const isOmr = exam.correctionType === 'BUBBLE_SHEET';
        const storedAnswers = Array.isArray(sheet.answers) ? sheet.answers : [];
        const questions = isOmr
            ? storedAnswers.map((answer) => {
                const number = Number(answer?.questionNumber ?? answer?.question ?? 0);
                const examQuestion = this._getStoredAnswerExamQuestion(exam, number);
                return this._normalizeStoredAnswer(answer, examQuestion);
            })
            : [];
        const summary = this._buildStoredAnswerSummary(sheet, exam);
        const sheetScore = this._finiteNumber(sheet.grade);
        let gradebookScore = null;
        let gradebookUpdatedAt = null;
        const evaluationId = getObjectIdString(exam.settings?.evaluationId);

        if (evaluationId) {
            const evaluation = await Evaluation.findOne({
                _id: evaluationId,
                school: schoolId,
                classInfo: classId,
            })
                .select('_id')
                .lean();

            if (evaluation) {
                const gradeRecord = await ClassGrade.findOne({
                    evaluation: evaluation._id,
                    student: sheet.student_id?._id || sheet.student_id,
                })
                    .select('value updatedAt')
                    .lean();
                gradebookScore = this._finiteNumber(gradeRecord?.value);
                gradebookUpdatedAt = gradeRecord?.updatedAt || null;
            }
        }

        const hasGradeDivergence =
            sheetScore !== null &&
            gradebookScore !== null &&
            Math.abs(sheetScore - gradebookScore) > 0.001;
        const score = sheetScore ?? gradebookScore;

        return {
            sheetId: getObjectIdString(sheet._id),
            student: {
                id: getObjectIdString(sheet.student_id),
                name: sheet.student_id?.fullName || sheet.student_id?.name || 'Aluno sem nome',
            },
            exam: {
                id: getObjectIdString(exam._id),
                title: exam.title,
                totalQuestions: Array.isArray(exam.questions) ? exam.questions.length : 0,
            },
            score,
            objectiveScore: this._finiteNumber(sheet.objectiveGrade),
            dissertativeScore: this._finiteNumber(sheet.dissertativeGrade),
            maxScore: this._finiteNumber(exam.totalValue),
            correctionType: isOmr ? 'omr' : 'manual',
            correctionSource: sheetScore !== null
                ? 'exam_sheet'
                : (gradebookScore !== null ? 'gradebook' : null),
            examSheetScore: sheetScore,
            gradebookScore,
            hasGradeDivergence,
            gradeDivergenceMessage: hasGradeDivergence
                ? 'Atencao: existe divergencia entre a correcao da prova e o diario.'
                : null,
            correctedAt: sheetScore !== null
                ? (sheet.updatedAt || sheet.createdAt || null)
                : (gradebookUpdatedAt || sheet.updatedAt || sheet.createdAt || null),
            sheetStatus: sheet.status || null,
            detailsAvailable: isOmr && questions.length > 0,
            message: isOmr && questions.length > 0
                ? null
                : isOmr
                    ? 'Os detalhes por questao nao foram armazenados para esta correcao.'
                    : 'Correcao manual: detalhes por questao indisponiveis.',
            correctAnswers: summary.correctAnswers,
            wrongAnswers: summary.wrongAnswers,
            blankAnswers: summary.blankAnswers,
            questions,
        };
    }

    async generateExamSheets(examId, schoolId, specificStudentIds = []) {
        this._logInfo('Gerando folhas da prova.', {
            examId,
            schoolId,
            specificStudentIdsCount: Array.isArray(specificStudentIds) ? specificStudentIds.length : 0,
        });

        const exam = await this.getExamById(examId, schoolId);
        if (!exam) {
            this._logError('Prova não encontrada ao gerar folhas.', { examId, schoolId });
            throw new Error('Prova não encontrada.');
        }

        if (exam.correctionType === 'BUBBLE_SHEET') {
            this._ensureBubbleSheetSupport(exam);
        }

        const enrollments = await Enrollment.find({
            class: exam.class_id._id,
            school_id: schoolId,
            status: 'Ativa',
        }).populate('student');

        let targetStudents = enrollments.map((e) => e.student).filter(Boolean);

        if (Array.isArray(specificStudentIds) && specificStudentIds.length > 0) {
            const allowedIds = new Set(specificStudentIds.map(String));
            targetStudents = targetStudents.filter((student) =>
                allowedIds.has(String(student._id))
            );

            if (targetStudents.length !== allowedIds.size) {
                throw new Error('Um ou mais alunos selecionados nÃ£o pertencem Ã  turma da prova.');
            }
        }

        await this._attachOmrLayoutToExamIfNeeded(exam);
        await exam.save();

        const sheetsCreated = [];

        for (const student of targetStudents) {
            let sheet = await ExamSheet.findOne({
                exam_id: examId,
                student_id: student._id,
            });

            if (!sheet) {
                sheet = new ExamSheet({
                    school_id: schoolId,
                    exam_id: examId,
                    student_id: student._id,
                    qr_code_uuid: crypto.randomUUID(),
                    pdf_generated_at: new Date(),
                });

                await sheet.save();
            }

            sheetsCreated.push({
                qrCodeUuid: sheet.qr_code_uuid,
                studentName: student.fullName,
                gradeName: exam.class_id.name,
            });
        }

        exam.status = 'PRINTED';
        await exam.save();

        return {
            examDetails: exam,
            omrLayout: exam.settings.omrLayout,
            sheets: sheetsCreated,
        };
    }

    _normalizePersistableSheetAnswers(payload = {}) {
        const legacyDetails = Array.isArray(payload.correctionDetails)
            ? payload.correctionDetails
            : null;
        const details = legacyDetails
            ? {}
            : payload.correctionDetails ||
            payload.correctionSummary ||
            payload.correctionDetailsPayload ||
            {};
        const questionResults = Array.isArray(details.questionResults)
            ? details.questionResults
            : Array.isArray(payload.questionResults)
                ? payload.questionResults
                : null;
        const sourceAnswers =
            questionResults ||
            legacyDetails ||
            (Array.isArray(payload.answers) ? payload.answers : []);

        return sourceAnswers
            .map((answer) => {
                const questionNumber = Number(
                    answer.questionNumber ?? answer.question ?? answer.number ?? 0
                );
                if (!Number.isFinite(questionNumber) || questionNumber <= 0) {
                    return null;
                }

                const rawStudentAnswer =
                    answer.studentAnswer ??
                    answer.markedOption ??
                    answer.studentMarked ??
                    answer.marked ??
                    answer.selected ??
                    answer.answer ??
                    null;
                const omrStatus = String(answer.omrStatus || answer.status || '').toLowerCase();
                const markedOption = [
                    'A',
                    'B',
                    'C',
                    'D',
                    'E',
                    'MULTIPLE',
                    'UNCERTAIN',
                    'NOT_DETECTED',
                ].includes(rawStudentAnswer)
                    ? rawStudentAnswer
                    : null;

                let status = 'ok';
                if (['blank', 'multiple', 'ambiguous', 'uncertain', 'not_detected'].includes(omrStatus)) {
                    status = omrStatus;
                } else if (answer.status === 'blank' || rawStudentAnswer === null) {
                    status = 'blank';
                } else if (answer.status === 'multiple' || rawStudentAnswer === 'MULTIPLE') {
                    status = 'multiple';
                } else if (answer.status === 'uncertain' || rawStudentAnswer === 'UNCERTAIN') {
                    status = 'uncertain';
                } else if (answer.status === 'not_detected' || rawStudentAnswer === 'NOT_DETECTED') {
                    status = 'not_detected';
                }

                return {
                    question_id: answer.question_id || answer.questionId || undefined,
                    questionNumber,
                    markedOption,
                    correctAnswer: answer.correctAnswer ?? null,
                    status,
                    omrStatus: answer.omrStatus || null,
                    markedAlternatives: Array.isArray(answer.markedAlternatives)
                        ? answer.markedAlternatives
                        : [],
                    confidence: answer.confidence ?? null,
                    isCorrect: Boolean(answer.isCorrect),
                    earnedPoints: this._finiteNumber(answer.earnedPoints ?? answer.points) ?? 0,
                    maxPoints: this._finiteNumber(answer.maxPoints) ?? null,
                };
            })
            .filter(Boolean);
    }

    async scanExamSheet(payload, schoolId) {
        const {
            qrCodeUuid,
            grade,
            objectiveGrade,
            answers,
            maxGrade,
            totalQuestions,
            correctCount,
            wrongCount,
            blankCount,
            multipleCount,
            uncertainCount,
            notDetectedCount,
            correctionDetails,
            correctionSummary,
            correctionDetailsPayload,
        } = payload;
        const normalizedAnswers = this._normalizePersistableSheetAnswers(payload);
        const structuredCorrectionDetails = Array.isArray(correctionDetails)
            ? (correctionSummary || correctionDetailsPayload || null)
            : (correctionDetails || correctionSummary || correctionDetailsPayload || null);

        const existingSheet = await ExamSheet.findOne({ qr_code_uuid: qrCodeUuid, school_id: schoolId });

        if (!existingSheet) {
            throw new Error('Folha da prova nao encontrada.');
        }

        const confirmationExam = await Exam.findOne({ _id: existingSheet.exam_id, school_id: schoolId })
            .select('totalValue questions')
            .lean();
        const resolvedMaxGrade = this._resolveExamMaxGrade(
            confirmationExam,
            maxGrade ?? structuredCorrectionDetails?.maxGrade
        );
        const validatedGrades = this._validateGradeWithinMax({
            grade,
            objectiveGrade,
            maxGrade: resolvedMaxGrade,
        });

        console.log('[OMR CONFIRM RECEIVED]', {
            qrCodeUuid,
            grade: validatedGrades.grade,
            objectiveGrade: validatedGrades.objectiveGrade,
            maxGrade: validatedGrades.maxGrade,
            valid: true,
        });

        const updateData = {
            grade: validatedGrades.grade,
            objectiveGrade: validatedGrades.objectiveGrade ?? validatedGrades.grade,
            answers: normalizedAnswers.length ? normalizedAnswers : answers,
            status: 'SCANNED',
        };

        const optionalFields = {
            maxGrade: validatedGrades.maxGrade,
            totalQuestions: totalQuestions ?? structuredCorrectionDetails?.totalQuestions,
            correctCount: correctCount ?? structuredCorrectionDetails?.correctCount,
            wrongCount: wrongCount ?? structuredCorrectionDetails?.wrongCount,
            blankCount: blankCount ?? structuredCorrectionDetails?.blankCount,
            multipleCount: multipleCount ?? structuredCorrectionDetails?.multipleCount,
            uncertainCount: uncertainCount ?? structuredCorrectionDetails?.uncertainCount,
            notDetectedCount: notDetectedCount ?? structuredCorrectionDetails?.notDetectedCount,
            correctionDetails: structuredCorrectionDetails,
        };

        for (const [key, value] of Object.entries(optionalFields)) {
            if (value !== undefined) {
                updateData[key] = value;
            }
        }

        const sheet = await ExamSheet.findOneAndUpdate(
            { _id: existingSheet._id, school_id: schoolId },
            updateData,
            { new: true }
        );

        if (!sheet) {
            throw new Error('Folha da prova não encontrada.');
        }

        try {
            const [eventExam, eventSheet] = await Promise.all([
                Exam.findOne({ _id: sheet.exam_id, school_id: schoolId })
                    .populate('class_id', 'name')
                    .populate('termId', 'titulo')
                    .select('title totalValue correctionType teacher_id class_id termId')
                    .lean(),
                ExamSheet.findOne({ _id: sheet._id, school_id: schoolId })
                    .populate('student_id', 'fullName name')
                    .select('student_id status updatedAt')
                    .lean(),
            ]);

            if (eventExam && eventSheet) {
                const realtimePayload = {
                    schoolId: String(schoolId),
                    school_id: String(schoolId),
                    teacherId: getObjectIdString(eventExam.teacher_id),
                    classId: getObjectIdString(eventExam.class_id),
                    className: eventExam.class_id?.name || '',
                    examId: getObjectIdString(eventExam._id),
                    examTitle: eventExam.title || 'Prova',
                    termId: getObjectIdString(eventExam.termId),
                    termName: eventExam.termId?.titulo || null,
                    studentId: getObjectIdString(eventSheet.student_id),
                    studentName:
                        eventSheet.student_id?.fullName ||
                        eventSheet.student_id?.name ||
                        'Aluno sem nome',
                    sheetId: getObjectIdString(eventSheet._id),
                    score: this._finiteNumber(sheet.grade),
                    maxScore: this._finiteNumber(eventExam.totalValue),
                    correctionType:
                        eventExam.correctionType === 'BUBBLE_SHEET' ? 'omr' : 'manual',
                    correctedAt: eventSheet.updatedAt || new Date(),
                };

                appEmitter.emit('exam:sheet-corrected', realtimePayload);
                console.log('[ExamRealtime] Correcao salva e evento emitido', {
                    schoolId: realtimePayload.schoolId,
                    teacherId: realtimePayload.teacherId,
                    examId: realtimePayload.examId,
                    sheetId: realtimePayload.sheetId,
                });
            }
        } catch (error) {
            console.error('[ExamRealtime] Falha ao preparar evento de correcao', {
                schoolId: String(schoolId),
                examId: getObjectIdString(sheet.exam_id),
                sheetId: getObjectIdString(sheet._id),
                error: error?.message || error,
            });
        }

        const exam = await Exam.findById(sheet.exam_id);

        await this._syncSheetGradeToGradebook(exam, sheet, schoolId, validatedGrades.grade);

        return sheet;
    }
}

module.exports = new ExamService();
