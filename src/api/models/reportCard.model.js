const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const reportCardScoreHistorySchema = new Schema(
  {
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    actorNameSnapshot: {
      type: String,
      trim: true,
      default: '',
    },
    actorRole: {
      type: String,
      trim: true,
      default: '',
    },
    source: {
      type: String,
      enum: ['manual_report_card_edit', 'exam_result_import'],
      required: true,
    },
    reason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },
    changedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    previous: {
      type: Schema.Types.Mixed,
      default: null,
    },
    current: {
      type: Schema.Types.Mixed,
      required: true,
    },
  },
  { _id: true }
);

const reportCardSubjectSchema = new Schema(
  {
    subjectId: {
      type: Schema.Types.Mixed,
      ref: 'Subject',
      default: null,
    },
    areaId: {
      type: String,
      trim: true,
      default: '',
    },
    subjectNameSnapshot: {
      type: String,
      required: true,
      trim: true,
    },

    teacherId: {
      type: Schema.Types.Mixed,
      ref: 'User',
      default: null,
    },
    teacherNameSnapshot: {
      type: String,
      trim: true,
      default: null,
    },

    // --- NOVOS CAMPOS DE COMPOSIÇÃO DE NOTA ---
    testScore: {
      type: Number,
      min: 0,
      max: 10,
      default: null,
    },
    testScoreSource: {
      type: {
        type: String,
        enum: ['exam_result_import'],
        default: null,
      },
      examId: {
        type: Schema.Types.ObjectId,
        ref: 'Exam',
        default: null,
      },
      examTitle: {
        type: String,
        trim: true,
        default: null,
      },
      sheetId: {
        type: Schema.Types.ObjectId,
        ref: 'ExamSheet',
        default: null,
      },
      importBatchId: {
        type: Schema.Types.ObjectId,
        ref: 'ReportCardExamImport',
        default: null,
      },
      importedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        default: null,
      },
      importedAt: {
        type: Date,
        default: null,
      },
      originalGrade: {
        type: Number,
        default: null,
      },
      originalMaxGrade: {
        type: Number,
        default: null,
      },
      scoreMode: {
        type: String,
        enum: ['raw', 'normalize_to_component'],
        default: null,
      },
    },
    activityScore: {
      type: Number,
      min: 0,
      max: 10,
      default: null,
    },
    participationScore: {
      type: Number,
      min: 0,
      max: 10,
      default: null,
    },
    // -----------------------------------------

    score: {
      type: Number,
      min: 0,
      max: 10,
      default: null,
    },

    status: {
      type: String,
      enum: [
        'Pendente',
        'Preenchido',
        'Abaixo da Média',
        'Acima da Média',
        'Em Revisão',
      ],
      default: 'Pendente',
    },

    observation: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },

    filledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    filledAt: {
      type: Date,
      default: null,
    },
    lastEditedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    lastEditedAt: {
      type: Date,
      default: null,
    },
    lastEditedRole: {
      type: String,
      trim: true,
      default: '',
    },
    lastEditedSource: {
      type: String,
      trim: true,
      default: '',
    },
    scoreHistory: {
      type: [reportCardScoreHistorySchema],
      default: [],
    },
  },
  { _id: false }
);

const developmentalCriterionSchema = new Schema(
  {
    criterionId: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    status: {
      type: String,
      enum: [null, '', 'autonomy', 'support', 'developing', 'not_worked'],
      default: null,
    },
    updatedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const developmentalAssessmentSchema = new Schema(
  {
    subjectId: {
      type: Schema.Types.Mixed,
      ref: 'Subject',
      required: true,
    },
    areaId: {
      type: String,
      trim: true,
      default: '',
    },
    subjectName: {
      type: String,
      required: true,
      trim: true,
    },
    teacherId: {
      type: Schema.Types.Mixed,
      ref: 'User',
      default: null,
    },
    teacherName: {
      type: String,
      trim: true,
      default: '',
    },
    criteria: {
      type: [developmentalCriterionSchema],
      default: [],
    },
    generalObservation: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },
    completionStatus: {
      type: String,
      enum: [
        'pending',
        'in_progress',
        'completed',
        'Pendente',
        'Em preenchimento',
        'Concluido',
        'Concluído',
      ],
      default: 'pending',
    },
    filledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    filledAt: {
      type: Date,
      default: null,
    },
    lastEditedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    lastEditedAt: {
      type: Date,
      default: null,
    },
    lastEditedRole: {
      type: String,
      trim: true,
      default: '',
    },
    lastEditedSource: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { _id: false }
);

const reportCardSchema = new Schema(
  {
    school_id: {
      type: Schema.Types.ObjectId,
      ref: 'School',
      required: [true, 'A referência da escola (school_id) é obrigatória.'],
      index: true,
    },

    schoolYear: {
      type: Number,
      required: [true, 'O ano letivo é obrigatório.'],
      index: true,
    },

    termId: {
      type: Schema.Types.ObjectId,
      ref: 'Periodo',
      required: [true, 'O período/bimestre (termId) é obrigatório.'],
      index: true,
    },

    classId: {
      type: Schema.Types.ObjectId,
      ref: 'Class',
      required: [true, 'A turma (classId) é obrigatória.'],
      index: true,
    },

    studentId: {
      type: Schema.Types.ObjectId,
      ref: 'Student',
      required: [true, 'O aluno (studentId) é obrigatório.'],
      index: true,
    },

    enrollmentId: {
      type: Schema.Types.ObjectId,
      ref: 'Enrollment',
      required: [true, 'A matrícula (enrollmentId) é obrigatória.'],
      index: true,
    },

    gradingType: {
      type: String,
      enum: ['numeric', 'developmental'],
      default: 'numeric',
      required: true,
    },

    evaluationMode: {
      type: String,
      enum: ['numeric', 'developmental'],
      default: 'numeric',
      required: true,
      index: true,
    },

    minimumAverage: {
      type: Number,
      required: true,
      default: 7.0,
      min: 0,
      max: 10,
    },

    status: {
      type: String,
      enum: [
        'Rascunho',
        'Em Preenchimento',
        'Parcial',
        'Completo',
        'Aguardando Conferência',
        'Liberado',
        'Impresso',
      ],
      default: 'Rascunho',
      index: true,
    },

    responsibleNameSnapshot: {
      type: String,
      trim: true,
      default: '',
    },

    generalObservation: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },

    subjects: {
      type: [reportCardSubjectSchema],
      default: [],
    },

    developmentalAssessments: {
      type: [developmentalAssessmentSchema],
      default: [],
    },

    releasedForPrint: {
      type: Boolean,
      default: false,
      index: true,
    },

    releasedAt: {
      type: Date,
      default: null,
    },

    releasedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

// Garante 1 boletim por aluno por turma por período por ano letivo dentro da escola
reportCardSchema.index(
  {
    school_id: 1,
    schoolYear: 1,
    termId: 1,
    classId: 1,
    studentId: 1,
  },
  { unique: true }
);

const ReportCard = mongoose.model('ReportCard', reportCardSchema);

module.exports = ReportCard;
