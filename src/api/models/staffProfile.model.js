// src/api/models/staffProfile.model.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const addressSchema = require('./address.model'); // ajuste path

const MARITAL_STATUS = [
  'SOLTEIRO',
  'CASADO',
  'DIVORCIADO',
  'VIUVO',
  'UNIAO_ESTAVEL',
];

const staffProfileSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // Kept optional for legacy records. New profiles always receive it from the
  // membership service and are therefore impossible to reuse across schools.
  school_id: { type: Schema.Types.ObjectId, ref: 'School', required: false, index: true },

  // --- Identificação (NOVO) ---
  nationality: { type: String, trim: true, default: '' },

  maritalStatus: {
    type: String,
    enum: [''].concat(MARITAL_STATUS),
    default: '',
    index: true,
  },

  documents: {
    cpf: { type: String, trim: true, default: '' },
    rg: { type: String, trim: true, default: '' },
  },

  address: { type: addressSchema, required: false },

  terminationDate: { type: Date, required: false },

  // --- Contratuais ---
  admissionDate: { type: Date, default: Date.now },
  employmentType: {
    type: String,
    required: true,
    enum: ['Efetivo (CLT)', 'Prestador de Serviço (PJ)', 'Temporário', 'Estagiário'],
  },
  mainRole: { type: String, required: true, trim: true },
  remunerationModel: {
    type: String,
    required: true,
    enum: ['Salário Fixo Mensal', 'Pagamento por Hora/Aula'],
  },
  salaryAmount: {
    type: Number,
    min: 0,
    required: function () { return this.remunerationModel === 'Salário Fixo Mensal'; },
  },
  hourlyRate: {
    type: Number,
    min: 0,
    required: function () { return this.remunerationModel === 'Pagamento por Hora/Aula'; },
  },
  weeklyWorkload: { type: Number, min: 0 },

  // --- Acadêmico ---
  academicFormation: { type: String, trim: true },
  enabledLevels: [{
    type: String,
    enum: ['Educação Infantil', 'Ensino Fundamental I', 'Ensino Fundamental II', 'Ensino Médio'],
  }],
  enabledSubjects: [{ type: Schema.Types.ObjectId, ref: 'Subject' }],
}, { timestamps: true });

staffProfileSchema.index({ user: 1, school_id: 1, mainRole: 1 }, { unique: true });

module.exports = mongoose.model('StaffProfile', staffProfileSchema);
