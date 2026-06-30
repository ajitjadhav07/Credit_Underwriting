/**
 * External APIs Manager
 * ----------------------------------------------------------------------
 * Integrates the five third-party verification/data services used in the
 * underwriting flow:
 *
 *   - NSDL        -> PAN validation
 *   - CIBIL       -> Credit score / bureau report
 *   - Perfios     -> Bank statement analysis (independent of Claude extraction)
 *   - Karza (ITR) -> ITR verification against govt records
 *   - Karza (GST) -> GSTIN / GST return verification
 *
 * Architecture decision (per finalized design):
 *   All five calls are routed through AFL's centralized Middleware /
 *   API Gateway (DataPower) — the App EC2 NEVER calls NSDL/CIBIL/Perfios/
 *   Karza directly. The Middleware owns encryption/decryption and holds
 *   the actual upstream credentials. This module only needs the
 *   Middleware's base URL and a Middleware-issued client key.
 *
 *   Sequencing: these calls happen AFTER Claude has extracted the 524
 *   fields from the documents (Claude is the data EXTRACTOR), and BEFORE
 *   calculation-engine.js runs (which is the data ANALYSER). The data
 *   fetched here augments/cross-verifies what Claude extracted — it is
 *   never sent to Claude.
 *
 *   Every raw response is persisted to S3 under
 *   assessments/{assessmentId}/api-responses/{provider}.json
 *   (this is also where the CIBIL response specifically is stored).
 */

const crypto = require('crypto');
const s3Client = require('./s3-client');

let piiHandler = null;
try {
    piiHandler = require('./pii-handler');
} catch (_) {
    piiHandler = null;
}

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------

const MIDDLEWARE_BASE_URL = process.env.MIDDLEWARE_BASE_URL || '';
const MIDDLEWARE_CLIENT_KEY = process.env.MIDDLEWARE_CLIENT_KEY || '';
const MIDDLEWARE_CLIENT_ID = process.env.MIDDLEWARE_CLIENT_ID || 'underwriting-agent';
const MIDDLEWARE_TIMEOUT_MS = parseInt(process.env.MIDDLEWARE_TIMEOUT_MS || '30000', 10);

// Per-provider path suffixes appended to MIDDLEWARE_BASE_URL.
// These are configurable via env so Infra/Middleware team can change
// routes without a code deploy.
const PROVIDER_PATHS = {
    nsdl: process.env.MIDDLEWARE_PATH_NSDL || '/v1/nsdl/pan-verify',
    cibil: process.env.MIDDLEWARE_PATH_CIBIL || '/v1/cibil/report',
    perfios: process.env.MIDDLEWARE_PATH_PERFIOS || '/v1/perfios/bank-analysis',
    karzaItr: process.env.MIDDLEWARE_PATH_KARZA_ITR || '/v1/karza/itr-verify',
    karzaGst: process.env.MIDDLEWARE_PATH_KARZA_GST || '/v1/karza/gst-verify'
};

// Simple in-memory call stats (mirrors the pattern used by ocr-pipeline.js / vision-ocr.js)
let apiStats = {
    nsdl: { calls: 0, failures: 0 },
    cibil: { calls: 0, failures: 0 },
    perfios: { calls: 0, failures: 0 },
    karzaItr: { calls: 0, failures: 0 },
    karzaGst: { calls: 0, failures: 0 }
};

/**
 * Whether the Middleware integration is configured at all.
 * @returns {{configured: boolean, details: string}}
 */
function isMiddlewareConfigured() {
    if (!MIDDLEWARE_BASE_URL) {
        return {
            configured: false,
            details: 'MIDDLEWARE_BASE_URL not set. NSDL/CIBIL/Perfios/Karza calls will be skipped.'
        };
    }
    return { configured: true, details: `Routing external API calls via ${MIDDLEWARE_BASE_URL}` };
}

/**
 * Mask sensitive identifiers (PAN, Aadhaar, account numbers) before logging.
 * Falls back to a basic mask if pii-handler isn't available.
 */
function safeLog(label, payload) {
    try {
        const masked = piiHandler && piiHandler.maskObject ? piiHandler.maskObject(payload) : payload;
        console.log(`[ExternalAPIs] ${label}:`, JSON.stringify(masked).slice(0, 500));
    } catch (_) {
        console.log(`[ExternalAPIs] ${label}: (unloggable payload)`);
    }
}

/**
 * Core HTTP helper — calls the Middleware Gateway for a given provider.
 * Uses Node 18+ built-in fetch (no extra dependency required).
 *
 * @param {string} providerKey - key into PROVIDER_PATHS / apiStats
 * @param {Object} body - request payload sent to the Middleware
 * @returns {Promise<{success: boolean, status: number, data: Object|null, error: string|null, durationMs: number}>}
 */
async function callMiddleware(providerKey, body) {
    const startTime = Date.now();
    const config = isMiddlewareConfigured();

    if (!config.configured) {
        return {
            success: false,
            status: 0,
            data: null,
            error: config.details,
            durationMs: 0,
            skipped: true
        };
    }

    const path = PROVIDER_PATHS[providerKey];
    const url = `${MIDDLEWARE_BASE_URL.replace(/\/$/, '')}${path}`;
    const requestId = crypto.randomUUID();

    apiStats[providerKey] = apiStats[providerKey] || { calls: 0, failures: 0 };
    apiStats[providerKey].calls++;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MIDDLEWARE_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Client-Id': MIDDLEWARE_CLIENT_ID,
                'X-Api-Key': MIDDLEWARE_CLIENT_KEY,
                'X-Request-Id': requestId,
                'X-Provider': providerKey
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        const durationMs = Date.now() - startTime;
        let data = null;
        try {
            data = await response.json();
        } catch (_) {
            data = null;
        }

        if (!response.ok) {
            apiStats[providerKey].failures++;
            safeLog(`${providerKey} FAILED (HTTP ${response.status})`, body);
            return {
                success: false,
                status: response.status,
                data,
                error: `Middleware returned HTTP ${response.status}`,
                durationMs,
                requestId
            };
        }

        safeLog(`${providerKey} OK (HTTP ${response.status}, ${durationMs}ms)`, { requestId });
        return { success: true, status: response.status, data, error: null, durationMs, requestId };

    } catch (error) {
        apiStats[providerKey].failures++;
        const durationMs = Date.now() - startTime;
        const isTimeout = error.name === 'AbortError';
        safeLog(`${providerKey} ERROR`, { error: error.message, timeout: isTimeout });
        return {
            success: false,
            status: 0,
            data: null,
            error: isTimeout ? `Middleware request timed out after ${MIDDLEWARE_TIMEOUT_MS}ms` : error.message,
            durationMs,
            requestId
        };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Persist a raw external API response to S3.
 * Path: assessments/{assessmentId}/api-responses/{provider}.json
 */
async function saveResponseToS3(assessmentId, provider, result) {
    if (!assessmentId) return null;
    try {
        const key = `assessments/${assessmentId}/api-responses/${provider}.json`;
        const body = Buffer.from(JSON.stringify({
            provider,
            assessmentId,
            fetchedAt: new Date().toISOString(),
            ...result
        }, null, 2));
        await s3Client.uploadFile(key, body, 'application/json');
        return key;
    } catch (error) {
        console.error(`[ExternalAPIs] Failed to save ${provider} response to S3:`, error.message);
        return null;
    }
}

// ---------------------------------------------------------------------
// 1. NSDL — PAN Validation
// ---------------------------------------------------------------------

/**
 * Verify a PAN number via NSDL (through Middleware).
 * @param {Object} params - { pan, name, dob, assessmentId }
 */
async function verifyPAN({ pan, name, dob, assessmentId }) {
    if (!pan) {
        return { success: false, error: 'PAN number not provided', skipped: true };
    }

    const result = await callMiddleware('nsdl', { pan, name, dob });

    const normalized = {
        provider: 'NSDL',
        purpose: 'PAN validation',
        pan_masked: pan ? `${pan.slice(0, 2)}XXXXX${pan.slice(-2)}` : null,
        success: result.success,
        is_valid: result.success ? !!(result.data && (result.data.valid === true || result.data.status === 'VALID')) : null,
        name_match: result.success ? (result.data?.name_match ?? null) : null,
        raw: result.data,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'nsdl', normalized);
    return normalized;
}

// ---------------------------------------------------------------------
// 2. CIBIL — Credit Score / Report
// ---------------------------------------------------------------------

/**
 * Fetch CIBIL score and report via Middleware.
 * This is the data that feeds the "Credit History" scoring component
 * in calculation-engine.js (calcCreditScore).
 * @param {Object} params - { pan, name, dob, mobile, assessmentId }
 */
async function fetchCIBIL({ pan, name, dob, mobile, assessmentId }) {
    if (!pan) {
        return { success: false, error: 'PAN number required for CIBIL pull', skipped: true };
    }

    const result = await callMiddleware('cibil', { pan, name, dob, mobile });

    const score = result.success ? (result.data?.cibil_score ?? result.data?.score ?? null) : null;
    const dpdHistory = result.success ? (result.data?.dpd_history ?? result.data?.payment_history ?? []) : [];

    const normalized = {
        provider: 'CIBIL',
        purpose: 'Credit score / bureau report',
        success: result.success,
        cibil_score: score !== null ? Number(score) : null,
        report_date: result.data?.report_date || null,
        dpd_history: dpdHistory,
        // max DPD (days-past-due) bucket seen across active/closed accounts in last 12 months
        max_dpd_last_12m: result.success ? computeMaxDPD(dpdHistory) : null,
        active_accounts: result.data?.active_accounts ?? null,
        overdue_accounts: result.data?.overdue_accounts ?? null,
        enquiries_last_6m: result.data?.enquiries_last_6_months ?? null,
        raw: result.data,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'cibil', normalized);
    return normalized;
}

/**
 * Helper: compute the worst (max) DPD bucket from a CIBIL dpd_history array.
 * Expected shape: [{ account_id, dpd: number, month: 'YYYY-MM' }, ...]
 */
function computeMaxDPD(dpdHistory) {
    if (!Array.isArray(dpdHistory) || dpdHistory.length === 0) return 0;
    return dpdHistory.reduce((max, entry) => {
        const dpd = Number(entry?.dpd ?? 0);
        return dpd > max ? dpd : max;
    }, 0);
}

// ---------------------------------------------------------------------
// 3. Perfios — Bank Statement Analyser
// ---------------------------------------------------------------------

/**
 * Run an independent bank statement analysis via Perfios (through Middleware).
 * This is separate from and in addition to Claude's own bank-statement
 * extraction — Perfios cross-verifies income patterns, EMI obligations,
 * and bounce history.
 * @param {Object} params - { accountNumber, ifsc, statementRefs, assessmentId }
 */
async function analyzeBankStatement({ accountNumber, ifsc, statementRefs, assessmentId }) {
    if (!accountNumber) {
        return { success: false, error: 'Bank account number not provided', skipped: true };
    }

    const result = await callMiddleware('perfios', { account_number: accountNumber, ifsc, statement_refs: statementRefs });

    const normalized = {
        provider: 'Perfios',
        purpose: 'Independent bank statement analysis',
        success: result.success,
        average_monthly_balance: result.data?.average_monthly_balance ?? null,
        average_monthly_credits: result.data?.average_monthly_credits ?? null,
        average_monthly_debits: result.data?.average_monthly_debits ?? null,
        cheque_bounce_count: result.data?.cheque_bounce_count ?? null,
        cheque_bounce_rate: result.data?.cheque_bounce_rate ?? null,
        existing_emi_obligations: result.data?.existing_emi_obligations ?? null,
        income_stability_score: result.data?.income_stability_score ?? null,
        raw: result.data,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'perfios', normalized);
    return normalized;
}

// ---------------------------------------------------------------------
// 4. Karza — ITR Verification
// ---------------------------------------------------------------------

/**
 * Verify self-reported ITR figures against government records via Karza.
 * @param {Object} params - { pan, assessmentYear, declaredIncome, assessmentId }
 */
async function verifyITR({ pan, assessmentYear, declaredIncome, assessmentId }) {
    if (!pan) {
        return { success: false, error: 'PAN number required for ITR verification', skipped: true };
    }

    const result = await callMiddleware('karzaItr', { pan, assessment_year: assessmentYear, declared_income: declaredIncome });

    const verifiedIncome = result.success ? (result.data?.verified_gross_total_income ?? null) : null;
    const variance = (verifiedIncome !== null && declaredIncome)
        ? Math.round(((declaredIncome - verifiedIncome) / verifiedIncome) * 10000) / 100
        : null;

    const normalized = {
        provider: 'Karza',
        purpose: 'ITR verification against IT department records',
        success: result.success,
        filing_status: result.data?.filing_status ?? null,
        assessment_year: assessmentYear,
        verified_gross_total_income: verifiedIncome,
        declared_income: declaredIncome ?? null,
        variance_percent: variance,
        is_consistent: variance !== null ? Math.abs(variance) <= 10 : null,
        raw: result.data,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'karza-itr', normalized);
    return normalized;
}

// ---------------------------------------------------------------------
// 5. Karza — GST Verification
// ---------------------------------------------------------------------

/**
 * Verify GSTIN and GST return filing history via Karza.
 * @param {Object} params - { gstin, assessmentId }
 */
async function verifyGST({ gstin, assessmentId }) {
    if (!gstin) {
        return { success: false, error: 'GSTIN not provided', skipped: true };
    }

    const result = await callMiddleware('karzaGst', { gstin });

    const normalized = {
        provider: 'Karza',
        purpose: 'GSTIN / GST return verification',
        success: result.success,
        gstin,
        registration_status: result.data?.registration_status ?? null,
        legal_name: result.data?.legal_name ?? null,
        filing_compliance_rate: result.data?.filing_compliance_rate ?? null,
        last_filed_return_period: result.data?.last_filed_return_period ?? null,
        cancellation_status: result.data?.cancellation_status ?? null,
        raw: result.data,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'karza-gst', normalized);
    return normalized;
}

// ---------------------------------------------------------------------
// Orchestrator — run all applicable external verifications for an assessment
// ---------------------------------------------------------------------

/**
 * Runs all external API verifications that have sufficient input data
 * available from the extracted/KYC data, in parallel. Designed to be
 * called AFTER Claude extraction and BEFORE calculation-engine.calculateAll().
 *
 * @param {Object} extractedData - the assessment's extractedData object
 * @param {string} assessmentId
 * @returns {Promise<Object>} external_verification block to merge into extractedData
 */
async function runAllVerifications(extractedData, assessmentId) {
    const config = isMiddlewareConfigured();
    if (!config.configured) {
        console.warn(`[ExternalAPIs] Skipping all external verifications — ${config.details}`);
        return {
            configured: false,
            note: config.details,
            nsdl: null,
            cibil: null,
            perfios: null,
            karza_itr: null,
            karza_gst: null
        };
    }

    const kyc = extractedData.kyc_documents || extractedData.kyc || extractedData.company_info || {};
    const bankAgg = extractedData.bank_aggregated || extractedData.bank_data || null;
    const itrData = extractedData.itr_returns || extractedData.itr_data || null;
    const gstAgg = extractedData.gst_aggregated || extractedData.gst_data || null;

    const pan = kyc?.pan_card?.pan_number || kyc?.pan_number || kyc?.pan || null;
    const name = kyc?.pan_card?.name || kyc?.company_name || kyc?.name || null;
    const dob = kyc?.pan_card?.date_of_birth || kyc?.date_of_incorporation || null;
    const mobile = kyc?.mobile_number || kyc?.contact?.mobile || null;
    const accountNumber = bankAgg?.account_number || extractedData.bank_statements?.[0]?.account_number || null;
    const ifsc = bankAgg?.ifsc_code || extractedData.bank_statements?.[0]?.ifsc_code || null;
    const gstin = gstAgg?.gstin || kyc?.gstin || extractedData.gst_returns?.[0]?.gstin || null;
    const declaredIncome = itrData?.gross_total_income || itrData?.fy25?.gross_total_income || null;
    const assessmentYear = itrData?.assessment_year || 'AY 2025-26';

    console.log(`${new Date().toISOString()} [ExternalAPIs] Running verifications for ${assessmentId} — PAN:${pan ? 'present' : 'missing'} GSTIN:${gstin ? 'present' : 'missing'} Bank:${accountNumber ? 'present' : 'missing'}`);

    const [nsdl, cibil, perfios, karzaItr, karzaGst] = await Promise.all([
        pan ? verifyPAN({ pan, name, dob, assessmentId }) : Promise.resolve({ success: false, skipped: true, error: 'PAN not available from extracted KYC data' }),
        pan ? fetchCIBIL({ pan, name, dob, mobile, assessmentId }) : Promise.resolve({ success: false, skipped: true, error: 'PAN not available from extracted KYC data' }),
        accountNumber ? analyzeBankStatement({ accountNumber, ifsc, assessmentId }) : Promise.resolve({ success: false, skipped: true, error: 'Bank account number not available' }),
        pan ? verifyITR({ pan, assessmentYear, declaredIncome, assessmentId }) : Promise.resolve({ success: false, skipped: true, error: 'PAN not available from extracted KYC data' }),
        gstin ? verifyGST({ gstin, assessmentId }) : Promise.resolve({ success: false, skipped: true, error: 'GSTIN not available' })
    ]);

    return {
        configured: true,
        fetchedAt: new Date().toISOString(),
        nsdl,
        cibil,
        perfios,
        karza_itr: karzaItr,
        karza_gst: karzaGst
    };
}

function getApiStats() {
    return { ...apiStats };
}

function resetApiStats() {
    apiStats = {
        nsdl: { calls: 0, failures: 0 },
        cibil: { calls: 0, failures: 0 },
        perfios: { calls: 0, failures: 0 },
        karzaItr: { calls: 0, failures: 0 },
        karzaGst: { calls: 0, failures: 0 }
    };
}

module.exports = {
    isMiddlewareConfigured,
    verifyPAN,
    fetchCIBIL,
    analyzeBankStatement,
    verifyITR,
    verifyGST,
    runAllVerifications,
    computeMaxDPD,
    getApiStats,
    resetApiStats
};
