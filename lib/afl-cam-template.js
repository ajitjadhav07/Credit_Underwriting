/**
 * AFL CAM Report — Template-based generator
 * ----------------------------------------------------------------------
 * Uses the AFL-provided master template (templates/cam-template.docx) as
 * the single source of truth for format, layout, headers, footers, fonts,
 * spacing, tables and structure. We ONLY substitute data values into
 * {{TOKEN}} placeholders — the document structure is never rebuilt, so the
 * output is byte-for-byte identical in format to the reference document.
 *
 * This is deliberately NOT a docx-js rebuild: rebuilding from code loses
 * the header ("Axis Finance Limited"), footer ("N | Page"), nested
 * sub-tables (Relationship/Existing Loan/etc.) and multi-row cells that
 * only exist in the original template.
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'cam-template.docx');

// XML-escape a value for safe insertion into document.xml
function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Format helpers matching the sample's presentation
// Format a value that is ALREADY in crores → "₹52.00 Cr"
function fmtCr(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = parseFloat(v);
    if (isNaN(n)) return String(v);
    return '\u20B9' + n.toFixed(2) + ' Cr';
}
// Format a value that is in LAKHS but should show as Cr if >= 100L
function fmtLakhAuto(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = parseFloat(v);
    if (isNaN(n)) return String(v);
    if (n >= 100) return '\u20B9' + (n / 100).toFixed(2) + ' Cr';
    return '\u20B9' + n.toFixed(2) + ' L';
}
function fmtL(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = parseFloat(v);
    if (isNaN(n)) return String(v);
    return '\u20B9 ' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' L';
}
function pct(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = parseFloat(v);
    if (isNaN(n)) return String(v);
    return n.toFixed(2) + '%';
}
// The CAM eligibility engine stores LTV/ratios as decimals (0.60 = 60%).
// pctFromDecimal converts those to a percentage string.
function pctFromDecimal(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = parseFloat(v);
    if (isNaN(n)) return String(v);
    return (n * 100).toFixed(2) + '%';
}
function dscr(v) {
    if (v === null || v === undefined || v === '') return '';
    return parseFloat(v).toFixed(2) + 'x';
}
// Blank placeholder for manual-entry fields (matches sample's ________)
const BLANK = '________';
function orBlank(v) {
    return (v === null || v === undefined || v === '') ? BLANK : String(v);
}
function orEmpty(v) {
    return (v === null || v === undefined) ? '' : String(v);
}

/**
 * Build the token → value map from an assessment object.
 */
function buildTokenMap(assessment) {
    const pen  = assessment.pennant_data || {};
    const cust = pen.customer   || {};
    const loan = pen.loanDetail || {};
    const cam  = assessment.cam_eligibility || assessment.calculations?.cam_eligibility || {};
    const S    = cam.summary || {};
    const checks = cam.policy_checks || [];
    const flags  = cam.flags || [];

    // CIBIL data — from uploaded report (extractCIBIL), not from the CIBIL API.
    // bull-queue storeExtractedData writes it to external_verification.cibil_commercial.
    const extData = assessment.extracted_data || assessment.all_extracted_data || {};
    const cibilCommercial = extData.external_verification?.cibil_commercial || null;
    const cibilRaw = (cibilCommercial?.success ? cibilCommercial
        : (extData.cibil?.company || extData.cibil?.director)) || null;
    const cibilScore = cibilRaw?.cibil_score ?? null;
    const maxDpd    = cibilRaw?.max_dpd_last_12m ?? null;
    const liveLoans = cibilRaw?.live_loans || [];

    const dateStr = new Date(assessment.created_at || Date.now())
        .toLocaleDateString('en-IN', { day: 'numeric', month: 'numeric', year: 'numeric' });

    // Policy check statuses — P_STATUS_4 (Nil DPD) auto-derived from
    // uploaded CIBIL if not set by the calc engine.
    const statusOf = (i) => {
        const c = checks[i];
        if (c) return c.complied ? 'Complied' : 'Not Complied';
        if (i === 3 && maxDpd !== null) return maxDpd === 0 ? 'Complied' : 'Not Complied';
        return '';
    };

    // Deviation flags line
    const deviationLine = (flags && flags.length > 0)
        ? 'Deviation Flags: ' + flags.join('; ')
        : 'Deviation Flags: None \u2013 proposal is within all policy norms.';

    const withinPolicy = !flags || flags.length === 0;
    const overallStatus = withinPolicy ? 'WITHIN POLICY NORMS' : 'DEVIATION FROM POLICY';

    // Build recommendation text incorporating CIBIL if available
    const cibilSummary = cibilScore !== null
        ? ` CIBIL Score: ${cibilScore}${maxDpd !== null ? ', Max DPD (12m): ' + maxDpd + ' days' : ''}.`
        : (liveLoans.length > 0 ? ` Live loans: ${liveLoans.length}.` : '');
    const recommendation = withinPolicy
        ? ('RECOMMENDED FOR SANCTION \u2014 within income (DSCR) and LTV eligibility with policy conditions complied.' + cibilSummary)
        : ('REFER TO CREDIT COMMITTEE \u2014 deviations noted: ' + flags.join('; ') + '.' + cibilSummary);

    // Final eligible = lower of income-based and LTV-based eligible loans.
    // Engine field names: eligible_loan_amount (income basis),
    // eligible_ltv * valuation_considered (LTV basis).
    const eligIncome = S.eligible_loan_amount ?? S.eligible_loan ?? null;
    const eligLtv = S.eligible_loan_ltv
        ?? (S.valuation_considered != null && S.eligible_ltv != null
            ? S.valuation_considered * S.eligible_ltv : null);
    const finalEligible = (eligIncome != null && eligLtv != null)
        ? Math.min(eligIncome, eligLtv)
        : (eligIncome ?? eligLtv);
    const recommended = S.recommended_loan ?? S.proposed_loan ?? null;

    return {
        DATE: dateStr,

        // Part A
        BORROWER_NAME:       orEmpty(cust.name),
        // "Customer Details" cell in the template holds one value — summarize
        // CIF / Category / Constitution together (all three are separate
        // Pennant fields per AFL's legend: CUSTCIF, CUSTCTGCODE, CUSTOMER_CONSTITUTION)
        CUSTOMER_DETAILS:    [
                                cust.custCif ? ('CIF: ' + cust.custCif) : '',
                                cust.category ? ('Category: ' + cust.category) : '',
                                cust.constitution ? ('Type: ' + cust.constitution) : ''
                             ].filter(Boolean).join('  |  ') || orEmpty(cust.customerCode),
        // Individual nested sub-table cells (Customer Details table: Name/CIF/
        // Category/Type/Core bank ID rows) — matches AFL reference layout
        CUST_NAME:           orEmpty(cust.name),
        CUST_CIF:            orEmpty(cust.custCif),
        CUST_CATEGORY:       orEmpty(cust.category),
        CUST_CONSTITUTION:   orEmpty(cust.constitution),
        UCIC:                orEmpty(loan.ucic),
        ADDRESS:             [cust.address, cust.city, cust.state].filter(Boolean).join(', '),
        PHONE:               orBlank(cust.phone),
        EMAIL:               orBlank(cust.email),
        LEI:                 orBlank(cust.lei),
        LEI_EXPIRY:          orBlank(cust.leiExpiry),
        CIN:                 orBlank(cust.cin),
        INCORPORATION:       orBlank(cust.incorporationDate),
        LISTED:              orBlank(cust.listedStatus),
        ACCOUNT_STATUS:      orBlank(cust.dealingsSince),
        GROUP:               orBlank(cust.group),
        RATING:              'Internal: ' + orBlank(loan.internalRating) + '  External: ' + orBlank(loan.externalRating),
        FACILITY_TYPE:       orBlank(cust.loanTypeDesc || loan.loanType),
        KYC_CATEGORY:        orBlank(cust.customerCategory),
        SOURCING_OFFICER:    orBlank(cust.sourcingOfficer),
        CKYC:                orBlank(cust.ckycNo),
        SECURED:             orBlank(cust.securedUnsecured),
        CATEGORY:            orBlank(cust.category),
        RBI_INDUSTRY:        orBlank(cust.industry),
        BANKING_ARRANGEMENT: orBlank(cust.bankingArrangement),
        MSME_TAGGING:        orEmpty(cust.msmeFlag) || 'YES',
        SECTOR:              orBlank(cust.sectorDesc),
        SUB_SECTOR:          orBlank(cust.subSector),
        SHAREHOLDER:         orEmpty(cust.shareholderDetails),
        CRILC:               orEmpty(cust.crilc),

        // Part B — Basic Loan Details nested sub-table
        BASIC_LOAN:          [loan.product, loan.loanType].filter(Boolean).join(' \u2014 '),
        LOAN_REFERENCE:      orEmpty(loan.loanAccountNumber || loan.finReference),
        LOAN_TYPE:           orEmpty(loan.loanType),
        LOAN_BRANCH:         orEmpty(loan.branchName),
        LOAN_AMOUNT:         loan.financeAmount ? fmtL(loan.financeAmount / 100000) : '',
        SOURCING_OFFICER_B:  orEmpty(loan.sourcingOfficer || cust.sourcingOfficer),
        LOAN_PURPOSE:        orEmpty(loan.loanPurpose),
        TRANSACTION_REF:     orEmpty(loan.transactionReference || loan.transaction_reference),
        MORATORIUM:          '',
        PAYMENT_DETAILS:     '',

        // Part C — Eligibility Calculation Working (value column)
        // Uses the ACTUAL field names emitted by lib/cam-eligibility.js summary{}.
        // All money values from the engine are in LAKHS. LTV/ratios are decimals
        // (0.60 = 60%). fmtLakhAuto shows Cr when >= 100L, else L.
        // Turnover/PAT/etc are program-specific inputs echoed back where present.
        C_TURNOVER:          fmtLakhAuto(S.turnover ?? S.gross_receipts ?? S.turnover_lakhs),
        C_PAT:               fmtLakhAuto(S.pat ?? S.net_profit ?? S.pat_lakhs),
        C_NONOP:             fmtLakhAuto(S.non_operating_income ?? S.non_op_income),
        C_DEP:               fmtLakhAuto(S.depreciation),
        C_INTEREST:          fmtLakhAuto(S.interest ?? S.interest_to_bank),
        C_EBIDTA:            fmtLakhAuto(S.ebidta_net_of_tax ?? S.ebidta),
        C_RELATED:           fmtLakhAuto(S.related_party_payment ?? S.related_party),
        C_OTHER:             fmtLakhAuto(S.other_income),
        C_TOTAL_INCOME:      fmtLakhAuto(S.total_annual_income),
        C_EXISTING_OBL:      fmtLakhAuto(S.existing_obligation ?? S.existing_emi_annual),
        C_TARGET_DSCR:       dscr(S.target_dscr),
        C_MAX_DS:            fmtLakhAuto(S.max_annual_debt_service ?? S.max_annual_ds),
        C_MAX_EMI:           fmtLakhAuto(S.max_emi_allowed ?? S.max_emi),
        C_TENURE:            (S.tenure_months ?? loan.tenureMonths) != null ? ((S.tenure_months ?? loan.tenureMonths) + ' months') : '',
        C_RATE:              S.rate != null ? pctFromDecimal(S.rate) : (loan.interestRate != null ? pct(loan.interestRate) : ''),
        C_EMI_FACTOR:        S.emi_factor != null ? parseFloat(S.emi_factor).toFixed(4) : '',
        C_ELIGIBLE_INCOME:   fmtLakhAuto(S.eligible_loan_amount ?? S.eligible_loan),
        C_PROPOSED:          fmtLakhAuto(S.proposed_loan),
        C_PROPOSED_EMI:      fmtLakhAuto(S.proposed_emi),
        C_TOTAL_OBL:         fmtLakhAuto(S.total_obligation_annual ?? S.total_obligation),
        C_POST_DSCR:         dscr(S.dscr_on_proposed ?? S.post_dscr),
        C_TECHVAL1:          fmtLakhAuto(S.technical_valuation_1 ?? S.tech_val_1),
        C_TECHVAL2:          fmtLakhAuto(S.technical_valuation_2 ?? S.tech_val_2),
        C_VAL_CONSIDERED:    fmtLakhAuto(S.valuation_considered),
        C_ELIGIBLE_LTV:      pctFromDecimal(S.eligible_ltv),
        C_LTV_PROPOSED:      pctFromDecimal(S.ltv_on_proposed),
        C_LTV_DEV:           pctFromDecimal(S.ltv_deviation),

        // Part C — Eligibility Summary
        S_EBIDTA:            fmtLakhAuto(S.ebidta_net_of_tax ?? S.ebidta),
        S_TOTAL_INCOME:      fmtLakhAuto(S.total_annual_income),
        S_TARGET_DSCR:       dscr(S.target_dscr),
        S_MAX_EMI:           fmtLakhAuto(S.max_emi_allowed ?? S.max_emi),
        S_ELIGIBLE_LOAN:     fmtLakhAuto(S.eligible_loan_amount ?? S.eligible_loan),
        S_PROPOSED:          fmtLakhAuto(S.proposed_loan),
        S_PROPOSED_EMI:      fmtLakhAuto(S.proposed_emi),
        S_DSCR_PROPOSED:     dscr(S.dscr_on_proposed ?? S.post_dscr),

        // Part C — Collateral & LTV
        L_VAL_CONSIDERED:    fmtLakhAuto(S.valuation_considered),
        L_ELIGIBLE_LTV:      pctFromDecimal(S.eligible_ltv),
        L_ELIGIBLE_LOAN_LTV: fmtLakhAuto(S.eligible_loan_ltv ?? (S.valuation_considered != null && S.eligible_ltv != null ? S.valuation_considered * S.eligible_ltv : null)),
        L_LTV_PROPOSED:      pctFromDecimal(S.ltv_on_proposed),
        L_LTV_DEV:           pctFromDecimal(S.ltv_deviation),

        // Part C — Final Eligible Loan
        F_ELIGIBLE_INCOME:   fmtLakhAuto(S.eligible_loan_amount ?? S.eligible_loan),
        F_ELIGIBLE_LTV:      fmtLakhAuto(S.eligible_loan_ltv ?? (S.valuation_considered != null && S.eligible_ltv != null ? S.valuation_considered * S.eligible_ltv : null)),
        F_FINAL_ELIGIBLE:    fmtLakhAuto(finalEligible),
        F_PROPOSED:          fmtLakhAuto(S.proposed_loan),
        F_RECOMMENDED:       fmtLakhAuto(recommended),

        // Part C — Policy compliance statuses
        P_STATUS_1:          statusOf(0),
        P_STATUS_2:          statusOf(1),
        P_STATUS_3:          statusOf(2),
        P_STATUS_4:          statusOf(3),
        P_STATUS_5:          statusOf(4),

        // Deviation flags
        DEVIATION_FLAGS:     deviationLine,

        // Decision
        D_OVERALL_STATUS:    overallStatus,
        D_FINAL_ELIGIBLE:    fmtLakhAuto(finalEligible),
        D_RECOMMENDED:       fmtLakhAuto(recommended),
        D_RECOMMENDATION:    recommendation,
        // CIBIL summary — shown in the recommendation/decision context
        // These aren't separate template tokens in the current template but
        // the D_RECOMMENDATION text incorporates CIBIL context when available.
    };
}

/**
 * Generate the AFL CAM report by filling the master template.
 * @param {Object} assessment
 * @returns {Promise<Buffer>} the filled .docx as a Buffer
 */
async function generateAflCamReport(assessment) {
    const templateBuf = fs.readFileSync(TEMPLATE_PATH);
    const zip = await JSZip.loadAsync(templateBuf);

    let docXml = await zip.file('word/document.xml').async('string');

    const tokens = buildTokenMap(assessment);

    // Replace every {{TOKEN}} — global replace so duplicated tokens all fill.
    for (const [key, value] of Object.entries(tokens)) {
        const re = new RegExp('\\{\\{' + key + '\\}\\}', 'g');
        docXml = docXml.replace(re, esc(value));
    }

    // Any token we didn't map → blank it so no {{...}} leaks into the doc.
    docXml = docXml.replace(/\{\{[A-Z_0-9]+\}\}/g, '');

    zip.file('word/document.xml', docXml);

    return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { generateAflCamReport, buildTokenMap };
