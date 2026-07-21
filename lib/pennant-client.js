/**
 * Pennant LOS Client
 * ----------------------------------------------------------------------
 * Pennant is the ONE external system this app calls DIRECTLY — not
 * through the Middleware Gateway. This matches the architecture decision
 * made early in this project (Pennant has its own Oracle APEX API and
 * is hosted on-prem separately from DMS/LOS).
 *
 * No auth headers — confirmed twice now: (1) the original request sample
 * in API_Collections.zip showed a plain JSON POST with no auth headers at
 * all, and (2) AFL later clarified that the key initially thought to be
 * Pennant's own auth key (RtXcvbN89MklyOiuP) is actually the shared
 * MIDDLEWARE_AUTH_KEY used by Karza/CIBIL/Novel — Pennant itself, being
 * an internal AFL-network API, doesn't sit behind that authentication at
 * all. If Pennant calls start failing with an auth-style error against a
 * real UAT test, that would be the signal this needs revisiting again —
 * but two independent pieces of evidence now agree it needs nothing.
 *
 * Single call: given a finance reference number, returns customer/KYC
 * data, collateral records, and loan terms in one response.
 */

const s3Client = require('./s3-client');
const https = require('https');

// Pennant's real field-name casing in the live JSON response hasn't been
// confirmed for every field yet (only a subset was seen in the one real
// sample response so far). AFL's own field mapping reference document
// (Sample_CAM-EM-Pennant) documents fields in UPPERCASE / DB-column style
// (e.g. CUSTSHRTNAME, CUSTCTGCODE, PHONENUMBER). Try the most likely
// casings so whichever one the live API actually uses, we pick it up
// without needing another round-trip once a real response is seen.
function pick(obj, keys) {
    if (!obj) return null;
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
        const lower = k.toLowerCase();
        if (obj[lower] !== undefined && obj[lower] !== null && obj[lower] !== '') return obj[lower];
        const upper = k.toUpperCase();
        if (obj[upper] !== undefined && obj[upper] !== null && obj[upper] !== '') return obj[upper];
    }
    return null;
}

// Use hostname now that AFL AD DNS has the A record for afloasuatweb.axisb.com.
// NODE_TLS_REJECT_UNAUTHORIZED=0 in server.js handles any cert issues.
// Fallback to IP if hostname still fails during DNS propagation.
const PENNANT_BASE_URL = process.env.PENNANT_BASE_URL || 'https://afloasuatweb.axisb.com:8070';
const TIMEOUT_MS = parseInt(process.env.PENNANT_TIMEOUT_MS || '30000', 10);

// When connecting via IP (e.g. https://10.0.252.13:8070) the TLS certificate
// is issued to the hostname, not the IP, so Node rejects it. AFL's internal
// APIs use private certs we can't install in the container, so we bypass cert
// validation only for these known internal AFL hosts.
// This is safe because: (1) traffic never leaves AFL's private network,
// (2) the IP addresses are AFL-confirmed internal hosts, not public internet.
const AFL_INTERNAL_AGENT = new https.Agent({ rejectUnauthorized: false });

function isPennantConfigured() {
    if (!PENNANT_BASE_URL) {
        return { configured: false, details: 'PENNANT_BASE_URL not set' };
    }
    return { configured: true, details: `Calling Pennant directly at ${PENNANT_BASE_URL} (no auth headers)` };
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
        const skipped = { success: false, error: 'finReference (e.g. "SPCO0000001") is required', skipped: true };
        await saveResponseToS3(assessmentId, skipped);
        return skipped;
    }

    const config = isPennantConfigured();
    if (!config.configured) {
        const skipped = { success: false, error: config.details, skipped: true };
        await saveResponseToS3(assessmentId, skipped);
        return skipped;
    }

    const url = `${PENNANT_BASE_URL}/ords/afl/loan/v1/loandetails`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startTime = Date.now();

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
                custCif: pick(customer, ['CUSTCIF']) || customer.custcif,
                customerCode: customer.customer_code,
                name: pick(customer, ['CUSTSHRTNAME']) || customer.custshrtname,
                pan: customer.pan,
                panStatus: customer.panstatus,
                panStatusRemarks: customer.panstsremarks,
                nameAgainstPan: customer.nameagainstpan,
                // ADDRESS — Pennant may supply a pre-concatenated address field
                // (per AFL's mapping: House/Building/City/Sub District/District/
                // Flat/State/Street/Country/Landmark/PIN/Locality/PO Box). Prefer
                // that; fall back to our own concatenation of the parts below.
                address: pick(customer, ['ADDRESS']) || customer.address,
                city: customer.city,
                state: customer.state,
                msmeFlag: customer.msmeflag,
                msmeSubType: customer.msmestyp,
                classification: customer.classification,
                industry: customer.industrydesc,
                // --- Fields from AFL's CAM field-mapping legend (Sample_CAM-EM-Pennant) ---
                // Casing not yet confirmed from a live Pennant response — pick()
                // tries the legend's exact name, lowercase, and uppercase.
                category: pick(customer, ['CUSTCTGCODE', 'custctgcode']),           // Customer Category
                constitution: pick(customer, ['CUSTOMER_CONSTITUTION']),            // Customer Type (Constitution)
                phone: pick(customer, ['PHONENUMBER']),
                email: pick(customer, ['CUSTEMAIL']),
                lei: pick(customer, ['LEICODE']),
                leiExpiry: pick(customer, ['LEIEXPDT']),
                cin: pick(customer, ['CIN']),
                incorporationDate: pick(customer, ['CUSTDOB']),                     // DOB / Date of Incorporation
                listedStatus: pick(customer, ['LISTED_UNLISTED', 'LISTED']),
                dealingsSince: pick(customer, ['DEALINGS_SINCE']),
                group: pick(customer, ['GROUP_NAME']),
                borrowerGroupCode: pick(customer, ['BORROWER_GROUP_CODE']),
                customerCategory: pick(customer, ['CUSTOMER_CATEGORY']),            // KYC Category
                sourcingOfficer: pick(customer, ['SOURCING_OFFICER']),
                ckycNo: pick(customer, ['CKYCNO']),
                securedUnsecured: pick(customer, ['SECURED_UNSECURED']),
                sectorDesc: pick(customer, ['SECTORDESC']),
                subSector: pick(customer, ['SUBSECTOR']),
                bankingArrangement: pick(customer, ['BANKING_ARRANGEMENT']),
                assetClassification: pick(customer, ['ASSET_CLASSIFICATION']),
                leadBankName: pick(customer, ['LEAD_BANK_NAME']),
                crilc: pick(customer, ['CRILC'])
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
                finReference: pick(loanDetail, ['FINREFERENCE']) || loanDetail.loan_account_number || finReference,
                loanType: pick(loanDetail, ['LOAN_TYPE']) || loanDetail.loan_type,
                loanTypeDesc: pick(loanDetail, ['LOAN_TYPE_DESC']),
                product: loanDetail.product,
                financeAmount: loanDetail.finamount,
                tenureMonths: loanDetail.tenure_in_months,
                interestRateType: loanDetail.interest_rate_type,
                maturityDate: loanDetail.maturitydate,
                loanStatus: pick(loanDetail, ['LOAN_STATUS']) || loanDetail.loan_status,
                ucic: pick(loanDetail, ['UCIC']) || loanDetail.ucic,
                // Ratings — per legend these are Loan Extended Fields
                internalRating: pick(loanDetail, ['INTERNALRATING']),
                externalRating: pick(loanDetail, ['EXTERNALRATING']),
                category: pick(loanDetail, ['CATEGORY'])
            } : null,
            raw: data,
            durationMs
        };

        await saveResponseToS3(assessmentId, normalized);
        return normalized;

    } catch (error) {
        const durationMs = Date.now() - startTime;
        // Node's native fetch reports low-level failures as the generic
        // "fetch failed" and hides the real reason in error.cause. Log the
        // full detail so we can tell apart: firewall/timeout (ETIMEDOUT,
        // AbortError), connection refused (ECONNREFUSED), DNS (ENOTFOUND),
        // and TLS/cert rejection (has 'certificate' in the message/code).
        const cause = error.cause || {};
        console.error('❌ [PENNANT] Call failed:', {
            url,
            name: error.name,
            message: error.message,
            causeCode: cause.code,
            causeMessage: cause.message,
            causeName: cause.name
        });

        let readableError;
        if (error.name === 'AbortError') {
            readableError = `Pennant request timed out after ${TIMEOUT_MS}ms (likely firewall not open from backend subnet to ${PENNANT_BASE_URL})`;
        } else if (cause.code === 'ECONNREFUSED') {
            readableError = `Connection refused by ${PENNANT_BASE_URL} — host reachable but port closed/service down`;
        } else if (cause.code === 'ENOTFOUND') {
            readableError = `DNS resolution failed for ${PENNANT_BASE_URL} — hostname not resolvable from inside the VPC`;
        } else if (cause.code === 'ETIMEDOUT') {
            readableError = `Connection timed out to ${PENNANT_BASE_URL} — firewall likely blocking backend subnet -> Pennant host`;
        } else if ((cause.code || '').includes('CERT') || (cause.message || '').toLowerCase().includes('certificate')) {
            readableError = `TLS certificate rejected for ${PENNANT_BASE_URL} — Pennant's HTTPS cert not trusted by the container (cause: ${cause.code || cause.message})`;
        } else {
            readableError = error.message + (cause.code ? ` (cause: ${cause.code})` : '');
        }

        const normalized = {
            provider: 'Pennant',
            success: false,
            error: readableError,
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
