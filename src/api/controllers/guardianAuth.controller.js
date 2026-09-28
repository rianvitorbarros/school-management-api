const crypto = require('crypto');
const guardianAuthService = require('../services/guardianAuth.service');

function buildRequestMeta(req, fallbackSource = 'api') {
  const requestedSource = String(
    req.headers['x-client-source'] || ''
  ).toLowerCase();
  const source =
    fallbackSource === 'desktop'
      ? 'desktop'
      : requestedSource === 'mobile'
        ? 'mobile'
        : 'api';

  return {
    ip: req.ip || null,
    userAgent: req.headers['user-agent'] || null,
    source,
    devicePlatform: req.headers['x-client-platform'] || 'unknown',
    appVersion: req.headers['x-app-version'] || null,
    correlationId:
      req.guardianAuditCorrelationId ||
      (req.guardianAuditCorrelationId = crypto.randomUUID()),
  };
}

function getSchoolId(req) {
  return req.user?.school_id || req.user?.schoolId || null;
}

function getGuardianContext(req) {
  return {
    schoolId: req.guardian?.school_id || req.guardian?.schoolId || null,
    accountId: req.guardian?.accountId || null,
    tutorId: req.guardian?.tutorId || null,
  };
}

function sendError(res, error, fallbackMessage) {
  if (error?.payload && typeof error.payload === 'object') {
    return res.status(error.statusCode || 500).json({
      ...error.payload,
      code: error.payload.code || error.reason || null,
      message:
        error.payload.message || error.message || fallbackMessage,
    });
  }

  return res.status(error.statusCode || 500).json({
    code: error.reason || null,
    message: error.message || fallbackMessage,
  });
}

class GuardianAuthController {
  async startFirstAccess(req, res) {
    try {
      const result = await guardianAuthService.startFirstAccess({
        schoolPublicId: req.body?.schoolPublicId,
        studentFullName: req.body?.studentFullName,
        birthDate: req.body?.birthDate,
        requestMeta: buildRequestMeta(req),
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel iniciar o primeiro acesso.'
      );
    }
  }

  async verifyResponsible(req, res) {
    try {
      const result = await guardianAuthService.verifyResponsible({
        challengeId: req.body?.challengeId,
        optionId: req.body?.optionId,
        cpf: req.body?.cpf,
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel validar o responsavel.'
      );
    }
  }

  async setPin(req, res) {
    try {
      const result = await guardianAuthService.setPin({
        challengeId: req.body?.challengeId,
        verificationToken: req.body?.verificationToken,
        pin: req.body?.pin,
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel configurar o PIN.');
    }
  }

  async linkExistingAccount(req, res) {
    try {
      const result = await guardianAuthService.linkExistingAccount({
        challengeId: req.body?.challengeId,
        verificationToken: req.body?.verificationToken,
        pin: req.body?.pin,
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel vincular o aluno a conta existente.'
      );
    }
  }

  async startPinRecovery(req, res) {
    try {
      const result = await guardianAuthService.startPinRecovery({
        cpf: req.body?.cpf,
        studentFullName: req.body?.studentFullName,
        studentBirthDate: req.body?.studentBirthDate,
        guardianBirthDate: req.body?.guardianBirthDate,
        schoolPublicId: req.body?.schoolPublicId,
        requestMeta: buildRequestMeta(req),
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel confirmar os dados informados. Revise e tente novamente ou procure a escola.'
      );
    }
  }

  async completePinRecovery(req, res) {
    try {
      const result = await guardianAuthService.completePinRecovery({
        challengeId: req.body?.challengeId,
        verificationToken: req.body?.verificationToken,
        newPin: req.body?.newPin,
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel concluir a recuperacao do PIN.'
      );
    }
  }

  async login(req, res) {
    try {
      const result = await guardianAuthService.login({
        schoolPublicId: req.body?.schoolPublicId,
        identifier: req.body?.identifier || req.body?.cpf,
        pin: req.body?.pin,
        requestMeta: buildRequestMeta(req),
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel autenticar o responsavel.');
    }
  }

  async listStudentGuardianAccesses(req, res) {
    try {
      const schoolId = getSchoolId(req);
      const result = await guardianAuthService.listStudentGuardianAccesses({
        schoolId,
        studentId: req.params.studentId,
        actor: req.user,
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel listar os acessos de responsaveis.'
      );
    }
  }

  async listGuardianAccessEvents(req, res) {
    try {
      const result = await guardianAuthService.listGuardianAccessEvents({
        schoolId: getSchoolId(req),
        accountId: req.params.accountId,
        actor: req.user,
        filters: req.query || {},
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel consultar o historico de acesso.'
      );
    }
  }

  async listGuardianInvoices(req, res) {
    try {
      const guardian = getGuardianContext(req);
      const result = await guardianAuthService.listGuardianInvoices({
        schoolId: guardian.schoolId,
        accountId: guardian.accountId,
        accountTutorId: guardian.tutorId,
        studentId: req.query?.studentId || null,
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel carregar os boletos do responsavel.'
      );
    }
  }

  async getGuardianPortalHome(req, res) {
    try {
      const guardian = getGuardianContext(req);
      const result = await guardianAuthService.getGuardianPortalHome({
        schoolId: guardian.schoolId,
        accountId: guardian.accountId,
        studentId: req.query?.studentId || null,
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel carregar a Home do responsavel.'
      );
    }
  }

  async getGuardianSchedule(req, res) {
    try {
      const guardian = getGuardianContext(req);
      const result = await guardianAuthService.getGuardianSchedule({
        schoolId: guardian.schoolId,
        accountId: guardian.accountId,
        studentId: req.params.studentId,
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel carregar a grade do responsavel.'
      );
    }
  }

  async getGuardianAttendance(req, res) {
    try {
      const guardian = getGuardianContext(req);
      const result = await guardianAuthService.getGuardianAttendance({
        schoolId: guardian.schoolId,
        accountId: guardian.accountId,
        studentId: req.params.studentId,
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel carregar a frequencia do responsavel.'
      );
    }
  }

  async getGuardianActivities(req, res) {
    try {
      const guardian = getGuardianContext(req);
      const result = await guardianAuthService.getGuardianActivities({
        schoolId: guardian.schoolId,
        accountId: guardian.accountId,
        studentId: req.params.studentId,
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel carregar as atividades do responsavel.'
      );
    }
  }

  async batchPrintGuardianInvoices(req, res) {
    try {
      const guardian = getGuardianContext(req);
      const pdfBytes = await guardianAuthService.downloadGuardianBatchPdf({
        schoolId: guardian.schoolId,
        accountId: guardian.accountId,
        invoiceIds: req.body?.invoiceIds,
        studentId: req.body?.studentId || null,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        'inline; filename=guardian_carne_pagamento.pdf'
      );

      return res.send(Buffer.from(pdfBytes));
    } catch (error) {
      return sendError(
        res,
        error,
        'Nao foi possivel gerar o PDF dos boletos.'
      );
    }
  }

  async resetPin(req, res) {
    try {
      const schoolId = getSchoolId(req);
      const result = await guardianAuthService.resetPin({
        schoolId,
        accountId: req.params.accountId,
        actor: req.user,
        reasonCode: req.body?.reasonCode,
        reasonText: req.body?.reasonText,
        requestMeta: buildRequestMeta(req, 'desktop'),
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel resetar o PIN.');
    }
  }

  async createTemporaryAccess(req, res) {
    try { return res.status(201).json(await guardianAuthService.createTemporaryAccess({ schoolId: getSchoolId(req), accountId: req.params.accountId, actor: req.user })); }
    catch (error) { return sendError(res, error, 'Nao foi possivel gerar o acesso temporario.'); }
  }

  async revokeTemporaryAccess(req, res) {
    try { return res.json(await guardianAuthService.revokeTemporaryAccess({ schoolId: getSchoolId(req), accountId: req.params.accountId, actor: req.user })); }
    catch (error) { return sendError(res, error, 'Nao foi possivel revogar o acesso temporario.'); }
  }

  async unlockAccount(req, res) {
    try {
      const schoolId = getSchoolId(req);
      const result = await guardianAuthService.unlockAccount({
        schoolId,
        accountId: req.params.accountId,
        actor: req.user,
        reasonCode: req.body?.reasonCode,
        reasonText: req.body?.reasonText,
        requestMeta: buildRequestMeta(req, 'desktop'),
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel desbloquear a conta.');
    }
  }

  async deactivateAccount(req, res) {
    try {
      const schoolId = getSchoolId(req);
      const result = await guardianAuthService.deactivateAccount({
        schoolId,
        accountId: req.params.accountId,
        actor: req.user,
        reasonCode: req.body?.reasonCode,
        reasonText: req.body?.reasonText,
        requestMeta: buildRequestMeta(req, 'desktop'),
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel desativar a conta.');
    }
  }

  async reactivateAccount(req, res) {
    try {
      const schoolId = getSchoolId(req);
      const result = await guardianAuthService.reactivateAccount({
        schoolId,
        accountId: req.params.accountId,
        actor: req.user,
        reasonCode: req.body?.reasonCode,
        reasonText: req.body?.reasonText,
        requestMeta: buildRequestMeta(req, 'desktop'),
      });

      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel reativar a conta.');
    }
  }
}

module.exports = new GuardianAuthController();
