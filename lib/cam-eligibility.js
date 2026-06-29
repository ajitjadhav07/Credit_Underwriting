/**
 * CAM (Credit Assessment Model) Eligibility Engine
 * --------------------------------------------------
 * Implements the four surrogate eligibility programs defined in the
 * CAM Eligibility workbook:
 *
 *   1. GROSS_MARGIN          - "Gross Turnover Program" (deemed margin on turnover)
 *   2. PROFESSIONAL_RECEIPT  - "Gross Professional Receipt" (multiplier on receipts)
 *   3. BANKING               - "Banking Program" (ADB based)
 *   4. CASH_PROFIT           - "Cash Profit Eligibility" (DSCR / cash-profit based)
 *
 * All monetary inputs/outputs are expressed in INR Lakhs (Lacs), exactly
 * as the source workbook is. The engine is intentionally framework-free
 * (no Express / S3 dependency) so it can be reused from the calculation
 * engine, the API layer, the report generator, or unit tests.
 *
 * Each program returns a normalised result object:
 *   {
 *     program, program_label,
 *     inputs,                 // echoed (normalised) inputs
 *     steps: [ { label, formula, value, value_display } ],
 *     summary: { eligible_loan, proposed_loan, foir, dscr, ltv, ... },
 *     policy_checks: [ { id, label, norm, complied, status } ],
 *     flags: [ "..." ],       // human-readable breaches
 *     overall: { status, breaching, decision_hint }
 *   }
 *
 * @module lib/cam-eligibility
 */

'use strict';

class CamEligibility {
    /**
     * @param {Object} [config] - optional overrides for defaults / reference tables
     */
    constructor(config = null) {
        this.config = Object.assign({}, this.getDefaultConfig(), config || {});
    }

    /** Update configuration (e.g. after a Masters refresh). */
    setConfig(config) {
        this.config = Object.assign({}, this.getDefaultConfig(), config || {});
    }

    /**
     * Default reference data and policy thresholds.
     * These mirror the "Data Validation" sheet and the policy notes in the workbook.
     */
    getDefaultConfig() {
        return {
            // Programmes supported (Data Validation!N)
            programs: [
                { code: 'GROSS_MARGIN', label: 'Gross Turnover / Gross Margin Program' },
                { code: 'PROFESSIONAL_RECEIPT', label: 'Gross Professional Receipt Program' },
                { code: 'BANKING', label: 'Banking Program' },
                { code: 'CASH_PROFIT', label: 'Cash Profit Eligibility Program' }
            ],
            // Default policy thresholds
            default_foir: 0.70,            // FOIR applicable (B14)
            min_dscr: 1.25,                // DSCR policy norm
            banking_emi_factor: 0.50,      // Max EMI = 50% of Net ADB (Banking!B10)
            professional_min_cibil: 720,   // Professional program CIBIL norm
            // Eligible LTV reference table (Data Validation!C:D)
            ltv_table: {
                'Residential - Self Occupied': 0.70,
                'Residential - Rented/Vacant': 0.65,
                'Commercial - Self Occupied': 0.65,
                'Commercial - Rented/Vacant': 0.60,
                'Commercial - LRD': 0.65,
                'Hospital': 0.55,
                'Nursing Home': 0.55,
                'New Medical Equipment': 0.75,
                'School': 0.55,
                'College': 0.55,
                'Educational Institute': 0.55,
                'Hotel': 0.40,
                'Plot Commercial': 0.40,
                'Plot Residential': 0.40,
                'Plot Industrial': 0.40,
                'Industrial Occupied': 0.55,
                'Industrial - Leasehold': 0.50,
                'Warehouse': 0.55,
                'Warehouse - Leasehold': 0.50,
                'NA': 0.0
            },
            // Multiplier guidance for the Professional Receipt program (Gross Professional Receipt!B4)
            professional_multipliers: {
                'Doctor': 2.5,
                'Other Professional': 2.0
            }
        };
    }

    // ----------------------------------------------------------------
    // Numeric / financial helpers
    // ----------------------------------------------------------------

    /** Coerce to a finite number, falling back to 0. */
    num(v) {
        const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : v;
        return (n === null || n === undefined || isNaN(n) || !isFinite(n)) ? 0 : n;
    }

    round2(n) {
        n = this.num(n);
        return Math.round(n * 100) / 100;
    }

    round4(n) {
        n = this.num(n);
        return Math.round(n * 10000) / 10000;
    }

    /**
     * EMI factor per 1 unit of principal = Excel PMT(rate/12, n, -1).
     * factor = i / (1 - (1+i)^-n)
     * @param {number} annualRate - decimal e.g. 0.1075
     * @param {number} months
     */
    emiFactor(annualRate, months) {
        const i = this.num(annualRate) / 12;
        const n = this.num(months);
        if (n <= 0) return 0;
        if (i === 0) return 1 / n;
        return i / (1 - Math.pow(1 + i, -n));
    }

    /** Monthly EMI for a principal (same units as principal). */
    calcEMI(principal, annualRate, months) {
        return this.num(principal) * this.emiFactor(annualRate, months);
    }

    /** Eligible loan amount for a given affordable monthly EMI. */
    eligibleLoan(maxMonthlyEMI, annualRate, months) {
        const f = this.emiFactor(annualRate, months);
        if (f === 0) return 0;
        return this.num(maxMonthlyEMI) / f;
    }

    safeDiv(a, b) {
        a = this.num(a); b = this.num(b);
        return b === 0 ? 0 : a / b;
    }

    /** Format a Lakhs value as "₹X.XX Cr" / "₹X.XX L". */
    formatLacs(lacs) {
        lacs = this.num(lacs);
        const sign = lacs < 0 ? '-' : '';
        const abs = Math.abs(lacs);
        if (abs >= 100) return `${sign}₹${(abs / 100).toFixed(2)} Cr`;
        return `${sign}₹${abs.toFixed(2)} L`;
    }

    /** Format a decimal fraction as a percentage string. */
    pct(frac, dp = 2) {
        return `${(this.num(frac) * 100).toFixed(dp)}%`;
    }

    /** Resolve eligible LTV for a property type (case/space insensitive). */
    resolveLtv(propertyType, explicitLtv) {
        if (explicitLtv !== undefined && explicitLtv !== null && explicitLtv !== '') {
            return this.num(explicitLtv);
        }
        if (!propertyType) return 0;
        const key = Object.keys(this.config.ltv_table).find(
            k => k.toLowerCase().replace(/\s+/g, '') === String(propertyType).toLowerCase().replace(/\s+/g, '')
        );
        return key ? this.config.ltv_table[key] : 0;
    }

    // ----------------------------------------------------------------
    // Shared blocks
    // ----------------------------------------------------------------

    /**
     * Valuation + LTV deviation block (common to all programs).
     * @returns {Object} { steps, summary, ltvFlag }
     */
    _valuationBlock(input, proposedLoan) {
        const v1 = this.num(input.technical_valuation_1);
        const v2 = this.num(input.technical_valuation_2);
        // Considered value: explicit, else lower of the two non-zero valuations, else max.
        let considered = this.num(input.valuation_considered);
        if (!considered) {
            const both = [v1, v2].filter(x => x > 0);
            considered = both.length === 2 ? Math.min(v1, v2) : (both[0] || 0);
        }
        const eligibleLtv = this.resolveLtv(input.property_type, input.eligible_ltv);
        const ltvConsidered = this.safeDiv(proposedLoan, considered);
        const ltvDeviation = ltvConsidered - eligibleLtv;

        const steps = [
            this._step('Technical Valuation 1', null, v1, this.formatLacs(v1)),
            this._step('Technical Valuation 2', null, v2, this.formatLacs(v2)),
            this._step('Valuation Considered', 'Lower of valuations', considered, this.formatLacs(considered)),
            this._step('Eligible LTV %', 'As per policy (less buffer)', eligibleLtv, this.pct(eligibleLtv)),
            this._step('LTV % on Proposed Loan', 'Proposed Loan / Valuation', this.round4(ltvConsidered), this.pct(ltvConsidered)),
            this._step('LTV Deviation', 'LTV on Proposed - Eligible LTV', this.round4(ltvDeviation), this.pct(ltvDeviation))
        ];

        return {
            steps,
            summary: {
                valuation_considered: this.round2(considered),
                eligible_ltv: this.round4(eligibleLtv),
                ltv_on_proposed: this.round4(ltvConsidered),
                ltv_deviation: this.round4(ltvDeviation)
            },
            ltvFlag: ltvDeviation > 0.0001
                ? `LTV on proposed loan (${this.pct(ltvConsidered)}) exceeds eligible LTV (${this.pct(eligibleLtv)})`
                : null
        };
    }

    _step(label, formula, value, valueDisplay) {
        return { label, formula: formula || null, value, value_display: valueDisplay };
    }

    /**
     * Normalise the policy condition checklist into structured checks.
     * @param {Array<{label:string, complied:boolean|string, norm?:string}>} list
     */
    _checks(list) {
        return (list || []).map((c, idx) => {
            const complied = c.complied === true || c.complied === 'Yes' || c.complied === 'yes' || c.complied === 'true';
            return {
                id: c.id || `chk_${idx + 1}`,
                label: c.label,
                norm: c.norm || 'Required',
                complied,
                status: complied ? 'pass' : 'fail'
            };
        });
    }

    // ----------------------------------------------------------------
    // Public entrypoint
    // ----------------------------------------------------------------

    /**
     * Evaluate a CAM eligibility request.
     * @param {Object} input - includes `program` plus program-specific fields
     * @returns {Object} normalised result
     */
    evaluate(input) {
        if (!input || typeof input !== 'object') {
            throw new Error('CAM evaluate(): input object is required');
        }
        const program = String(input.program || '').toUpperCase();
        switch (program) {
            case 'GROSS_MARGIN':
            case 'GROSS MARGIN':
                return this.evaluateGrossMargin(input);
            case 'PROFESSIONAL_RECEIPT':
            case 'GROSS_PROFESSIONAL_RECEIPT':
                return this.evaluateProfessionalReceipt(input);
            case 'BANKING':
            case 'BANKING_PROGRAM':
                return this.evaluateBanking(input);
            case 'CASH_PROFIT':
            case 'CASH PROFIT':
                return this.evaluateCashProfit(input);
            default:
                throw new Error(`CAM evaluate(): unknown program "${input.program}"`);
        }
    }

    /**
     * Wrap a finished program result with overall status / decision hint.
     */
    _finalise(base, extraFlags = []) {
        const foir = base.summary.foir_on_proposed;
        const dscr = base.summary.dscr_on_proposed;
        const eligible = base.summary.eligible_loan_amount;
        const proposed = base.summary.proposed_loan;
        const maxEmiAllowed = base.summary.max_emi_allowed;

        const flags = [];

        if (typeof maxEmiAllowed === 'number' && maxEmiAllowed < 0) {
            flags.push('No EMI headroom: existing obligations exceed appraised repayment capacity');
        }
        if (typeof eligible === 'number' && typeof proposed === 'number' && proposed > eligible + 0.01 && eligible >= 0) {
            flags.push(`Proposed loan (${this.formatLacs(proposed)}) exceeds income-eligible loan (${this.formatLacs(eligible)})`);
        }
        if (typeof foir === 'number' && foir > base.summary.foir_applicable + 0.0001) {
            flags.push(`FOIR on proposed (${this.pct(foir)}) exceeds applicable FOIR (${this.pct(base.summary.foir_applicable)})`);
        }
        if (typeof dscr === 'number' && dscr > 0 && dscr < this.config.min_dscr) {
            flags.push(`DSCR on proposed (${this.round2(dscr)}x) is below policy norm (${this.config.min_dscr}x)`);
        }

        extraFlags.filter(Boolean).forEach(f => flags.push(f));

        // Failed policy checks become flags too
        (base.policy_checks || []).filter(c => !c.complied).forEach(c => {
            flags.push(`Policy condition not complied: ${c.label}`);
        });

        const breaching = flags.length > 0;
        base.flags = flags;
        base.overall = {
            status: breaching ? 'breach' : 'within_norms',
            breaching,
            breach_count: flags.length,
            decision_hint: breaching
                ? 'Breaching policy norms — deviation approval required'
                : 'Within policy norms'
        };
        return base;
    }

    // ----------------------------------------------------------------
    // Program 1 — Gross Turnover / Gross Margin
    // ----------------------------------------------------------------
    evaluateGrossMargin(input) {
        const turnover = this.num(input.gross_turnover);
        const grossMarginPct = this.num(input.gross_margin_pct);     // from financials
        const deemedMarginPct = this.num(input.deemed_margin_pct);   // COE list
        const marginApplied = Math.min(grossMarginPct, deemedMarginPct);

        const eligibleIncomeAnnual = marginApplied * turnover;
        const odCcInterest = this.num(input.od_cc_interest);
        const incomeTaxPaid = this.num(input.income_tax_paid);
        const totalDeduction = odCcInterest + incomeTaxPaid;
        const netIncomeAnnual = eligibleIncomeAnnual - totalDeduction;
        const netIncomeMonthly = netIncomeAnnual / 12;

        const foir = input.foir != null && input.foir !== '' ? this.num(input.foir) : this.config.default_foir;
        const appraisedEmi = foir * netIncomeMonthly;
        const existingEmi = this.num(input.existing_emi_monthly);
        const maxEmiAllowed = appraisedEmi - existingEmi;

        const tenure = this.num(input.tenure_months);
        const rate = this.num(input.rate);
        const factor = this.emiFactor(rate, tenure);
        const eligibleLoan = this.eligibleLoan(maxEmiAllowed, rate, tenure);

        const proposedLoan = this.num(input.proposed_loan);
        const proposedEmi = this.calcEMI(proposedLoan, rate, tenure);
        const foirOnProposed = this.safeDiv(proposedEmi + existingEmi, netIncomeMonthly);
        const dscrOnProposed = this.safeDiv(netIncomeAnnual, existingEmi * 12 + proposedEmi * 12);

        const val = this._valuationBlock(input, proposedLoan);

        const steps = [
            this._step('Gross Turnover (ITR/GST)', null, turnover, this.formatLacs(turnover)),
            this._step('Gross Margin % (Financials)', null, grossMarginPct, this.pct(grossMarginPct)),
            this._step('Deemed Margin % (COE list)', null, deemedMarginPct, this.pct(deemedMarginPct)),
            this._step('Margin Applied', 'MIN(Gross, Deemed)', this.round4(marginApplied), this.pct(marginApplied)),
            this._step('Eligible Income (Annual)', 'Turnover × Margin', this.round2(eligibleIncomeAnnual), this.formatLacs(eligibleIncomeAnnual)),
            this._step('Less: OD/CC Interest', null, odCcInterest, this.formatLacs(odCcInterest)),
            this._step('Less: Income Tax Paid', null, incomeTaxPaid, this.formatLacs(incomeTaxPaid)),
            this._step('Net Eligible Income (Annual)', 'Eligible Income - Deductions', this.round2(netIncomeAnnual), this.formatLacs(netIncomeAnnual)),
            this._step('Net Eligible Income (Monthly)', 'Annual / 12', this.round2(netIncomeMonthly), this.formatLacs(netIncomeMonthly)),
            this._step('FOIR Applicable', null, foir, this.pct(foir)),
            this._step('Appraised Monthly Income (Max EMI)', 'FOIR × Monthly Income', this.round2(appraisedEmi), this.formatLacs(appraisedEmi)),
            this._step('Existing EMI (Monthly)', null, existingEmi, this.formatLacs(existingEmi)),
            this._step('Max EMI Allowed', 'Appraised - Existing EMI', this.round2(maxEmiAllowed), this.formatLacs(maxEmiAllowed)),
            this._step('Tenure (months)', null, tenure, `${tenure} months`),
            this._step('Rate', null, rate, this.pct(rate)),
            this._step('EMI Factor', 'PMT(rate/12, n, -1)', this.round4(factor), this.round4(factor).toString()),
            this._step('Eligible Loan Amount', 'Max EMI / EMI Factor', this.round2(eligibleLoan), this.formatLacs(eligibleLoan)),
            this._step('Proposed Loan Amount', null, proposedLoan, this.formatLacs(proposedLoan)),
            this._step('Proposed Monthly EMI', 'PMT on proposed loan', this.round2(proposedEmi), this.formatLacs(proposedEmi)),
            this._step('FOIR on Proposed', '(Proposed EMI + Existing) / Monthly Income', this.round4(foirOnProposed), this.pct(foirOnProposed)),
            this._step('DSCR on Proposed', 'Net Income / Total Annual Debt Service', this.round2(dscrOnProposed), `${this.round2(dscrOnProposed)}x`),
            ...val.steps
        ];

        const policy_checks = this._checks([
            { id: 'gm_1', label: 'Customer not in negative profile list', complied: input.chk_negative_profile },
            { id: 'gm_2', label: 'Annualised banking credits > 75% of reported receipts', complied: input.chk_banking_credits },
            { id: 'gm_3', label: 'Nil DPD in any loan in last 12 months (ex technical bounces)', complied: input.chk_nil_dpd },
            { id: 'gm_4', label: 'Reason for surrogate assessment recorded in CAM', complied: input.chk_surrogate_reason }
        ]);

        return this._finalise({
            program: 'GROSS_MARGIN',
            program_label: 'Gross Turnover / Gross Margin Program',
            inputs: input,
            steps,
            policy_checks,
            summary: {
                margin_applied: this.round4(marginApplied),
                net_eligible_income_annual: this.round2(netIncomeAnnual),
                foir_applicable: this.round4(foir),
                max_emi_allowed: this.round2(maxEmiAllowed),
                eligible_loan_amount: this.round2(eligibleLoan),
                proposed_loan: this.round2(proposedLoan),
                proposed_emi: this.round2(proposedEmi),
                foir_on_proposed: this.round4(foirOnProposed),
                dscr_on_proposed: this.round2(dscrOnProposed),
                ...val.summary
            }
        }, [val.ltvFlag]);
    }

    // ----------------------------------------------------------------
    // Program 2 — Gross Professional Receipt
    // ----------------------------------------------------------------
    evaluateProfessionalReceipt(input) {
        const receipts = this.num(input.gross_receipts);
        let multiplier = this.num(input.multiplier);
        if (!multiplier && input.professional_category) {
            multiplier = this.config.professional_multipliers[input.professional_category] || 0;
        }
        const eligibleIncomeAnnual = multiplier * receipts;
        const odCcInterest = this.num(input.od_cc_interest);
        const incomeTaxPaid = this.num(input.income_tax_paid);
        const totalDeduction = odCcInterest + incomeTaxPaid;
        const netIncomeAnnual = eligibleIncomeAnnual - totalDeduction;
        const netIncomeMonthly = netIncomeAnnual / 12;

        const foir = input.foir != null && input.foir !== '' ? this.num(input.foir) : this.config.default_foir;
        const appraisedEmi = foir * netIncomeMonthly;
        const existingEmi = this.num(input.existing_emi_monthly);
        const maxEmiAllowed = appraisedEmi - existingEmi;

        const tenure = this.num(input.tenure_months);
        const rate = this.num(input.rate);
        const factor = this.emiFactor(rate, tenure);
        const eligibleLoan = this.eligibleLoan(maxEmiAllowed, rate, tenure);

        const proposedLoan = this.num(input.proposed_loan);
        const proposedEmi = this.calcEMI(proposedLoan, rate, tenure);
        const foirOnProposed = this.safeDiv(proposedEmi + existingEmi, netIncomeMonthly);
        const dscrOnProposed = this.safeDiv(netIncomeAnnual, existingEmi * 12 + proposedEmi * 12);

        const val = this._valuationBlock(input, proposedLoan);

        const steps = [
            this._step('Gross Receipts (Financials)', null, receipts, this.formatLacs(receipts)),
            this._step('Multiplier', 'By customer category', multiplier, `${multiplier}x`),
            this._step('Eligible Income (Annual)', 'Receipts × Multiplier', this.round2(eligibleIncomeAnnual), this.formatLacs(eligibleIncomeAnnual)),
            this._step('Less: OD/CC Interest', null, odCcInterest, this.formatLacs(odCcInterest)),
            this._step('Less: Income Tax Paid', null, incomeTaxPaid, this.formatLacs(incomeTaxPaid)),
            this._step('Net Eligible Income (Annual)', 'Eligible Income - Deductions', this.round2(netIncomeAnnual), this.formatLacs(netIncomeAnnual)),
            this._step('Net Eligible Income (Monthly)', 'Annual / 12', this.round2(netIncomeMonthly), this.formatLacs(netIncomeMonthly)),
            this._step('FOIR Applicable', null, foir, this.pct(foir)),
            this._step('Appraised Monthly Income (Max EMI)', 'FOIR × Monthly Income', this.round2(appraisedEmi), this.formatLacs(appraisedEmi)),
            this._step('Existing EMI (Monthly)', null, existingEmi, this.formatLacs(existingEmi)),
            this._step('Max EMI Allowed', 'Appraised - Existing EMI', this.round2(maxEmiAllowed), this.formatLacs(maxEmiAllowed)),
            this._step('Tenure (months)', null, tenure, `${tenure} months`),
            this._step('Rate', null, rate, this.pct(rate)),
            this._step('EMI Factor', 'PMT(rate/12, n, -1)', this.round4(factor), this.round4(factor).toString()),
            this._step('Eligible Loan Amount', 'Max EMI / EMI Factor', this.round2(eligibleLoan), this.formatLacs(eligibleLoan)),
            this._step('Proposed Loan Amount', null, proposedLoan, this.formatLacs(proposedLoan)),
            this._step('Proposed Monthly EMI', 'PMT on proposed loan', this.round2(proposedEmi), this.formatLacs(proposedEmi)),
            this._step('FOIR on Proposed', '(Proposed EMI + Existing) / Monthly Income', this.round4(foirOnProposed), this.pct(foirOnProposed)),
            this._step('DSCR on Proposed', 'Net Income / Total Annual Debt Service', this.round2(dscrOnProposed), `${this.round2(dscrOnProposed)}x`),
            ...val.steps
        ];

        const policy_checks = this._checks([
            { id: 'pr_1', label: 'Business experience > 5 years (Doctor registered with MCI)', complied: input.chk_experience },
            { id: 'pr_2', label: 'If Doctor, registered with Medical Council of India', complied: input.chk_mci_registered },
            { id: 'pr_3', label: `CIBIL score > ${this.config.professional_min_cibil}`, complied: input.chk_cibil },
            { id: 'pr_4', label: 'Nil bounces in last 12 months due to insufficient funds', complied: input.chk_nil_bounces },
            { id: 'pr_5', label: 'Reason for surrogate assessment recorded in CAM', complied: input.chk_surrogate_reason },
            { id: 'pr_6', label: 'Tax Audit report taken on record', complied: input.chk_tax_audit }
        ]);

        return this._finalise({
            program: 'PROFESSIONAL_RECEIPT',
            program_label: 'Gross Professional Receipt Program',
            inputs: input,
            steps,
            policy_checks,
            summary: {
                multiplier,
                net_eligible_income_annual: this.round2(netIncomeAnnual),
                foir_applicable: this.round4(foir),
                max_emi_allowed: this.round2(maxEmiAllowed),
                eligible_loan_amount: this.round2(eligibleLoan),
                proposed_loan: this.round2(proposedLoan),
                proposed_emi: this.round2(proposedEmi),
                foir_on_proposed: this.round4(foirOnProposed),
                dscr_on_proposed: this.round2(dscrOnProposed),
                ...val.summary
            }
        }, [val.ltvFlag]);
    }

    // ----------------------------------------------------------------
    // Program 3 — Banking Program
    // ----------------------------------------------------------------
    evaluateBanking(input) {
        const adb1 = this.num(input.adb_account_1);
        const adb2 = this.num(input.adb_account_2);
        const adb3 = this.num(input.adb_account_3);
        const btEmiAdded = this.num(input.bt_emi_added);          // LAP loan being taken over
        const grossAdb = adb1 + adb2 + adb3 + btEmiAdded;
        const lessEmi12m = this.num(input.emi_last_12_months);   // EMI repaid from these accounts
        const netAdb = grossAdb - lessEmi12m;

        const emiFactorPct = input.max_emi_factor != null && input.max_emi_factor !== ''
            ? this.num(input.max_emi_factor) : this.config.banking_emi_factor;
        const maxEmiAllowed = netAdb * emiFactorPct;

        const tenure = this.num(input.tenure_months);
        const rate = this.num(input.rate);
        const factor = this.emiFactor(rate, tenure);
        const eligibleLoan = this.eligibleLoan(maxEmiAllowed, rate, tenure);

        const proposedLoan = this.num(input.proposed_loan);
        const proposedEmi = this.calcEMI(proposedLoan, rate, tenure);
        const avgMonthlyCredits = this.num(input.avg_monthly_credits);

        const val = this._valuationBlock(input, proposedLoan);

        const steps = [
            this._step('Average Daily Balance - Account 1', null, adb1, this.formatLacs(adb1)),
            this._step('Average Daily Balance - Account 2', null, adb2, this.formatLacs(adb2)),
            this._step('Average Daily Balance - Account 3', null, adb3, this.formatLacs(adb3)),
            this._step('EMI Added (LAP loan taken over)', null, btEmiAdded, this.formatLacs(btEmiAdded)),
            this._step('Gross Average Daily Balance', 'Sum of ADBs + BT EMI', this.round2(grossAdb), this.formatLacs(grossAdb)),
            this._step('Less: EMI of loans (last 12 months)', null, lessEmi12m, this.formatLacs(lessEmi12m)),
            this._step('Net ADB Considered', 'Gross ADB - EMI', this.round2(netAdb), this.formatLacs(netAdb)),
            this._step('Max EMI Allowed', `Net ADB × ${this.pct(emiFactorPct, 0)}`, this.round2(maxEmiAllowed), this.formatLacs(maxEmiAllowed)),
            this._step('Tenure (months)', null, tenure, `${tenure} months`),
            this._step('Rate', null, rate, this.pct(rate)),
            this._step('EMI Factor', 'PMT(rate/12, n, -1)', this.round4(factor), this.round4(factor).toString()),
            this._step('Eligible Loan Amount', 'Max EMI / EMI Factor', this.round2(eligibleLoan), this.formatLacs(eligibleLoan)),
            this._step('Proposed Loan Amount', null, proposedLoan, this.formatLacs(proposedLoan)),
            this._step('Proposed Monthly EMI', 'PMT on proposed loan', this.round2(proposedEmi), this.formatLacs(proposedEmi)),
            this._step('Average Monthly Credits', null, avgMonthlyCredits, this.formatLacs(avgMonthlyCredits)),
            ...val.steps
        ];

        // Credits-vs-EMI norm: avg monthly credits must be >= 3x proposed EMI
        const creditsCoverageOk = avgMonthlyCredits >= 3 * proposedEmi && proposedEmi > 0;

        const policy_checks = this._checks([
            { id: 'bk_1', label: 'Customer not having CC/OD facility', complied: input.chk_no_cc_od },
            { id: 'bk_2', label: 'Business experience > 3 years', complied: input.chk_experience },
            { id: 'bk_3', label: '>= 12 business credit transactions per quarter', complied: input.chk_credit_txns },
            { id: 'bk_4', label: 'Average monthly credits >= 3x proposed EMI', complied: input.chk_credits_3x != null ? input.chk_credits_3x : creditsCoverageOk },
            { id: 'bk_5', label: 'Inward bounces not > 2% of cheques issued', complied: input.chk_bounces },
            { id: 'bk_6', label: 'Customer not in negative profile list', complied: input.chk_negative_profile },
            { id: 'bk_7', label: 'Nil DPD in any loan in last 12 months (ex technical bounces)', complied: input.chk_nil_dpd },
            { id: 'bk_8', label: 'No cash-out / >2 unsecured loans in last 6 months', complied: input.chk_no_cashout },
            { id: 'bk_9', label: 'Reason for surrogate assessment recorded in CAM', complied: input.chk_surrogate_reason }
        ]);

        const extraFlag = (proposedEmi > 0 && !creditsCoverageOk)
            ? `Average monthly credits (${this.formatLacs(avgMonthlyCredits)}) are below 3x proposed EMI (${this.formatLacs(3 * proposedEmi)})`
            : null;

        return this._finalise({
            program: 'BANKING',
            program_label: 'Banking Program',
            inputs: input,
            steps,
            policy_checks,
            summary: {
                gross_adb: this.round2(grossAdb),
                net_adb: this.round2(netAdb),
                foir_applicable: 1, // not FOIR-driven; kept for uniform shape
                max_emi_allowed: this.round2(maxEmiAllowed),
                eligible_loan_amount: this.round2(eligibleLoan),
                proposed_loan: this.round2(proposedLoan),
                proposed_emi: this.round2(proposedEmi),
                foir_on_proposed: 0,
                dscr_on_proposed: 0,
                ...val.summary
            }
        }, [extraFlag, val.ltvFlag]);
    }

    // ----------------------------------------------------------------
    // Program 4 — Cash Profit Eligibility (DSCR based)
    // ----------------------------------------------------------------
    evaluateCashProfit(input) {
        const turnover = this.num(input.turnover);
        const pat = this.num(input.pat);
        const nonOpIncome = this.num(input.non_operating_income);
        const depreciation = this.num(input.depreciation);
        const interestToBank = this.num(input.interest_to_bank);
        const relatedPartyPayment = this.num(input.related_party_payment);
        const otherIncome = this.num(input.other_income);

        // EBIDTA (net of tax) = PAT - Non-op income + Depreciation + Interest
        const ebidta = pat - nonOpIncome + depreciation + interestToBank;
        const totalAnnualIncome = ebidta + relatedPartyPayment + otherIncome;

        const existingObligationAnnual = this.num(input.existing_obligation_annual);

        const tenure = this.num(input.tenure_months);
        const rate = this.num(input.rate);
        const factor = this.emiFactor(rate, tenure);

        // Income-based eligible loan via target DSCR
        const targetDscr = input.target_dscr != null && input.target_dscr !== ''
            ? this.num(input.target_dscr) : this.config.min_dscr;
        const maxAnnualDebtService = this.safeDiv(totalAnnualIncome, targetDscr);
        const maxEmiMonthly = (maxAnnualDebtService - existingObligationAnnual) / 12;
        const eligibleLoan = this.eligibleLoan(maxEmiMonthly, rate, tenure);

        const proposedLoan = this.num(input.proposed_loan);
        const proposedEmi = this.calcEMI(proposedLoan, rate, tenure);
        const proposedObligationAnnual = proposedEmi * 12;
        const totalObligation = existingObligationAnnual + proposedObligationAnnual;
        const dscrPostDisbursement = this.safeDiv(totalAnnualIncome, totalObligation);

        const val = this._valuationBlock(input, proposedLoan);

        const steps = [
            this._step('Turnover / Receipts', null, turnover, this.formatLacs(turnover)),
            this._step('PAT', null, pat, this.formatLacs(pat)),
            this._step('Less: Non-operating Income', null, nonOpIncome, this.formatLacs(nonOpIncome)),
            this._step('Add: Depreciation', null, depreciation, this.formatLacs(depreciation)),
            this._step('Add: Interest to Bank/FI', null, interestToBank, this.formatLacs(interestToBank)),
            this._step('EBIDTA (Net of Tax)', 'PAT - NonOp + Dep + Interest', this.round2(ebidta), this.formatLacs(ebidta)),
            this._step('Add: Related Party Payment', null, relatedPartyPayment, this.formatLacs(relatedPartyPayment)),
            this._step('Add: Other Income', null, otherIncome, this.formatLacs(otherIncome)),
            this._step('Total Annual Income (Cash Profit)', 'EBIDTA + Related Party + Other', this.round2(totalAnnualIncome), this.formatLacs(totalAnnualIncome)),
            this._step('Existing Obligation (Annual)', null, existingObligationAnnual, this.formatLacs(existingObligationAnnual)),
            this._step('Target DSCR', null, targetDscr, `${targetDscr}x`),
            this._step('Max Annual Debt Service', 'Total Income / Target DSCR', this.round2(maxAnnualDebtService), this.formatLacs(maxAnnualDebtService)),
            this._step('Max EMI Allowed (Monthly)', '(Max DS - Existing) / 12', this.round2(maxEmiMonthly), this.formatLacs(maxEmiMonthly)),
            this._step('Tenure (months)', null, tenure, `${tenure} months`),
            this._step('Rate', null, rate, this.pct(rate)),
            this._step('EMI Factor', 'PMT(rate/12, n, -1)', this.round4(factor), this.round4(factor).toString()),
            this._step('Eligible Loan (basis Income)', 'Max EMI / EMI Factor', this.round2(eligibleLoan), this.formatLacs(eligibleLoan)),
            this._step('Proposed Loan Amount', null, proposedLoan, this.formatLacs(proposedLoan)),
            this._step('Proposed Monthly EMI', 'PMT on proposed loan', this.round2(proposedEmi), this.formatLacs(proposedEmi)),
            this._step('Total Obligation (Annual)', 'Existing + Proposed', this.round2(totalObligation), this.formatLacs(totalObligation)),
            this._step('Post-disbursement DSCR', 'Total Income / Total Obligation', this.round2(dscrPostDisbursement), `${this.round2(dscrPostDisbursement)}x`),
            ...val.steps
        ];

        const policy_checks = this._checks([
            { id: 'cp_1', label: `Post-disbursement DSCR >= ${this.config.min_dscr}x`, norm: `>= ${this.config.min_dscr}x`, complied: dscrPostDisbursement >= this.config.min_dscr },
            { id: 'cp_2', label: 'Audited financials taken on record', complied: input.chk_audited },
            { id: 'cp_3', label: 'Customer not in negative profile list', complied: input.chk_negative_profile },
            { id: 'cp_4', label: 'Nil DPD in any loan in last 12 months (ex technical bounces)', complied: input.chk_nil_dpd },
            { id: 'cp_5', label: 'Reason for assessment recorded in CAM', complied: input.chk_surrogate_reason }
        ]);

        return this._finalise({
            program: 'CASH_PROFIT',
            program_label: 'Cash Profit Eligibility Program',
            inputs: input,
            steps,
            policy_checks,
            summary: {
                ebidta_net_of_tax: this.round2(ebidta),
                total_annual_income: this.round2(totalAnnualIncome),
                foir_applicable: 1, // DSCR-driven; uniform shape
                target_dscr: this.round2(targetDscr),
                max_emi_allowed: this.round2(maxEmiMonthly),
                eligible_loan_amount: this.round2(eligibleLoan),
                proposed_loan: this.round2(proposedLoan),
                proposed_emi: this.round2(proposedEmi),
                foir_on_proposed: 0,
                dscr_on_proposed: this.round2(dscrPostDisbursement),
                ...val.summary
            }
        }, [val.ltvFlag]);
    }

    // ----------------------------------------------------------------
    // Optional convenience: prefill CAM inputs from extracted financials
    // ----------------------------------------------------------------

    /**
     * Build sensible default CAM inputs from an assessment's extracted data.
     * The frontend can use these to pre-populate the form; the user can override.
     * @param {Object} extractedData
     * @returns {Object} suggested inputs (amounts in Lakhs)
     */
    deriveDefaults(extractedData) {
        const ed = extractedData || {};
        const pnl = ed.profit_and_loss || {};
        const years = Object.keys(pnl).filter(k => !k.startsWith('_')).sort();
        const latest = pnl[years[years.length - 1]] || {};
        const toLacs = v => this.round2(this.num(v) / 100000);

        const revenue = this.num(latest.revenue);
        const grossProfit = this.num(latest.gross_profit);
        const grossMarginPct = revenue ? this.round4(grossProfit / revenue) : 0;

        return {
            gross_turnover: toLacs(revenue),
            gross_margin_pct: grossMarginPct,
            od_cc_interest: toLacs(latest.interest_expense || latest.interest),
            pat: toLacs(latest.profit_after_tax),
            depreciation: toLacs(latest.depreciation),
            interest_to_bank: toLacs(latest.interest_expense || latest.interest),
            turnover: toLacs(revenue),
            foir: this.config.default_foir,
            target_dscr: this.config.min_dscr
        };
    }
}

// Default singleton (backward compatible with the calculation-engine pattern)
const defaultCam = new CamEligibility();

module.exports = defaultCam;
module.exports.CamEligibility = CamEligibility;
module.exports.createCamEngine = (config) => new CamEligibility(config);
