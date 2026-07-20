/**
 * External APIs Manager — REST/JSON providers
 * ----------------------------------------------------------------------
 * Rebuilt against the REAL Postman collections provided by AFL
 * (API_Collections.zip), replacing the earlier generic/guessed REST
 * implementation. Each provider here goes through AFL's Middleware
 * (DataPower or the internal gateway) — never called by a third party
 * directly. Pennant (lib/pennant-client.js) and individual CIBIL
 * (lib/cibil-soap-client.js) are NOT in this file because they use a
 * different protocol/gateway — see those files.
 *
 * GATEWAYS (confirmed from AFL, most recent — 2026-07):
 *   - DataPower Middleware  -> Karza ITR, Karza EPFO (UAN OTP/Auth)
 *       https://afldatapoweruat.axisb.com:8441/V1/Karza/...
 *   - Middleware gateway    -> CIBIL Commercial, Novel (bank statements)
 *       https://aflmiddlepower.axisb.com:8441/... (CIBIL Commercial)
 *       https://aflmiddlepower.axisb.com:8446/... (Novel — all 3 steps
 *       share this one port, distinguished by path, not port, unlike the
 *       earlier 7083/7084 split that turned out to be wrong)
 *
 * All of these share the same AFL Middleware header convention:
 *   serviceCode, callerIdentification, authorizationKey, trackingId,
 *   (referenceId on some calls)
 * — NOT the generic X-Api-Key/X-Client-Id pair used in the previous
 * (pre-spec) version of this file.
 *
 * ⚠️ RESPONSE SHAPES NOT YET CONFIRMED for CIBIL Commercial and Novel's
 * download step — the provided collections only included sample
 * requests for these two, no captured responses. The request-building
 * here is exact; the response normalization is best-effort and flagged
 * with NEEDS_REAL_RESPONSE_SAMPLE markers. Do not trust the normalized
 * fields for these two until verified against a real UAT response —
 * the raw response is always saved to S3 untouched regardless, so no
 * data is lost even if the normalization is wrong.
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
// Configuration — three distinct hosts, NOT one generic MIDDLEWARE_BASE_URL
// ---------------------------------------------------------------------

const DATAPOWER_BASE_URL        = process.env.MIDDLEWARE_DATAPOWER_URL          || 'https://afldatapoweruat.axisb.com:8441';
const CIBIL_COMMERCIAL_BASE_URL = process.env.MIDDLEWARE_CIBIL_COMMERCIAL_URL   || 'https://aflmiddatapower.axisb.com:8441';
const NOVEL_UPLOAD_BASE_URL     = process.env.MIDDLEWARE_NOVEL_UPLOAD_URL        || 'https://aflmiddatapower.axisb.com:8446';
const NOVEL_BASE_URL            = process.env.MIDDLEWARE_NOVEL_URL               || 'https://aflmiddatapower.axisb.com:8446';

// Shared AFL Middleware auth header — same authorizationKey across
// providers in the UAT collections (ZwkE9nXb4HiFPvYJ6C7x was the sample
// value; production will have its own key issued by the Middleware team)
const AUTH_KEY = process.env.MIDDLEWARE_AUTH_KEY || '';
const CALLER_ID = process.env.MIDDLEWARE_CALLER_ID || 'INDUS';
const TIMEOUT_MS = parseInt(process.env.MIDDLEWARE_TIMEOUT_MS || '30000', 10);

function isMiddlewareConfigured() {
    if (!AUTH_KEY) {
        return { configured: false, details: 'MIDDLEWARE_AUTH_KEY not set — Karza/CIBIL Commercial/Novel calls will be skipped.' };
    }
    return { configured: true, details: 'Middleware auth key present' };
}

function trackingId() {
    // AFL's samples use a 20-digit zero-padded numeric tracking ID
    return Date.now().toString().padStart(20, '0').slice(-20);
}

function referenceId() {
    // Sample format: 00000001240419181310 (date/time based, 20 chars)
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    return `00000001${stamp}`.slice(0, 20);
}

function safeLog(label, payload) {
    try {
        const masked = piiHandler && piiHandler.maskObject ? piiHandler.maskObject(payload) : payload;
        console.log(`[ExternalAPIs] ${label}:`, JSON.stringify(masked).slice(0, 500));
    } catch (_) {
        console.log(`[ExternalAPIs] ${label}: (unloggable payload)`);
    }
}

/**
 * Core HTTP helper for the AFL Middleware header convention.
 * @param {string} url - full request URL
 * @param {string} serviceCode - e.g. 'IN0114KARITR'
 * @param {Object} body - JSON request body
 * @param {Object} extraHeaders - optional extra headers (e.g. referenceId)
 */
async function callMiddleware(url, serviceCode, body, extraHeaders = {}) {
    const startTime = Date.now();
    const config = isMiddlewareConfigured();
    if (!config.configured) {
        return { success: false, status: 0, data: null, error: config.details, durationMs: 0, skipped: true };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const tid = trackingId();

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                serviceCode,
                callerIdentification: CALLER_ID,
                authorizationKey: AUTH_KEY,
                trackingId: tid,
                ...extraHeaders
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        const durationMs = Date.now() - startTime;
        let data = null;
        try { data = await response.json(); } catch (_) { data = null; }

        if (!response.ok) {
            safeLog(`${serviceCode} FAILED (HTTP ${response.status})`, body);
            return { success: false, status: response.status, data, error: `Middleware returned HTTP ${response.status}`, durationMs, trackingId: tid };
        }

        safeLog(`${serviceCode} OK (HTTP ${response.status}, ${durationMs}ms)`, { trackingId: tid });
        return { success: true, status: response.status, data, error: null, durationMs, trackingId: tid };

    } catch (error) {
        const durationMs = Date.now() - startTime;
        const isTimeout = error.name === 'AbortError';
        safeLog(`${serviceCode} ERROR`, { error: error.message, timeout: isTimeout });
        return { success: false, status: 0, data: null, error: isTimeout ? `Middleware request timed out after ${TIMEOUT_MS}ms` : error.message, durationMs, trackingId: tid };
    } finally {
        clearTimeout(timeout);
    }
}

async function saveResponseToS3(assessmentId, provider, result) {
    if (!assessmentId) return null;
    try {
        const key = `assessments/${assessmentId}/api-responses/${provider}.json`;
        const body = Buffer.from(JSON.stringify({ provider, assessmentId, fetchedAt: new Date().toISOString(), ...result }, null, 2));
        await s3Client.uploadFile(key, body, 'application/json');
        return key;
    } catch (error) {
        console.error(`[ExternalAPIs] Failed to save ${provider} response to S3:`, error.message);
        return null;
    }
}

// ---------------------------------------------------------------------
// Karza ITR-V (via DataPower) — confirmed request/response shape
// ---------------------------------------------------------------------

/**
 * Verify ITR via Karza ITR-V. Requires the ITR acknowledgment number
 * (the "ack" field on the ITR-V document itself) in addition to PAN —
 * this was missing from the original guessed implementation.
 */
async function verifyITR({ pan, ack, assessmentId }) {
    if (!pan || !ack) {
        return { success: false, error: 'PAN and ITR acknowledgment number (ack) are both required for Karza ITR-V', skipped: true };
    }

    const url = `${DATAPOWER_BASE_URL}/V1/Karza/IN0114/ITR-V`;
    const result = await callMiddleware(url, 'IN0114KARITR', { request: { consent: 'Y', pan, ack } });

    const normalized = {
        provider: 'Karza',
        purpose: 'ITR-V verification against IT department records',
        success: result.success,
        pan,
        ack,
        raw: result.data,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'karza-itr', normalized);
    return normalized;
}

// ---------------------------------------------------------------------
// Karza EPFO — two-step OTP flow (via DataPower)
// ---------------------------------------------------------------------

/**
 * Step 1 of 2: request an OTP be sent to the borrower's mobile for
 * EPFO UAN lookup. Returns a request_id that must be passed to
 * epfoAuthenticate() along with the OTP the borrower receives.
 */
async function epfoLookupOTP({ mobile, assessmentId }) {
    if (!mobile) {
        return { success: false, error: 'Mobile number required for EPFO UAN OTP lookup', skipped: true };
    }

    const url = `${DATAPOWER_BASE_URL}/V1/Karza/IN0108/EPFUANLookupOTP`;
    const result = await callMiddleware(url, 'IN0108UANOTP', { request: { consent: 'y', mobile } });

    const normalized = {
        provider: 'Karza',
        purpose: 'EPFO UAN lookup - OTP request (step 1 of 2)',
        success: result.success,
        request_id: result.data?.request_id || result.data?.request?.request_id || null,
        raw: result.data,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'epfo-otp-request', normalized);
    return normalized;
}

/**
 * Step 2 of 2: complete EPFO UAN authentication using the OTP the
 * borrower received, and the request_id from epfoLookupOTP().
 * This is the call that actually returns EPFO employment/contribution data.
 */
async function epfoAuthenticate({ requestId, otp, assessmentId }) {
    if (!requestId || !otp) {
        return { success: false, error: 'request_id and otp are both required for EPFO authentication', skipped: true };
    }

    const url = `${DATAPOWER_BASE_URL}/V1/Karza/IN0109/EPFUANAuthentication`;
    const result = await callMiddleware(
        url,
        'IN0109UANPASB',
        { request: { request_id: requestId, otp } },
        { referenceId: referenceId() }
    );

    const normalized = {
        provider: 'Karza',
        purpose: 'EPFO UAN authentication - employment/contribution data (step 2 of 2)',
        success: result.success,
        raw: result.data,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'epfo-authenticated', normalized);
    return normalized;
}

// ---------------------------------------------------------------------
// CIBIL Commercial (via internal gateway) — confirmed REQUEST shape only
// ---------------------------------------------------------------------

/**
 * Fetch Commercial CIBIL report. The request body is a deeply nested
 * structure per AFL's sample — this matches that exactly. The response
 * normalization below is NOT YET VERIFIED (no sample response was
 * provided) — the raw response is preserved in full in S3 regardless.
 *
 * @param {Object} params - { borrowerName, cin, classOfActivity, address, email, directors, assessmentId }
 */
async function fetchCommercialCIBIL({ borrowerName, cin, classOfActivity = '17', address = {}, email, directors = [], assessmentId }) {
    if (!borrowerName || !cin) {
        return { success: false, error: 'Borrower name and CIN/LLPIN are both required for Commercial CIBIL', skipped: true };
    }

    const url = `${CIBIL_COMMERCIAL_BASE_URL}/V1/CommercialCibil/IN0033/ProcessCommercialRequest`;
    const body = {
        request: {
            ProcessCommercialRequest: {
                request: {
                    BatchNo: '',
                    BureauCategory: { CategoryId: '3', CategoryName: '', IsEnabled: 'false' },
                    BureauId: '7',
                    CommRequest: {
                        BorrowerName: borrowerName,
                        BorrowerShortName: '',
                        CIN_LLPN: cin,
                        CRN: '',
                        ClassOfActivity1: classOfActivity,
                        CommercialAddresses: {
                            'CommRequest.CommercialAddress': {
                                AddressLine: address.line || '',
                                AddressType: '2',
                                City: address.city || '',
                                Locality: address.locality || '',
                                PinCode: address.pinCode || '',
                                State: address.state || ''
                            }
                        },
                        CommercialContactDetail: {
                            Email1: email || '',
                            Email2: '',
                            Fax: '',
                            MobileNo: '',
                            Telephone1: '',
                            Telephone2: ''
                        },
                        CommercialDirectorsDetails: {
                            'CommRequest.CommercialDirectors': directors
                        }
                    }
                }
            }
        }
    };

    const result = await callMiddleware(url, 'IN0033COMCIB', body, { referenceId: referenceId() });

    // NEEDS_REAL_RESPONSE_SAMPLE: field paths below are best-effort guesses
    // pending a captured UAT response. Verify cibil_score / dpd path once
    // a real response is available, then update this normalization.
    const normalized = {
        provider: 'CIBIL Commercial',
        purpose: 'Commercial credit score / bureau report',
        success: result.success,
        cibil_score: result.data?.CommercialResponse?.CreditScore?.Value
            ?? result.data?.cibil_score
            ?? null, // NEEDS_REAL_RESPONSE_SAMPLE
        dpd_history: result.data?.CommercialResponse?.TradeLines
            ?? result.data?.dpd_history
            ?? [], // NEEDS_REAL_RESPONSE_SAMPLE
        raw: result.data,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'cibil-commercial', normalized);
    return normalized;
}

// ---------------------------------------------------------------------
// Novel — bank statement engine (3-step: upload -> autofetch -> download)
// ---------------------------------------------------------------------

/**
 * Step A: upload a bank statement file (multipart/form-data) for Novel
 * to process. Uses Node 18+ built-in FormData/Blob — no extra dependency.
 * @param {Object} params - { fileBuffer, fileName, mimeType, assessmentId }
 */
async function novelUploadBankStatement({ fileBuffer, fileName, mimeType = 'application/pdf', assessmentId }) {
    if (!fileBuffer) {
        return { success: false, error: 'No file buffer provided for Novel upload', skipped: true };
    }
    const config = isMiddlewareConfigured();
    if (!config.configured) {
        return { success: false, error: config.details, skipped: true };
    }

    const url = `${NOVEL_UPLOAD_BASE_URL}/V1/IN0189/NOVEL/BANKSTATEMENTUPLOAD`;
    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: mimeType }), fileName || 'statement.pdf');

    const tid = trackingId();
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                serviceCode: 'IN0189UPLOAD',
                callerIdentification: CALLER_ID,
                authorizationKey: AUTH_KEY,
                trackingId: tid
            },
            body: form
        });
        let data = null;
        try { data = await response.json(); } catch (_) { data = null; }

        const normalized = {
            provider: 'Novel',
            purpose: 'Bank statement upload (step 1 of 3)',
            success: response.ok,
            doc_id: data?.DOC || data?.doc_id || null, // NEEDS_REAL_RESPONSE_SAMPLE
            raw: data,
            error: response.ok ? null : `HTTP ${response.status}`
        };
        await saveResponseToS3(assessmentId, 'novel-upload', normalized);
        return normalized;
    } catch (error) {
        const normalized = { provider: 'Novel', purpose: 'Bank statement upload (step 1 of 3)', success: false, error: error.message };
        await saveResponseToS3(assessmentId, 'novel-upload', normalized);
        return normalized;
    }
}

/**
 * Step B: generate an auto-fetch URL (borrower net-banking flow) as an
 * alternative/supplement to manual upload.
 */
async function novelGenerateAutoFetchURL({ fileNo, name, accountType = 'Saving', contactNo, organizationName, bank, assessmentId }) {
    if (!fileNo || !contactNo) {
        return { success: false, error: 'fileNo and contactNo are required for Novel auto-fetch', skipped: true };
    }

    const url = `${NOVEL_BASE_URL}/V1/IN0190/NOVEL/GenerateAutoFetchURL`;
    const result = await callMiddleware(url, 'IN0190AUTOFETCH', {
        request: { fileNo, name, accountType, contactNo, clientAuth: '', organizationName, defaultScreen: 'NetBanking', bank }
    });

    const normalized = {
        provider: 'Novel',
        purpose: 'Bank statement auto-fetch URL generation (step 2 of 3)',
        success: result.success,
        fetch_url: result.data?.url || result.data?.fetchUrl || null, // NEEDS_REAL_RESPONSE_SAMPLE
        raw: result.data,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'novel-autofetch', normalized);
    return normalized;
}

/**
 * Step C: download the processed bank statement analysis by document ID
 * (the DOC value returned from upload or autofetch). This is the call
 * that should contain the actual ADB/EMI/bounce-rate analysis — response
 * shape NOT YET VERIFIED, no sample was provided.
 */
async function novelDownloadBankStatement({ docId, assessmentId }) {
    if (!docId) {
        return { success: false, error: 'docId required for Novel download', skipped: true };
    }

    const url = `${NOVEL_BASE_URL}/V1/IN0191/NOVEL/BANKSTATEMENTDOWNLOAD`;
    const result = await callMiddleware(url, 'IN0191Download', { Request: { DOC: docId } });

    // NEEDS_REAL_RESPONSE_SAMPLE: every field below is a guess pending a
    // captured UAT response. Do not trust for scoring until verified.
    const normalized = {
        provider: 'Novel',
        purpose: 'Bank statement analysis download (step 3 of 3)',
        success: result.success,
        average_monthly_balance: result.data?.average_monthly_balance ?? null,
        average_monthly_credits: result.data?.average_monthly_credits ?? null,
        average_monthly_debits: result.data?.average_monthly_debits ?? null,
        cheque_bounce_count: result.data?.cheque_bounce_count ?? null,
        raw: result.data,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'novel-download', normalized);
    return normalized;
}

module.exports = {
    isMiddlewareConfigured,
    verifyITR,
    epfoLookupOTP,
    epfoAuthenticate,
    fetchCommercialCIBIL,
    novelUploadBankStatement,
    novelGenerateAutoFetchURL,
    novelDownloadBankStatement
};
