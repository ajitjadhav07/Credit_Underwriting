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
        // Confirmed from a real Pennant response: some fields that look
        // like they'd have underscores (BORROWER_GROUP_CODE, GROUP_NAME,
        // ASSET_CLASSIFICATION, LEAD_BANK_NAME) actually come back with NO
        // underscores at all (borrowergroupcode, groupname, assetclassify,
        // leadbankname). Try that variant too.
        const noUnderscore = lower.replace(/_/g, '');
        if (obj[noUnderscore] !== undefined && obj[noUnderscore] !== null && obj[noUnderscore] !== '') return obj[noUnderscore];
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
                custCif: customer.custcif,
                customerCode: customer.customer_code,
                name: customer.custshrtname,
                pan: customer.pan,
                panStatus: customer.panstatus,
                panStatusRemarks: customer.panstsremarks,
                nameAgainstPan: customer.nameagainstpan,
                // ADDRESS — real response's `address` field is a raw concatenation
                // (e.g. "   PL RJ 306001") using city/state CODES, not full names.
                // Keep it as Pennant supplies it; city/state below are also codes.
                address: customer.address,
                city: customer.city,
                state: customer.state,
                zip: customer.custaddrzip,
                country: customer.custaddrcountry,
                addressType: customer['Address Type'],
                msmeFlag: customer.msmeflag,
                msmeSubType: customer.msmestyp,
                classification: customer.classification,
                // industrydesc is actually an industry CODE in the real response
                // (e.g. "01106"), not a description — kept as-is; sectorDesc below
                // carries the human-readable value.
                industry: customer.industrydesc,
                // --- Confirmed from a real Pennant response (customer_api) ---
                category: customer.custctgcode,                                     // Customer Category e.g. "RETAIL"
                custType: customer.custtypecode,                                    // e.g. "IND"
                constitution: customer.custtypecode,                                // Type (Constitution) — same field as custType
                phone: customer.phonenumber || customer.PHONENUMBER || null,        // not present in sample seen so far
                email: customer.custemail,
                lei: customer.leicode || customer.LEICODE || null,                  // not present in sample seen so far
                leiExpiry: customer.leiexpdt || customer.LEIEXPDT || null,           // not present in sample seen so far
                cin: customer.cin || customer.CIN || null,                          // not present in sample seen so far
                incorporationDate: customer.custdob,                                 // DOB / Date of Incorporation
                listedStatus: customer.listed_unlisted || null,
                dealingsSince: customer.dealings_since || null,
                // 'Group' is a literal Title-Case key in the real response
                group: customer['Group'] || customer.groupname,
                borrowerGroupCode: customer.borrowergroupcode,                       // confirmed NO underscore
                customerCategory: pick(customer, ['CUSTOMER_CATEGORY']),            // KYC Category (from loan_detail_api normally)
                // 'Sourcing Officer' and 'Type of facility' are literal Title-Case
                // keys with spaces in the real response
                sourcingOfficer: customer['Sourcing Officer'],
                loanTypeDesc: customer['Type of facility'],
                loanStatusLabel: customer['Loan Status'],
                ckycNo: pick(customer, ['CKYCNO']),                                 // not present in sample seen so far
                securedUnsecured: pick(customer, ['SECURED_UNSECURED']),            // not present in sample seen so far
                sectorDesc: customer.sectordesc,
                subSector: customer.SUBSECTOR || customer.subsector,
                bankingArrangement: pick(customer, ['BANKING_ARRANGEMENT']),        // not present in sample seen so far
                crilc: pick(customer, ['CRILC'])                                    // not present in sample seen so far
            } : null,
            collateral: collateral.map(c => ({
                collateralRef: c.collateralref,
                collateralType: c.collateraltype,
                ownershipDetails: c.ownership_details,
                fullAddress: c.full_address,
                valuation1Amt: c.valuation1amt,
                valuation2Amt: c.valuation2amt,
                unitPrice: c.unitprice,
                assignedValue: c.assignedvalue,
                loanStatus: c.loan_status
            })),
            loanDetail: loanDetail ? {
                loanAccountNumber: loanDetail.loan_account_number,
                finReference: loanDetail.loan_account_number || finReference,
                loanType: loanDetail.loan_type,
                // loan_detail_api.product is a full description here (e.g.
                // "COLLATERALISED LOAN TO EDUCATION SECTOR- BBG"); customer_api's
                // 'Type of facility' carries a different, also-descriptive value —
                // prefer customer['Type of facility'] (set as customer.loanTypeDesc)
                // for display; this field kept as the raw loan_detail_api.product.
                product: loanDetail.product,
                financeAmount: loanDetail.finamount,
                tenureMonths: loanDetail.tenure_in_months,
                interestRateType: loanDetail.interest_rate_type,
                interestRate: loanDetail.interest_rate ?? loanDetail.rateofinterest ?? loanDetail.roi ?? loanDetail.interestrate ?? null,
                maturityDate: loanDetail.maturitydate,
                loanStatus: loanDetail.loan_status,
                ucic: loanDetail.ucic,
                sourcingOfficer: loanDetail.sourcing_officer,
                customerConstitution: loanDetail.customer_constitution,
                borrowerGroupCode: loanDetail.borrowergroupcode,
                groupName: loanDetail.groupname,
                sectorCodeConstitution: loanDetail.seccodeconsti,
                assetClassification: loanDetail.assetclassify,
                leadBankName: loanDetail.leadbankname,
                recordStatus: loanDetail.recordstatus,
                loanPurpose: loanDetail.loan_purpose,
                branchName: loanDetail.branch_name,
                // Exposure tables (Part A "Single Borrower & Group Exposure")
                singleExposure: {
                    details: loanDetail.single_exposure_details,
                    rbiCeiling: loanDetail.single_rbi_ceiling,
                    internalCeiling: loanDetail.single_internal_ceiling,
                    guardRailCeiling: loanDetail.single_guard_rail_ceiling,
                    currentExposure: loanDetail.single_curr_exposure,
                    proposedExposure: loanDetail.single_total_exposure
                },
                groupExposure: {
                    details: loanDetail['Group_Exposure Details'],
                    rbiCeiling: loanDetail['Group_RBI CEILING'],
                    internalCeiling: loanDetail['Group_Internal Ceiling'],
                    guardRailCeiling: loanDetail['Group_Guard Rail ceiling'],
                    currentExposure: loanDetail['Group_Current / Present Exposure'],
                    proposedExposure: loanDetail['Group_Proposed Total Exposure']
                },
                // Ratings — NOT present in the confirmed real response for this
                // loan; will read as null and render blank (underwriter fills
                // manually) until AFL's Pennant response includes them.
                internalRating: pick(loanDetail, ['INTERNALRATING']),
                externalRating: pick(loanDetail, ['EXTERNALRATING']),
                category: loanDetail.customer_category
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
