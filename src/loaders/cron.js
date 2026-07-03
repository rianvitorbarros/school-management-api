const cron = require('node-cron');

const InvoiceService = require('../api/services/invoice.service');
const NotificationService = require('../api/services/notification.service');
const gmailMailboxReconciliationService = require('../api/services/gmailMailboxReconciliation.service');
const WhatsappBotService = require('../api/services/whatsappBot.service');
const tempAccessTokenService = require('../api/services/tempAccessToken.service');
const guardianAuthService = require('../api/services/guardianAuth.service');

let financeSyncSweepRunning = false;

const initCronJobs = () => {
    console.log('Inicializando Cron Jobs...');

    // ------------------------------------------------------------------
    // JOB 1 - Scan inteligente da fila de cobranca
    // roda a cada hora e respeita a janela configurada por escola
    // ------------------------------------------------------------------
    cron.schedule('0 * * * *', async () => {
        console.log('[Cron] Executando scan inteligente de cobranca');

        try {
            await NotificationService.scanAndQueueInvoices({
                dispatchOrigin: 'cron_scan',
            });
        } catch (error) {
            console.error('Erro no Cron Job de scan de cobranca:', error);
        }

    }, {
        scheduled: true,
        timezone: 'America/Sao_Paulo',
    });

    // ------------------------------------------------------------------
    // JOB 1A - Processamento da fila de notificacoes
    // roda a cada minuto para drenar a fila com previsibilidade
    // ------------------------------------------------------------------
    cron.schedule('* * * * *', async () => {
        try {
            await NotificationService.processQueue();
        } catch (error) {
            console.error('Erro no Cron Job de processamento da fila:', error);
        }

    }, {
        scheduled: true,
        timezone: 'America/Sao_Paulo',
    });

    // ------------------------------------------------------------------
    // JOB 1B - Sincronizacao financeira em background
    // roda a cada 15 minutos, sem depender da navegacao na tela
    // ------------------------------------------------------------------
    cron.schedule('*/15 * * * *', async () => {
        if (financeSyncSweepRunning) {
            console.log('[Cron] Finance sync sweep ja esta em execucao. Pulando ciclo.');
            return;
        }

        financeSyncSweepRunning = true;

        try {
            const result = await InvoiceService.processFinanceSyncSweep();

            console.log('[Cron] Finance sync sweep concluido', {
                totalSchools: result?.totalSchools || 0,
                startedSchools: result?.startedSchools || 0,
                skippedSchools: result?.skippedSchools || 0,
                failedSchools: result?.failedSchools || 0,
                updatedCount: result?.updatedCount || 0,
            });
        } catch (error) {
            console.error('Erro no Cron Job de Sync Financeira:', error);
        } finally {
            financeSyncSweepRunning = false;
        }

    }, {
        scheduled: true,
        timezone: 'America/Sao_Paulo',
    });

    // ------------------------------------------------------------------
    // JOB 1C - Reconciliacao da caixa Gmail para bounces/DSN
    // roda a cada 10 minutos e atualiza falhas assincronas do e-mail
    // ------------------------------------------------------------------
    cron.schedule('*/10 * * * *', async () => {
        try {
            const result = await gmailMailboxReconciliationService.reconcile({
                maxMessages: 25,
            });

            if (result?.processed > 0 || result?.skipped) {
                console.log('[Cron] Gmail mailbox reconciliation', result);
            }
        } catch (error) {
            console.error('Erro no Cron Job de reconciliacao do Gmail:', error);
        }

    }, {
        scheduled: true,
        timezone: 'America/Sao_Paulo',
    });

    // ------------------------------------------------------------------
    // JOB 2 - Expirar sessoes antigas do WhatsApp Bot
    // roda a cada 10 minutos
    // ------------------------------------------------------------------
    cron.schedule('*/10 * * * *', async () => {
        try {
            const result = await WhatsappBotService.expireOldSessions();

            if (result?.modifiedCount > 0) {
                console.log(`Sessoes WhatsApp expiradas: ${result.modifiedCount}`);
            }

        } catch (error) {
            console.error('Erro limpando sessoes do WhatsApp Bot:', error);
        }

    }, {
        scheduled: true,
        timezone: 'America/Sao_Paulo',
    });

    // ------------------------------------------------------------------
    // JOB 3 - Expirar tokens temporarios do portal
    // roda a cada 10 minutos
    // ------------------------------------------------------------------
    cron.schedule('*/10 * * * *', async () => {
        try {
            const result = await tempAccessTokenService.revokeExpiredTokens();

            if (result?.modifiedCount > 0) {
                console.log(`Tokens temporarios expirados: ${result.modifiedCount}`);
            }

        } catch (error) {
            console.error('Erro limpando tokens temporarios:', error);
        }

    }, {
        scheduled: true,
        timezone: 'America/Sao_Paulo',
    });

    cron.schedule('*/5 * * * *', async () => {
        try {
            const result = await guardianAuthService.expirePinRecoveryChallenges();
            if (result?.expiredCount > 0) {
                console.log('[Cron] Recuperacoes de PIN expiradas', {
                    expiredCount: result.expiredCount,
                });
            }
        } catch (error) {
            console.error('Erro auditando recuperacoes de PIN expiradas:', error);
        }
    }, {
        scheduled: true,
        timezone: 'America/Sao_Paulo',
    });
};

module.exports = { initCronJobs };
