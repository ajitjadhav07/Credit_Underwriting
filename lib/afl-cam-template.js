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

    const dateStr = new Date(assessment.created_at || Date.now())
        .toLocaleDateString('en-IN', { day: 'numeric', month: 'numeric', year: 'numeric' });

    // Policy check statuses (up to 5 rows in the template)
    const statusOf = (i) => {
        const c = checks[i];
        if (!c) return '';
        return c.complied ? 'Complied' : 'Not Complied';
    };

    // Deviation flags line
    const deviationLine = (flags && flags.length > 0)
        ? 'Deviation Flags: ' + flags.join('; ')
        : 'Deviation Flags: None \u2013 proposal is within all policy norms.';

    // Overall status / recommendation
    const withinPolicy = !flags || flags.length === 0;
    const overallStatus = withinPolicy ? 'WITHIN POLICY NORMS' : 'DEVIATION FROM POLICY';
    const recommendation = withinPolicy
        ? 'RECOMMENDED FOR SANCTION \u2014 within income (DSCR) and LTV eligibility with policy conditions complied.'
        : ('REFER TO CREDIT COMMITTEE \u2014 deviations noted: ' + flags.join('; ') + '.');

    const finalEligible = S.final_eligible_loan_lakhs != null
        ? S.final_eligible_loan_lakhs
        : (S.eligible_loan_amount_lakhs != null && S.eligible_loan_ltv_lakhs != null
            ? Math.min(S.eligible_loan_amount_lakhs, S.eligible_loan_ltv_lakhs)
            : null);
    const recommended = S.recommended_loan_lakhs != null ? S.recommended_loan_lakhs : S.proposed_loan_lakhs;

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

        // Part B
        BASIC_LOAN:          [loan.product, loan.loanType].filter(Boolean).join(' \u2014 '),
        MORATORIUM:          '',
        PAYMENT_DETAILS:     '',

        // Part C — Eligibility Calculation Working (value column)
        // Fields suffixed _cr are in crores; smaller line items may be in lakhs.
        // fmtLakhAuto shows Cr when >= 100L, else L — matching the sample where
        // Turnover/PAT show Cr but Non-op/Dep/Interest show L.
        C_TURNOVER:          fmtCr(S.turnover_cr),
        C_PAT:               fmtCr(S.pat_cr),
        C_NONOP:             S.non_op_income_lakhs != null ? fmtLakhAuto(S.non_op_income_lakhs) : fmtLakhAuto(S.non_op_income_cr != null ? S.non_op_income_cr * 100 : null),
        C_DEP:               S.depreciation_lakhs != null ? fmtLakhAuto(S.depreciation_lakhs) : fmtLakhAuto(S.depreciation_cr != null ? S.depreciation_cr * 100 : null),
        C_INTEREST:          S.interest_lakhs != null ? fmtLakhAuto(S.interest_lakhs) : fmtLakhAuto(S.interest_cr != null ? S.interest_cr * 100 : null),
        C_EBIDTA:            fmtCr(S.ebidta_cr),
        C_RELATED:           S.related_party_lakhs != null ? fmtLakhAuto(S.related_party_lakhs) : fmtLakhAuto(S.related_party_cr != null ? S.related_party_cr * 100 : null),
        C_OTHER:             S.other_income_lakhs != null ? fmtLakhAuto(S.other_income_lakhs) : fmtLakhAuto(S.other_income_cr != null ? S.other_income_cr * 100 : null),
        C_TOTAL_INCOME:      fmtCr(S.total_annual_income_cr),
        C_EXISTING_OBL:      S.existing_obligation_lakhs != null ? fmtLakhAuto(S.existing_obligation_lakhs) : fmtLakhAuto(S.existing_obligation_cr != null ? S.existing_obligation_cr * 100 : null),
        C_TARGET_DSCR:       dscr(S.target_dscr),
        C_MAX_DS:            fmtCr(S.max_annual_ds_cr),
        C_MAX_EMI:           fmtLakhAuto(S.max_emi_lakhs != null ? S.max_emi_lakhs : S.max_emi_allowed_lakhs),
        C_TENURE:            S.tenure_months != null ? (S.tenure_months + ' months') : orEmpty(loan.tenureMonths ? loan.tenureMonths + ' months' : ''),
        C_RATE:              S.rate != null ? pct(S.rate * 100) : (loan.interestRate != null ? pct(loan.interestRate) : ''),
        C_EMI_FACTOR:        S.emi_factor != null ? parseFloat(S.emi_factor).toFixed(4) : '',
        C_ELIGIBLE_INCOME:   fmtCr(S.eligible_loan_income_cr != null ? S.eligible_loan_income_cr : (S.eligible_loan_amount_lakhs != null ? S.eligible_loan_amount_lakhs / 100 : null)),
        C_PROPOSED:          fmtCr(S.proposed_loan_cr != null ? S.proposed_loan_cr : (S.proposed_loan_lakhs != null ? S.proposed_loan_lakhs / 100 : null)),
        C_PROPOSED_EMI:      fmtLakhAuto(S.proposed_emi),
        C_TOTAL_OBL:         fmtCr(S.total_obligation_annual_cr),
        C_POST_DSCR:         dscr(S.post_dscr),
        C_TECHVAL1:          fmtCr(S.tech_val_1_cr != null ? S.tech_val_1_cr : (S.tech_val_1_lakhs != null ? S.tech_val_1_lakhs / 100 : null)),
        C_TECHVAL2:          fmtCr(S.tech_val_2_cr != null ? S.tech_val_2_cr : (S.tech_val_2_lakhs != null ? S.tech_val_2_lakhs / 100 : null)),
        C_VAL_CONSIDERED:    fmtCr(S.valuation_considered_cr != null ? S.valuation_considered_cr : (S.valuation_considered_lakhs != null ? S.valuation_considered_lakhs / 100 : null)),
        C_ELIGIBLE_LTV:      pct(S.eligible_ltv_pct),
        C_LTV_PROPOSED:      pct(S.ltv_on_proposed_pct),
        C_LTV_DEV:           pct(S.ltv_deviation_pct),

        // Part C — Eligibility Summary
        S_EBIDTA:            fmtL(S.ebidta_lakhs != null ? S.ebidta_lakhs : (S.ebidta_cr != null ? S.ebidta_cr * 100 : null)),
        S_TOTAL_INCOME:      fmtL(S.total_annual_income_lakhs != null ? S.total_annual_income_lakhs : (S.total_annual_income_cr != null ? S.total_annual_income_cr * 100 : null)),
        S_TARGET_DSCR:       dscr(S.target_dscr),
        S_MAX_EMI:           fmtL(S.max_emi_lakhs != null ? S.max_emi_lakhs : S.max_emi_allowed_lakhs),
        S_ELIGIBLE_LOAN:     fmtL(S.eligible_loan_amount_lakhs),
        S_PROPOSED:          fmtL(S.proposed_loan_lakhs),
        S_PROPOSED_EMI:      fmtL(S.proposed_emi),
        S_DSCR_PROPOSED:     dscr(S.post_dscr),

        // Part C — Collateral & LTV
        L_VAL_CONSIDERED:    fmtL(S.valuation_considered_lakhs),
        L_ELIGIBLE_LTV:      pct(S.eligible_ltv_pct),
        L_ELIGIBLE_LOAN_LTV: fmtL(S.eligible_loan_ltv_lakhs),
        L_LTV_PROPOSED:      pct(S.ltv_on_proposed_pct),
        L_LTV_DEV:           pct(S.ltv_deviation_pct),

        // Part C — Final Eligible Loan
        F_ELIGIBLE_INCOME:   fmtL(S.eligible_loan_amount_lakhs),
        F_ELIGIBLE_LTV:      fmtL(S.eligible_loan_ltv_lakhs),
        F_FINAL_ELIGIBLE:    fmtL(finalEligible),
        F_PROPOSED:          fmtL(S.proposed_loan_lakhs),
        F_RECOMMENDED:       fmtL(recommended),

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
        D_FINAL_ELIGIBLE:    fmtL(finalEligible),
        D_RECOMMENDED:       fmtL(recommended),
        D_RECOMMENDATION:    recommendation,
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
