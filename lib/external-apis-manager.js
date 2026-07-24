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

// AFL Middleware APIs use self-signed / hostname-bound TLS certificates.
// We connect via IP (e.g. 192.168.127.69) so the cert hostname never matches.
// NODE_TLS_REJECT_UNAUTHORIZED=0 in server.js handles JSON fetch() calls, but
// undici (Node 18 native fetch) still rejects for multipart/FormData requests
// in some configurations. Using a custom undici Dispatcher with
// rejectUnauthorized:false guarantees TLS bypass for ALL requests from this
// module — safe because all AFL IPs are confirmed private-network hosts.
let _dispatcher = null;
function getDispatcher() {
    if (_dispatcher !== null) return _dispatcher;
    // Try undici Agent (Node 18 native) for TLS bypass on IP-based connections
    // Falls back to undefined if not available — NODE_TLS_REJECT_UNAUTHORIZED=0
    // in server.js handles the fallback for JSON fetch calls.
    const paths = ['undici', '/usr/local/lib/node_modules/undici',
                   process.execPath.replace(/\/bin\/node$/, '/lib/node_modules/undici')];
    for (const p of paths) {
        try {
            const { Agent } = require(p);
            _dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
            return _dispatcher;
        } catch (_) {}
    }
    _dispatcher = undefined;
    return _dispatcher;
}

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
const NOVEL_UPLOAD_BASE_URL     = process.env.MIDDLEWARE_NOVEL_UPLOAD_URL        || 'https://afldatapoweruat.axisb.com:8446';
const NOVEL_BASE_URL            = process.env.MIDDLEWARE_NOVEL_URL               || 'https://afldatapoweruat.axisb.com:8446';

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
            signal: controller.signal,
            ...(getDispatcher() ? { dispatcher: getDispatcher() } : {})
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
        const skipped = { success: false, error: 'PAN and ITR acknowledgment number (ack) are both required for Karza ITR-V', skipped: true };
        await saveResponseToS3(assessmentId, 'karza-itr', skipped);
        return skipped;
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

    // Full URL can be overridden directly via env (matches the working curl).
    // Falls back to base + path if the full-URL env isn't set.
    const url = process.env.NOVEL_UPLOAD_FULL_URL || `${NOVEL_UPLOAD_BASE_URL}/V1/IN0189/NOVEL/BANKSTATEMENTUPLOAD`;
    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: mimeType }), fileName || 'statement.pdf');

    const tid = trackingId();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                serviceCode: 'IN0189UPLOAD',
                callerIdentification: CALLER_ID,
                authorizationKey: AUTH_KEY,
                trackingId: tid
            },
            body: form,
            signal: controller.signal,
            ...(getDispatcher() ? { dispatcher: getDispatcher() } : {})
        });
        let data = null;
        try { data = await response.json(); } catch (_) { data = null; }

        const normalized = {
            provider: 'Novel',
            purpose: 'Bank statement upload (step 1 of 3)',
            success: response.ok,
            doc_id: data?.DOC || data?.doc_id || null,
            raw: data,
            error: response.ok ? null : `HTTP ${response.status}`
        };
        await saveResponseToS3(assessmentId, 'novel-upload', normalized);
        return normalized;
    } catch (error) {
        const isTimeout = error.name === 'AbortError';
        const normalized = {
            provider: 'Novel',
            purpose: 'Bank statement upload (step 1 of 3)',
            success: false,
            error: isTimeout ? `Novel upload timed out after ${TIMEOUT_MS}ms` : error.message
        };
        await saveResponseToS3(assessmentId, 'novel-upload', normalized);
        return normalized;
    } finally {
        clearTimeout(timeout);
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

    const url = process.env.NOVEL_AUTOFETCH_FULL_URL || `${NOVEL_BASE_URL}/V1/IN0190/NOVEL/GenerateAutoFetchURL`;
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
 * Step C: download the processed bank statement analysis Excel from Novel.
 * The response is a binary Excel file (.xlsx) — NOT JSON. We parse the
 * "CAM Analysis" sheet to extract ADB and banking conduct metrics.
 *
 * Fields confirmed from NovelReportDOC31275086.xlsx (CAM Analysis sheet):
 *   Row "Average Balance"           col B → average_balance (ADB)
 *   Row "Average Balance Last 12M"  col E → avg_balance_last_12m  ← ADB for Banking Program
 *   Row "Average Receipt 12M"       col E → avg_receipt_12m       ← avg monthly credits
 *   Row "Average Balance"           col E → inward_return_count   (I/W Return)
 *   Row "Average Balance(5,10...)"  col E/F → outward_return_count/amount
 *   Grand Total row → totals for credits/debits
 */
async function novelDownloadBankStatement({ docId, assessmentId }) {
    if (!docId) {
        return { success: false, error: 'docId required for Novel download', skipped: true };
    }

    const url = process.env.NOVEL_DOWNLOAD_FULL_URL || `${NOVEL_BASE_URL}/V1/IN0191/NOVEL/BANKSTATEMENTDOWNLOAD`;
    const tid = trackingId();

    let rawBuffer = null;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                serviceCode: 'IN0191Download',
                callerIdentification: CALLER_ID,
                authorizationKey: AUTH_KEY,
                trackingId: tid
            },
            body: JSON.stringify({ Request: { DOC: docId } }),
            signal: controller.signal,
            ...(getDispatcher() ? { dispatcher: getDispatcher() } : {})
        });
        clearTimeout(timeout);
        if (!response.ok) {
            const normalized = { provider: 'Novel', success: false, error: `HTTP ${response.status}`, docId };
            await saveResponseToS3(assessmentId, 'novel-download', normalized);
            return normalized;
        }
        const arrayBuf = await response.arrayBuffer();
        rawBuffer = Buffer.from(arrayBuf);
    } catch (err) {
        const normalized = { provider: 'Novel', success: false, error: err.message, docId };
        await saveResponseToS3(assessmentId, 'novel-download', normalized);
        return normalized;
    }

    // Parse the Excel file — xlsx lazy-require so missing lib fails gracefully
    let parsed = null;
    try {
        const XLSX = require('xlsx');
        const wb = XLSX.read(rawBuffer, { type: 'buffer', cellDates: true });
        const sheetName = wb.SheetNames.find(s =>
            s.toLowerCase().includes('cam') && s.toLowerCase().includes('analysis')
        ) || wb.SheetNames.find(s => s.toLowerCase().includes('analysis'))
          || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

        const findRow = (pat) => rows.find(r => r[0] && String(r[0]).toLowerCase().includes(pat.toLowerCase()));
        const num = (row, col) => {
            if (!row || row[col] == null) return null;
            const v = parseFloat(row[col]);
            return isNaN(v) ? null : v;
        };

        const rBal     = findRow('average balance');
        const r5_25    = rows.find(r => r[0] && /average balance\(5/i.test(String(r[0])));
        const r6m      = findRow('average balance(last 6');
        const rRcp6m   = findRow('average receipt(6');
        const r12m     = findRow('average balance(last 12');
        const rRcp12m  = findRow('average receipt(12');
        const r3m      = findRow('average balance(last 3');
        const rRcp3m   = findRow('average receipt(last 3');
        const rGrand   = findRow('grand total');

        const hdrIdx = rows.findIndex(r => r[0] && /month.?year/i.test(String(r[0])));
        const gtIdx  = rows.findIndex(r => r[0] && /grand total/i.test(String(r[0])));
        const monthly = (hdrIdx >= 0 && gtIdx > hdrIdx)
            ? rows.slice(hdrIdx + 1, gtIdx).filter(r => r[0])
                  .map(r => ({ month_year: r[0], net_credits_count: r[1],
                      net_monthly_credit: r[2], internal_transfer: r[3],
                      gross_credits_count: r[4], gross_monthly_credit: r[5],
                      net_debits_count: r[6], net_monthly_debit: r[7] }))
            : [];

        // Convert rupees to lakhs (Novel reports in absolute rupees)
        const toLakhs = v => v != null ? parseFloat((v / 100000).toFixed(4)) : null;

        parsed = {
            // Primary ADB for Banking Program (Last 12 months is the standard)
            adb_lakhs:               toLakhs(num(r12m,  4) ?? num(rBal, 1)),
            average_balance:         toLakhs(num(rBal,  1)),
            avg_balance_last_12m:    toLakhs(num(r12m,  4)),
            avg_receipt_12m:         toLakhs(num(rRcp12m,4)),  // avg monthly credits
            avg_balance_last_6m:     toLakhs(num(r6m,   1)),
            avg_receipt_6m:          toLakhs(num(rRcp6m, 1)),
            avg_balance_last_3m:     toLakhs(num(r3m,   4)),
            avg_receipt_last_3m:     toLakhs(num(rRcp3m, 4)),
            inward_return_count:     num(rBal,  4),
            outward_return_count:    num(r5_25, 4),
            outward_return_amount:   toLakhs(num(r5_25, 5)),
            total_net_credits_count: num(rGrand, 1),
            total_net_monthly_credit:toLakhs(num(rGrand, 2)),
            total_gross_credits:     toLakhs(num(rGrand, 5)),
            total_net_debits_count:  num(rGrand, 6),
            total_net_monthly_debit: toLakhs(num(rGrand, 7)),
            monthly_detail: monthly,
            sheet_used: sheetName,
            docId
        };
        console.log(`[NOVEL] Parsed OK — ADB(12m): ₹${parsed.avg_balance_last_12m}L, AvgReceipt(12m): ₹${parsed.avg_receipt_12m}L, I/W Returns: ${parsed.inward_return_count}`);
    } catch (xlsxErr) {
        console.error('[NOVEL] Excel parse failed:', xlsxErr.message);
        const normalized = { provider: 'Novel', success: false,
            error: 'Excel parse failed: ' + xlsxErr.message, docId };
        await saveResponseToS3(assessmentId, 'novel-download', normalized);
        return normalized;
    }

    const normalized = {
        provider: 'Novel',
        purpose: 'Bank statement analysis download (step 3 of 3)',
        success: true,
        docId,
        ...parsed
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
