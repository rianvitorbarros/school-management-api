const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const AttendanceRecordSchema = new Schema({
  studentId: {
    type: Schema.Types.ObjectId,
    ref: 'Student',
    required: true
  },
  status: {
    type: String,
    enum: ['PRESENT', 'ABSENT'],
    default: 'PRESENT'
  },
  observation: {
    type: String,
    default: ''
  },
  absenceState: {
    type: String,
    enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'],
    default: 'NONE'
  },
  justificationId: {
    type: Schema.Types.ObjectId,
    ref: 'AbsenceJustification',
    default: null
  },
  justificationDeadlineAt: {
    type: Date,
    default: null
  },
  justificationUpdatedAt: {
    type: Date,
    default: null
  }
}, { _id: false });

const AttendanceSchema = new Schema({
  schoolId: {
    type: Schema.Types.ObjectId,
    ref: 'School',
    required: true,
    index: true
  },
  classId: {
    type: Schema.Types.ObjectId,
    ref: 'Class',
    required: true
  },
  teacherId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  date: {
    type: Date,
    required: true,
    default: Date.now
  },
  records: {
    type: [AttendanceRecordSchema],
    default: []
  },
  version: {
    type: Number,
    default: 1,
    min: 1
  },
  appliedOperationIds: {
    type: [String],
    default: [],
    select: false
  },
  metadata: {
    device: {
      type: String,
      default: 'mobile'
    },
    syncedAt: {
      type: Date,
      default: Date.now
    }
  }
}, { timestamps: true });

AttendanceSchema.index({ schoolId: 1, classId: 1, date: 1 }, { unique: true });
AttendanceSchema.index({ schoolId: 1, appliedOperationIds: 1 });
AttendanceSchema.index({ schoolId: 1, classId: 1, 'records.studentId': 1 });
AttendanceSchema.index({ schoolId: 1, classId: 1, 'records.absenceState': 1 });

module.exports = mongoose.model('Attendance', AttendanceSchema);
