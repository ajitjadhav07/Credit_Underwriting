/**
 * Pennant LOS Client
 * ----------------------------------------------------------------------
 * Pennant is the ONE external system this app calls DIRECTLY — not
 * through the Middleware Gateway. This matches the architecture decision
 * made early in this project (Pennant has its own Oracle APEX API and
 * is hosted on-prem separately from DMS/LOS).
 *
 * The original request sample in API_Collections.zip showed a plain JSON
 * POST with no auth headers at all, but AFL confirmed on 2026-07-04 (via
 * chat, not a written spec yet) that Pennant requires a caller-identification
 * header ("PENNANT") plus its own auth key — distinct from MIDDLEWARE_AUTH_KEY
 * used by the Karza/CIBIL/Novel calls. Header field names below
 * (callerIdentification / authKey) are our best-guess naming based on how
 * AFL described the field ("Caller identification = PENNANT") — confirm
 * against the real Pennant API spec/Postman collection once available and
 * adjust PENNANT_AUTH_HEADER_NAME / PENNANT_CALLER_HEADER_NAME below if
 * Pennant rejects these names or expects them as body params instead.
 *
 * Single call: given a finance reference number, returns customer/KYC
 * data, collateral records, and loan terms in one response.
 */

const s3Client = require('./s3-client');

const PENNANT_BASE_URL = process.env.PENNANT_BASE_URL || 'https://afloasuatweb.axisb.com:8070';
const TIMEOUT_MS = parseInt(process.env.PENNANT_TIMEOUT_MS || '30000', 10);

// Caller identification is a fixed, non-secret value ("PENNANT"); the auth
// key is the actual secret, sourced from Secrets Manager in UAT/Prod.
const CALLER_IDENTIFICATION = process.env.PENNANT_CALLER_IDENTIFICATION || 'PENNANT';
const AUTH_KEY = process.env.PENNANT_AUTH_KEY || '';
const PENNANT_CALLER_HEADER_NAME = process.env.PENNANT_CALLER_HEADER_NAME || 'callerIdentification';
const PENNANT_AUTH_HEADER_NAME = process.env.PENNANT_AUTH_HEADER_NAME || 'authKey';

function isPennantConfigured() {
    if (!PENNANT_BASE_URL) {
        return { configured: false, details: 'PENNANT_BASE_URL not set' };
    }
    if (!AUTH_KEY) {
        return { configured: false, details: 'PENNANT_AUTH_KEY not set — Pennant calls will be skipped.' };
    }
    return { configured: true, details: `Calling Pennant directly at ${PENNANT_BASE_URL}` };
}

async function saveResponseToS3(assessmentId, result) {
    if (!assessmentId) return null;
    try {
        const key = `assessments/${assessmentId}/api-responses/pennant.json`;
        const body = Buffer.from(JSON.stringify({ provider: 'Pennant', assessmentId, fetchedAt: new Date().toISOString(), ...result }, null, 2));
        await s3Client.uploadFile(key, body, 'application/json');
        return key;
    } catch (error) {
        console.error('[Pennant] Failed to save response to S3:', error.message);
        return null;
    }
}

/**
 * Fetch loan/customer/collateral details from Pennant by finance reference.
 * @param {Object} params - { finReference, assessmentId }
 * @returns {Promise<Object>} normalized { customer, collateral, loanDetail, raw }
 */
async function getLoanDetails({ finReference, assessmentId }) {
    if (!finReference) {
        return { success: false, error: 'finReference (e.g. "SPCO0000001") is required', skipped: true };
    }

    const config = isPennantConfigured();
    if (!config.configured) {
        return { success: false, error: config.details, skipped: true };
    }

    const url = `${PENNANT_BASE_URL}/ords/afl/loan/v1/loandetails`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startTime = Date.now();

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                [PENNANT_CALLER_HEADER_NAME]: CALLER_IDENTIFICATION,
                [PENNANT_AUTH_HEADER_NAME]: AUTH_KEY
            },
            body: JSON.stringify({ p_fin_reference: finReference }),
            signal: controller.signal
        });

        const durationMs = Date.now() - startTime;
        let data = null;
        try { data = await response.json(); } catch (_) { data = null; }

        if (!response.ok || data?.status !== 'success') {
            const normalized = {
                provider: 'Pennant',
                success: false,
                error: data?.status !== 'success' ? `Pennant returned status: ${data?.status}` : `HTTP ${response.status}`,
                raw: data,
                durationMs
            };
            await saveResponseToS3(assessmentId, normalized);
            return normalized;
        }

        // Confirmed shape from the real sample response
        const customer = data.customer_api?.[0] || null;
        const collateral = data.collateral_api || [];
        const loanDetail = data.loan_detail_api?.[0] || null;

        const normalized = {
            provider: 'Pennant',
            success: true,
            finReference,
            customer: customer ? {
                custId: customer.custid,
                custCif: customer.custcif,
                customerCode: customer.customer_code,
                name: customer.custshrtname,
                pan: customer.pan,
                panStatus: customer.panstatus,
                panStatusRemarks: customer.panstsremarks,
                nameAgainstPan: customer.nameagainstpan,
                address: customer.address,
                city: customer.city,
                state: customer.state,
                msmeFlag: customer.msmeflag,
                msmeSubType: customer.msmestyp,
                classification: customer.classification,
                industry: customer.industrydesc
            } : null,
            collateral: collateral.map(c => ({
                collateralRef: c.collateralref,
                collateralType: c.collateraltype,
                ownershipDetails: c.ownership_details,
                unitPrice: c.unitprice,
                assignedValue: c.assignedvalue,
                loanStatus: c.loan_status
            })),
            loanDetail: loanDetail ? {
                loanAccountNumber: loanDetail.loan_account_number,
                loanType: loanDetail.loan_type,
                product: loanDetail.product,
                financeAmount: loanDetail.finamount,
                tenureMonths: loanDetail.tenure_in_months,
                interestRateType: loanDetail.interest_rate_type,
                maturityDate: loanDetail.maturitydate,
                loanStatus: loanDetail.loan_status,
                ucic: loanDetail.ucic
            } : null,
            raw: data,
            durationMs
        };

        await saveResponseToS3(assessmentId, normalized);
        return normalized;

    } catch (error) {
        const durationMs = Date.now() - startTime;
        const normalized = {
            provider: 'Pennant',
            success: false,
            error: error.name === 'AbortError' ? `Pennant request timed out after ${TIMEOUT_MS}ms` : error.message,
            durationMs
        };
        await saveResponseToS3(assessmentId, normalized);
        return normalized;
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    isPennantConfigured,
    getLoanDetails
};
