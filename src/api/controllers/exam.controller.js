const examService = require('../services/exam.service');
const omrProcessingService = require('../services/omrProcessing.service');
const crypto = require('crypto');

function elapsedMs(startHrtime) {
    return Number(process.hrtime.bigint() - startHrtime) / 1e6;
}

function roundMs(value) {
    if (value === null || value === undefined) {
        return null;
    }
    return Math.round(Number(value) * 100) / 100;
}

function timedNow() {
    return process.hrtime.bigint();
}

function buildCorrelationId(req) {
    const raw =
        req.headers['x-correlation-id'] ||
        req.headers['x-omr-correlation-id'] ||
        req.body?.correlationId ||
        req.query?.correlationId;

    const normalized = raw ? String(raw).trim() : '';
    if (normalized) {
        return normalized.slice(0, 120);
    }

    return `omr-${crypto.randomUUID()}`;
}

function buildPayloadSize(req, imageBase64) {
    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > 0) {
        return contentLength;
    }

    const imageSize = String(imageBase64 || '').length;
    return imageSize > 0 ? imageSize : null;
}

function finishOmrRequest({ status, payload, performanceTimings, requestStart }) {
    if (!performanceTimings) {
        return { status, payload };
    }

    performanceTimings.totalRequestMs = roundMs(elapsedMs(requestStart));
    for (const [key, value] of Object.entries(performanceTimings)) {
        if (typeof value === 'number') {
            performanceTimings[key] = roundMs(value);
        }
    }

    payload.correlationId = performanceTimings.correlationId;
    payload.performance = performanceTimings;

    console.log('[OMR PERF]', JSON.stringify(performanceTimings));
    return { status, payload };
}

function buildOmrResultLog({
    result,
    performanceTimings,
    engineVersion,
    primaryEngineVersion,
    examId,
    schoolId,
    teacherId,
    omrLayout,
}) {
    const debug = result?.debug || {};
    const anchorsDebug = debug.anchors || {};
    const homographyDebug = debug.homography || {};
    const anchorDiagnostics = anchorsDebug.diagnostics || {};
    const anchorsFound = Number(result?.anchorsFound ?? anchorsDebug.found ?? 0);
    const requestedQuestions = Number(result?.requestedQuestions ?? omrLayout?.totalQuestions ?? 0);
    const detectedQuestions = Number(result?.detectedQuestions ?? result?.questionsCount ?? 0);
    const questions = Array.isArray(result?.questions) ? result.questions : [];
    const answers = Array.isArray(result?.answers) ? result.answers : [];
    const evaluatedQuestions = Number(
        result?.evaluatedQuestions ??
        (result?.success ? result?.questionsCount ?? answers.length : 0)
    );

    let bubbleReadStatus = 'skipped';
    if (evaluatedQuestions > 0 || result?.stage === 'completed') {
        bubbleReadStatus = evaluatedQuestions >= requestedQuestions ? 'completed' : 'partial';
    } else if (questions.length > 0 && result?.stage !== 'sheet_detection') {
        bubbleReadStatus = 'partial';
    }

    return {
        correlationId: performanceTimings?.correlationId || null,
        engineVersion,
        primaryEngineVersion,
        success: Boolean(result?.success),
        imageStatus: result?.imageStatus || null,
        errorCode: result?.errorCode || null,
        examId: examId ? String(examId) : null,
        schoolId: schoolId ? String(schoolId) : null,
        teacherId: teacherId ? String(teacherId) : null,
        requestedQuestions,
        detectedQuestions,
        evaluatedQuestions,
        orientation: result?.orientation || debug.orientation || null,
        anchorsFound,
        anchorDetectionStatus:
            anchorsFound >= 4 || anchorsDebug.success === true ? 'completed' : 'failed',
        anchorDiagnostics: {
            thresholdMode: anchorDiagnostics.thresholdMode || null,
            blackPixelRatio: anchorDiagnostics.blackPixelRatio ?? null,
            anchorCandidatesBeforeFilter: anchorDiagnostics.anchorCandidatesBeforeFilter ?? null,
            anchorCandidatesAfterSizeFilter: anchorDiagnostics.anchorCandidatesAfterSizeFilter ?? null,
            anchorCandidatesAfterFrameFilter: anchorDiagnostics.anchorCandidatesAfterFrameFilter ?? null,
            anchorCandidatesAfterShapeFilter: anchorDiagnostics.anchorCandidatesAfterShapeFilter ?? null,
            anchorCandidatesAfterPositionFilter: anchorDiagnostics.anchorCandidatesAfterPositionFilter ?? null,
            anchorCandidatesAfterSolidityFilter: anchorDiagnostics.anchorCandidatesAfterSolidityFilter ?? null,
            fallbackUsed: anchorDiagnostics.fallbackUsed ?? null,
            failureReason: anchorDiagnostics.failureReason || null,
        },
        homographyStatus:
            homographyDebug.applied === true || result?.stage === 'completed' ? 'completed' : 'skipped',
        bubbleReadStatus,
        confidence: result?.confidence ?? null,
        warnings: result?.warnings || result?.captureHints || [],
        message: result?.message || null,
    };
}

function logOmrResult(meta) {
    console.log('[OMR RESULT]', JSON.stringify(buildOmrResultLog(meta)));
}

function getRequestRoles(req) {
    return [
        ...(Array.isArray(req.user?.roles) ? req.user.roles : []),
        req.user?.role,
    ]
        .filter(Boolean)
        .map((role) => String(role).trim().toLowerCase());
}

function hasOmrDebugAccess(req) {
    if (req.omrDebugAuth) {
        return true;
    }

    const configuredToken = omrProcessingService.getDebugToken();
    const requestToken =
        req.headers['x-omr-debug-token'] ||
        req.headers['x-internal-debug-token'] ||
        req.body?.debugToken;

    if (configuredToken && requestToken && String(requestToken) === String(configuredToken)) {
        return true;
    }

    const roles = getRequestRoles(req);
    return roles.some((role) => ['admin', 'coordenador'].includes(role));
}

function findQuestionDebug(result, questionNumber) {
    const questions = result?.debug?.questions;
    if (!Array.isArray(questions)) {
        return null;
    }

    return questions.find((question) => Number(question.question) === Number(questionNumber)) || null;
}

function buildPersistedDebugPayload({
    sessionId,
    result,
    debugContext,
    saveImages,
}) {
    const pipelineDebug = result.debug || {};
    const questions = Array.isArray(pipelineDebug.questions) ? pipelineDebug.questions : [];

    return {
        debugId: sessionId,
        ...debugContext,
        success: Boolean(result.success),
        imageStatus: result.imageStatus || null,
        errorCode: result.errorCode || null,
        type: result.type || 'BUBBLE_SHEET',
        stage: result.stage || null,
        message: result.message || null,
        anchorsFound: result.anchorsFound ?? null,
        questionsCount: result.questionsCount ?? null,
        requestedQuestions: result.requestedQuestions ?? null,
        detectedQuestions: result.detectedQuestions ?? null,
        evaluatedQuestions: result.evaluatedQuestions ?? null,
        confidence: result.confidence ?? null,
        imageWidth: pipelineDebug.imageWidth ?? null,
        imageHeight: pipelineDebug.imageHeight ?? null,
        orientation: pipelineDebug.orientation ?? null,
        anchors: pipelineDebug.anchors || null,
        homography: pipelineDebug.homography || null,
        machineWidth: pipelineDebug.machineWidth ?? null,
        machineHeight: pipelineDebug.machineHeight ?? null,
        layoutDebug: pipelineDebug.layoutDebug || null,
        layoutAttempts: pipelineDebug.layoutAttempts || [],
        bubbleTemplate: pipelineDebug.bubbleTemplate || [],
        questions,
        question5: questions.find((question) => Number(question.question) === 5) || null,
        answers: result.answers || [],
        captureHints: result.captureHints || [],
        saveImages,
    };
}

function attachOmrDebugInfo({
    payload,
    result,
    sessionId,
    manifest,
    debugPayload,
    debugMode,
}) {
    if (debugMode) {
        payload.debug = {
            ...debugPayload,
            manifest: manifest || null,
            artifacts: manifest?.files || [],
        };
        return;
    }

    delete payload.debug;
    payload.debugId = sessionId;
    payload.debugFilesUrl = `/api/omr/debug/${encodeURIComponent(sessionId)}/files`;
    payload.debugZipUrl = `/api/omr/debug/${encodeURIComponent(sessionId)}/zip`;
    payload.debugArtifacts = manifest?.files || [];
    payload.anchorDebug = debugPayload.anchors;
    payload.homographyDebug = debugPayload.homography;
    payload.question5Debug = debugPayload.question5 || findQuestionDebug(result, 5);
}

function buildOmrCaptureMessage(result) {
    if (!result || result.success) {
        return null;
    }

    const hints = Array.isArray(result.captureHints) ? result.captureHints : [];
    if (hints.length > 0) {
        return hints[0];
    }

    if (result.stage === 'sheet_detection') {
        return 'Inclua os quatro cantos pretos dentro da area e mantenha o papel plano.';
    }

    return result.message || 'Nao foi possivel ler o gabarito.';
}

function buildOmrShadowComparison(legacyResult, v2Result) {
    const legacyAnswers = Array.isArray(legacyResult?.answers) ? legacyResult.answers : [];
    const v2Answers = Array.isArray(v2Result?.answers) ? v2Result.answers : [];
    const v2ByQuestion = new Map(
        v2Answers.map((answer) => [Number(answer.question), answer])
    );
    const divergences = [];

    for (const legacyAnswer of legacyAnswers) {
        const question = Number(legacyAnswer?.question);
        const v2Answer = v2ByQuestion.get(question);
        if (!v2Answer) {
            divergences.push({
                question,
                legacy: legacyAnswer?.marked ?? legacyAnswer?.answer ?? null,
                v2: null,
                reason: 'missing_in_v2',
            });
            continue;
        }

        const legacyMarked = legacyAnswer?.marked ?? legacyAnswer?.answer ?? null;
        const v2Marked = v2Answer?.marked ?? v2Answer?.answer ?? null;
        const legacyStatus = legacyAnswer?.status || null;
        const v2Status = v2Answer?.status || null;
        if (legacyMarked !== v2Marked || legacyStatus !== v2Status) {
            divergences.push({
                question,
                legacy: legacyMarked,
                legacyStatus,
                v2: v2Marked,
                v2Status,
            });
        }
    }

    return {
        enabled: true,
        v2Success: Boolean(v2Result?.success),
        v2ImageStatus: v2Result?.imageStatus || null,
        v2ErrorCode: v2Result?.errorCode || null,
        divergencesCount: divergences.length,
        divergences,
    };
}

async function resolveOmrContext({ req, examId, qrCodeUuid, schoolId }) {
    let verifiedSheet = null;
    let resolvedExamId = examId;

    if (qrCodeUuid) {
        verifiedSheet = await examService.verifyExamSheet(qrCodeUuid, schoolId);
        if (!resolvedExamId && verifiedSheet?.examId) {
            resolvedExamId = verifiedSheet.examId;
        }
    }

    if (!resolvedExamId) {
        return {
            errorStatus: 400,
            errorPayload: {
                success: false,
                message: 'examId e obrigatorio para leitura do cartao-resposta.',
            },
        };
    }

    const exam = await examService.getExamById(resolvedExamId, schoolId);
    if (!exam) {
        return {
            errorStatus: 404,
            errorPayload: {
                success: false,
                message: 'Prova nao encontrada.',
            },
        };
    }

    return {
        exam,
        examId: resolvedExamId,
        verifiedSheet,
        debugContext: {
            studentId: req.body?.studentId || null,
            studentName: req.body?.studentName || verifiedSheet?.studentName || null,
            examId: String(resolvedExamId),
            examTitle: verifiedSheet?.examTitle || exam.title || null,
            activityId: req.body?.activityId || req.body?.classActivityId || null,
            qrDetected: Boolean(qrCodeUuid),
            qrSource: qrCodeUuid ? 'payload' : null,
        },
    };
}

async function runOmrRequest(req, { persistResults, debugMode }) {
    const requestStart = timedNow();
    const performanceDebug = omrProcessingService.isPerformanceDebugEnabled();
    const performanceTimings = performanceDebug
        ? {
            correlationId: buildCorrelationId(req),
            route: req.originalUrl || req.url,
            method: req.method,
            debugMode: Boolean(debugMode),
            persistResults: Boolean(persistResults),
            startedAt: new Date().toISOString(),
        }
        : null;
    const finish = (status, payload) =>
        finishOmrRequest({ status, payload, performanceTimings, requestStart });

    if (debugMode) {
        if (!omrProcessingService.isDebugEnabled()) {
            return finish(404, {
                    success: false,
                    message: 'Debug OMR desativado.',
            });
        }

        if (!hasOmrDebugAccess(req)) {
            return finish(403, {
                    success: false,
                    message: 'Acesso ao debug OMR nao autorizado.',
            });
        }
    }

    let sessionDir = null;

    try {
        const {
            imageBase64,
            correctionType = 'DIRECT_GRADE',
            examId,
            qrCodeUuid = null,
        } = req.body;

        if (performanceTimings) {
            performanceTimings.payloadSizeBytes = buildPayloadSize(req, imageBase64);
            performanceTimings.imageBase64Size = String(imageBase64 || '')
                .replace(/^data:image\/\w+;base64,/, '')
                .length;
            performanceTimings.correctionType = correctionType;
            performanceTimings.examId = examId ? String(examId) : null;
            performanceTimings.qrCodeUuidPresent = Boolean(qrCodeUuid);
        }

        const schoolId = req.user?.school_id || req.user?.schoolId || req.body?.schoolId;

        if (!schoolId) {
            return finish(400, {
                    success: false,
                    message: 'schoolId e obrigatorio para debug OMR quando nao ha JWT.',
            });
        }

        if (!imageBase64) {
            return finish(400, {
                    success: false,
                    message: 'Imagem nao enviada.',
            });
        }

        if (correctionType !== 'BUBBLE_SHEET') {
            return finish(400, {
                    success: false,
                    message: 'O novo motor OMR atende somente correctionType=BUBBLE_SHEET.',
            });
        }

        const contextStart = timedNow();
        const context = await resolveOmrContext({ req, examId, qrCodeUuid, schoolId });
        if (performanceTimings) {
            performanceTimings.contextResolveMs = elapsedMs(contextStart);
        }
        if (context.errorPayload) {
            return finish(context.errorStatus, context.errorPayload);
        }

        const { exam, examId: resolvedExamId, debugContext } = context;
        const layoutFetchStart = timedNow();
        const omrLayout = await examService.getExamOmrLayout(resolvedExamId, schoolId);
        if (performanceTimings) {
            performanceTimings.layoutFetchMs = elapsedMs(layoutFetchStart);
            performanceTimings.layoutBuildMs = null;
            performanceTimings.totalQuestions = omrLayout?.totalQuestions || null;
        }

        const sessionStart = timedNow();
        const session = omrProcessingService.createDebugSession();
        sessionDir = session.sessionDir;
        if (performanceTimings) {
            performanceTimings.tempSessionCreateMs = elapsedMs(sessionStart);
            performanceTimings.debugId = session.sessionId;
        }

        const imagePath = omrProcessingService.writeBase64ImageToDisk(
            imageBase64,
            sessionDir,
            performanceTimings
        );
        const layoutWriteStart = timedNow();
        const layoutPath = omrProcessingService.writeLayoutToDisk(omrLayout, sessionDir);
        if (performanceTimings) {
            performanceTimings.layoutWriteMs = elapsedMs(layoutWriteStart);
        }
        const debugEnabled = omrProcessingService.isDebugEnabled();
        const saveImages = debugEnabled && omrProcessingService.shouldSaveDebugImages();
        if (performanceTimings) {
            performanceTimings.omrDebugEnabled = debugEnabled;
            performanceTimings.omrDebugSaveImages = saveImages;
            performanceTimings.keepOmrDebugFiles = omrProcessingService.shouldKeepDebugFiles();
        }

        const engineVersion = omrProcessingService.getEngineVersion();
        const primaryEngineVersion = engineVersion === 'shadow' ? 'legacy' : engineVersion;
        if (performanceTimings) {
            performanceTimings.engineVersion = engineVersion;
            performanceTimings.primaryEngineVersion = primaryEngineVersion;
        }

        const pythonStart = timedNow();
        const { result } = await omrProcessingService.runPythonOmr({
            imagePath,
            correctionType,
            layoutPath,
            sessionDir,
            saveImages,
            engineVersion: primaryEngineVersion,
        });
        if (performanceTimings) {
            performanceTimings.pythonTotalMs = elapsedMs(pythonStart);
            if (result.performance && typeof result.performance === 'object') {
                for (const [key, value] of Object.entries(result.performance)) {
                    performanceTimings[key] = value;
                }
            }
        }

        let shadowComparison = null;
        if (engineVersion === 'shadow') {
            const shadowStart = timedNow();
            try {
                const { result: v2Result } = await omrProcessingService.runPythonOmr({
                    imagePath,
                    correctionType,
                    layoutPath,
                    sessionDir,
                    saveImages: false,
                    engineVersion: 'v2',
                });
                shadowComparison = buildOmrShadowComparison(result, v2Result);
                console.log('[OMR SHADOW]', {
                    examId: String(resolvedExamId),
                    schoolId: String(schoolId),
                    legacySuccess: Boolean(result?.success),
                    v2Success: Boolean(v2Result?.success),
                    v2ImageStatus: v2Result?.imageStatus || null,
                    divergencesCount: shadowComparison.divergencesCount,
                    processingTimeMs: roundMs(elapsedMs(shadowStart)),
                });
            } catch (error) {
                shadowComparison = {
                    enabled: true,
                    error: error.message,
                };
                console.warn('[OMR SHADOW WARN] Falha ao executar v2 em shadow.', {
                    examId: String(resolvedExamId),
                    schoolId: String(schoolId),
                    error: error.message,
                });
            }
            if (performanceTimings) {
                performanceTimings.shadowV2Ms = elapsedMs(shadowStart);
            }
        }

        logOmrResult({
            result,
            performanceTimings,
            engineVersion,
            primaryEngineVersion,
            examId: resolvedExamId,
            schoolId,
            teacherId: req.user?._id,
            omrLayout,
        });

        const debugPayloadStart = timedNow();
        const debugPayload = debugEnabled
            ? buildPersistedDebugPayload({
                sessionId: session.sessionId,
                result,
                debugContext,
                saveImages,
            })
            : null;
        let manifest = null;

        if (debugPayload && saveImages) {
            omrProcessingService.writeCompatibilityDebugArtifacts({
                sessionDir,
                engineVersion: primaryEngineVersion,
                result,
            });
            omrProcessingService.writeDebugJson(sessionDir, debugPayload);
            manifest = omrProcessingService.writeManifest(sessionDir, session.sessionId);
        }
        if (performanceTimings) {
            performanceTimings.debugPayloadMs = elapsedMs(debugPayloadStart);
        }

        if (!result.success) {
            const friendlyMessage = buildOmrCaptureMessage(result);
            if (friendlyMessage) {
                result.userMessage = friendlyMessage;
            }

            result.engineVersion = primaryEngineVersion;
            if (shadowComparison) {
                result.shadow = shadowComparison;
            }

            if (debugPayload) {
                attachOmrDebugInfo({
                    payload: result,
                    result,
                    sessionId: session.sessionId,
                    manifest,
                    debugPayload,
                    debugMode,
                });
            } else {
                delete result.debug;
            }

            return finish(200, result);
        }

        const gradingStart = timedNow();
        const correction = examService.buildBubbleSheetCorrection(exam, result.answers);
        if (performanceTimings) {
            performanceTimings.gradingMs = elapsedMs(gradingStart);
        }

        const responsePayload = {
            ...result,
            engineVersion: primaryEngineVersion,
            requestedQuestions: result.requestedQuestions ?? omrLayout?.totalQuestions ?? null,
            detectedQuestions: result.detectedQuestions ?? result.questionsCount ?? null,
            evaluatedQuestions: result.evaluatedQuestions ?? result.questionsCount ?? null,
            grade: correction.grade,
            objectiveGrade: correction.objectiveGrade,
            maxGrade: correction.maxGrade,
            totalQuestions: correction.totalQuestions,
            correctCount: correction.correctCount,
            wrongCount: correction.wrongCount,
            blankCount: correction.blankCount,
            multipleCount: correction.multipleCount,
            uncertainCount: correction.uncertainCount,
            notDetectedCount: correction.notDetectedCount,
            studentAnswers: correction.studentAnswers,
            answerKey: correction.answerKey,
            questionResults: correction.questionResults,
            persistableAnswers: correction.persistableAnswers,
            correctionDetails: correction.correctionDetails,
            correctionSummary: correction.correctionDetailsPayload,
            correctionDetailsPayload: correction.correctionDetailsPayload,
            omrTechnicalDetails: {
                confidence: result.confidence ?? null,
                questions: result.questions || [],
                gridCalibration: result.gridCalibration || null,
                orientation: result.orientation || null,
            },
            omrLayoutVersion: exam.settings?.omrLayout?.version || null,
        };
        if (shadowComparison) {
            responsePayload.shadow = shadowComparison;
        }

        const canPersistOmrResult = !result.imageStatus || result.imageStatus === 'accepted';
        if (persistResults && qrCodeUuid && canPersistOmrResult) {
            const dbSaveStart = timedNow();
            const persistedSheet = await examService.scanExamSheet(
                {
                    qrCodeUuid,
                    grade: correction.grade,
                    objectiveGrade: correction.objectiveGrade,
                    answers: correction.persistableAnswers,
                    maxGrade: correction.maxGrade,
                    totalQuestions: correction.totalQuestions,
                    correctCount: correction.correctCount,
                    wrongCount: correction.wrongCount,
                    blankCount: correction.blankCount,
                    multipleCount: correction.multipleCount,
                    uncertainCount: correction.uncertainCount,
                    notDetectedCount: correction.notDetectedCount,
                    correctionDetails: correction.correctionDetailsPayload,
                },
                schoolId
            );
            if (performanceTimings) {
                performanceTimings.dbSaveMs = elapsedMs(dbSaveStart);
            }

            responsePayload.persisted = true;
            responsePayload.sheetId = persistedSheet._id;
            responsePayload.sheetStatus = persistedSheet.status;
        } else {
            if (performanceTimings) {
                performanceTimings.dbSaveMs = 0;
            }
            responsePayload.persisted = false;
            if (persistResults && qrCodeUuid && !canPersistOmrResult) {
                responsePayload.academicWriteSkipped = true;
                responsePayload.persistenceBlockedReason = `image_status_${result.imageStatus}`;
            }
        }

        if (debugMode) {
            responsePayload.academicWriteSkipped = true;
        }

        if (debugPayload) {
            attachOmrDebugInfo({
                payload: responsePayload,
                result,
                sessionId: session.sessionId,
                manifest,
                debugPayload,
                debugMode,
            });
        } else {
            delete responsePayload.debug;
        }

        return finish(200, responsePayload);
    } finally {
        if (sessionDir) {
            omrProcessingService.cleanupSession(sessionDir);
        }
    }
}

class ExamController {
    async create(req, res) {
        try {
            const schoolId = req.user.school_id;
            const exam = await examService.createExam(req.body, schoolId);
            res.status(201).json(exam);
        } catch (error) {
            console.error('ERRO AO SALVAR PROVA:', error.message);
            res.status(400).json({ message: error.message });
        }
    }

    async update(req, res) {
        try {
            const schoolId = req.user.school_id;
            const examId = req.params.id;
            const updatedExam = await examService.updateExam(examId, req.body, schoolId);
            res.status(200).json(updatedExam);
        } catch (error) {
            console.error('ERRO AO ATUALIZAR PROVA:', error.message);
            const normalizedMessage = String(error.message || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase();
            if (normalizedMessage.includes('nao pode mais ser alterada')) {
                return res.status(403).json({ message: error.message });
            }
            res.status(400).json({ message: error.message });
        }
    }

    async duplicate(req, res) {
        try {
            const schoolId = req.user.school_id;
            const examId = req.params.id;
            const duplicatedExam = await examService.duplicateExam(examId, schoolId);
            res.status(201).json(duplicatedExam);
        } catch (error) {
            console.error('ERRO AO DUPLICAR PROVA:', error.message);
            res.status(400).json({ message: error.message });
        }
    }

    async getAll(req, res) {
        try {
            const schoolId = req.user.school_id;
            const exams = await examService.getExams(req.query, schoolId);
            res.status(200).json(exams);
        } catch (error) {
            console.error('ERRO AO BUSCAR PROVAS:', error);
            res.status(500).json({ message: error.message });
        }
    }

    async getReusable(req, res) {
        try {
            const schoolId = req.user.school_id;
            const exams = await examService.getReusableExams(req.query, schoolId, req.user);
            res.status(200).json(exams);
        } catch (error) {
            console.error('ERRO AO BUSCAR PROVAS REUTILIZAVEIS:', error);
            res.status(400).json({ message: error.message });
        }
    }

    async reuseForClass(req, res) {
        try {
            const schoolId = req.user.school_id;
            const userId = req.user.id || req.user._id;
            const { sourceExamId } = req.params;
            const { targetClassId, reuseFromAnotherClass } = req.body;

            const reusedExam = await examService.reuseExamForClass(
                sourceExamId,
                targetClassId,
                schoolId,
                userId,
                reuseFromAnotherClass,
                req.user
            );

            res.status(201).json(reusedExam);
        } catch (error) {
            console.error('ERRO AO REUTILIZAR PROVA:', error.message);
            res.status(error.statusCode || error.status || 400).json({ message: error.message });
        }
    }

    async setSharing(req, res) {
        try {
            const schoolId = req.user.school_id;
            const result = await examService.setExamSharing(
                req.params.id,
                req.body?.sharing,
                schoolId,
                req.user
            );
            res.status(200).json(result);
        } catch (error) {
            console.error('ERRO AO ALTERAR COMPARTILHAMENTO DA PROVA:', error.message);
            res.status(error.statusCode || error.status || 400).json({ message: error.message });
        }
    }

    async getById(req, res) {
        try {
            const schoolId = req.user.school_id;
            const exam = await examService.getExamByIdForResponse(req.params.id, schoolId);
            res.status(200).json(exam);
        } catch (error) {
            console.error('ERRO AO BUSCAR PROVA POR ID:', error);
            res.status(404).json({ message: error.message });
        }
    }

    async getResults(req, res) {
        const startedAt = Date.now();
        const requestId = req.headers['x-request-id'] || req.query.requestId || crypto.randomUUID();
        const perfEnabled = ['true', '1', 'yes', 'sim'].includes(String(req.query.perf || process.env.EXAM_PERF_DEBUG || '').toLowerCase());
        try {
            const schoolId = req.user.school_id || req.user.schoolId;
            if (perfEnabled) {
                console.log('[ExamPerfAPI][RequestStart]', {
                    requestId,
                    endpoint: 'exam_results',
                    method: req.method,
                    path: req.path,
                    query: { examId: req.params.examId },
                    schoolId: String(schoolId || ''),
                    teacherId: String(req.user?._id || req.user?.id || ''),
                });
            }
            const result = await examService.getExamResults(
                req.params.examId,
                schoolId,
                req.user,
                { requestId, perfEnabled }
            );
            if (perfEnabled) {
                console.log('[ExamPerfAPI][RequestEnd]', {
                    requestId,
                    endpoint: 'exam_results',
                    method: req.method,
                    path: req.path,
                    status: 200,
                    durationMs: Date.now() - startedAt,
                    responseBytes: Buffer.byteLength(JSON.stringify(result)),
                    students: Array.isArray(result?.students) ? result.students.length : null,
                });
            }
            return res.status(200).json(result);
        } catch (error) {
            const status = error.statusCode || 400;
            const payload = { message: error.message };
            if (perfEnabled) {
                console.log('[ExamPerfAPI][RequestEnd]', {
                    requestId,
                    endpoint: 'exam_results',
                    method: req.method,
                    path: req.path,
                    status,
                    durationMs: Date.now() - startedAt,
                    responseBytes: Buffer.byteLength(JSON.stringify(payload)),
                });
            }
            return res.status(status).json(payload);
        }
    }

    async getResultDetails(req, res) {
        try {
            const schoolId = req.user.school_id || req.user.schoolId;
            const result = await examService.getExamResultDetails(
                req.params.examId,
                req.params.sheetId,
                schoolId,
                req.user
            );
            return res.status(200).json(result);
        } catch (error) {
            return res.status(error.statusCode || 400).json({ message: error.message });
        }
    }

    async generateSheets(req, res) {
        try {
            const schoolId = req.user.school_id;
            const examId = req.params.id;
            const { studentIds } = req.body;
            const result = await examService.generateExamSheets(examId, schoolId, studentIds);
            res.status(200).json(result);
        } catch (error) {
            console.error('ERRO AO GERAR LOTE:', error.message);
            res.status(400).json({ message: error.message });
        }
    }

    async scanSheet(req, res) {
        try {
            const schoolId = req.user.school_id;
            const sheet = await examService.scanExamSheet(req.body, schoolId);
            res.status(200).json({ message: 'Computado com sucesso!', sheet });
        } catch (error) {
            console.error('ERRO AO PROCESSAR RESULTADO:', error.message);
            res.status(400).json({ message: error.message });
        }
    }

    async verifySheet(req, res) {
        const requestStart = timedNow();
        const performanceDebug = omrProcessingService.isPerformanceDebugEnabled();
        const correlationId = performanceDebug ? buildCorrelationId(req) : null;

        try {
            const schoolId = req.user.school_id;
            const { uuid } = req.params;
            const verifyStart = timedNow();
            const info = await examService.verifyExamSheet(uuid, schoolId);
            if (performanceDebug) {
                info.correlationId = correlationId;
                info.performance = {
                    correlationId,
                    route: req.originalUrl || req.url,
                    method: req.method,
                    qrUuidPresent: Boolean(uuid),
                    verifySheetMs: roundMs(elapsedMs(verifyStart)),
                    totalRequestMs: roundMs(elapsedMs(requestStart)),
                };
                console.log('[QR PERF]', JSON.stringify(info.performance));
            }
            res.status(200).json(info);
        } catch (error) {
            if (performanceDebug) {
                const performancePayload = {
                    correlationId,
                    route: req.originalUrl || req.url,
                    method: req.method,
                    error: error.message,
                    totalRequestMs: roundMs(elapsedMs(requestStart)),
                };
                console.log('[QR PERF]', JSON.stringify(performancePayload));
            }
            console.error('ERRO AO VERIFICAR QR CODE:', error.message);
            res.status(400).json({ message: error.message });
        }
    }

    async getSheetsByExam(req, res) {
        try {
            const schoolId = req.user.school_id;
            const examId = req.params.id;
            const result = await examService.getExamSheetsByExamId(examId, schoolId);
            res.status(200).json(result);
        } catch (error) {
            console.error('ERRO AO BUSCAR ALUNOS DA PROVA:', error);
            res.status(404).json({ message: error.message });
        }
    }

    async processOMRImage(req, res) {
        try {
            const { status, payload } = await runOmrRequest(req, {
                persistResults: true,
                debugMode: false,
            });

            return res.status(status).json(payload);
        } catch (error) {
            console.error('ERRO AO PROCESSAR OMR:', error.message);
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }
    }

    async debugOMRImage(req, res) {
        try {
            const { status, payload } = await runOmrRequest(req, {
                persistResults: false,
                debugMode: true,
            });

            return res.status(status).json(payload);
        } catch (error) {
            console.error('ERRO AO PROCESSAR DEBUG OMR:', error.message);
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }
    }

    async listOMRDebugFiles(req, res) {
        try {
            const { debugId } = req.params;
            const sessionDir = omrProcessingService.resolveDebugSessionDir(debugId);
            const files = omrProcessingService.buildArtifactList(debugId);

            return res.status(200).json({
                debugId,
                exists: require('fs').existsSync(sessionDir),
                files,
            });
        } catch (error) {
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }
    }

    async downloadOMRDebugFile(req, res) {
        try {
            const { debugId, filename } = req.params;
            const file = omrProcessingService.resolveDebugFile(debugId, filename);

            if (!file) {
                return res.status(404).json({
                    success: false,
                    message: 'Arquivo de debug nao encontrado.',
                });
            }

            res.setHeader('Content-Type', file.contentType);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return res.sendFile(file.filePath);
        } catch (error) {
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }
    }

    async downloadOMRDebugZip(req, res) {
        try {
            const { debugId } = req.params;
            const zipBuffer = omrProcessingService.createDebugZip(debugId);

            if (!zipBuffer) {
                return res.status(404).json({
                    success: false,
                    message: 'Artefatos de debug nao encontrados.',
                });
            }

            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="omr_debug_${debugId}.zip"`);
            res.setHeader('Content-Length', zipBuffer.length);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return res.send(zipBuffer);
        } catch (error) {
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }
    }
}

module.exports = new ExamController();
