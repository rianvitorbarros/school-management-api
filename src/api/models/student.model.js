const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const addressSchema = require('./address.model');
const { buildBirthDateKey, normalizeName } = require('../utils/guardianAccess.util');

const auditLogPlugin = require('../../helpers/auditLog.plugin');

// --- SUB-SCHEMAS ---
const studentAuthSchema = new Schema({
    username: { type: String, sparse: true, trim: true },
    passwordHash: { type: String, select: false },
    firstAccess: { type: Boolean, default: true },
    lastLogin: { type: Date }
}, { _id: false });

const healthInfoSchema = new Schema({
    hasHealthProblem: { type: Boolean, default: false },
    healthProblemDetails: { type: String, default: '' },
    hasHealthCondition: { type: Boolean, default: false },
    healthConditionDetails: { type: String, default: '' },
    takesMedication: { type: Boolean, default: false },
    medicationDetails: { type: String, default: '' },
    usesContinuousMedication: { type: Boolean, default: false },
    continuousMedicationName: { type: String, default: '' },
    continuousMedicationGuidance: { type: String, default: '' },
    hasDisability: { type: Boolean, default: false },
    disabilityDetails: { type: String, default: '' },
    disabilities: { type: [String], default: [] },
    accessibilityNeeds: { type: String, default: '' },
    hasAllergy: { type: Boolean, default: false },
    allergyDetails: { type: String, default: '' },
    hasAllergies: { type: Boolean, default: false },
    allergies: { type: [String], default: [] },
    hasMedicationAllergy: { type: Boolean, default: false },
    medicationAllergyDetails: { type: String, default: '' },
    hasVisionProblem: { type: Boolean, default: false },
    visionProblemDetails: { type: String, default: '' },
    wearsGlasses: { type: Boolean, default: false },
    usesGlassesDaily: { type: Boolean, default: false },
    needsFrontSeat: { type: Boolean, default: false },
    glassesUseDetails: { type: String, default: '' },
    hasNeurodevelopmentalCondition: { type: Boolean, default: false },
    neurodevelopmentalConditions: { type: [String], default: [] },
    neurodevelopmentalDetails: { type: String, default: '' },
    hasFoodRestriction: { type: Boolean, default: false },
    foodRestrictions: { type: [String], default: [] },
    foodRestrictionDetails: { type: String, default: '' },
    emergencyContact: {
        name: { type: String, default: '' },
        phoneNumber: { type: String, default: '' },
        relationship: { type: String, default: '' }
    },
    feverMedication: { type: String, default: '' },
    foodObservations: { type: String, default: '' },
    generalNotes: { type: String, default: '' },
}, { _id: false });

const parentContactSchema = new Schema({
    fullName: { type: String, trim: true, default: '' },
    cpf: { type: String, trim: true, default: '' },
    rg: { type: String, trim: true, default: '' },
    birthDate: { type: Date, default: null },
    phoneNumber: { type: String, trim: true, default: '' },
    email: { type: String, lowercase: true, trim: true, default: '' },
    profession: { type: String, trim: true, default: '' },
    relationship: { type: String, trim: true, default: '' },
    isPrimaryResponsible: { type: Boolean, default: false },
    notInRegistry: { type: Boolean, default: false },
    authorizedPickup: { type: Boolean, default: false },
    address: { type: addressSchema, default: undefined },
}, { _id: false });

const authorizedPickupSchema = new Schema({
    fullName: { type: String, required: true },
    relationship: { type: String, required: true },
    phoneNumber: { type: String, required: true },
}, { _id: false });

const gradeSchema = new Schema({
    subjectId: { type: Schema.Types.ObjectId, ref: 'Subject', default: null },
    subjectName: { type: String, required: true, trim: true },
    gradeValue: { type: String, trim: true, default: '' },
    historicalName: { type: String, trim: true, default: '' },
    curriculumCategory: { type: String, trim: true, default: '' },
    finalGrade: { type: Number, min: 0, max: 10, default: null },
    concept: { type: String, trim: true, default: '' },
    specialStatus: {
        type: String,
        enum: ['', 'not_taken', 'not_offered', 'exempt', 'transferred'],
        default: ''
    },
    workloadHours: { type: Number, min: 0, default: null },
    bimonthlyGrades: {
        type: [{ type: Number, min: 0, max: 10, default: null }],
        default: []
    },
    origin: {
        type: String,
        enum: ['legacy', 'manual', 'system_import'],
        default: 'legacy'
    }
}, { _id: false });

const academicRecordSchema = new Schema({
    gradeLevel: { type: String, required: true, trim: true },
    schoolYear: { type: Number, required: true },
    schoolName: { type: String, required: true, trim: true, default: 'Escola Sossego da Mamãe' },
    inepCode: { type: String, trim: true, default: '' },
    city: { type: String, required: true, trim: true, default: 'Parauapebas' },
    state: { type: String, required: true, trim: true, default: 'PA' },
    enrollmentId: { type: Schema.Types.ObjectId, ref: 'Enrollment', default: null },
    classId: { type: Schema.Types.ObjectId, ref: 'Class', default: null },
    grades: { type: [gradeSchema], default: [] },
    annualWorkload: { type: String, trim: true },
    annualFrequency: { type: Number, min: 0, max: 100, default: null },
    schoolDays: { type: Number, min: 0, default: null },
    finalResult: { type: String, required: true, trim: true },
    observations: { type: String, trim: true, default: '' },
    approvalCriterion: { type: String, trim: true, default: '' },
    institutionType: {
        type: String,
        enum: ['legacy', 'current_school', 'external_school'],
        default: 'legacy'
    },
    gradeEntryMode: {
        type: String,
        enum: ['final_only', 'bimonthly'],
        default: 'final_only'
    },
    origin: {
        type: String,
        enum: ['legacy', 'manual', 'system_import'],
        default: 'legacy'
    },
    gradingFormulaSnapshot: { type: Schema.Types.Mixed, default: null },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

// --- SCHEMA PRINCIPAL ---

const studentSchema = new Schema({
    enrollmentNumber: { type: String, unique: true, trim: true, sparse: true, },
    
    intendedGrade: { type: String, trim: true },

    accessCredentials: { type: studentAuthSchema, default: () => ({}) },

    fullName: { type: String, required: [true, 'O nome completo é obrigatório.'], trim: true },
    fullNameNormalized: { type: String, default: null, index: true },
    birthDate: { type: Date, required: [true, 'A data de nascimento é obrigatória.'] },
    birthDateKey: { type: String, default: null, index: true },
    gender: { type: String, required: true, enum: ['Masculino', 'Feminino', 'Outro'] },
    race: { type: String, required: true, enum: ['Branca', 'Preta', 'Parda', 'Amarela', 'Indígena', 'Prefiro não dizer'] },
    nationality: { type: String, required: true },
    
    profilePicture: {
        data: Buffer,
        contentType: String
    },
    
    email: { type: String, lowercase: true, sparse: true, trim: true },
    phoneNumber: { type: String },
    
    rg: { type: String, sparse: true },
    cpf: { type: String, sparse: true }, 
    mother_name: { type: String, trim: true, default: '' },
    father_name: { type: String, trim: true, default: '' },
    parents: {
        mother: { type: parentContactSchema, default: undefined },
        father: { type: parentContactSchema, default: undefined },
    },
    primaryResponsibleType: {
        type: String,
        enum: ['mother', 'father', 'other', null],
        default: null,
    },
    
    birthCertificateUrl: { type: String },
    address: { type: addressSchema, required: true },

    tutors: {
        type: [
            {
                _id: false, 
                tutorId: { type: Schema.Types.ObjectId, ref: 'Tutor' }, 
                // A validação de ENUM acontece aqui, mas o hook 'pre validate' vai corrigir antes
                relationship: { type: String, enum: ['Mãe', 'Pai', 'Avó/Avô', 'Tio/Tia', 'Outro', 'Cônjuge'] }
            }
        ],
        default: []
    },

    financialResp: {
        type: String,
        enum: ['STUDENT', 'TUTOR'],
        default: 'TUTOR', 
        required: true
    },

    financialTutorId: {
        type: Schema.Types.ObjectId,
        ref: 'Tutor',
        default: null
    },

    healthInfo: { type: healthInfoSchema, default: () => ({}) },
    authorizedPickups: { type: [authorizedPickupSchema], default: [] },
    isActive: { type: Boolean, default: true },
    classId: { type: Schema.Types.ObjectId, ref: 'Class', default: null },
    school_id: { type: Schema.Types.ObjectId, ref: 'School', required: [true, 'School ID obrigatório.'], index: true },
    academicHistory: { type: [academicRecordSchema], default: [] }
}, {
    timestamps: true 
});

// --- [NOVO] HOOK DE CORREÇÃO (Sanitização) ---
// Roda ANTES da validação do Mongoose. Transforma 'pai' em 'Pai', etc.
studentSchema.pre('validate', function(next) {
    this.fullNameNormalized = normalizeName(this.fullName);
    this.birthDateKey = buildBirthDateKey(this.birthDate);

    if (this.tutors && this.tutors.length > 0) {
        const mapRel = {
            'pai': 'Pai',
            'mãe': 'Mãe', 'mae': 'Mãe',
            'avó': 'Avó/Avô', 'avô': 'Avó/Avô', 'avo': 'Avó/Avô', 'avó/avô': 'Avó/Avô',
            'tio': 'Tio/Tia', 'tia': 'Tio/Tia', 'tio/tia': 'Tio/Tia',
            'conjuge': 'Cônjuge', 'cônjuge': 'Cônjuge',
            'outro': 'Outro'
        };

        this.tutors.forEach(tutor => {
            if (tutor.relationship && typeof tutor.relationship === 'string') {
                const lower = tutor.relationship.toLowerCase().trim();
                // Tenta encontrar no mapa, se não, tenta Capitalizar a primeira letra
                if (mapRel[lower]) {
                    tutor.relationship = mapRel[lower];
                } else {
                    // Fallback: 'alguma coisa' -> 'Alguma coisa'
                    tutor.relationship = tutor.relationship.charAt(0).toUpperCase() + tutor.relationship.slice(1).toLowerCase();
                }
            }
        });
    }
    next();
});

// HOOKS DE VALIDAÇÃO DE NEGÓCIO
studentSchema.pre('save', function(next) {
    if (this.rg === '') { this.rg = null; }
    if (this.cpf === '') { this.cpf = null; }
    if (this.email === '') { this.email = null; }

    const today = new Date();
    const birthDate = new Date(this.birthDate);
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }

    if (age < 18) {
        if (this.tutors.length === 0) {
            return next(new Error('Alunos menores de idade precisam de pelo menos um tutor/responsável vinculado.'));
        }
        if (this.financialResp === 'STUDENT') {
            return next(new Error('Alunos menores de idade não podem ser responsáveis financeiros. Selecione um Tutor.'));
        }
    }

    if (this.financialResp === 'TUTOR') {
        if (!this.financialTutorId) {
            if (this.tutors.length > 0) {
                this.financialTutorId = this.tutors[0].tutorId;
            } else {
                return next(new Error('Responsabilidade financeira definida como Tutor, mas não há tutores cadastrados.'));
            }
        }
    } else {
        this.financialTutorId = null;
    }

    if (this.financialResp === 'STUDENT' && !this.cpf) {
         return next(new Error('Para ser o responsável financeiro, o aluno precisa ter o CPF cadastrado.'));
    }

    next();
});

studentSchema.plugin(auditLogPlugin, { entityName: 'Student' });
studentSchema.index({ school_id: 1, fullNameNormalized: 1, birthDateKey: 1, isActive: 1 });

const Student = mongoose.model('Student', studentSchema);
module.exports = Student;
