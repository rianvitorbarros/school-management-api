const mongoose = require('mongoose');

// Deliberately keeps grades as the school-configured values already used by Class.
// A "Grade" model in this application represents an assessment mark, not a grade level.
const academicProgressionSchema = new mongoose.Schema({
  school_id: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
  level: { type: String, required: true, trim: true },
  fromGrade: { type: String, required: true, trim: true },
  // Usually the next grade stays in the same level. It is explicit for
  // transitions such as 5º Ano (Fundamental I) -> 6º Ano (Fundamental II).
  toLevel: { type: String, trim: true, default: null },
  // The Class model is the current academic catalogue in the regular flow;
  // its level/grade values are therefore the stable school-scoped keys here.
  toGrade: { type: String, trim: true, default: null },
  progressionType: { type: String, enum: ['NEXT_GRADE', 'TERMINAL'], default: 'NEXT_GRADE' },
  active: { type: Boolean, default: true, index: true },
}, { timestamps: true });

academicProgressionSchema.pre('validate', function validateProgression(next) {
  const from = String(this.fromGrade || '').trim();
  const to = String(this.toGrade || '').trim();
  if (this.progressionType === 'TERMINAL') {
    this.toGrade = null;
    this.toLevel = null;
    return next();
  }
  if (!to) return next(new Error('A próxima série é obrigatória para uma progressão interna.'));
  if (from && from === to) return next(new Error('A série de origem não pode ser igual à próxima série.'));
  return next();
});

academicProgressionSchema.index(
  { school_id: 1, level: 1, fromGrade: 1 },
  { unique: true, name: 'uniq_school_academic_progression_source' }
);

module.exports = mongoose.model('AcademicProgression', academicProgressionSchema);
