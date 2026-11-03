const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const questionSchema = new Schema({
    type: {
        type: String,
        enum: ['OBJECTIVE', 'DISSERTATIVE'],
        required: true
    },
    text: { type: String, required: true },

    image: {
        url: { type: String, default: null },
        layout: {
            type: String,
            // 👇 AQUI ESTÁ A CORREÇÃO: Atualizado com os novos layouts do Flutter
            enum: ['NONE', 'LEFT_SMALL', 'RIGHT_SMALL', 'CENTER_MEDIUM', 'CENTER_LARGE', 'FULL_WIDTH'],
            default: 'NONE'
        }
    },

    options: [{ type: String }],

    correctAnswer: {
        type: String,
        enum: ['A', 'B', 'C', 'D', 'E', null],
        default: null
    },

    linesToLeave: { type: Number, default: 5 },
    weight: { type: Number, default: 1 },

    // Metadados pedagogicos (preenchidos pela Iara ou pelo professor).
    difficulty: { type: String, enum: ['EASY', 'MEDIUM', 'HARD', null], default: null },
    explanation: { type: String, default: null },
    expectedAnswer: { type: String, default: null },
    bnccSkill: { type: String, default: null },
    estimatedMinutes: { type: Number, default: null },
    generatedByIara: { type: Boolean, default: false }
});

const examSchema = new Schema({
    school_id: { type: Schema.Types.ObjectId, ref: 'School', required: true, index: true },
    teacher_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    class_id: { type: Schema.Types.ObjectId, ref: 'Class', required: true },
    subject_id: { type: Schema.Types.ObjectId, ref: 'Subject', required: true },
    schoolyear_id: { type: Schema.Types.ObjectId, ref: 'SchoolYear' },
    termId: { type: Schema.Types.ObjectId, ref: 'Periodo', default: null, index: true },
    termResolution: {
        status: {
            type: String,
            enum: ['explicit', 'inferred', 'missing', 'conflict'],
            default: 'missing'
        },
        source: {
            type: String,
            enum: ['payload', 'applicationDate', 'current_period', 'legacy_inference', 'none'],
            default: 'none'
        },
        resolvedAt: { type: Date, default: null },
        message: { type: String, default: null }
    },

    title: { type: String, required: true },
    applicationDate: { type: Date, required: true },
    totalValue: { type: Number, required: true },

    correctionType: {
        type: String,
        enum: ['DIRECT_GRADE', 'BUBBLE_SHEET'],
        default: 'DIRECT_GRADE'
    },

    questions: [questionSchema],

    settings: {
        evaluationId: { type: Schema.Types.ObjectId, ref: 'Evaluation', default: null },
        omrLayout: { type: Schema.Types.Mixed, default: null }
    },

    reusedFromExamId: { type: Schema.Types.ObjectId, ref: 'Exam', default: null },
    reusedFromClassId: { type: Schema.Types.ObjectId, ref: 'Class', default: null },
    reusedAt: { type: Date, default: null },
    reusedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    status: {
        type: String,
        enum: ['DRAFT', 'READY', 'PRINTED', 'GRADED'],
        default: 'DRAFT'
    }
}, { timestamps: true });

examSchema.index({ school_id: 1, class_id: 1, applicationDate: -1, createdAt: -1 });
examSchema.index({ school_id: 1, class_id: 1, teacher_id: 1, applicationDate: -1, createdAt: -1 });
examSchema.index({ school_id: 1, class_id: 1, subject_id: 1, applicationDate: -1, createdAt: -1 });
examSchema.index({ school_id: 1, class_id: 1, termId: 1, applicationDate: -1, createdAt: -1 });

module.exports = mongoose.model('Exam', examSchema);
