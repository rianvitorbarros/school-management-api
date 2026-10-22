const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const parentContactSchema = new Schema({
    fullName: String,
    cpf: String,
    rg: String,
    birthDate: Date,
    phoneNumber: String,
    email: String,
    profession: String,
    relationship: String,
    isPrimaryResponsible: { type: Boolean, default: false },
    notInRegistry: { type: Boolean, default: false },
    authorizedPickup: { type: Boolean, default: false },
    address: {
        street: String,
        number: String,
        neighborhood: String,
        city: String,
        state: String,
        cep: String,
        zipCode: String,
        complement: String,
        block: String,
        lot: String
    }
}, { _id: false });

const emergencyContactSchema = new Schema({
    name: String,
    phoneNumber: String,
    relationship: String
}, { _id: false });

const enrollmentOfferSnapshotSchema = new Schema({
    name: String,
    type: String,
    startTime: String,
    endTime: String,
    monthlyFee: Number,
    pricingMode: String
}, { _id: false });

const permanenceClassSnapshotSchema = new Schema({
    name: String,
    shift: String,
    startTime: String,
    endTime: String
}, { _id: false });

const registrationRequestSchema = new Schema({
    // ... campos padrão (school_id, status, type) ...
    school_id: { type: Schema.Types.ObjectId, ref: 'School', required: true, index: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', index: true },
    registrationType: { type: String, enum: ['ADULT_STUDENT', 'MINOR_STUDENT'], required: true },
    academicYearTo: { type: Number, min: 1900, max: 2200 },
    approvedStudentId: { type: Schema.Types.ObjectId, ref: 'Student' },
    selectedClassId: { type: Schema.Types.ObjectId, ref: 'Class', required: false, index: true },
    projectedClassSourceId: { type: Schema.Types.ObjectId, ref: 'Class' },
    selectedClassSnapshot: {
        schoolYear: Number,
        id: String,
        name: String,
        educationLevel: String,
        grade: String,
        shift: String,
        startTime: String,
        endTime: String,
        monthlyFee: Number,
        pricingVersionId: String,
        pricingVersion: Number
    },
    selectedEnrollmentOfferId: {
        type: Schema.Types.ObjectId,
        ref: 'EnrollmentOffer',
        required: false,
        index: true
    },
    selectedEnrollmentOfferSnapshot: {
        type: enrollmentOfferSnapshotSchema,
        default: undefined
    },
    requestedRegime: {
        type: String,
        enum: [
            'regular',
            'full_time',
            'extended_stay',
            'complementary_activity',
            'reinforcement',
            'other',
            null
        ],
        default: null
    },
    requestedPermanenceClassId: {
        type: Schema.Types.ObjectId,
        ref: 'Class',
        required: false
    },
    requestedPermanenceClassSnapshot: {
        type: permanenceClassSnapshotSchema,
        default: undefined
    },
    permanenceNotes: {
        type: String,
        trim: true
    },
    origin: { type: String, trim: true },
    onlyMinors: { type: Boolean },
    
    // --- DADOS COMPLETOS DO ALUNO ---
    studentData: {
        fullName: { type: String, required: true },
        
        // [NOVO] Série/Turma Pretendida (Informada pelo pai)
        intendedGrade: { type: String, required: false }, 

        birthDate: { type: Date, required: true },
        motherName: String,
        fatherName: String,
        parents: {
            mother: { type: parentContactSchema, default: undefined },
            father: { type: parentContactSchema, default: undefined }
        },
        primaryResponsibleType: {
            type: String,
            enum: ['mother', 'father', 'other', null],
            default: null
        },
        gender: String,
        race: String,
        nationality: String,
        phoneNumber: String,
        email: String,
        cpf: String,
        rg: String,
        
        // Endereço Completo
        address: {
            street: String,
            number: String,
            neighborhood: String,
            city: String,
            state: String,
            cep: String,
            zipCode: String,
            complement: String,
            block: String,
            lot: String
        },

        // Ficha de Saúde (inalterada)
        healthInfo: {
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
            emergencyContact: { type: emergencyContactSchema, default: undefined },
            feverMedication: { type: String, default: '' },
            foodObservations: { type: String, default: '' },
            generalNotes: { type: String, default: '' },
        },
        
        // Pessoas Autorizadas
        authorizedPickups: [{
            fullName: String,
            relationship: String,
            phoneNumber: String
        }]
    },

    // --- DADOS DO TUTOR ---
    tutorData: {
        fullName: String,
        
        // [NOVO] Profissão do Tutor (opcional aqui também para refletir o schema do Tutor)
        profession: { type: String },

        birthDate: Date,
        cpf: String,
        rg: String,
        gender: String,
        nationality: String,
        phoneNumber: String,
        email: String,
        relationship: String,
        address: {
            street: String,
            number: String,
            neighborhood: String,
            city: String,
            state: String,
            cep: String,
            zipCode: String,
            complement: String,
            block: String,
            lot: String
        }
    },

    rejectionReason: { type: String },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, {
    timestamps: true
});

module.exports = mongoose.model('RegistrationRequest', registrationRequestSchema);
