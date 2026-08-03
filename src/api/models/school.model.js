const mongoose = require('mongoose');

const SchoolSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    publicIdentifier: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true,
      unique: true,
    },
    legalName: { type: String },
    cnpj: { type: String },
    stateRegistration: { type: String },
    municipalRegistration: { type: String },
    inepCode: {
      type: String,
      trim: true,
      validate: {
        validator: (value) => value == null || value === '' || /^\d{8}$/.test(value),
        message: 'Codigo INEP deve conter exatamente 8 digitos numericos.',
      },
    },

    // Diferencia a operação institucional da escola.
    educationModel: {
      type: String,
      enum: ['regular', 'technical_apprenticeship'],
      default: 'regular',
    },

    academicSettings: {
      regularWeeklyScheduleMode: {
        type: String,
        enum: ['period_specific', 'shared_across_periods'],
        default: 'period_specific',
      },
    },

    // Novo campo para o Ato Autorizativo/Portaria
    authorizationProtocol: { type: String },

    contactPhone: { type: String },
    contactEmail: { type: String },

    address: {
      street: String,
      number: String,
      neighborhood: String,
      city: String,
      state: String,
      zipCode: String,
    },

    logo: {
      data: { type: Buffer, select: false },
      contentType: { type: String },
    },

    logoUrl: { type: String },

    platformContact: {
      responsibleName: { type: String, trim: true },
      responsibleEmail: { type: String, trim: true, lowercase: true },
      responsiblePhone: { type: String, trim: true },
    },

    platformAccess: {
      status: {
        type: String,
        enum: ['active', 'inactive', 'blocked', 'trial', 'cancelled'],
        default: 'active',
        index: true,
      },
      isBlocked: {
        type: Boolean,
        default: false,
        index: true,
      },
      reason: { type: String, trim: true, default: '' },
      notes: { type: String, trim: true, default: '' },
      blockedAt: { type: Date, default: null },
      blockedUntil: { type: Date, default: null },
      blockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformAdmin', default: null },
      unblockedAt: { type: Date, default: null },
      unblockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformAdmin', default: null },
      unblockNotes: { type: String, trim: true, default: '' },
    },

    preferredGateway: {
      type: String,
      enum: ['MERCADOPAGO', 'CORA'],
      default: 'MERCADOPAGO',
    },

    mercadoPagoConfig: {
      prodAccessToken: { type: String, select: false },
      prodPublicKey: { type: String },
      prodClientId: { type: String, select: false },
      prodClientSecret: { type: String, select: false },
      isConfigured: { type: Boolean, default: false },
    },

    coraConfig: {
      isSandbox: { type: Boolean, default: false },
      defaultInterest: {
        percentage: { type: Number, default: 0 },
      },
      defaultFine: {
        percentage: { type: Number, default: 0 },
      },
      defaultDiscount: {
        type: Number,
        default: 0,
      },
      sandbox: {
        clientId: { type: String },
        certificateContent: { type: String, select: false },
        privateKeyContent: { type: String, select: false },
      },
      production: {
        clientId: { type: String },
        certificateContent: { type: String, select: false },
        privateKeyContent: { type: String, select: false },
      },
      isConfigured: { type: Boolean, default: false },
    },

    whatsapp: {
      status: {
        type: String,
        enum: ['disconnected', 'connecting', 'qr_pending', 'connected', 'error'],
        default: 'disconnected',
        index: true,
      },
      instanceName: {
        type: String,
        index: true,
      },
      qrCode: {
        type: String,
        default: null,
        select: false,
      },
      connectedPhone: {
        type: String,
        default: null,
      },
      profileName: {
        type: String,
        default: null,
      },
      lastSyncAt: {
        type: Date,
        default: null,
      },
      lastConnectedAt: {
        type: Date,
        default: null,
      },
      lastDisconnectedAt: {
        type: Date,
        default: null,
      },
      lastError: {
        type: String,
        default: null,
      },
    },
  },
  {
    timestamps: true,
  }
);

SchoolSchema.set('toJSON', {
  transform: function (doc, ret) {
    if (ret.mercadoPagoConfig) {
      delete ret.mercadoPagoConfig.prodAccessToken;
      delete ret.mercadoPagoConfig.prodClientSecret;
    }

    if (ret.coraConfig) {
      if (ret.coraConfig.sandbox) {
        delete ret.coraConfig.sandbox.certificateContent;
        delete ret.coraConfig.sandbox.privateKeyContent;
      }

      if (ret.coraConfig.production) {
        delete ret.coraConfig.production.certificateContent;
        delete ret.coraConfig.production.privateKeyContent;
      }
    }

    if (ret.whatsapp) {
      delete ret.whatsapp.qrCode;
    }

    return ret;
  },
});

module.exports = mongoose.model('School', SchoolSchema);
