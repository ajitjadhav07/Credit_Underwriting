/**
 * Calculation Engine with Full Formula Transparency
 * Every calculation shows: formula, values, result, status
 * 
 * v7.0.38: Now reads configuration from Masters via configCache
 * v7.7.8:  Integrated CAM (Credit Assessment Model) eligibility engine
 */

const { createCamEngine } = require('./cam-eligibility');

class CalculationEngine {
    
    /**
     * Constructor - accepts configuration from Masters
     * @param {Object} config - Configuration object from /api/config/all
     */
    constructor(config = null) {
        this.config = config || this.getDefaultConfig();
        // CAM eligibility sub-engine (modular, reusable)
        this.cam = createCamEngine(this.config && this.config.cam_config);
    }

    /**
     * Set configuration (for updating after cache flush)
     */
    setConfig(config) {
        this.config = config || this.getDefaultConfig();
        if (this.cam && typeof this.cam.setConfig === 'function') {
            this.cam.setConfig(this.config && this.config.cam_config);
        }
    }

    /**
     * Evaluate CAM (Credit Assessment Model) eligibility.
     * Delegates to the modular CAM engine. Safe to call standalone.
     * @param {Object} camInput - program + program-specific fields (amounts in Lakhs)
     * @returns {Object} normalised CAM result (steps, summary, policy_checks, flags)
     */
    calculateCamEligibility(camInput) {
        if (!camInput || !camInput.program) return null;
        return this.cam.evaluate(camInput);
    }

    /**
     * Suggest CAM input defaults from extracted financials (for prefill).
     */
    deriveCamDefaults(extractedData) {
        return this.cam.deriveDefaults(extractedData);
    }

    /**
     * Get default configuration (fallback if Masters not available)
     */
    getDefaultConfig() {
        return {
            policy_rules: [
                { id: 'cr_001', parameter: 'Current Ratio', clause_ref: '3.1.1', norm_operator: '>=', current_value: 1.20, norm_display: '>= 1.20' },
                { id: 'cr_002', parameter: 'Debt to Equity Ratio', clause_ref: '3.1.2', norm_operator: '<=', current_value: 2.00, norm_display: '<= 2.00' },
                { id: 'cr_003', parameter: 'TOL/TNW', clause_ref: '3.1.3', norm_operator: '<=', current_value: 3.00, norm_display: '<= 3.00' },
                { id: 'cr_004', parameter: 'Quick Ratio (Acid Test)', clause_ref: '3.1.5', norm_operator: '>=', current_value: 1.00, norm_display: '>= 1.00' },
                { id: 'cr_005', parameter: 'Cash Ratio', clause_ref: '3.1.6', norm_operator: '>=', current_value: 0.20, norm_display: '>= 0.20' },
                { id: 'cr_006', parameter: 'Debt Service Coverage Ratio (DSCR)', clause_ref: '3.2.1', norm_operator: '>=', current_value: 1.25, norm_display: '>= 1.25x' },
                { id: 'cr_007', parameter: 'Interest Coverage Ratio (ICR)', clause_ref: '3.2.3', norm_operator: '>=', current_value: 2.00, norm_display: '>= 2.00x' },
                { id: 'cr_008', parameter: 'Gross Profit Margin', clause_ref: '3.3.3', norm_operator: '>=', current_value: 10.00, norm_display: '>= 10%' },
                { id: 'cr_009', parameter: 'EBITDA Margin', clause_ref: '3.3.4', norm_operator: '>=', current_value: 8.00, norm_display: '>= 8%' },
                { id: 'cr_010', parameter: 'Net Profit Margin (PAT Margin)', clause_ref: '3.3.5', norm_operator: '>=', current_value: 2.00, norm_display: '>= 2%' },
                { id: 'cr_011', parameter: 'Return on Equity (ROE)', clause_ref: '3.3.6', norm_operator: '>=', current_value: 15.00, norm_display: '>= 15%' },
                { id: 'cr_012', parameter: 'Return on Assets (ROA)', clause_ref: '3.3.7', norm_operator: '>=', current_value: 5.00, norm_display: '>= 5%' }
            ],
            scoring_weights: [
                { category_code: 'FINANCIAL', category_name: 'Financial Strength', max_score: 35 },
                { category_code: 'BANKING', category_name: 'Banking Conduct', max_score: 20 },
                { category_code: 'CREDIT_HISTORY', category_name: 'Credit History', max_score: 15 },
                { category_code: 'BUSINESS', category_name: 'Business Stability', max_score: 15 },
                { category_code: 'SECURITY', category_name: 'Security Coverage', max_score: 15 }
            ],
            scoring_metrics: [
                { metric_code: 'CURRENT_RATIO', category_code: 'FINANCIAL', max_score: 7, threshold_1: 1.5, score_1: 7, threshold_2: 1.25, score_2: 5, threshold_3: 1.0, score_3: 3, default_score: 1, comparison_type: 'higher_better' },
                { metric_code: 'DEBT_EQUITY', category_code: 'FINANCIAL', max_score: 7, threshold_1: 0.5, score_1: 7, threshold_2: 1.0, score_2: 5, threshold_3: 2.0, score_3: 3, default_score: 1, comparison_type: 'lower_better' },
                { metric_code: 'INTEREST_COVERAGE', category_code: 'FINANCIAL', max_score: 7, threshold_1: 3.0, score_1: 7, threshold_2: 2.0, score_2: 5, threshold_3: 1.5, score_3: 3, default_score: 1, comparison_type: 'higher_better' },
                { metric_code: 'NET_MARGIN', category_code: 'FINANCIAL', max_score: 7, threshold_1: 5.0, score_1: 7, threshold_2: 3.0, score_2: 5, threshold_3: 1.0, score_3: 3, default_score: 1, comparison_type: 'higher_better' },
                { metric_code: 'ROE', category_code: 'FINANCIAL', max_score: 7, threshold_1: 20.0, score_1: 7, threshold_2: 15.0, score_2: 5, threshold_3: 10.0, score_3: 3, default_score: 1, comparison_type: 'higher_better' },
                { metric_code: 'AVG_BALANCE', category_code: 'BANKING', max_score: 7, threshold_1: 1000000, score_1: 7, threshold_2: 500000, score_2: 5, threshold_3: 100000, score_3: 3, default_score: 1, comparison_type: 'higher_better' },
                { metric_code: 'CHEQUE_RETURN', category_code: 'BANKING', max_score: 7, threshold_1: 1.0, score_1: 7, threshold_2: 2.0, score_2: 5, threshold_3: 5.0, score_3: 3, default_score: 0, comparison_type: 'lower_better' },
                { metric_code: 'EMI_BURDEN', category_code: 'BANKING', max_score: 6, threshold_1: 30.0, score_1: 6, threshold_2: 50.0, score_2: 4, threshold_3: 70.0, score_3: 2, default_score: 0, comparison_type: 'lower_better' },
                { metric_code: 'REVENUE_GROWTH', category_code: 'BUSINESS', max_score: 5, threshold_1: 10.0, score_1: 5, threshold_2: 5.0, score_2: 4, threshold_3: 0.0, score_3: 2, default_score: 1, comparison_type: 'higher_better' },
                { metric_code: 'BUSINESS_VINTAGE', category_code: 'BUSINESS', max_score: 5, threshold_1: 5, score_1: 5, threshold_2: 3, score_2: 4, threshold_3: 2, score_3: 2, default_score: 1, comparison_type: 'higher_better' },
                { metric_code: 'GST_COMPLIANCE', category_code: 'BUSINESS', max_score: 5, threshold_1: 100, score_1: 5, threshold_2: 90, score_2: 3, threshold_3: 75, score_3: 2, default_score: 1, comparison_type: 'higher_better' },
                { metric_code: 'COLLATERAL_VALUE', category_code: 'SECURITY', max_score: 8, threshold_1: 10000000, score_1: 8, threshold_2: 5000000, score_2: 6, threshold_3: 1000000, score_3: 4, default_score: 2, comparison_type: 'higher_better' }
            ],
            scoring_grades: [
                { grade: 'A+', min_score: 85, max_score: 100, decision: 'Approve' },
                { grade: 'A', min_score: 75, max_score: 84, decision: 'Approve' },
                { grade: 'B+', min_score: 65, max_score: 74, decision: 'Refer to Credit Committee' },
                { grade: 'B', min_score: 55, max_score: 64, decision: 'Refer to Credit Committee' },
                { grade: 'C', min_score: 45, max_score: 54, decision: 'Decline' },
                { grade: 'D', min_score: 0, max_score: 44, decision: 'Decline' }
            ],
            limit_params: [
                { param_code: 'STOCK_MARGIN', param_value: 75, param_unit: 'percentage' },
                { param_code: 'DEBTOR_MARGIN', param_value: 60, param_unit: 'percentage' },
                { param_code: 'OD_TURNOVER_PCT', param_value: 10, param_unit: 'percentage' },
                { param_code: 'TARGET_DSCR', param_value: 1.5, param_unit: 'times' },
                { param_code: 'TL_TENURE', param_value: 60, param_unit: 'months' },
                { param_code: 'PRINCIPAL_PCT', param_value: 20, param_unit: 'percentage' }
            ]
        };
    }

    /**
     * Get policy rule by parameter name
     */
    getPolicyRule(parameterName) {
        const rules = this.config.policy_rules || [];
        const rule = rules.find(r => 
            r.parameter === parameterName || 
            r.rule_name === parameterName ||
            r.parameter?.toLowerCase().includes(parameterName.toLowerCase())
        );
        if (rule) {
            return {
                value: rule.current_value || rule.threshold_value,
                operator: rule.norm_operator || rule.operator || '>=',
                display: rule.norm_display || `${rule.operator || '>='} ${rule.current_value || rule.threshold_value}`,
                clause_ref: rule.clause_ref
            };
        }
        return null;
    }

    /**
     * Get scoring weight by category code
     */
    getScoringWeight(categoryCode) {
        const weights = this.config.scoring_weights || [];
        const weight = weights.find(w => w.category_code === categoryCode);
        return weight ? weight.max_score : 0;
    }

    /**
     * Get scoring metric by metric code
     */
    getScoringMetric(metricCode) {
        const metrics = this.config.scoring_metrics || [];
        return metrics.find(m => m.metric_code === metricCode);
    }

    /**
     * Evaluate a value against a scoring metric and return the score
     */
    evaluateMetric(value, metricCode) {
        const metric = this.getScoringMetric(metricCode);
        if (!metric) return { score: 0, max: 0, logic: 'Metric not found' };

        const { threshold_1, score_1, threshold_2, score_2, threshold_3, score_3, default_score, comparison_type, max_score } = metric;
        
        let score = default_score;
        let logic = '';

        if (comparison_type === 'higher_better') {
            if (value > threshold_1) score = score_1;
            else if (value > threshold_2) score = score_2;
            else if (value > threshold_3) score = score_3;
            logic = `>${threshold_1}=${score_1}, >${threshold_2}=${score_2}, >${threshold_3}=${score_3}, else ${default_score}`;
        } else {
            // lower_better
            if (value < threshold_1) score = score_1;
            else if (value < threshold_2) score = score_2;
            else if (value < threshold_3) score = score_3;
            logic = `<${threshold_1}=${score_1}, <${threshold_2}=${score_2}, <${threshold_3}=${score_3}, else ${default_score}`;
        }

        return { score, max: max_score, logic };
    }

    /**
     * Get grade and decision for a score
     */
    getScoringGrade(score) {
        const grades = this.config.scoring_grades || [];
        const grade = grades.find(g => score >= g.min_score && score <= g.max_score);
        if (grade) {
            return { grade: grade.grade, decision: grade.decision, color: grade.color_code };
        }
        return { grade: 'F', decision: 'REJECTED', color: '#dc2626' };
    }

    /**
     * Get limit parameter by code
     */
    getLimitParam(paramCode) {
        const params = this.config.limit_params || [];
        const param = params.find(p => p.param_code === paramCode);
        return param ? param.param_value : null;
    }

    /**
     * Check if value passes policy rule
     */
    checkPolicyCompliance(value, parameterName) {
        const rule = this.getPolicyRule(parameterName);
        if (!rule) return { status: 'warn', norm: 'N/A' };

        const threshold = rule.value;
        const operator = rule.operator;
        let passes = false;

        switch (operator) {
            case '>=': passes = value >= threshold; break;
            case '<=': passes = value <= threshold; break;
            case '>': passes = value > threshold; break;
            case '<': passes = value < threshold; break;
            case '=': passes = value === threshold; break;
            default: passes = value >= threshold;
        }

        return { 
            status: passes ? 'pass' : 'fail', 
            norm: rule.display,
            clause_ref: rule.clause_ref
        };
    }

    /**
     * Format number in Indian currency format: ₹24,97,000
     */
    formatINR(num) {
        if (num === null || num === undefined || isNaN(num) || num === 0) return '₹0';
        const absNum = Math.abs(Math.round(num));
        let x = absNum.toString();
        let lastThree = x.substring(x.length - 3);
        let otherNumbers = x.substring(0, x.length - 3);
        if (otherNumbers !== '') lastThree = ',' + lastThree;
        const formatted = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + lastThree;
        return (num < 0 ? '-₹' : '₹') + formatted;
    }

    safeDivide(num, den) {
        if (!den || den === 0) return 0;
        return num / den;
    }
    
    /**
     * Safe divide with negative value handling
     * For ratios where negative denominator makes result meaningless
     */
    safeDividePositive(num, den) {
        if (!den || den === 0) return 0;
        // If denominator is negative, the ratio is meaningless (e.g., D/E with negative net worth)
        if (den < 0) return null;
        return num / den;
    }
    
    /**
     * Check if a value indicates a loss/negative situation
     */
    isNegativeOrLoss(value) {
        return value !== null && value !== undefined && value < 0;
    }

    round2(num) {
        if (num === null || num === undefined || isNaN(num)) return 0;
        return Math.round(num * 100) / 100;
    }

    /**
     * Calculate all metrics for an assessment
     * @param {Object} extractedData - All extracted data including financial, bank, GST, ITR, KYC, property
     */
    calculateAll(extractedData) {
        const bs = extractedData.balance_sheet || {};
        const pnl = extractedData.profit_and_loss || {};
        
        // Fix: Support multiple field names for bank data
        const bankData = extractedData.bank_aggregated || 
                         extractedData.bank_data || 
                         extractedData.bank_statements?.aggregated || 
                         null;
        
        // Fix: Support multiple field names for GST data
        const gstData = extractedData.gst_aggregated || 
                        extractedData.gst_data || 
                        extractedData.gst_returns?.aggregated || 
                        null;
        
        const itrData = extractedData.itr_returns || extractedData.itr_data || null;
        
        // Fix: Support multiple field names for KYC data
        const kycData = extractedData.kyc_documents || 
                        extractedData.kyc || 
                        extractedData.company_info ||
                        null;
        
        // Fix: Support multiple field names for property data
        const propertyData = extractedData.property_documents || 
                             extractedData.property || 
                             extractedData.collateral ||
                             extractedData.legal_risk_assessment ||
                             null;
        
        const bsFY25 = bs.fy25 || {};
        const bsFY24 = bs.fy24 || {};
        const pnlFY25 = pnl.fy25 || {};
        const pnlFY24 = pnl.fy24 || {};
        const pnlFY23 = pnl.fy23 || {};

        // CAM eligibility (only computed when CAM input is supplied on the assessment)
        const camInput = extractedData.cam_input || null;
        let camEligibility = null;
        if (camInput && camInput.program) {
            try {
                camEligibility = this.calculateCamEligibility(camInput);
            } catch (err) {
                camEligibility = { error: err.message, program: camInput.program };
            }
        }

        return {
            liquidity: this.calcLiquidity(bsFY25),
            leverage: this.calcLeverage(bsFY25, pnlFY25),
            profitability: this.calcProfitability(bsFY25, pnlFY25),
            efficiency: this.calcEfficiency(bsFY25, pnlFY25),
            growth: this.calcGrowth(pnlFY25, pnlFY24, pnlFY23, bsFY25, bsFY24),
            banking: this.calcBankingConduct(bankData),
            gst_compliance: this.calcGSTCompliance(gstData, pnlFY25),
            business_vintage: this.calcBusinessVintage(kycData),
            collateral: this.calcCollateral(propertyData),
            credit_score: this.calcCreditScore(bsFY25, pnlFY25, pnlFY24, bankData, gstData, kycData, propertyData),
            cam_eligibility: camEligibility
        };
    }

    /**
     * Calculate banking conduct metrics
     */
    calcBankingConduct(bankData) {
        if (!bankData) {
            return {
                available: false,
                note: 'Bank statements not uploaded'
            };
        }

        const avgBal = bankData.average_balance || 0;
        const chequeReturnRate = bankData.cheque_return_rate || 0;
        const monthlyCredits = bankData.average_monthly_credits || 0;
        const monthlyDebits = bankData.average_monthly_debits || 0;
        const monthlyEMI = bankData.monthly_emi_total || 0;

        return {
            available: true,
            average_balance: {
                name: 'Average Bank Balance',
                value: avgBal,
                value_display: this.formatINR(avgBal),
                status: avgBal > 500000 ? 'pass' : avgBal > 100000 ? 'warn' : 'fail',
                policy_norm: '> ₹5 Lakhs'
            },
            cheque_returns: {
                name: 'Cheque Return Rate',
                value: chequeReturnRate,
                value_display: this.round2(chequeReturnRate) + '%',
                status: chequeReturnRate < 2 ? 'pass' : chequeReturnRate < 5 ? 'warn' : 'fail',
                policy_norm: '< 2%'
            },
            cash_flow: {
                name: 'Monthly Cash Flow',
                credits: this.formatINR(monthlyCredits),
                debits: this.formatINR(monthlyDebits),
                net: this.formatINR(monthlyCredits - monthlyDebits),
                status: monthlyCredits > monthlyDebits ? 'pass' : 'warn'
            },
            emi_burden: {
                name: 'Monthly EMI Burden',
                value: monthlyEMI,
                value_display: this.formatINR(monthlyEMI),
                ratio: this.round2(this.safeDivide(monthlyEMI, monthlyCredits) * 100) + '%',
                status: this.safeDivide(monthlyEMI, monthlyCredits) < 0.5 ? 'pass' : 'warn'
            },
            months_analyzed: bankData.period_months || 0
        };
    }

    /**
     * Calculate GST compliance metrics
     */
    calcGSTCompliance(gstData, pnl) {
        if (!gstData) {
            return {
                available: false,
                note: 'GST returns not uploaded'
            };
        }

        const gstTurnover = gstData.total_turnover || 0;
        const pnlRevenue = pnl.revenue || 0;
        const complianceRate = gstData.compliance_rate || 0;
        const turnoverMatch = pnlRevenue > 0 ? (gstTurnover / pnlRevenue) * 100 : 0;

        return {
            available: true,
            gstin: gstData.gstin,
            compliance_rate: {
                name: 'Filing Compliance',
                value: complianceRate,
                value_display: this.round2(complianceRate) + '%',
                returns_filed: gstData.filed_count,
                total_returns: gstData.returns_count,
                status: complianceRate === 100 ? 'pass' : complianceRate >= 90 ? 'warn' : 'fail',
                policy_norm: '100%'
            },
            turnover_match: {
                name: 'GST vs P&L Turnover Match',
                gst_turnover: this.formatINR(gstTurnover),
                pnl_revenue: this.formatINR(pnlRevenue),
                match_percent: this.round2(turnoverMatch) + '%',
                status: turnoverMatch > 90 && turnoverMatch < 110 ? 'pass' : turnoverMatch > 80 ? 'warn' : 'fail',
                policy_norm: '90-110%'
            },
            tax_paid: {
                name: 'Total GST Paid',
                value: this.formatINR(gstData.total_tax_paid || 0)
            }
        };
    }

    /**
     * Calculate business vintage from KYC
     */
    calcBusinessVintage(kycData) {
        // Handle multiple data structures
        let coi = null;
        let incDate = null;
        
        if (kycData) {
            // Try various paths to find COI/incorporation data
            coi = kycData.coi || 
                  kycData.certificate_of_incorporation ||
                  kycData;
            
            // Try various field names for incorporation date
            incDate = coi?.date_of_incorporation || 
                      coi?.incorporation_date ||
                      kycData?.date_of_incorporation ||
                      kycData?.incorporation_date ||
                      kycData?.company_info?.incorporation_date;
        }
        
        if (!kycData || !incDate) {
            return {
                available: false,
                note: 'KYC documents not uploaded or incorporation date not found'
            };
        }

        let vintageYears = 0;
        
        if (incDate) {
            // Try to parse various date formats
            let incDateParsed;
            if (typeof incDate === 'string') {
                // Handle formats like "15th March 2018", "15/03/2018", "2018-03-15"
                incDateParsed = new Date(incDate.replace(/(\d+)(st|nd|rd|th)/g, '$1'));
            } else {
                incDateParsed = new Date(incDate);
            }
            
            if (!isNaN(incDateParsed.getTime())) {
                const now = new Date();
                vintageYears = (now - incDateParsed) / (365.25 * 24 * 60 * 60 * 1000);
            }
        }

        return {
            available: true,
            company_name: coi?.company_name || kycData?.company_name,
            cin: coi?.cin || kycData?.cin,
            incorporation_date: incDate,
            vintage_years: this.round2(vintageYears),
            vintage_status: vintageYears >= 3 ? 'pass' : vintageYears >= 2 ? 'warn' : 'fail',
            policy_norm: '≥ 3 years',
            paid_up_capital: this.formatINR(coi?.paid_up_capital || kycData?.paid_up_capital || 0),
            directors: coi.directors || []
        };
    }

    /**
     * Calculate collateral coverage
     */
    calcCollateral(propertyData) {
        if (!propertyData || Object.keys(propertyData).length === 0) {
            return {
                available: false,
                note: 'Property documents not uploaded'
            };
        }

        // Handle multiple data structures
        let valuation = propertyData.prop_valuation || 
                        propertyData.valuation || 
                        propertyData.valuation_report ||
                        propertyData;
        
        let title = propertyData.prop_title || 
                    propertyData.title_deed || 
                    propertyData.sale_deed ||
                    propertyData;
        
        let enc = propertyData.prop_enc || 
                  propertyData.encumbrance_certificate || 
                  propertyData.ec ||
                  propertyData;

        // For legal_risk_assessment structure (from Legal Agent)
        if (propertyData.properties && propertyData.properties.length > 0) {
            const prop = propertyData.properties[0];
            valuation = prop;
            title = prop;
            enc = prop.encumbrance_analysis || {};
        }

        // Try multiple field names for market value
        const marketValue = valuation?.market_value || 
                           valuation?.total_market_value ||
                           title?.registration_value || 
                           title?.consideration_amount ||
                           title?.sale_value ||
                           0;
        
        // Try multiple field names for encumbrance status
        const encStatus = enc?.encumbrance_status || 
                         enc?.status ||
                         (enc?.has_adverse_entries === false ? 'Clear' : 
                          enc?.has_adverse_entries === true ? 'Encumbered' : 'Unknown');
        
        const existingMortgage = valuation?.existing_mortgage || 
                                 valuation?.prior_charges ||
                                 0;
        const clearValue = marketValue - existingMortgage;

        return {
            available: marketValue > 0,
            property_type: valuation?.property_type || title?.property_type,
            property_address: valuation?.property_address || title?.property_address,
            market_value: {
                name: 'Market Value',
                value: marketValue,
                value_display: this.formatINR(marketValue)
            },
            existing_mortgage: {
                name: 'Existing Mortgage',
                value: existingMortgage,
                value_display: this.formatINR(existingMortgage)
            },
            clear_value: {
                name: 'Clear Value',
                value: clearValue,
                value_display: this.formatINR(clearValue)
            },
            encumbrance: {
                name: 'Encumbrance Status',
                status: encStatus,
                is_clear: encStatus === 'Clear' || encStatus === 'Nil',
                policy_norm: 'Clear title'
            }
        };
    }

    calcLiquidity(bs) {
        const ca = bs.current_assets || 0;
        const inv = bs.inventory || 0;
        const cash = bs.cash_bank || 0;
        const stb = bs.short_term_borrowings || 0;
        const tp = bs.trade_payables || 0;
        const ocl = bs.other_current_liabilities || 0;
        const cl = stb + tp + ocl;
        
        // Derivation details for Current Liabilities (Issue 5 fix)
        const clDerivation = {
            name: 'Current Liabilities',
            formula: 'Short Term Borrowings + Trade Payables + Other Current Liabilities',
            components: [
                { label: 'Short Term Borrowings', value: stb, formatted: this.formatINR(stb) },
                { label: 'Trade Payables', value: tp, formatted: this.formatINR(tp) },
                { label: 'Other Current Liabilities', value: ocl, formatted: this.formatINR(ocl) }
            ],
            result: cl,
            result_formatted: this.formatINR(cl)
        };

        // Get policy norms from config
        const crCompliance = this.checkPolicyCompliance(this.safeDivide(ca, cl), 'Current Ratio');
        const qrCompliance = this.checkPolicyCompliance(this.safeDivide(ca - inv, cl), 'Quick Ratio');
        const cashCompliance = this.checkPolicyCompliance(this.safeDivide(cash, cl), 'Cash Ratio');

        return {
            current_ratio: {
                name: 'Current Ratio',
                formula: 'Current Assets ÷ Current Liabilities',
                numerator: { label: 'Current Assets', value: ca, formatted: this.formatINR(ca) },
                denominator: { label: 'Current Liabilities', value: cl, formatted: this.formatINR(cl), derivation: clDerivation },
                result: this.round2(this.safeDivide(ca, cl)),
                result_display: this.round2(this.safeDivide(ca, cl)).toString(),
                policy_norm: crCompliance.norm,
                status: crCompliance.status,
                clause_ref: crCompliance.clause_ref
            },
            quick_ratio: {
                name: 'Quick Ratio (Acid Test)',
                formula: '(Current Assets - Inventory) ÷ Current Liabilities',
                numerator: { label: 'Current Assets - Inventory', value: ca - inv, formatted: this.formatINR(ca - inv) },
                denominator: { label: 'Current Liabilities', value: cl, formatted: this.formatINR(cl), derivation: clDerivation },
                result: this.round2(this.safeDivide(ca - inv, cl)),
                result_display: this.round2(this.safeDivide(ca - inv, cl)).toString(),
                policy_norm: qrCompliance.norm,
                status: qrCompliance.status,
                clause_ref: qrCompliance.clause_ref
            },
            cash_ratio: {
                name: 'Cash Ratio',
                formula: 'Cash & Bank ÷ Current Liabilities',
                numerator: { label: 'Cash & Bank', value: cash, formatted: this.formatINR(cash) },
                denominator: { label: 'Current Liabilities', value: cl, formatted: this.formatINR(cl), derivation: clDerivation },
                result: this.round2(this.safeDivide(cash, cl)),
                result_display: this.round2(this.safeDivide(cash, cl)).toString(),
                policy_norm: cashCompliance.norm,
                status: cashCompliance.status,
                clause_ref: cashCompliance.clause_ref
            }
        };
    }

    calcLeverage(bs, pnl) {
        const ltDebt = bs.long_term_borrowings || 0;
        const stDebt = bs.short_term_borrowings || 0;
        const totalDebt = ltDebt + stDebt;
        const nw = bs.net_worth || 0;
        const ta = bs.total_assets || 0;
        const ebit = pnl.ebit || 0;
        const interest = pnl.interest_expense || 0;
        const pat = pnl.profit_after_tax || 0;
        const dep = pnl.depreciation || 0;
        const tol = ta - nw;
        
        // Check for negative/loss situations
        const isNetWorthNegative = nw < 0;
        const isLossMaking = pat < 0;
        const isEbitNegative = ebit < 0;
        
        // Get principal percentage from config
        const principalPct = (this.getLimitParam('PRINCIPAL_PCT') || 20) / 100;
        const principal = totalDebt * principalPct;
        
        // Derivation details for Total Debt (Issue 5 fix)
        const totalDebtDerivation = {
            name: 'Total Debt',
            formula: 'Long Term Borrowings + Short Term Borrowings',
            components: [
                { label: 'Long Term Borrowings', value: ltDebt, formatted: this.formatINR(ltDebt) },
                { label: 'Short Term Borrowings', value: stDebt, formatted: this.formatINR(stDebt) }
            ],
            result: totalDebt,
            result_formatted: this.formatINR(totalDebt)
        };
        
        // Derivation details for TOL
        const tolDerivation = {
            name: 'Total Outside Liabilities',
            formula: 'Total Assets - Net Worth',
            components: [
                { label: 'Total Assets', value: ta, formatted: this.formatINR(ta) },
                { label: 'Net Worth (subtract)', value: nw, formatted: this.formatINR(nw) }
            ],
            result: tol,
            result_formatted: this.formatINR(tol)
        };

        // Get policy compliance from config
        const deCompliance = this.checkPolicyCompliance(this.safeDivide(totalDebt, nw), 'Debt to Equity');
        const icrCompliance = this.checkPolicyCompliance(this.safeDivide(ebit, interest), 'Interest Coverage');
        const dscrCompliance = this.checkPolicyCompliance(this.safeDivide(pat + dep + interest, interest + principal), 'DSCR');
        const tolCompliance = this.checkPolicyCompliance(this.safeDivide(tol, nw), 'TOL/TNW');

        // Calculate D/E - handle negative net worth
        let deResult = this.round2(this.safeDivide(totalDebt, nw));
        let deDisplay = deResult.toString();
        let deStatus = deCompliance.status;
        let deNote = null;
        
        if (isNetWorthNegative) {
            deResult = null;
            deDisplay = 'N/A (Negative Net Worth)';
            deStatus = 'fail';
            deNote = '⚠️ Net Worth is negative due to accumulated losses - D/E ratio not meaningful';
        }
        
        // Calculate ICR - handle negative EBIT
        let icrResult = this.round2(this.safeDivide(ebit, interest));
        let icrDisplay = icrResult + 'x';
        let icrStatus = icrCompliance.status;
        let icrNote = interest === 0 ? 'No interest expense reported' : null;
        
        if (isEbitNegative) {
            icrDisplay = icrResult + 'x (Negative)';
            icrStatus = 'fail';
            icrNote = '⚠️ EBIT is negative - company has operating loss';
        }
        
        // Calculate DSCR - handle negative PAT (loss)
        const dscrNumerator = pat + dep + interest;
        let dscrResult = this.round2(this.safeDivide(dscrNumerator, interest + principal));
        let dscrDisplay = dscrResult + 'x';
        let dscrStatus = dscrCompliance.status;
        let dscrNote = `Principal estimated as ${principalPct*100}% of total debt`;
        
        if (isLossMaking) {
            dscrNote = `⚠️ Company is loss-making (PAT: ${this.formatINR(pat)}). DSCR may be understated. ${dscrNote}`;
            if (dscrResult < 1) {
                dscrStatus = 'fail';
            }
        }
        
        // Calculate TOL/TNW - handle negative net worth
        let tolResult = this.round2(this.safeDivide(tol, nw));
        let tolDisplay = tolResult.toString();
        let tolStatus = tolCompliance.status;
        let tolNote = null;
        
        if (isNetWorthNegative) {
            tolResult = null;
            tolDisplay = 'N/A (Negative Net Worth)';
            tolStatus = 'fail';
            tolNote = '⚠️ Net Worth is negative - TOL/TNW ratio not meaningful';
        }

        return {
            debt_equity: {
                name: 'Debt to Equity Ratio',
                formula: 'Total Debt ÷ Net Worth',
                numerator: { label: 'Total Debt (LT + ST)', value: totalDebt, formatted: this.formatINR(totalDebt), derivation: totalDebtDerivation },
                denominator: { label: 'Net Worth', value: nw, formatted: this.formatINR(nw), is_negative: isNetWorthNegative },
                result: deResult,
                result_display: deDisplay,
                policy_norm: deCompliance.norm,
                status: deStatus,
                clause_ref: deCompliance.clause_ref,
                note: deNote,
                warning: isNetWorthNegative ? 'negative_net_worth' : null
            },
            interest_coverage: {
                name: 'Interest Coverage Ratio (ICR)',
                formula: 'EBIT ÷ Interest Expense',
                numerator: { label: 'EBIT', value: ebit, formatted: this.formatINR(ebit), is_negative: isEbitNegative },
                denominator: { label: 'Interest Expense', value: interest, formatted: this.formatINR(interest) },
                result: icrResult,
                result_display: icrDisplay,
                policy_norm: icrCompliance.norm,
                status: icrStatus,
                clause_ref: icrCompliance.clause_ref,
                note: icrNote,
                warning: isEbitNegative ? 'negative_ebit' : null
            },
            dscr: {
                name: 'Debt Service Coverage Ratio (DSCR)',
                formula: '(PAT + Depreciation + Interest) ÷ (Interest + Principal)',
                numerator: { label: 'PAT + Dep + Interest', value: dscrNumerator, formatted: this.formatINR(dscrNumerator), is_loss: isLossMaking },
                denominator: { label: `Interest + Principal (${principalPct*100}% of debt)`, value: interest + principal, formatted: this.formatINR(interest + principal) },
                result: dscrResult,
                result_display: dscrDisplay,
                policy_norm: dscrCompliance.norm,
                status: dscrStatus,
                clause_ref: dscrCompliance.clause_ref,
                note: dscrNote,
                warning: isLossMaking ? 'loss_making' : null
            },
            tol_tnw: {
                name: 'TOL/TNW',
                formula: 'Total Outside Liabilities ÷ Tangible Net Worth',
                numerator: { label: 'TOL (Total Assets - Net Worth)', value: tol, formatted: this.formatINR(tol), derivation: tolDerivation },
                denominator: { label: 'TNW (Net Worth)', value: nw, formatted: this.formatINR(nw), is_negative: isNetWorthNegative },
                result: tolResult,
                result_display: tolDisplay,
                policy_norm: tolCompliance.norm,
                status: tolStatus,
                clause_ref: tolCompliance.clause_ref,
                note: tolNote,
                warning: isNetWorthNegative ? 'negative_net_worth' : null
            }
        };
    }

    calcProfitability(bs, pnl) {
        const rev = pnl.revenue || 0;
        const gp = pnl.gross_profit || 0;
        const ebitda = pnl.ebitda || 0;
        const pat = pnl.profit_after_tax || 0;
        const nw = bs.net_worth || 0;
        const ta = bs.total_assets || 0;
        
        // Check for negative/loss situations
        const isLossMaking = pat < 0;
        const isNetWorthNegative = nw < 0;
        const isGrossLoss = gp < 0;
        const isEbitdaNegative = ebitda < 0;

        // Get policy compliance from config
        const gpCompliance = this.checkPolicyCompliance(this.safeDivide(gp, rev) * 100, 'Gross Profit Margin');
        const ebitdaCompliance = this.checkPolicyCompliance(this.safeDivide(ebitda, rev) * 100, 'EBITDA Margin');
        const npmCompliance = this.checkPolicyCompliance(this.safeDivide(pat, rev) * 100, 'Net Profit Margin');
        const roeCompliance = this.checkPolicyCompliance(this.safeDivide(pat, nw) * 100, 'Return on Equity');
        const roaCompliance = this.checkPolicyCompliance(this.safeDivide(pat, ta) * 100, 'Return on Assets');
        
        // Calculate margins with negative handling
        const gpMargin = this.round2(this.safeDivide(gp, rev) * 100);
        const ebitdaMargin = this.round2(this.safeDivide(ebitda, rev) * 100);
        const netMargin = this.round2(this.safeDivide(pat, rev) * 100);
        const roe = this.round2(this.safeDivide(pat, nw) * 100);
        const roa = this.round2(this.safeDivide(pat, ta) * 100);
        
        // ROE special handling for negative net worth
        let roeResult = roe;
        let roeDisplay = roe + '%';
        let roeStatus = roeCompliance.status;
        let roeNote = null;
        
        if (isNetWorthNegative) {
            roeResult = null;
            roeDisplay = 'N/A (Negative Net Worth)';
            roeStatus = 'fail';
            roeNote = '⚠️ Net Worth is negative - ROE not meaningful';
        } else if (isLossMaking) {
            roeDisplay = roe + '% (Loss)';
            roeStatus = 'fail';
            roeNote = '⚠️ Company is loss-making';
        }

        return {
            gross_margin: {
                name: 'Gross Profit Margin',
                formula: 'Gross Profit ÷ Revenue × 100',
                numerator: { label: 'Gross Profit', value: gp, formatted: this.formatINR(gp), is_negative: isGrossLoss },
                denominator: { label: 'Revenue', value: rev, formatted: this.formatINR(rev) },
                result: gpMargin,
                result_display: gpMargin + '%' + (isGrossLoss ? ' (Loss)' : ''),
                policy_norm: gpCompliance.norm,
                status: isGrossLoss ? 'fail' : gpCompliance.status,
                clause_ref: gpCompliance.clause_ref,
                note: isGrossLoss ? '⚠️ Gross Loss indicates COGS exceeds Revenue' : null,
                warning: isGrossLoss ? 'gross_loss' : null
            },
            ebitda_margin: {
                name: 'EBITDA Margin',
                formula: 'EBITDA ÷ Revenue × 100',
                numerator: { label: 'EBITDA', value: ebitda, formatted: this.formatINR(ebitda), is_negative: isEbitdaNegative },
                denominator: { label: 'Revenue', value: rev, formatted: this.formatINR(rev) },
                result: ebitdaMargin,
                result_display: ebitdaMargin + '%' + (isEbitdaNegative ? ' (Negative)' : ''),
                policy_norm: ebitdaCompliance.norm,
                status: isEbitdaNegative ? 'fail' : ebitdaCompliance.status,
                clause_ref: ebitdaCompliance.clause_ref,
                note: isEbitdaNegative ? '⚠️ Negative EBITDA indicates operating loss before depreciation' : null,
                warning: isEbitdaNegative ? 'negative_ebitda' : null
            },
            net_margin: {
                name: 'Net Profit Margin (PAT Margin)',
                formula: 'PAT ÷ Revenue × 100',
                numerator: { label: 'PAT', value: pat, formatted: this.formatINR(pat), is_negative: isLossMaking },
                denominator: { label: 'Revenue', value: rev, formatted: this.formatINR(rev) },
                result: netMargin,
                result_display: netMargin + '%' + (isLossMaking ? ' (Loss)' : ''),
                policy_norm: npmCompliance.norm,
                status: isLossMaking ? 'fail' : npmCompliance.status,
                clause_ref: npmCompliance.clause_ref,
                note: isLossMaking ? '⚠️ Company is loss-making (Net Loss)' : null,
                warning: isLossMaking ? 'net_loss' : null
            },
            roe: {
                name: 'Return on Equity (ROE)',
                formula: 'PAT ÷ Net Worth × 100',
                numerator: { label: 'PAT', value: pat, formatted: this.formatINR(pat), is_negative: isLossMaking },
                denominator: { label: 'Net Worth', value: nw, formatted: this.formatINR(nw), is_negative: isNetWorthNegative },
                result: roeResult,
                result_display: roeDisplay,
                policy_norm: roeCompliance.norm,
                status: roeStatus,
                clause_ref: roeCompliance.clause_ref,
                note: roeNote,
                warning: isNetWorthNegative ? 'negative_net_worth' : (isLossMaking ? 'loss_making' : null)
            },
            roa: {
                name: 'Return on Assets (ROA)',
                formula: 'PAT ÷ Total Assets × 100',
                numerator: { label: 'PAT', value: pat, formatted: this.formatINR(pat), is_negative: isLossMaking },
                denominator: { label: 'Total Assets', value: ta, formatted: this.formatINR(ta) },
                result: roa,
                result_display: roa + '%' + (isLossMaking ? ' (Loss)' : ''),
                policy_norm: roaCompliance.norm,
                status: isLossMaking ? 'fail' : roaCompliance.status,
                clause_ref: roaCompliance.clause_ref,
                note: isLossMaking ? '⚠️ Company is loss-making' : null,
                warning: isLossMaking ? 'loss_making' : null
            }
        };
    }

    calcEfficiency(bs, pnl) {
        const inv = bs.inventory || 0;
        const recv = bs.trade_receivables || 0;
        const pay = bs.trade_payables || 0;
        const rev = pnl.revenue || 0;
        const cogs = pnl.cost_of_goods_sold || 0;

        const invDays = this.round2(this.safeDivide(inv, cogs) * 365);
        const recvDays = this.round2(this.safeDivide(recv, rev) * 365);
        const payDays = this.round2(this.safeDivide(pay, cogs) * 365);
        const cashCycle = invDays + recvDays - payDays;

        return {
            inventory_days: {
                name: 'Inventory Days',
                formula: 'Inventory ÷ COGS × 365',
                numerator: { label: 'Inventory', value: inv, formatted: this.formatINR(inv) },
                denominator: { label: 'COGS', value: cogs, formatted: this.formatINR(cogs) },
                result: invDays,
                result_display: invDays + ' days',
                policy_norm: '< 90 days',
                status: invDays < 90 ? 'pass' : 'warn'
            },
            receivable_days: {
                name: 'Receivable Days (DSO)',
                formula: 'Trade Receivables ÷ Revenue × 365',
                numerator: { label: 'Receivables', value: recv, formatted: this.formatINR(recv) },
                denominator: { label: 'Revenue', value: rev, formatted: this.formatINR(rev) },
                result: recvDays,
                result_display: recvDays + ' days',
                policy_norm: '< 60 days',
                status: recvDays < 60 ? 'pass' : 'warn'
            },
            payable_days: {
                name: 'Payable Days (DPO)',
                formula: 'Trade Payables ÷ COGS × 365',
                numerator: { label: 'Payables', value: pay, formatted: this.formatINR(pay) },
                denominator: { label: 'COGS', value: cogs, formatted: this.formatINR(cogs) },
                result: payDays,
                result_display: payDays + ' days',
                policy_norm: '< 60 days',
                status: payDays < 60 ? 'pass' : 'ok'
            },
            cash_cycle: {
                name: 'Cash Conversion Cycle',
                formula: 'Inventory Days + Receivable Days - Payable Days',
                components: `${invDays} + ${recvDays} - ${payDays}`,
                result: this.round2(cashCycle),
                result_display: this.round2(cashCycle) + ' days',
                policy_norm: '< 90 days',
                status: cashCycle < 90 ? 'pass' : 'warn',
                note: 'Lower is better'
            }
        };
    }

    calcGrowth(pnlFY25, pnlFY24, pnlFY23, bsFY25, bsFY24) {
        const revFY25 = pnlFY25.revenue || 0;
        const revFY24 = pnlFY24.revenue || 0;
        const revFY23 = pnlFY23.revenue || 0;
        const patFY25 = pnlFY25.profit_after_tax || 0;
        const patFY24 = pnlFY24.profit_after_tax || 0;
        const nwFY25 = bsFY25.net_worth || 0;
        const nwFY24 = bsFY24.net_worth || 0;

        const revGrowth = this.safeDivide(revFY25 - revFY24, revFY24) * 100;
        const patGrowth = this.safeDivide(patFY25 - patFY24, patFY24) * 100;
        const nwGrowth = this.safeDivide(nwFY25 - nwFY24, nwFY24) * 100;
        const cagr = revFY23 > 0 ? (Math.pow(revFY25 / revFY23, 0.5) - 1) * 100 : 0;

        return {
            revenue_growth: {
                name: 'Revenue Growth (YoY)',
                formula: '(FY25 Revenue - FY24 Revenue) ÷ FY24 Revenue × 100',
                numerator: { label: 'Change', value: revFY25 - revFY24, formatted: this.formatINR(revFY25 - revFY24) },
                denominator: { label: 'FY24 Revenue', value: revFY24, formatted: this.formatINR(revFY24) },
                result: this.round2(revGrowth),
                result_display: this.round2(revGrowth) + '%',
                policy_norm: '> 10%',
                status: revGrowth > 10 ? 'pass' : revGrowth > 0 ? 'warn' : 'fail'
            },
            pat_growth: {
                name: 'PAT Growth (YoY)',
                formula: '(FY25 PAT - FY24 PAT) ÷ FY24 PAT × 100',
                numerator: { label: 'Change', value: patFY25 - patFY24, formatted: this.formatINR(patFY25 - patFY24) },
                denominator: { label: 'FY24 PAT', value: patFY24, formatted: this.formatINR(patFY24) },
                result: this.round2(patGrowth),
                result_display: this.round2(patGrowth) + '%',
                policy_norm: '> 0%',
                status: patGrowth > 0 ? 'pass' : 'fail'
            },
            networth_growth: {
                name: 'Net Worth Growth (YoY)',
                formula: '(FY25 NW - FY24 NW) ÷ FY24 NW × 100',
                numerator: { label: 'Change', value: nwFY25 - nwFY24, formatted: this.formatINR(nwFY25 - nwFY24) },
                denominator: { label: 'FY24 Net Worth', value: nwFY24, formatted: this.formatINR(nwFY24) },
                result: this.round2(nwGrowth),
                result_display: this.round2(nwGrowth) + '%',
                policy_norm: '> 0%',
                status: nwGrowth > 0 ? 'pass' : 'fail'
            },
            revenue_cagr: {
                name: 'Revenue CAGR (2 Year)',
                formula: '((FY25 ÷ FY23) ^ 0.5) - 1 × 100',
                values: { fy25: this.formatINR(revFY25), fy23: this.formatINR(revFY23) },
                result: this.round2(cagr),
                result_display: this.round2(cagr) + '%',
                policy_norm: '> 10%',
                status: cagr > 10 ? 'pass' : cagr > 0 ? 'warn' : 'fail',
                note: revFY23 === 0 ? 'FY23 data not available' : null
            }
        };
    }

    calcCreditScore(bs, pnlFY25, pnlFY24, bankData, gstData, kycData, propertyData) {
        const ca = bs.current_assets || 0;
        const cl = (bs.short_term_borrowings || 0) + (bs.trade_payables || 0) + (bs.other_current_liabilities || 0);
        const totalDebt = (bs.long_term_borrowings || 0) + (bs.short_term_borrowings || 0);
        const nw = bs.net_worth || 0;
        const ebit = pnlFY25.ebit || 0;
        const interest = pnlFY25.interest_expense || 0;
        const pat = pnlFY25.profit_after_tax || 0;
        const rev = pnlFY25.revenue || 0;
        const revPrev = pnlFY24.revenue || 0;
        const patPrev = pnlFY24.profit_after_tax || 0;

        const cr = this.safeDivide(ca, cl);
        const de = this.safeDivide(totalDebt, nw);
        const icr = this.safeDivide(ebit, interest);
        const npm = this.safeDivide(pat, rev) * 100;
        const roe = this.safeDivide(pat, nw) * 100;
        const revGr = this.safeDivide(rev - revPrev, revPrev) * 100;

        // Get category weights from config
        const fsMax = this.getScoringWeight('FINANCIAL') || 35;
        const bcMax = this.getScoringWeight('BANKING') || 20;
        const chMax = this.getScoringWeight('CREDIT_HISTORY') || 15;
        const bstMax = this.getScoringWeight('BUSINESS') || 15;
        const scMax = this.getScoringWeight('SECURITY') || 15;

        // Financial Strength - using config metrics
        const crScore = this.evaluateMetric(cr, 'CURRENT_RATIO');
        const deScore = this.evaluateMetric(de, 'DEBT_EQUITY');
        const icrScore = this.evaluateMetric(icr, 'INTEREST_COVERAGE');
        const npmScore = this.evaluateMetric(npm, 'NET_MARGIN');
        const roeScore = this.evaluateMetric(roe, 'ROE');

        const fs = {
            name: 'Financial Strength', max: fsMax,
            breakdown: [
                { metric: 'Current Ratio', value: this.round2(cr), score: crScore.score, max: crScore.max, logic: crScore.logic },
                { metric: 'Debt/Equity', value: this.round2(de), score: deScore.score, max: deScore.max, logic: deScore.logic },
                { metric: 'Interest Coverage', value: this.round2(icr) + 'x', score: icrScore.score, max: icrScore.max, logic: icrScore.logic },
                { metric: 'Net Margin', value: this.round2(npm) + '%', score: npmScore.score, max: npmScore.max, logic: npmScore.logic },
                { metric: 'ROE', value: this.round2(roe) + '%', score: roeScore.score, max: roeScore.max, logic: roeScore.logic }
            ]
        };
        fs.score = fs.breakdown.reduce((s, b) => s + b.score, 0);

        // Banking Conduct - using config metrics
        let bc;
        if (bankData && bankData.average_balance) {
            const avgBal = bankData.average_balance || 0;
            const chequeRate = bankData.cheque_return_rate || 0;
            const emiRatio = bankData.monthly_emi_total && bankData.average_monthly_credits 
                ? (bankData.monthly_emi_total / bankData.average_monthly_credits) * 100 : 0;
            
            const avgBalScore = this.evaluateMetric(avgBal, 'AVG_BALANCE');
            const chequeScore = this.evaluateMetric(chequeRate, 'CHEQUE_RETURN');
            const emiScore = this.evaluateMetric(emiRatio, 'EMI_BURDEN');

            bc = { 
                name: 'Banking Conduct', max: bcMax,
                breakdown: [
                    { metric: 'Avg Balance', value: this.formatINR(avgBal), score: avgBalScore.score, max: avgBalScore.max, logic: avgBalScore.logic },
                    { metric: 'Cheque Returns', value: this.round2(chequeRate) + '%', score: chequeScore.score, max: chequeScore.max, logic: chequeScore.logic },
                    { metric: 'EMI Burden', value: this.round2(emiRatio) + '%', score: emiScore.score, max: emiScore.max, logic: emiScore.logic }
                ]
            };
            bc.score = bc.breakdown.reduce((s, b) => s + b.score, 0);
        } else {
            bc = { name: 'Banking Conduct', max: bcMax, score: 0, reason: 'Bank statements not analyzed',
                breakdown: [
                    { metric: 'Avg Balance', value: 'N/A', score: 0, max: 7, reason: 'Not available' },
                    { metric: 'Cheque Returns', value: 'N/A', score: 0, max: 7, reason: 'Not available' },
                    { metric: 'EMI Burden', value: 'N/A', score: 0, max: 6, reason: 'Not available' }
                ]
            };
        }

        // Credit History (15 points) - CIBIL API not integrated
        const ch = { name: 'Credit History', max: chMax, score: 0, reason: 'Bureau API not integrated',
            breakdown: [
                { metric: 'CIBIL Score', value: 'N/A', score: 0, max: 8, reason: 'Not available' },
                { metric: 'DPD History', value: 'N/A', score: 0, max: 7, reason: 'Not available' }
            ]
        };

        // Business Stability - using config metrics
        let bst;
        const patPositive = pat > 0 && patPrev > 0;
        
        let vintageScore = 0, vintageValue = 'N/A', vintageYears = 0;
        // Try multiple paths for incorporation date
        let incDateStr = null;
        if (kycData) {
            incDateStr = kycData?.coi?.date_of_incorporation ||
                         kycData?.certificate_of_incorporation?.date_of_incorporation ||
                         kycData?.date_of_incorporation ||
                         kycData?.incorporation_date ||
                         kycData?.company_info?.incorporation_date;
        }
        
        if (incDateStr) {
            // Handle various date formats
            let incDate;
            if (typeof incDateStr === 'string') {
                incDate = new Date(incDateStr.replace(/(\d+)(st|nd|rd|th)/g, '$1'));
            } else {
                incDate = new Date(incDateStr);
            }
            
            if (!isNaN(incDate.getTime())) {
                vintageYears = (new Date() - incDate) / (365.25 * 24 * 60 * 60 * 1000);
                vintageValue = this.round2(vintageYears) + ' years';
                const vintageEval = this.evaluateMetric(vintageYears, 'BUSINESS_VINTAGE');
                vintageScore = vintageEval.score;
            }
        }
        
        let gstCompScore = 0, gstCompValue = 'N/A';
        if (gstData && gstData.compliance_rate !== undefined) {
            gstCompValue = this.round2(gstData.compliance_rate) + '%';
            const gstEval = this.evaluateMetric(gstData.compliance_rate, 'GST_COMPLIANCE');
            gstCompScore = gstEval.score;
        }

        const revGrScore = this.evaluateMetric(revGr, 'REVENUE_GROWTH');

        bst = { name: 'Business Stability', max: bstMax,
            breakdown: [
                { metric: 'Revenue Growth', value: this.round2(revGr) + '%', score: revGrScore.score, max: revGrScore.max, logic: revGrScore.logic },
                { metric: 'Business Vintage', value: vintageValue, score: vintageScore, max: 5, logic: '≥5yr=5, ≥3yr=4, ≥2yr=2, else 1' },
                { metric: 'GST Compliance', value: gstCompValue, score: gstCompScore, max: 5, logic: '100%=5, ≥90%=3, else 1' }
            ]
        };
        bst.score = bst.breakdown.reduce((s, b) => s + b.score, 0);

        // Security Coverage - using config metrics
        let sc;
        // Try multiple paths for property data
        let hasPropertyData = false;
        let marketValue = 0;
        let encStatus = 'Unknown';
        
        if (propertyData) {
            // Handle legal_risk_assessment structure
            if (propertyData.properties && propertyData.properties.length > 0) {
                const prop = propertyData.properties[0];
                marketValue = prop.market_value || prop.valuation?.market_value || 0;
                encStatus = prop.encumbrance_analysis?.has_adverse_entries === false ? 'Clear' :
                           prop.encumbrance_analysis?.has_adverse_entries === true ? 'Encumbered' : 'Unknown';
                hasPropertyData = marketValue > 0;
            }
            // Handle prop_valuation/prop_title structure
            else if (propertyData.prop_valuation || propertyData.prop_title) {
                const valuation = propertyData.prop_valuation || propertyData.prop_title || {};
                marketValue = valuation.market_value || valuation.registration_value || 0;
                encStatus = propertyData.prop_enc?.encumbrance_status || valuation.encumbrance_status || 'Unknown';
                hasPropertyData = marketValue > 0;
            }
            // Handle valuation_report or title_deed direct structure
            else if (propertyData.market_value || propertyData.valuation_report || propertyData.title_deed) {
                const valData = propertyData.valuation_report || propertyData.title_deed || propertyData;
                marketValue = valData.market_value || valData.total_market_value || 
                             valData.registration_value || valData.sale_value || 
                             propertyData.market_value || 0;
                encStatus = propertyData.encumbrance_status || 
                           propertyData.encumbrance_certificate?.status ||
                           (propertyData.has_encumbrance === false ? 'Clear' : 'Unknown');
                hasPropertyData = marketValue > 0;
            }
        }
        
        if (hasPropertyData) {
            const isEncClear = encStatus === 'Clear' || encStatus === 'Nil' || encStatus === 'No Encumbrance';
            
            const collateralEval = this.evaluateMetric(marketValue, 'COLLATERAL_VALUE');
            const encScore = isEncClear ? 7 : 2;
            
            sc = { name: 'Security Coverage', max: scMax,
                breakdown: [
                    { metric: 'Collateral Value', value: this.formatINR(marketValue), score: collateralEval.score, max: collateralEval.max, logic: collateralEval.logic },
                    { metric: 'Title Status', value: encStatus, score: encScore, max: 7, logic: 'Clear=7, else 2' }
                ]
            };
            sc.score = sc.breakdown.reduce((s, b) => s + b.score, 0);
        } else {
            sc = { name: 'Security Coverage', max: scMax, score: 0, reason: 'Collateral not provided',
                breakdown: [
                    { metric: 'Collateral Value', value: 'N/A', score: 0, max: 8, reason: 'Not available' },
                    { metric: 'Title Status', value: 'N/A', score: 0, max: 7, reason: 'Not available' }
                ]
            };
        }

        const total = fs.score + bc.score + ch.score + bst.score + sc.score;
        const maxPossible = fsMax + bcMax + chMax + bstMax + scMax;
        
        // Get grade from config
        const gradeInfo = this.getScoringGrade(total);
        const grade = gradeInfo.grade;
        const decision = gradeInfo.decision;

        // Calculate what data is missing
        const missingData = [];
        if (!bankData) missingData.push('Bank Statements');
        if (!gstData) missingData.push('GST Returns');
        if (!kycData) missingData.push('KYC Documents');
        if (!propertyData || Object.keys(propertyData).length === 0) missingData.push('Property Documents');

        return {
            total, max: maxPossible, grade, decision,
            formula: `${fs.score} (Financial) + ${bc.score} (Banking) + ${ch.score} (Credit) + ${bst.score} (Stability) + ${sc.score} (Security) = ${total}`,
            components: { financial_strength: fs, banking_conduct: bc, credit_history: ch, business_stability: bst, security_coverage: sc },
            data_completeness: {
                available: ['Financial Statements'],
                missing: missingData,
                completeness_pct: this.round2(((5 - missingData.length) / 5) * 100)
            },
            note: total < 55 ? `Score limited due to missing: ${missingData.join(', ')}. Financial score: ${fs.score}/35` : null
        };
    }

    /**
     * Generate policy compliance array
     */
    generatePolicyCompliance(calc) {
        const items = [];
        
        // Policy reference mapping - CORRECT mapping to actual policy clauses
        // Existing clauses from MSME Credit Policy V2024-25 / 3.2
        // New clauses added: 3.1.5, 3.1.6, 3.3.3, 3.3.4, 3.3.5, 3.3.6, 3.3.7
        const policyRefMap = {
            'Current Ratio': '3.1.1',
            'Quick Ratio (Acid Test)': '3.1.5',
            'Cash Ratio': '3.1.6',
            'Debt to Equity Ratio': '3.1.2',
            'Interest Coverage Ratio (ICR)': '3.2.3',
            'Debt Service Coverage Ratio (DSCR)': '3.2.1',
            'TOL/TNW': '3.1.3',
            'Gross Profit Margin': '3.3.3',
            'EBITDA Margin': '3.3.4',
            'Net Profit Margin (PAT Margin)': '3.3.5',
            'Return on Equity (ROE)': '3.3.6',
            'Return on Assets (ROA)': '3.3.7'
        };
        
        ['liquidity', 'leverage', 'profitability'].forEach(cat => {
            if (calc[cat]) {
                Object.values(calc[cat]).forEach(r => {
                    items.push({
                        param: r.name,
                        actual: r.result_display,
                        norm: r.policy_norm,
                        status: r.status,
                        policyRef: policyRefMap[r.name] || null
                    });
                });
            }
        });
        
        return items;
    }

    /**
     * Calculate recommended limits using config parameters
     */
    calculateLimits(bs, pnl, loanLakhs) {
        const inv = bs.inventory || 0;
        const recv = bs.trade_receivables || 0;
        const pat = pnl.profit_after_tax || 0;
        const dep = pnl.depreciation || 0;
        const interest = pnl.interest_expense || 0;
        const rev = pnl.revenue || 0;

        // Net Worth / TNW for exposure cap
        const netWorth = bs.net_worth || 0;
        const intangibles = bs.intangible_assets || 0;
        const tnw = netWorth - intangibles; // Tangible Net Worth

        // Get limit parameters from config
        const stockMarginPct = (this.getLimitParam('STOCK_MARGIN') || 75) / 100;
        const debtorMarginPct = (this.getLimitParam('DEBTOR_MARGIN') || 60) / 100;
        const odTurnoverPct = (this.getLimitParam('OD_TURNOVER_PCT') || 10) / 100;
        const targetDscr = this.getLimitParam('TARGET_DSCR') || 1.5;
        const tlTenureMonths = this.getLimitParam('TL_TENURE') || 60;
        const tlTenureYears = tlTenureMonths / 12;
        const maxTnwMultiple = this.getLimitParam('MAX_TNW_MULTIPLE') || 3;

        // WC - Drawing Power
        const eligStock = inv * stockMarginPct;
        const eligDebtors = recv * debtorMarginPct;
        const wcLimit = eligStock + eligDebtors;

        // TL - DSCR based
        const cashFlow = pat + dep + interest;
        const maxDS = cashFlow / targetDscr;
        const tlLimit = maxDS > interest ? (maxDS - interest) * tlTenureYears : 0;

        // OD - Turnover
        const odLimit = rev * odTurnoverPct;

        // Raw total before cap
        const rawTotal = wcLimit + tlLimit + odLimit;

        // TNW-based exposure cap: Total exposure cannot exceed TNW × multiple
        const tnwCap = tnw > 0 ? Math.round(tnw * maxTnwMultiple) : 0;
        const isCapped = tnw > 0 && rawTotal > tnwCap;
        
        // Apply proportional reduction if capped
        let finalWc = Math.round(wcLimit);
        let finalTl = Math.round(tlLimit);
        let finalOd = Math.round(odLimit);
        let finalTotal = Math.round(rawTotal);
        let capNote = null;

        if (isCapped) {
            const ratio = tnwCap / rawTotal;
            finalWc = Math.round(wcLimit * ratio);
            finalTl = Math.round(tlLimit * ratio);
            finalOd = Math.round(odLimit * ratio);
            finalTotal = finalWc + finalTl + finalOd;
            capNote = `Total exposure capped at ${maxTnwMultiple}× TNW (${this.formatINR(tnw)}). Raw total ${this.formatINR(rawTotal)} reduced to ${this.formatINR(finalTotal)}.`;
        }

        return {
            working_capital: {
                name: 'Working Capital Limit',
                method: `Drawing Power (Stock ${stockMarginPct*100}% + Debtors ${debtorMarginPct*100}%)`,
                calculation: `Stock: ${this.formatINR(inv)} × ${stockMarginPct*100}% = ${this.formatINR(eligStock)} | Debtors: ${this.formatINR(recv)} × ${debtorMarginPct*100}% = ${this.formatINR(eligDebtors)}`,
                amount: finalWc,
                formatted: this.formatINR(finalWc),
                raw_amount: Math.round(wcLimit)
            },
            term_loan: {
                name: 'Term Loan',
                method: `DSCR Based (Target ${targetDscr}x, ${tlTenureYears}yr tenure)`,
                calculation: `Cash Flow: ${this.formatINR(cashFlow)} ÷ ${targetDscr} = ${this.formatINR(maxDS)}/yr`,
                amount: finalTl,
                formatted: this.formatINR(finalTl),
                raw_amount: Math.round(tlLimit)
            },
            overdraft: {
                name: 'Overdraft',
                method: `Turnover Based (${odTurnoverPct*100}%)`,
                calculation: `Revenue: ${this.formatINR(rev)} × ${odTurnoverPct*100}%`,
                amount: finalOd,
                formatted: this.formatINR(finalOd),
                raw_amount: Math.round(odLimit)
            },
            total: {
                name: 'Total Recommended',
                amount: finalTotal,
                formatted: this.formatINR(finalTotal),
                raw_amount: Math.round(rawTotal)
            },
            tnw_cap: {
                tnw: Math.round(tnw),
                tnw_formatted: this.formatINR(tnw),
                multiple: maxTnwMultiple,
                cap_amount: tnwCap,
                cap_formatted: this.formatINR(tnwCap),
                is_capped: isCapped,
                note: capNote
            }
        };
    }
}

// Create default instance (backward compatible)
const defaultEngine = new CalculationEngine();

// Export both the class and default instance
module.exports = defaultEngine;
module.exports.CalculationEngine = CalculationEngine;
module.exports.createEngine = (config) => new CalculationEngine(config);
