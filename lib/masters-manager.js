/**
 * Masters Manager Module
 * Handles all master data CRUD operations with audit trail and S3 sync
 * Database: Single table with JSON approach
 */

const mastersSchema = require('./masters-schema.json');
const policyRulesSchema = require('./policy-rules-schema.json');
const s3Client = require('./s3-client');

// In-memory store (persisted to S3)
let mastersData = new Map();
let auditLog = [];
let policyAuditLog = []; // Separate audit for policy changes

// Master data structure
const MASTERS_COLLECTION_KEY = 'masters-collection';
const AUDIT_LOG_KEY = 'masters-audit-log';
const POLICY_AUDIT_KEY = 'policy-audit-log';

/**
 * Initialize masters from S3
 */
async function initialize() {
    console.log('Initializing Masters Manager...');
    
    if (s3Client.isConfigured()) {
        try {
            // Load masters from S3
            const data = await s3Client.getMasters(MASTERS_COLLECTION_KEY);
            if (data && data.masters) {
                mastersData = new Map(Object.entries(data.masters));
                console.log(`Loaded ${mastersData.size} master types from S3`);
            }
            
            // Load audit log from S3
            const audit = await s3Client.getMasters(AUDIT_LOG_KEY);
            if (audit && audit.logs) {
                auditLog = audit.logs;
                console.log(`Loaded ${auditLog.length} audit log entries from S3`);
            }
            
            // Load policy audit log from S3
            const policyAudit = await s3Client.getMasters(POLICY_AUDIT_KEY);
            if (policyAudit && policyAudit.logs) {
                policyAuditLog = policyAudit.logs;
                console.log(`Loaded ${policyAuditLog.length} policy audit entries from S3`);
            }
        } catch (err) {
            console.error('Error loading masters from S3:', err.message);
        }
    }
    
    // Seed default data if empty OR if new master types are missing
    if (mastersData.size === 0) {
        seedDefaultMasters();
    } else {
        // Check for missing master types and seed them
        seedMissingMasterTypes();
    }
}

/**
 * Seed only missing master types (for upgrades)
 */
function seedMissingMasterTypes() {
    const requiredTypes = [
        'products', 'policy_rules', 'branches', 'industries', 'constitution_types',
        'turnover_slabs', 'credit_score_ranges', 'aml_screening_lists', 'aml_threshold_rules',
        'scoring_weights', 'scoring_metrics', 'scoring_grades', 'limit_params',
        // Legal & Collateral masters
        'state_legal_rules', 'legal_risk_rules', 'property_types', 'encumbrance_types'
    ];
    
    const missingTypes = requiredTypes.filter(type => !mastersData.has(type) || mastersData.get(type).length === 0);
    
    if (missingTypes.length > 0) {
        console.log(`📦 Seeding missing master types: ${missingTypes.join(', ')}`);
        
        // Seed only the missing types
        if (missingTypes.includes('scoring_weights')) seedScoringWeights();
        if (missingTypes.includes('scoring_metrics')) seedScoringMetrics();
        if (missingTypes.includes('scoring_grades')) seedScoringGrades();
        if (missingTypes.includes('limit_params')) seedLimitParams();
        
        // Legal & Collateral masters
        if (missingTypes.includes('state_legal_rules')) seedStateLegalRules();
        if (missingTypes.includes('legal_risk_rules')) seedLegalRiskRules();
        if (missingTypes.includes('property_types')) seedPropertyTypes();
        if (missingTypes.includes('encumbrance_types')) seedEncumbranceTypes();
        
        // Save to S3 after seeding missing types
        saveMastersToS3();
    }
}

/**
 * Seed default master data
 */
function seedDefaultMasters() {
    console.log('Seeding default master data...');
    
    // Default Products
    addMasterRecord('products', {
        product_code: 'WC',
        product_name: 'Working Capital',
        description: 'Working capital loan for business operations',
        min_amount_lakhs: 5,
        max_amount_lakhs: 5000,
        min_tenure_months: 12,
        max_tenure_months: 60,
        interest_rate_min: 9.0,
        interest_rate_max: 12.0,
        processing_fee_percent: 1.0,
        is_active: true
    }, 'system');
    
    addMasterRecord('products', {
        product_code: 'TL',
        product_name: 'Term Loan',
        description: 'Term loan for capital expenditure',
        min_amount_lakhs: 10,
        max_amount_lakhs: 10000,
        min_tenure_months: 12,
        max_tenure_months: 120,
        interest_rate_min: 10.0,
        interest_rate_max: 14.0,
        processing_fee_percent: 1.5,
        is_active: true
    }, 'system');
    
    addMasterRecord('products', {
        product_code: 'CC',
        product_name: 'Cash Credit',
        description: 'Cash credit facility against current assets',
        min_amount_lakhs: 3,
        max_amount_lakhs: 2500,
        min_tenure_months: 12,
        max_tenure_months: 36,
        interest_rate_min: 11.0,
        interest_rate_max: 15.0,
        processing_fee_percent: 1.0,
        is_active: true
    }, 'system');
    
    // Default Policy Rules from policy-rules-schema.json
    policyRulesSchema.policy_rules.forEach(rule => {
        addMasterRecord('policy_rules', {
            rule_code: rule.id,
            rule_name: rule.parameter,
            parameter: rule.parameter,
            clause_ref: rule.clause_ref,
            category: rule.category,
            operator: rule.norm_operator,
            policy_value: rule.policy_value,
            current_value: rule.current_value,
            norm_display: rule.norm_display,
            formula: rule.formula,
            policy_text: rule.policy_text,
            source_policy: rule.source_policy,
            is_mandatory: rule.is_mandatory,
            applicable_product: 'All',
            severity: rule.is_mandatory ? 'Critical' : 'Warning',
            is_active: true
        }, 'system');
    });
    
    console.log(`Seeded ${policyRulesSchema.policy_rules.length} policy rules from MSME Credit Policy V2024-25 / 3.2`);
    
    // ============================================
    // CREDIT SCORING CONFIGURATION
    // ============================================
    
    // Scoring Category Weights
    addMasterRecord('scoring_weights', {
        category_code: 'FINANCIAL',
        category_name: 'Financial Strength',
        max_score: 35,
        display_order: 1,
        description: 'Assessment of financial ratios including liquidity, leverage, and profitability',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_weights', {
        category_code: 'BANKING',
        category_name: 'Banking Conduct',
        max_score: 20,
        display_order: 2,
        description: 'Assessment of banking behavior, account conduct, and payment discipline',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_weights', {
        category_code: 'CREDIT_HISTORY',
        category_name: 'Credit History',
        max_score: 15,
        display_order: 3,
        description: 'Assessment of credit bureau scores and repayment history',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_weights', {
        category_code: 'BUSINESS',
        category_name: 'Business Stability',
        max_score: 15,
        display_order: 4,
        description: 'Assessment of business vintage, growth, and compliance',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_weights', {
        category_code: 'SECURITY',
        category_name: 'Security Coverage',
        max_score: 15,
        display_order: 5,
        description: 'Assessment of collateral value and coverage',
        is_active: true
    }, 'system');
    
    console.log('Seeded 5 scoring weight categories (Total: 100)');
    
    // Scoring Metrics (Financial)
    addMasterRecord('scoring_metrics', {
        metric_code: 'CURRENT_RATIO',
        metric_name: 'Current Ratio',
        category_code: 'FINANCIAL',
        max_score: 7,
        threshold_1: 1.5, score_1: 7,
        threshold_2: 1.25, score_2: 5,
        threshold_3: 1.0, score_3: 3,
        default_score: 1,
        comparison_type: 'higher_better',
        display_format: 'number',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'DEBT_EQUITY',
        metric_name: 'Debt to Equity',
        category_code: 'FINANCIAL',
        max_score: 7,
        threshold_1: 0.5, score_1: 7,
        threshold_2: 1.0, score_2: 5,
        threshold_3: 2.0, score_3: 3,
        default_score: 1,
        comparison_type: 'lower_better',
        display_format: 'number',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'INTEREST_COVERAGE',
        metric_name: 'Interest Coverage',
        category_code: 'FINANCIAL',
        max_score: 7,
        threshold_1: 3.0, score_1: 7,
        threshold_2: 2.0, score_2: 5,
        threshold_3: 1.5, score_3: 3,
        default_score: 1,
        comparison_type: 'higher_better',
        display_format: 'times',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'NET_MARGIN',
        metric_name: 'Net Profit Margin',
        category_code: 'FINANCIAL',
        max_score: 7,
        threshold_1: 5.0, score_1: 7,
        threshold_2: 3.0, score_2: 5,
        threshold_3: 1.0, score_3: 3,
        default_score: 1,
        comparison_type: 'higher_better',
        display_format: 'percentage',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'ROE',
        metric_name: 'Return on Equity',
        category_code: 'FINANCIAL',
        max_score: 7,
        threshold_1: 20.0, score_1: 7,
        threshold_2: 15.0, score_2: 5,
        threshold_3: 10.0, score_3: 3,
        default_score: 1,
        comparison_type: 'higher_better',
        display_format: 'percentage',
        is_active: true
    }, 'system');
    
    // Scoring Metrics (Banking)
    addMasterRecord('scoring_metrics', {
        metric_code: 'AVG_BALANCE',
        metric_name: 'Average Bank Balance',
        category_code: 'BANKING',
        max_score: 7,
        threshold_1: 1000000, score_1: 7,
        threshold_2: 500000, score_2: 5,
        threshold_3: 100000, score_3: 3,
        default_score: 1,
        comparison_type: 'higher_better',
        display_format: 'currency',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'CHEQUE_RETURN',
        metric_name: 'Cheque Return Rate',
        category_code: 'BANKING',
        max_score: 7,
        threshold_1: 1.0, score_1: 7,
        threshold_2: 2.0, score_2: 5,
        threshold_3: 5.0, score_3: 3,
        default_score: 0,
        comparison_type: 'lower_better',
        display_format: 'percentage',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'EMI_BURDEN',
        metric_name: 'EMI Burden Ratio',
        category_code: 'BANKING',
        max_score: 6,
        threshold_1: 30.0, score_1: 6,
        threshold_2: 50.0, score_2: 4,
        threshold_3: 70.0, score_3: 2,
        default_score: 0,
        comparison_type: 'lower_better',
        display_format: 'percentage',
        is_active: true
    }, 'system');
    
    // Scoring Metrics (Credit History)
    addMasterRecord('scoring_metrics', {
        metric_code: 'CIBIL_SCORE',
        metric_name: 'CIBIL Score',
        category_code: 'CREDIT_HISTORY',
        max_score: 8,
        threshold_1: 750, score_1: 8,
        threshold_2: 700, score_2: 6,
        threshold_3: 650, score_3: 4,
        default_score: 0,
        comparison_type: 'higher_better',
        display_format: 'number',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'DPD_HISTORY',
        metric_name: 'DPD History',
        category_code: 'CREDIT_HISTORY',
        max_score: 7,
        threshold_1: 0, score_1: 7,
        threshold_2: 30, score_2: 4,
        threshold_3: 60, score_3: 2,
        default_score: 0,
        comparison_type: 'lower_better',
        display_format: 'number',
        is_active: true
    }, 'system');
    
    // Scoring Metrics (Business)
    addMasterRecord('scoring_metrics', {
        metric_code: 'REVENUE_GROWTH',
        metric_name: 'Revenue Growth',
        category_code: 'BUSINESS',
        max_score: 5,
        threshold_1: 10.0, score_1: 5,
        threshold_2: 5.0, score_2: 4,
        threshold_3: 0.0, score_3: 2,
        default_score: 1,
        comparison_type: 'higher_better',
        display_format: 'percentage',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'BUSINESS_VINTAGE',
        metric_name: 'Business Vintage',
        category_code: 'BUSINESS',
        max_score: 5,
        threshold_1: 5, score_1: 5,
        threshold_2: 3, score_2: 4,
        threshold_3: 2, score_3: 2,
        default_score: 1,
        comparison_type: 'higher_better',
        display_format: 'number',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'GST_COMPLIANCE',
        metric_name: 'GST Filing Compliance',
        category_code: 'BUSINESS',
        max_score: 5,
        threshold_1: 100, score_1: 5,
        threshold_2: 90, score_2: 3,
        threshold_3: 75, score_3: 2,
        default_score: 1,
        comparison_type: 'higher_better',
        display_format: 'percentage',
        is_active: true
    }, 'system');
    
    // Scoring Metrics (Security)
    addMasterRecord('scoring_metrics', {
        metric_code: 'COLLATERAL_VALUE',
        metric_name: 'Collateral Value',
        category_code: 'SECURITY',
        max_score: 8,
        threshold_1: 10000000, score_1: 8,
        threshold_2: 5000000, score_2: 6,
        threshold_3: 1000000, score_3: 4,
        default_score: 2,
        comparison_type: 'higher_better',
        display_format: 'currency',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'TITLE_STATUS',
        metric_name: 'Title Status',
        category_code: 'SECURITY',
        max_score: 7,
        threshold_1: 1, score_1: 7,
        threshold_2: 0, score_2: 2,
        threshold_3: -1, score_3: 0,
        default_score: 0,
        comparison_type: 'higher_better',
        display_format: 'number',
        is_active: true
    }, 'system');
    
    console.log('Seeded 15 scoring metrics');
    
    // Scoring Grades
    addMasterRecord('scoring_grades', {
        grade: 'A+',
        min_score: 85,
        max_score: 100,
        decision: 'Approve',
        interest_rate_markup: 0,
        color_code: '#10b981',
        description: 'Excellent credit profile - Auto approve with best terms',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_grades', {
        grade: 'A',
        min_score: 75,
        max_score: 84,
        decision: 'Approve',
        interest_rate_markup: 0.25,
        color_code: '#22c55e',
        description: 'Very good credit profile - Approve with standard terms',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_grades', {
        grade: 'B+',
        min_score: 65,
        max_score: 74,
        decision: 'Refer to Credit Committee',
        interest_rate_markup: 0.50,
        color_code: '#eab308',
        description: 'Good credit profile - Refer for enhanced collateral',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_grades', {
        grade: 'B',
        min_score: 55,
        max_score: 64,
        decision: 'Refer to Credit Committee',
        interest_rate_markup: 1.00,
        color_code: '#f97316',
        description: 'Fair credit profile - Requires credit committee approval',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_grades', {
        grade: 'C',
        min_score: 45,
        max_score: 54,
        decision: 'Decline',
        interest_rate_markup: 2.00,
        color_code: '#ef4444',
        description: 'Weak credit profile - Decline unless exceptional circumstances',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_grades', {
        grade: 'D',
        min_score: 0,
        max_score: 44,
        decision: 'Decline',
        interest_rate_markup: 0,
        color_code: '#dc2626',
        description: 'Poor credit profile - Auto decline',
        is_active: true
    }, 'system');
    
    console.log('Seeded 6 scoring grades');
    
    // ============================================
    // LIMIT CALCULATION PARAMETERS
    // ============================================
    
    addMasterRecord('limit_params', {
        param_code: 'STOCK_MARGIN',
        param_name: 'Eligible Stock Margin',
        param_value: 75,
        param_unit: 'percentage',
        facility_type: 'Working Capital',
        description: 'Percentage of stock value considered eligible for drawing power',
        is_active: true
    }, 'system');
    
    addMasterRecord('limit_params', {
        param_code: 'DEBTOR_MARGIN',
        param_name: 'Eligible Debtors Margin',
        param_value: 60,
        param_unit: 'percentage',
        facility_type: 'Working Capital',
        description: 'Percentage of debtors (< 90 days) considered eligible for drawing power',
        is_active: true
    }, 'system');
    
    addMasterRecord('limit_params', {
        param_code: 'OD_TURNOVER_PCT',
        param_name: 'Overdraft as % of Turnover',
        param_value: 10,
        param_unit: 'percentage',
        facility_type: 'Overdraft',
        description: 'OD limit calculated as percentage of annual turnover',
        is_active: true
    }, 'system');
    
    addMasterRecord('limit_params', {
        param_code: 'TARGET_DSCR',
        param_name: 'Target DSCR for TL',
        param_value: 1.5,
        param_unit: 'times',
        facility_type: 'Term Loan',
        description: 'Target DSCR for calculating term loan eligibility',
        is_active: true
    }, 'system');
    
    addMasterRecord('limit_params', {
        param_code: 'TL_TENURE',
        param_name: 'Standard TL Tenure',
        param_value: 60,
        param_unit: 'months',
        facility_type: 'Term Loan',
        description: 'Standard term loan tenure for limit calculation',
        is_active: true
    }, 'system');
    
    addMasterRecord('limit_params', {
        param_code: 'PRINCIPAL_PCT',
        param_name: 'Annual Principal Repayment %',
        param_value: 20,
        param_unit: 'percentage',
        facility_type: 'Term Loan',
        description: 'Assumed annual principal repayment as % of total debt',
        is_active: true
    }, 'system');
    
    addMasterRecord('limit_params', {
        param_code: 'MIN_COLLATERAL_COVERAGE',
        param_name: 'Minimum Collateral Coverage',
        param_value: 125,
        param_unit: 'percentage',
        facility_type: 'All',
        description: 'Minimum collateral coverage required (125% = 1.25x)',
        is_active: true
    }, 'system');
    
    console.log('Seeded 7 limit calculation parameters');

    // Default Branches
    addMasterRecord('branches', {
        branch_code: 'MUM001',
        branch_name: 'Mumbai Main Branch',
        region: 'West',
        state: 'Maharashtra',
        city: 'Mumbai',
        address: 'Nariman Point, Mumbai - 400021',
        manager_name: 'Rajesh Kumar',
        contact_number: '+91-22-12345678',
        email: 'mumbai@axisbank.com',
        is_active: true
    }, 'system');
    
    addMasterRecord('branches', {
        branch_code: 'DEL001',
        branch_name: 'Delhi Corporate Branch',
        region: 'North',
        state: 'Delhi',
        city: 'New Delhi',
        address: 'Connaught Place, New Delhi - 110001',
        manager_name: 'Priya Sharma',
        contact_number: '+91-11-23456789',
        email: 'delhi@axisbank.com',
        is_active: true
    }, 'system');
    
    // Default Industries
    addMasterRecord('industries', {
        industry_code: 'MFG-TEX',
        industry_name: 'Textiles Manufacturing',
        sector: 'Manufacturing',
        risk_category: 'Medium',
        default_rate: 2.5,
        special_considerations: 'Check GST returns and export data',
        is_active: true
    }, 'system');
    
    addMasterRecord('industries', {
        industry_code: 'SVC-IT',
        industry_name: 'IT Services',
        sector: 'Services',
        risk_category: 'Low',
        default_rate: 1.2,
        special_considerations: 'Verify client contracts and receivables',
        is_active: true
    }, 'system');
    
    // Default Credit Score Ranges
    addMasterRecord('credit_score_ranges', {
        min_score: 850,
        max_score: 1000,
        grade: 'A+',
        description: 'Excellent',
        recommendation: 'Approve',
        color_code: '#10b981',
        is_active: true
    }, 'system');
    
    addMasterRecord('credit_score_ranges', {
        min_score: 750,
        max_score: 849,
        grade: 'A',
        description: 'Very Good',
        recommendation: 'Approve',
        color_code: '#34d399',
        is_active: true
    }, 'system');
    
    addMasterRecord('credit_score_ranges', {
        min_score: 650,
        max_score: 749,
        grade: 'B+',
        description: 'Good',
        recommendation: 'Approve with Conditions',
        color_code: '#fbbf24',
        is_active: true
    }, 'system');
    
    addMasterRecord('credit_score_ranges', {
        min_score: 550,
        max_score: 649,
        grade: 'B',
        description: 'Fair',
        recommendation: 'Refer to Committee',
        color_code: '#fb923c',
        is_active: true
    }, 'system');
    
    addMasterRecord('credit_score_ranges', {
        min_score: 450,
        max_score: 549,
        grade: 'C',
        description: 'Poor',
        recommendation: 'Reject',
        color_code: '#ef4444',
        is_active: true
    }, 'system');
    
    // Default AML Screening Lists
    addMasterRecord('aml_screening_lists', {
        list_code: 'OFAC',
        list_name: 'OFAC - US Treasury Sanctions',
        list_type: 'International Sanctions',
        list_category: 'Sanctions',
        source_url: 'https://ofac.treasury.gov',
        auto_screen: true,
        match_threshold_auto_reject: 95,
        match_threshold_review: 75,
        update_frequency: 'Daily',
        is_active: true
    }, 'system');
    
    addMasterRecord('aml_screening_lists', {
        list_code: 'UN_SANCTIONS',
        list_name: 'UN Security Council Sanctions',
        list_type: 'International Sanctions',
        list_category: 'Sanctions',
        source_url: 'https://www.un.org/securitycouncil/sanctions',
        auto_screen: true,
        match_threshold_auto_reject: 95,
        match_threshold_review: 75,
        update_frequency: 'Weekly',
        is_active: true
    }, 'system');
    
    addMasterRecord('aml_screening_lists', {
        list_code: 'RBI_WILFUL_DEFAULTERS',
        list_name: 'RBI Wilful Defaulters List',
        list_type: 'India Specific',
        list_category: 'Wilful Defaulters',
        source_url: 'https://rbi.org.in',
        auto_screen: true,
        match_threshold_auto_reject: 90,
        match_threshold_review: 70,
        update_frequency: 'Monthly',
        is_active: true
    }, 'system');
    
    addMasterRecord('aml_screening_lists', {
        list_code: 'CIBIL_WILFUL_DEFAULTERS',
        list_name: 'CIBIL Wilful Defaulters',
        list_type: 'India Specific',
        list_category: 'Wilful Defaulters',
        source_url: 'https://cibil.com',
        auto_screen: true,
        match_threshold_auto_reject: 90,
        match_threshold_review: 70,
        update_frequency: 'Monthly',
        is_active: true
    }, 'system');
    
    addMasterRecord('aml_screening_lists', {
        list_code: 'ECGC_CAUTION',
        list_name: 'ECGC Caution List',
        list_type: 'India Specific',
        list_category: 'Other',
        source_url: 'https://ecgc.in',
        auto_screen: true,
        match_threshold_auto_reject: 90,
        match_threshold_review: 70,
        update_frequency: 'Quarterly',
        is_active: true
    }, 'system');
    
    addMasterRecord('aml_screening_lists', {
        list_code: 'MCA_DISQUALIFIED',
        list_name: 'MCA Disqualified Directors',
        list_type: 'India Specific',
        list_category: 'Disqualified Directors',
        source_url: 'https://mca.gov.in',
        auto_screen: true,
        match_threshold_auto_reject: 90,
        match_threshold_review: 70,
        update_frequency: 'Monthly',
        is_active: true
    }, 'system');
    
    addMasterRecord('aml_screening_lists', {
        list_code: 'SEBI_DEBARRED',
        list_name: 'SEBI Debarred Entities',
        list_type: 'India Specific',
        list_category: 'Other',
        source_url: 'https://sebi.gov.in',
        auto_screen: true,
        match_threshold_auto_reject: 90,
        match_threshold_review: 70,
        update_frequency: 'Monthly',
        is_active: true
    }, 'system');
    
    addMasterRecord('aml_screening_lists', {
        list_code: 'PEP_INDIA',
        list_name: 'Politically Exposed Persons (India)',
        list_type: 'PEP',
        list_category: 'PEP',
        source_url: '',
        auto_screen: true,
        match_threshold_auto_reject: 0, // PEP doesn't auto-reject, only flags
        match_threshold_review: 60,
        update_frequency: 'Monthly',
        is_active: true
    }, 'system');
    
    addMasterRecord('aml_screening_lists', {
        list_code: 'INTERNAL_NEGATIVE',
        list_name: 'Internal Negative List',
        list_type: 'Internal',
        list_category: 'Fraud',
        source_url: '',
        auto_screen: true,
        match_threshold_auto_reject: 95,
        match_threshold_review: 80,
        update_frequency: 'On-Demand',
        is_active: true
    }, 'system');
    
    // Default AML Screening Rules
    addMasterRecord('aml_screening_rules', {
        rule_code: 'AML-EXACT-MATCH',
        rule_name: 'Exact Match - Auto Reject',
        rule_description: 'Automatically reject applications with exact match (95%+) on sanctions lists',
        match_score_min: 95,
        match_score_max: 100,
        applicable_lists: 'OFAC, UN_SANCTIONS, RBI_WILFUL_DEFAULTERS',
        action: 'Auto Reject',
        create_investigation: true,
        alert_emails: 'fraud_team@axis.com',
        priority: 'Critical',
        is_active: true
    }, 'system');
    
    addMasterRecord('aml_screening_rules', {
        rule_code: 'AML-HIGH-MATCH',
        rule_name: 'High Match - Manual Review',
        rule_description: 'Flag for manual review when match score is between 75-94%',
        match_score_min: 75,
        match_score_max: 94,
        applicable_lists: 'ALL',
        action: 'Manual Review',
        create_investigation: false,
        alert_emails: 'compliance_team@axis.com',
        priority: 'High',
        is_active: true
    }, 'system');
    
    addMasterRecord('aml_screening_rules', {
        rule_code: 'AML-PEP-ALERT',
        rule_name: 'PEP Match - Enhanced Due Diligence',
        rule_description: 'Flag PEP matches for enhanced due diligence',
        match_score_min: 60,
        match_score_max: 100,
        applicable_lists: 'PEP_INDIA',
        action: 'Manual Review',
        create_investigation: false,
        alert_emails: 'compliance_team@axis.com',
        priority: 'High',
        is_active: true
    }, 'system');
    
    // Interest Rates Matrix
    addMasterRecord('interest_rates', {
        product_code: 'WC',
        risk_grade: 'A+',
        interest_rate: 9.5,
        processing_fee: 1.0,
        effective_from: '2024-01-01',
        is_active: true
    }, 'system');
    
    addMasterRecord('interest_rates', {
        product_code: 'TL',
        risk_grade: 'A',
        interest_rate: 10.5,
        processing_fee: 1.5,
        effective_from: '2024-01-01',
        is_active: true
    }, 'system');
    
    addMasterRecord('interest_rates', {
        product_code: 'CC',
        risk_grade: 'B+',
        interest_rate: 12.0,
        processing_fee: 1.0,
        effective_from: '2024-01-01',
        is_active: true
    }, 'system');
    
    // Constitution Types
    addMasterRecord('constitution_types', {
        code: 'PVT_LTD',
        name: 'Private Limited Company',
        description: 'Company registered under Companies Act 2013',
        is_active: true
    }, 'system');
    
    addMasterRecord('constitution_types', {
        code: 'LLP',
        name: 'Limited Liability Partnership',
        description: 'Partnership with limited liability under LLP Act 2008',
        is_active: true
    }, 'system');
    
    addMasterRecord('constitution_types', {
        code: 'PARTNERSHIP',
        name: 'Partnership Firm',
        description: 'Traditional partnership firm under Partnership Act 1932',
        is_active: true
    }, 'system');
    
    addMasterRecord('constitution_types', {
        code: 'SOLE_PROP',
        name: 'Sole Proprietorship',
        description: 'Individual business ownership',
        is_active: true
    }, 'system');
    
    // Turnover Slabs
    addMasterRecord('turnover_slabs', {
        slab_code: 'SLAB1',
        min_turnover_lakhs: 0,
        max_turnover_lakhs: 50,
        category: 'Micro',
        is_active: true
    }, 'system');
    
    addMasterRecord('turnover_slabs', {
        slab_code: 'SLAB2',
        min_turnover_lakhs: 50,
        max_turnover_lakhs: 250,
        category: 'Small',
        is_active: true
    }, 'system');
    
    addMasterRecord('turnover_slabs', {
        slab_code: 'SLAB3',
        min_turnover_lakhs: 250,
        max_turnover_lakhs: 1000,
        category: 'Medium',
        is_active: true
    }, 'system');
    
    // Documents
    addMasterRecord('documents', {
        doc_code: 'ITR',
        doc_name: 'Income Tax Returns',
        doc_category: 'Financial',
        required: true,
        validity_months: 12,
        is_active: true
    }, 'system');
    
    addMasterRecord('documents', {
        doc_code: 'BS',
        doc_name: 'Balance Sheet',
        doc_category: 'Financial',
        required: true,
        validity_months: 12,
        is_active: true
    }, 'system');
    
    addMasterRecord('documents', {
        doc_code: 'BANK_STMT',
        doc_name: 'Bank Statement',
        doc_category: 'Financial',
        required: true,
        validity_months: 6,
        is_active: true
    }, 'system');
    
    // Rejection Reasons
    addMasterRecord('rejection_reasons', {
        reason_code: 'LOW_CR',
        reason_text: 'Current ratio below policy threshold',
        category: 'Financial Ratios',
        is_active: true
    }, 'system');
    
    addMasterRecord('rejection_reasons', {
        reason_code: 'HIGH_DE',
        reason_text: 'Debt-equity ratio exceeds limit',
        category: 'Financial Ratios',
        is_active: true
    }, 'system');
    
    addMasterRecord('rejection_reasons', {
        reason_code: 'AML_MATCH',
        reason_text: 'AML screening match - sanctioned entity',
        category: 'Compliance',
        is_active: true
    }, 'system');
    
    // Ratio Thresholds
    addMasterRecord('ratio_thresholds', {
        ratio_name: 'Current Ratio',
        min_value: 1.33,
        max_value: null,
        severity: 'Critical',
        is_active: true
    }, 'system');
    
    addMasterRecord('ratio_thresholds', {
        ratio_name: 'Debt-Equity Ratio',
        min_value: null,
        max_value: 2.5,
        severity: 'Critical',
        is_active: true
    }, 'system');
    
    addMasterRecord('ratio_thresholds', {
        ratio_name: 'Interest Coverage Ratio',
        min_value: 2.0,
        max_value: null,
        severity: 'High',
        is_active: true
    }, 'system');
    
    // Fees & Charges
    addMasterRecord('fees_charges', {
        fee_code: 'PROC_FEE',
        fee_name: 'Processing Fee',
        fee_type: 'Percentage',
        fee_value: 1.0,
        applicable_products: 'All',
        is_active: true
    }, 'system');
    
    addMasterRecord('fees_charges', {
        fee_code: 'DOC_CHG',
        fee_name: 'Documentation Charges',
        fee_type: 'Fixed',
        fee_value: 5000,
        applicable_products: 'All',
        is_active: true
    }, 'system');
    
    // Role Permissions
    addMasterRecord('role_permissions', {
        role: 'Super Admin',
        module: 'All',
        permissions: 'Create,Read,Update,Delete,Approve',
        is_active: true
    }, 'system');
    
    addMasterRecord('role_permissions', {
        role: 'Admin',
        module: 'Masters',
        permissions: 'Create,Read,Update,Delete',
        is_active: true
    }, 'system');
    
    addMasterRecord('role_permissions', {
        role: 'Underwriter',
        module: 'Assessments',
        permissions: 'Create,Read,Update',
        is_active: true
    }, 'system');
    
    // Email Templates
    addMasterRecord('email_templates', {
        template_code: 'APPROVAL',
        template_name: 'Loan Approval Notification',
        subject: 'Loan Application Approved',
        body: 'Your loan application has been approved.',
        is_active: true
    }, 'system');
    
    addMasterRecord('email_templates', {
        template_code: 'REJECTION',
        template_name: 'Loan Rejection Notification',
        subject: 'Loan Application Status',
        body: 'We regret to inform you that your loan application has been declined.',
        is_active: true
    }, 'system');
    
    // System Parameters
    addMasterRecord('system_parameters', {
        param_key: 'max_loan_amount',
        param_value: '10000',
        param_type: 'number',
        description: 'Maximum loan amount in lakhs',
        is_active: true
    }, 'system');
    
    addMasterRecord('system_parameters', {
        param_key: 'assessment_timeout',
        param_value: '300',
        param_type: 'number',
        description: 'Assessment timeout in seconds',
        is_active: true
    }, 'system');
    
    // Seed Legal & Collateral masters
    seedStateLegalRules();
    seedLegalRiskRules();
    seedPropertyTypes();
    seedEncumbranceTypes();
    
    console.log('Default master data seeded - All 23 types (including Legal & Collateral)');
    saveMastersToS3();
}

/**
 * Get all master types
 */
function getMasterTypes() {
    return Object.keys(mastersSchema.masters).map(key => ({
        key: key,
        name: mastersSchema.masters[key].name,
        description: mastersSchema.masters[key].description,
        category: mastersSchema.masters[key].category,
        count: getMasterRecords(key).length
    }));
}

/**
 * Get schema for a master type
 */
function getMasterSchema(masterType) {
    return mastersSchema.masters[masterType] || null;
}

/**
 * Get all records for a master type
 */
function getMasterRecords(masterType) {
    const data = mastersData.get(masterType);
    return data ? data.records : [];
}

/**
 * Get single master record
 */
function getMasterRecord(masterType, id) {
    const records = getMasterRecords(masterType);
    return records.find(r => r.id === id) || null;
}

/**
 * Add new master record
 */
function addMasterRecord(masterType, data, createdBy = 'admin') {
    // Get or create master type data
    let masterData = mastersData.get(masterType);
    if (!masterData) {
        masterData = { records: [] };
        mastersData.set(masterType, masterData);
    }
    
    // Generate ID
    const id = generateId(masterType);
    
    // Create record
    const record = {
        id: id,
        ...data,
        created_by: createdBy,
        created_at: new Date().toISOString(),
        updated_by: createdBy,
        updated_at: new Date().toISOString()
    };
    
    masterData.records.push(record);
    
    // Audit log
    logAudit(masterType, id, 'CREATE', null, record, createdBy);
    
    // Save to S3
    saveMastersToS3();
    
    return record;
}

/**
 * Update master record
 */
function updateMasterRecord(masterType, id, updates, updatedBy = 'admin') {
    const records = getMasterRecords(masterType);
    const index = records.findIndex(r => r.id === id);
    
    if (index === -1) {
        throw new Error('Record not found');
    }
    
    const oldRecord = { ...records[index] };
    
    // Update record
    records[index] = {
        ...records[index],
        ...updates,
        id: id, // Preserve ID
        created_by: records[index].created_by, // Preserve creator
        created_at: records[index].created_at, // Preserve creation time
        updated_by: updatedBy,
        updated_at: new Date().toISOString()
    };
    
    // Audit log
    logAudit(masterType, id, 'UPDATE', oldRecord, records[index], updatedBy);
    
    // Save to S3
    saveMastersToS3();
    
    return records[index];
}

/**
 * Delete master record
 */
function deleteMasterRecord(masterType, id, deletedBy = 'admin') {
    const masterData = mastersData.get(masterType);
    if (!masterData) {
        throw new Error('Master type not found');
    }
    
    const index = masterData.records.findIndex(r => r.id === id);
    if (index === -1) {
        throw new Error('Record not found');
    }
    
    const deletedRecord = masterData.records[index];
    
    // Remove record
    masterData.records.splice(index, 1);
    
    // Audit log
    logAudit(masterType, id, 'DELETE', deletedRecord, null, deletedBy);
    
    // Save to S3
    saveMastersToS3();
    
    return true;
}

/**
 * Generate unique ID for record
 */
function generateId(masterType) {
    const prefix = masterType.substring(0, 3).toUpperCase();
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    return `${prefix}-${timestamp}-${random}`;
}

/**
 * Log audit trail
 */
function logAudit(masterType, recordId, action, oldValue, newValue, performedBy) {
    const auditEntry = {
        id: `AUD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        master_type: masterType,
        record_id: recordId,
        action: action, // CREATE, UPDATE, DELETE
        old_value: oldValue,
        new_value: newValue,
        performed_by: performedBy,
        performed_at: new Date().toISOString(),
        ip_address: null, // Can be populated from request
        user_agent: null // Can be populated from request
    };
    
    auditLog.push(auditEntry);
    
    // Keep only last 10000 entries
    if (auditLog.length > 10000) {
        auditLog = auditLog.slice(-10000);
    }
    
    // Save audit log to S3
    saveAuditLogToS3();
}

/**
 * Get audit log
 */
function getAuditLog(filters = {}) {
    let logs = [...auditLog];
    
    // Filter by master type
    if (filters.masterType) {
        logs = logs.filter(l => l.master_type === filters.masterType);
    }
    
    // Filter by record ID
    if (filters.recordId) {
        logs = logs.filter(l => l.record_id === filters.recordId);
    }
    
    // Filter by action
    if (filters.action) {
        logs = logs.filter(l => l.action === filters.action);
    }
    
    // Filter by user
    if (filters.performedBy) {
        logs = logs.filter(l => l.performed_by === filters.performedBy);
    }
    
    // Filter by date range
    if (filters.fromDate) {
        logs = logs.filter(l => new Date(l.performed_at) >= new Date(filters.fromDate));
    }
    
    if (filters.toDate) {
        logs = logs.filter(l => new Date(l.performed_at) <= new Date(filters.toDate));
    }
    
    // Sort by date descending
    logs.sort((a, b) => new Date(b.performed_at) - new Date(a.performed_at));
    
    // Limit results
    const limit = filters.limit || 100;
    return logs.slice(0, limit);
}

/**
 * Save masters to S3
 */
async function saveMastersToS3() {
    if (!s3Client.isConfigured()) {
        return;
    }
    
    try {
        const data = {
            masters: Object.fromEntries(mastersData),
            last_updated: new Date().toISOString()
        };
        
        await s3Client.saveMasters(MASTERS_COLLECTION_KEY, data);
    } catch (err) {
        console.error('Error saving masters to S3:', err.message);
    }
}

/**
 * Save audit log to S3
 */
async function saveAuditLogToS3() {
    if (!s3Client.isConfigured()) {
        return;
    }
    
    try {
        const data = {
            logs: auditLog,
            last_updated: new Date().toISOString()
        };
        
        await s3Client.saveMasters(AUDIT_LOG_KEY, data);
    } catch (err) {
        console.error('Error saving audit log to S3:', err.message);
    }
}

/**
 * Force reseed all masters (clear and reseed)
 */
async function forceReseed() {
    console.log('Force reseeding all masters...');
    
    // Clear existing data
    mastersData.clear();
    auditLog = [];
    
    // Reseed
    seedDefaultMasters();
    
    // Count types and records
    let typesCount = mastersData.size;
    let recordsCount = 0;
    for (let [key, records] of mastersData) {
        recordsCount += records.length;
    }
    
    console.log(`Force reseed complete: ${typesCount} types, ${recordsCount} records`);
    
    return {
        types_count: typesCount,
        records_count: recordsCount
    };
}

/**
 * Seed scoring weights only (for upgrades)
 */
function seedScoringWeights() {
    console.log('📦 Seeding scoring_weights...');
    
    addMasterRecord('scoring_weights', {
        category_code: 'FINANCIAL',
        category_name: 'Financial Strength',
        max_score: 35,
        display_order: 1,
        description: 'Assessment of financial ratios including liquidity, leverage, and profitability',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_weights', {
        category_code: 'BANKING',
        category_name: 'Banking Conduct',
        max_score: 20,
        display_order: 2,
        description: 'Assessment of banking behavior, account conduct, and payment discipline',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_weights', {
        category_code: 'CREDIT_HISTORY',
        category_name: 'Credit History',
        max_score: 15,
        display_order: 3,
        description: 'Assessment of credit bureau scores and repayment history',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_weights', {
        category_code: 'BUSINESS',
        category_name: 'Business Stability',
        max_score: 15,
        display_order: 4,
        description: 'Assessment of business vintage, growth, and compliance',
        is_active: true
    }, 'system');
    
    addMasterRecord('scoring_weights', {
        category_code: 'SECURITY',
        category_name: 'Security Coverage',
        max_score: 15,
        display_order: 5,
        description: 'Assessment of collateral value and coverage',
        is_active: true
    }, 'system');
    
    console.log('✅ Seeded 5 scoring weight categories');
}

/**
 * Seed scoring metrics only (for upgrades)
 */
function seedScoringMetrics() {
    console.log('📦 Seeding scoring_metrics...');
    
    // Financial metrics
    addMasterRecord('scoring_metrics', {
        metric_code: 'CURRENT_RATIO', metric_name: 'Current Ratio', category_code: 'FINANCIAL',
        max_score: 7, threshold_1: 1.5, score_1: 7, threshold_2: 1.25, score_2: 5, threshold_3: 1.0, score_3: 3, default_score: 1,
        comparison_type: 'higher_better', display_format: 'number', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'DEBT_EQUITY', metric_name: 'Debt to Equity', category_code: 'FINANCIAL',
        max_score: 7, threshold_1: 0.5, score_1: 7, threshold_2: 1.0, score_2: 5, threshold_3: 2.0, score_3: 3, default_score: 1,
        comparison_type: 'lower_better', display_format: 'number', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'INTEREST_COVERAGE', metric_name: 'Interest Coverage', category_code: 'FINANCIAL',
        max_score: 7, threshold_1: 3.0, score_1: 7, threshold_2: 2.0, score_2: 5, threshold_3: 1.5, score_3: 3, default_score: 1,
        comparison_type: 'higher_better', display_format: 'times', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'NET_MARGIN', metric_name: 'Net Profit Margin', category_code: 'FINANCIAL',
        max_score: 7, threshold_1: 5.0, score_1: 7, threshold_2: 3.0, score_2: 5, threshold_3: 1.0, score_3: 3, default_score: 1,
        comparison_type: 'higher_better', display_format: 'percentage', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'ROE', metric_name: 'Return on Equity', category_code: 'FINANCIAL',
        max_score: 7, threshold_1: 20.0, score_1: 7, threshold_2: 15.0, score_2: 5, threshold_3: 10.0, score_3: 3, default_score: 1,
        comparison_type: 'higher_better', display_format: 'percentage', is_active: true
    }, 'system');
    
    // Banking metrics
    addMasterRecord('scoring_metrics', {
        metric_code: 'AVG_BALANCE', metric_name: 'Average Bank Balance', category_code: 'BANKING',
        max_score: 7, threshold_1: 1000000, score_1: 7, threshold_2: 500000, score_2: 5, threshold_3: 100000, score_3: 3, default_score: 1,
        comparison_type: 'higher_better', display_format: 'currency', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'CHEQUE_RETURN', metric_name: 'Cheque Return Rate', category_code: 'BANKING',
        max_score: 7, threshold_1: 1.0, score_1: 7, threshold_2: 2.0, score_2: 5, threshold_3: 5.0, score_3: 3, default_score: 0,
        comparison_type: 'lower_better', display_format: 'percentage', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'EMI_BURDEN', metric_name: 'EMI Burden Ratio', category_code: 'BANKING',
        max_score: 6, threshold_1: 30.0, score_1: 6, threshold_2: 50.0, score_2: 4, threshold_3: 70.0, score_3: 2, default_score: 0,
        comparison_type: 'lower_better', display_format: 'percentage', is_active: true
    }, 'system');
    
    // Credit History metrics
    addMasterRecord('scoring_metrics', {
        metric_code: 'CIBIL_SCORE', metric_name: 'CIBIL Score', category_code: 'CREDIT_HISTORY',
        max_score: 8, threshold_1: 750, score_1: 8, threshold_2: 700, score_2: 6, threshold_3: 650, score_3: 4, default_score: 0,
        comparison_type: 'higher_better', display_format: 'number', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'DPD_HISTORY', metric_name: 'DPD History', category_code: 'CREDIT_HISTORY',
        max_score: 7, threshold_1: 0, score_1: 7, threshold_2: 30, score_2: 4, threshold_3: 60, score_3: 2, default_score: 0,
        comparison_type: 'lower_better', display_format: 'number', is_active: true
    }, 'system');
    
    // Business metrics
    addMasterRecord('scoring_metrics', {
        metric_code: 'REVENUE_GROWTH', metric_name: 'Revenue Growth', category_code: 'BUSINESS',
        max_score: 5, threshold_1: 10.0, score_1: 5, threshold_2: 5.0, score_2: 4, threshold_3: 0.0, score_3: 2, default_score: 1,
        comparison_type: 'higher_better', display_format: 'percentage', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'BUSINESS_VINTAGE', metric_name: 'Business Vintage', category_code: 'BUSINESS',
        max_score: 5, threshold_1: 5, score_1: 5, threshold_2: 3, score_2: 4, threshold_3: 2, score_3: 2, default_score: 1,
        comparison_type: 'higher_better', display_format: 'number', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'GST_COMPLIANCE', metric_name: 'GST Filing Compliance', category_code: 'BUSINESS',
        max_score: 5, threshold_1: 100, score_1: 5, threshold_2: 90, score_2: 3, threshold_3: 75, score_3: 2, default_score: 1,
        comparison_type: 'higher_better', display_format: 'percentage', is_active: true
    }, 'system');
    
    // Security metrics
    addMasterRecord('scoring_metrics', {
        metric_code: 'COLLATERAL_VALUE', metric_name: 'Collateral Value', category_code: 'SECURITY',
        max_score: 8, threshold_1: 10000000, score_1: 8, threshold_2: 5000000, score_2: 6, threshold_3: 1000000, score_3: 4, default_score: 2,
        comparison_type: 'higher_better', display_format: 'currency', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_metrics', {
        metric_code: 'TITLE_STATUS', metric_name: 'Title Status', category_code: 'SECURITY',
        max_score: 7, threshold_1: 1, score_1: 7, threshold_2: 0, score_2: 2, threshold_3: -1, score_3: 0, default_score: 0,
        comparison_type: 'higher_better', display_format: 'number', is_active: true
    }, 'system');
    
    console.log('✅ Seeded 15 scoring metrics');
}

/**
 * Seed scoring grades only (for upgrades)
 */
function seedScoringGrades() {
    console.log('📦 Seeding scoring_grades...');
    
    addMasterRecord('scoring_grades', {
        grade: 'A+', min_score: 85, max_score: 100, decision: 'Approve',
        interest_rate_markup: 0, color_code: '#10b981',
        description: 'Excellent credit profile - Auto approve with best terms', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_grades', {
        grade: 'A', min_score: 75, max_score: 84, decision: 'Approve',
        interest_rate_markup: 0.25, color_code: '#22c55e',
        description: 'Very good credit profile - Approve with standard terms', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_grades', {
        grade: 'B+', min_score: 65, max_score: 74, decision: 'Refer to Credit Committee',
        interest_rate_markup: 0.50, color_code: '#eab308',
        description: 'Good credit profile - Refer for enhanced collateral', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_grades', {
        grade: 'B', min_score: 55, max_score: 64, decision: 'Refer to Credit Committee',
        interest_rate_markup: 1.00, color_code: '#f97316',
        description: 'Fair credit profile - Requires credit committee approval', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_grades', {
        grade: 'C', min_score: 45, max_score: 54, decision: 'Decline',
        interest_rate_markup: 2.00, color_code: '#ef4444',
        description: 'Weak credit profile - Decline unless exceptional circumstances', is_active: true
    }, 'system');
    
    addMasterRecord('scoring_grades', {
        grade: 'D', min_score: 0, max_score: 44, decision: 'Decline',
        interest_rate_markup: 0, color_code: '#dc2626',
        description: 'Poor credit profile - Auto decline', is_active: true
    }, 'system');
    
    console.log('✅ Seeded 6 scoring grades');
}

/**
 * Seed limit params only (for upgrades)
 */
function seedLimitParams() {
    console.log('📦 Seeding limit_params...');
    
    addMasterRecord('limit_params', {
        param_code: 'STOCK_MARGIN', param_name: 'Eligible Stock Margin', param_value: 75,
        param_unit: 'percentage', facility_type: 'Working Capital',
        description: 'Percentage of stock value considered eligible for drawing power', is_active: true
    }, 'system');
    
    addMasterRecord('limit_params', {
        param_code: 'DEBTOR_MARGIN', param_name: 'Eligible Debtors Margin', param_value: 60,
        param_unit: 'percentage', facility_type: 'Working Capital',
        description: 'Percentage of debtors (< 90 days) considered eligible for drawing power', is_active: true
    }, 'system');
    
    addMasterRecord('limit_params', {
        param_code: 'OD_TURNOVER_PCT', param_name: 'Overdraft as % of Turnover', param_value: 10,
        param_unit: 'percentage', facility_type: 'Overdraft',
        description: 'OD limit calculated as percentage of annual turnover', is_active: true
    }, 'system');
    
    addMasterRecord('limit_params', {
        param_code: 'TARGET_DSCR', param_name: 'Target DSCR for TL', param_value: 1.5,
        param_unit: 'times', facility_type: 'Term Loan',
        description: 'Target DSCR for calculating term loan eligibility', is_active: true
    }, 'system');
    
    addMasterRecord('limit_params', {
        param_code: 'TL_TENURE', param_name: 'Standard TL Tenure', param_value: 60,
        param_unit: 'months', facility_type: 'Term Loan',
        description: 'Standard term loan tenure for limit calculation', is_active: true
    }, 'system');
    
    addMasterRecord('limit_params', {
        param_code: 'PRINCIPAL_PCT', param_name: 'Annual Principal Repayment %', param_value: 20,
        param_unit: 'percentage', facility_type: 'Term Loan',
        description: 'Assumed annual principal repayment as % of total debt', is_active: true
    }, 'system');
    
    addMasterRecord('limit_params', {
        param_code: 'MIN_COLLATERAL_COVERAGE', param_name: 'Minimum Collateral Coverage', param_value: 125,
        param_unit: 'percentage', facility_type: 'All',
        description: 'Minimum collateral coverage required (125% = 1.25x)', is_active: true
    }, 'system');
    
    console.log('✅ Seeded 7 limit calculation parameters');
}

/**
 * Seed State Legal Rules (for Legal & Collateral)
 */
function seedStateLegalRules() {
    console.log('📦 Seeding state_legal_rules...');
    
    addMasterRecord('state_legal_rules', {
        state_code: 'MH', state_name: 'Maharashtra',
        agricultural_land_mortgageable: false, na_conversion_required: true,
        max_mortgage_period_years: 30, stamp_duty_rate: 5.0, registration_fee_rate: 1.0,
        tenancy_law_applicable: true, ceiling_act_applicable: true, ulc_exemption_required: false,
        sarfaesi_restrictions: 'Agricultural land excluded from SARFAESI. Tenanted properties require tenant consent.',
        special_zones: 'SEZ properties need SLDC approval. MIDC properties have separate norms.',
        mutation_authority: 'Talathi/Tehsildar', ec_issuing_authority: 'Sub-Registrar',
        is_active: true
    }, 'system');
    
    addMasterRecord('state_legal_rules', {
        state_code: 'GJ', state_name: 'Gujarat',
        agricultural_land_mortgageable: false, na_conversion_required: true,
        max_mortgage_period_years: 30, stamp_duty_rate: 4.9, registration_fee_rate: 1.0,
        tenancy_law_applicable: false, ceiling_act_applicable: true, ulc_exemption_required: false,
        sarfaesi_restrictions: 'Agricultural land excluded.',
        special_zones: 'GIDC properties have specific documentation requirements.',
        mutation_authority: 'Talati/Mamlatdar', ec_issuing_authority: 'Sub-Registrar',
        is_active: true
    }, 'system');
    
    addMasterRecord('state_legal_rules', {
        state_code: 'KA', state_name: 'Karnataka',
        agricultural_land_mortgageable: false, na_conversion_required: true,
        max_mortgage_period_years: 30, stamp_duty_rate: 5.6, registration_fee_rate: 1.0,
        tenancy_law_applicable: true, ceiling_act_applicable: true, ulc_exemption_required: false,
        sarfaesi_restrictions: 'Land granted under land reforms not mortgageable for 15 years.',
        special_zones: 'BDA/BBMP properties need plan sanction verification.',
        mutation_authority: 'Village Accountant/Tahsildar', ec_issuing_authority: 'Sub-Registrar',
        is_active: true
    }, 'system');
    
    addMasterRecord('state_legal_rules', {
        state_code: 'TN', state_name: 'Tamil Nadu',
        agricultural_land_mortgageable: false, na_conversion_required: true,
        max_mortgage_period_years: 30, stamp_duty_rate: 7.0, registration_fee_rate: 1.0,
        tenancy_law_applicable: true, ceiling_act_applicable: true, ulc_exemption_required: false,
        sarfaesi_restrictions: 'Patta land restrictions apply.',
        special_zones: 'CMDA/DTCP approval required for layouts.',
        mutation_authority: 'Village Administrative Officer', ec_issuing_authority: 'Sub-Registrar',
        is_active: true
    }, 'system');
    
    addMasterRecord('state_legal_rules', {
        state_code: 'DL', state_name: 'Delhi',
        agricultural_land_mortgageable: false, na_conversion_required: true,
        max_mortgage_period_years: 30, stamp_duty_rate: 6.0, registration_fee_rate: 1.0,
        tenancy_law_applicable: true, ceiling_act_applicable: false, ulc_exemption_required: false,
        sarfaesi_restrictions: 'DDA leasehold properties need NOC for mortgage.',
        special_zones: 'Unauthorized colonies have title issues. L&DO properties need permission.',
        mutation_authority: 'SDM/Revenue Dept', ec_issuing_authority: 'Sub-Registrar',
        is_active: true
    }, 'system');
    
    console.log('✅ Seeded 5 state legal rules');
}

/**
 * Seed Legal Risk Rules (for Legal & Collateral)
 */
function seedLegalRiskRules() {
    console.log('📦 Seeding legal_risk_rules...');
    
    // Ownership Rules
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-OWN-001', rule_name: 'Title Chain Break',
        risk_category: 'Ownership', condition_description: 'Break in title chain - missing link documents',
        condition_field: 'ownership_analysis.title_chain_status', condition_operator: 'equals', condition_value: 'Break',
        risk_rating: 'High', enforceability_impact: 'Not Enforceable',
        recommended_action: 'Obtain missing link documents or affidavits. Legal opinion on title validity required.',
        is_blocking: true, priority: 1, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-OWN-002', rule_name: 'POA-based Transaction',
        risk_category: 'Ownership', condition_description: 'Property acquired/sold through Power of Attorney',
        condition_field: 'ownership_analysis.title_chain_status', condition_operator: 'equals', condition_value: 'POA-based',
        risk_rating: 'High', enforceability_impact: 'Enforceable with Conditions',
        recommended_action: 'Verify POA validity. Ensure POA is registered and not revoked. Get legal opinion.',
        is_blocking: false, priority: 2, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-OWN-003', rule_name: 'Unregistered Sale Deed',
        risk_category: 'Ownership', condition_description: 'Last sale deed not registered',
        condition_field: 'ownership_analysis.title_chain_status', condition_operator: 'equals', condition_value: 'Unregistered',
        risk_rating: 'High', enforceability_impact: 'Not Enforceable',
        recommended_action: 'Sale deed must be registered. Cannot proceed without registered title.',
        is_blocking: true, priority: 1, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    // Encumbrance Rules
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-ENC-001', rule_name: 'Prior Mortgage Subsisting',
        risk_category: 'Encumbrance', condition_description: 'Existing mortgage/charge not released',
        condition_field: 'encumbrance_analysis.prior_charge_subsisting', condition_operator: 'is_true', condition_value: 'true',
        risk_rating: 'High', enforceability_impact: 'Not Enforceable',
        recommended_action: 'Obtain release/NOC from prior charge holder before mortgage creation.',
        is_blocking: true, priority: 1, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-ENC-002', rule_name: 'Attachment by Court/Authority',
        risk_category: 'Encumbrance', condition_description: 'Property attached by court or revenue authority',
        condition_field: 'encumbrance_analysis.has_adverse_entries', condition_operator: 'is_true', condition_value: 'true',
        risk_rating: 'High', enforceability_impact: 'Not Enforceable',
        recommended_action: 'Get attachment vacated before proceeding. Obtain stay order copy and case status.',
        is_blocking: true, priority: 1, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    // Litigation Rules
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-LIT-001', rule_name: 'Lis Pendens Registered',
        risk_category: 'Litigation', condition_description: 'Lis pendens registered against property',
        condition_field: 'litigation_analysis.lis_pendens', condition_operator: 'is_true', condition_value: 'true',
        risk_rating: 'High', enforceability_impact: 'Not Enforceable',
        recommended_action: 'Do not proceed until lis pendens is vacated or case disposed in favor of mortgagor.',
        is_blocking: true, priority: 1, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-LIT-002', rule_name: 'Ongoing Title Dispute',
        risk_category: 'Litigation', condition_description: 'Ongoing litigation regarding title/ownership',
        condition_field: 'litigation_analysis.has_litigation', condition_operator: 'is_true', condition_value: 'true',
        risk_rating: 'High', enforceability_impact: 'Enforceable with Conditions',
        recommended_action: 'Obtain case details, court orders. Legal opinion on impact required. Additional collateral may be needed.',
        is_blocking: false, priority: 2, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    // Land Use Rules
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-LU-001', rule_name: 'NA Conversion Pending',
        risk_category: 'Land Use', condition_description: 'Agricultural to Non-Agricultural conversion not done',
        condition_field: 'land_use_analysis.na_conversion_status', condition_operator: 'equals', condition_value: 'Pending',
        risk_rating: 'Medium', enforceability_impact: 'Enforceable with Conditions',
        recommended_action: 'NA conversion to be completed before disbursement or as condition subsequent.',
        is_blocking: false, priority: 3, applicable_property_types: 'Agricultural,Land Only', is_active: true
    }, 'system');
    
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-LU-002', rule_name: 'Zoning Non-Compliance',
        risk_category: 'Land Use', condition_description: 'Current use not compliant with zoning/master plan',
        condition_field: 'land_use_analysis.zoning_compliant', condition_operator: 'is_false', condition_value: 'false',
        risk_rating: 'Medium', enforceability_impact: 'Enforceable with Conditions',
        recommended_action: 'Verify if regularization possible. Get legal opinion on enforcement risk.',
        is_blocking: false, priority: 3, applicable_property_types: 'Commercial,Industrial', is_active: true
    }, 'system');
    
    // Revenue Rules
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-REV-001', rule_name: 'Mutation Pending',
        risk_category: 'Revenue', condition_description: 'Mutation in revenue records not completed',
        condition_field: 'revenue_municipal_analysis.mutation_status', condition_operator: 'not_equals', condition_value: 'Done',
        risk_rating: 'Medium', enforceability_impact: 'Enforceable with Conditions',
        recommended_action: 'Mutation to be completed. Obtain latest 7/12 or Khata after mutation.',
        is_blocking: false, priority: 3, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-REV-002', rule_name: 'Property Tax Dues',
        risk_category: 'Revenue', condition_description: 'Outstanding property tax dues exist',
        condition_field: 'revenue_municipal_analysis.property_tax_current', condition_operator: 'is_false', condition_value: 'false',
        risk_rating: 'Low', enforceability_impact: 'Enforceable with Conditions',
        recommended_action: 'Clear all outstanding dues before disbursement or deduct from loan amount.',
        is_blocking: false, priority: 4, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    // Stamp/Registration Rules
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-SR-001', rule_name: 'Stamp Duty Deficiency',
        risk_category: 'Stamp/Registration', condition_description: 'Documents not adequately stamped',
        condition_field: 'stamping_registration_analysis.properly_stamped', condition_operator: 'is_false', condition_value: 'false',
        risk_rating: 'Medium', enforceability_impact: 'Enforceable with Conditions',
        recommended_action: 'Adjudicate documents and pay deficit stamp duty with penalty before mortgage.',
        is_blocking: false, priority: 3, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    // Mortgage Perfection Rules
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-MP-001', rule_name: 'MOD Not Registered',
        risk_category: 'Mortgage Perfection', condition_description: 'Memorandum of Deposit not registered (where required)',
        condition_field: 'mortgage_perfection_analysis.mod_registered', condition_operator: 'is_false', condition_value: 'false',
        risk_rating: 'Medium', enforceability_impact: 'Enforceable with Conditions',
        recommended_action: 'Register MOD within 30 days of mortgage creation as per state requirements.',
        is_blocking: false, priority: 3, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-MP-002', rule_name: 'Schedule Mismatch',
        risk_category: 'Mortgage Perfection', condition_description: 'Property schedule in mortgage docs differs from title docs',
        condition_field: 'mortgage_perfection_analysis.schedule_correct', condition_operator: 'is_false', condition_value: 'false',
        risk_rating: 'High', enforceability_impact: 'Enforceable with Conditions',
        recommended_action: 'Correct schedule description. May need supplementary deed or rectification.',
        is_blocking: false, priority: 2, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    // Advocate Remarks Rules
    addMasterRecord('legal_risk_rules', {
        rule_code: 'LR-ADV-001', rule_name: 'Adverse Advocate Opinion',
        risk_category: 'Advocate Remarks', condition_description: 'Advocate has given adverse/negative remarks',
        condition_field: 'advocate_remarks.has_adverse_remarks', condition_operator: 'is_true', condition_value: 'true',
        risk_rating: 'High', enforceability_impact: 'Enforceable with Conditions',
        recommended_action: 'Review specific adverse remarks. Address conditions precedent before sanction.',
        is_blocking: false, priority: 2, applicable_property_types: 'All', is_active: true
    }, 'system');
    
    console.log('✅ Seeded 16 legal risk rules');
}

/**
 * Seed Property Types (for Legal & Collateral)
 */
function seedPropertyTypes() {
    console.log('📦 Seeding property_types...');
    
    // Residential
    addMasterRecord('property_types', {
        property_type_code: 'RES-APT', property_type_name: 'Residential Apartment/Flat',
        category: 'Residential', sub_category: 'Apartment',
        default_risk_rating: 'Low', mortgage_eligibility: 'Eligible',
        ltv_cap_percent: 75, valuation_frequency_months: 36,
        special_requirements: 'Society NOC required. Check if all installments paid to builder.',
        documents_required: 'Sale Deed, Society Share Certificate, OC/CC, Approved Plan, Tax Receipts',
        is_active: true
    }, 'system');
    
    addMasterRecord('property_types', {
        property_type_code: 'RES-HSE', property_type_name: 'Residential House/Bungalow',
        category: 'Residential', sub_category: 'Independent House',
        default_risk_rating: 'Low', mortgage_eligibility: 'Eligible',
        ltv_cap_percent: 70, valuation_frequency_months: 36,
        special_requirements: 'Check building approval and setbacks.',
        documents_required: 'Sale Deed/Conveyance, Approved Plan, OC, Tax Receipts, 7/12 or City Survey',
        is_active: true
    }, 'system');
    
    // Commercial
    addMasterRecord('property_types', {
        property_type_code: 'COM-OFF', property_type_name: 'Commercial Office Space',
        category: 'Commercial', sub_category: 'Office',
        default_risk_rating: 'Low', mortgage_eligibility: 'Eligible',
        ltv_cap_percent: 65, valuation_frequency_months: 24,
        special_requirements: 'Check FSI utilization. Verify common area maintenance arrangement.',
        documents_required: 'Sale Deed, OC, Approved Plan, Tax Receipts, Maintenance Agreement',
        is_active: true
    }, 'system');
    
    addMasterRecord('property_types', {
        property_type_code: 'COM-SHP', property_type_name: 'Commercial Shop/Showroom',
        category: 'Commercial', sub_category: 'Retail',
        default_risk_rating: 'Low', mortgage_eligibility: 'Eligible',
        ltv_cap_percent: 65, valuation_frequency_months: 24,
        special_requirements: 'Verify shop license and permitted use.',
        documents_required: 'Sale Deed, OC, Shop License, Tax Receipts',
        is_active: true
    }, 'system');
    
    // Industrial
    addMasterRecord('property_types', {
        property_type_code: 'IND-FAC', property_type_name: 'Industrial Factory/Unit',
        category: 'Industrial', sub_category: 'Manufacturing',
        default_risk_rating: 'Medium', mortgage_eligibility: 'Eligible',
        ltv_cap_percent: 60, valuation_frequency_months: 24,
        special_requirements: 'Check MIDC/GIDC allotment. Verify pollution clearances.',
        documents_required: 'Allotment Letter, Lease Deed, Factory License, Pollution NOC, Approved Plan',
        is_active: true
    }, 'system');
    
    addMasterRecord('property_types', {
        property_type_code: 'IND-WAR', property_type_name: 'Warehouse/Godown',
        category: 'Industrial', sub_category: 'Storage',
        default_risk_rating: 'Medium', mortgage_eligibility: 'Eligible',
        ltv_cap_percent: 60, valuation_frequency_months: 24,
        special_requirements: 'Check permitted storage use. Fire safety compliance required.',
        documents_required: 'Sale Deed/Lease, Approved Plan, Fire NOC, Tax Receipts',
        is_active: true
    }, 'system');
    
    // Agricultural
    addMasterRecord('property_types', {
        property_type_code: 'AGR-FRM', property_type_name: 'Agricultural Farm Land',
        category: 'Agricultural', sub_category: 'Farm Land',
        default_risk_rating: 'High', mortgage_eligibility: 'Conditional',
        ltv_cap_percent: 50, valuation_frequency_months: 12,
        special_requirements: 'Check state restrictions. NA conversion may be required. Verify ceiling limits.',
        documents_required: '7/12 Extract, Mutation Entry, Ferfar, NA Order (if applicable)',
        is_active: true
    }, 'system');
    
    // Land Only
    addMasterRecord('property_types', {
        property_type_code: 'LND-PLT', property_type_name: 'Vacant Plot/Land',
        category: 'Land Only', sub_category: 'Vacant',
        default_risk_rating: 'Medium', mortgage_eligibility: 'Conditional',
        ltv_cap_percent: 50, valuation_frequency_months: 24,
        special_requirements: 'Check approved layout. Verify development permissions.',
        documents_required: 'Sale Deed, Approved Layout, NA Order, City Survey/7-12',
        is_active: true
    }, 'system');
    
    // Mixed Use
    addMasterRecord('property_types', {
        property_type_code: 'MIX-RES', property_type_name: 'Mixed Use - Residential + Commercial',
        category: 'Mixed Use', sub_category: 'Residential Dominant',
        default_risk_rating: 'Low', mortgage_eligibility: 'Eligible',
        ltv_cap_percent: 65, valuation_frequency_months: 24,
        special_requirements: 'Verify permitted FSI for each use. Check approval for mixed use.',
        documents_required: 'Sale Deed, OC with mixed use approval, Approved Plan, Tax Receipts',
        is_active: true
    }, 'system');
    
    console.log('✅ Seeded 9 property types');
}

/**
 * Seed Encumbrance Types (for Legal & Collateral)
 */
function seedEncumbranceTypes() {
    console.log('📦 Seeding encumbrance_types...');
    
    addMasterRecord('encumbrance_types', {
        encumbrance_code: 'ENC-MTG', encumbrance_name: 'Mortgage (Registered/Equitable)',
        encumbrance_category: 'Mortgage', risk_impact: 'High',
        blocks_mortgage: true, prior_noc_required: true, can_be_released: true,
        release_mechanism: 'Release deed from mortgagee. ROC Form CHG-4 for company charges.',
        priority_ranking: 1, sarfaesi_applicable: true, typical_resolution_days: 15,
        is_active: true
    }, 'system');
    
    addMasterRecord('encumbrance_types', {
        encumbrance_code: 'ENC-CHG', encumbrance_name: 'Charge (ROC Registered)',
        encumbrance_category: 'Charge', risk_impact: 'High',
        blocks_mortgage: true, prior_noc_required: true, can_be_released: true,
        release_mechanism: 'Form CHG-4 filing with ROC within 30 days of satisfaction.',
        priority_ranking: 1, sarfaesi_applicable: true, typical_resolution_days: 30,
        is_active: true
    }, 'system');
    
    addMasterRecord('encumbrance_types', {
        encumbrance_code: 'ENC-LEN', encumbrance_name: 'Lien',
        encumbrance_category: 'Lien', risk_impact: 'Medium',
        blocks_mortgage: true, prior_noc_required: true, can_be_released: true,
        release_mechanism: 'Release letter from lien holder. Clear underlying obligation.',
        priority_ranking: 2, sarfaesi_applicable: true, typical_resolution_days: 15,
        is_active: true
    }, 'system');
    
    addMasterRecord('encumbrance_types', {
        encumbrance_code: 'ENC-LSE', encumbrance_name: 'Registered Lease',
        encumbrance_category: 'Lease', risk_impact: 'Medium',
        blocks_mortgage: false, prior_noc_required: false, can_be_released: true,
        release_mechanism: 'Lease termination deed or expiry. Check lease terms for mortgage permission.',
        priority_ranking: 3, sarfaesi_applicable: true, typical_resolution_days: 30,
        is_active: true
    }, 'system');
    
    addMasterRecord('encumbrance_types', {
        encumbrance_code: 'ENC-ATT', encumbrance_name: 'Court Attachment',
        encumbrance_category: 'Attachment', risk_impact: 'High',
        blocks_mortgage: true, prior_noc_required: true, can_be_released: true,
        release_mechanism: 'Court order vacating attachment. Disposal of underlying case.',
        priority_ranking: 1, sarfaesi_applicable: false, typical_resolution_days: 90,
        is_active: true
    }, 'system');
    
    addMasterRecord('encumbrance_types', {
        encumbrance_code: 'ENC-CRT', encumbrance_name: 'Court Order/Injunction',
        encumbrance_category: 'Court Order', risk_impact: 'High',
        blocks_mortgage: true, prior_noc_required: true, can_be_released: true,
        release_mechanism: 'Vacation of injunction. Appeal and stay of order.',
        priority_ranking: 1, sarfaesi_applicable: false, typical_resolution_days: 120,
        is_active: true
    }, 'system');
    
    addMasterRecord('encumbrance_types', {
        encumbrance_code: 'ENC-REV', encumbrance_name: 'Revenue Recovery Attachment',
        encumbrance_category: 'Revenue Recovery', risk_impact: 'High',
        blocks_mortgage: true, prior_noc_required: true, can_be_released: true,
        release_mechanism: 'Payment of revenue dues. Obtain release certificate from Collector.',
        priority_ranking: 1, sarfaesi_applicable: false, typical_resolution_days: 45,
        is_active: true
    }, 'system');
    
    addMasterRecord('encumbrance_types', {
        encumbrance_code: 'ENC-AGR', encumbrance_name: 'Agreement to Sell',
        encumbrance_category: 'Other', risk_impact: 'Medium',
        blocks_mortgage: false, prior_noc_required: true, can_be_released: true,
        release_mechanism: 'Cancellation deed or completion of sale. Verify if specific performance filed.',
        priority_ranking: 4, sarfaesi_applicable: true, typical_resolution_days: 30,
        is_active: true
    }, 'system');
    
    addMasterRecord('encumbrance_types', {
        encumbrance_code: 'ENC-POA', encumbrance_name: 'Power of Attorney (Irrevocable)',
        encumbrance_category: 'Other', risk_impact: 'Medium',
        blocks_mortgage: false, prior_noc_required: true, can_be_released: true,
        release_mechanism: 'Revocation deed (if revocable). Obtain consent from POA holder.',
        priority_ranking: 4, sarfaesi_applicable: true, typical_resolution_days: 15,
        is_active: true
    }, 'system');
    
    addMasterRecord('encumbrance_types', {
        encumbrance_code: 'ENC-LIS', encumbrance_name: 'Lis Pendens',
        encumbrance_category: 'Court Order', risk_impact: 'High',
        blocks_mortgage: true, prior_noc_required: true, can_be_released: true,
        release_mechanism: 'Disposal of suit. Court order for removal from EC.',
        priority_ranking: 1, sarfaesi_applicable: false, typical_resolution_days: 180,
        is_active: true
    }, 'system');
    
    console.log('✅ Seeded 10 encumbrance types');
}

/**
 * Update policy rule with audit trail
 * Tracks changes from policy_value to current_value
 */
function updatePolicyRule(ruleId, newValue, changedBy, reason) {
    const records = mastersData.get('policy_rules') || [];
    const ruleIndex = records.findIndex(r => r.rule_code === ruleId || r.id === ruleId);
    
    if (ruleIndex === -1) {
        throw new Error(`Policy rule ${ruleId} not found`);
    }
    
    const rule = records[ruleIndex];
    const oldValue = rule.current_value;
    
    // Create policy audit entry
    const auditEntry = {
        id: `PA${Date.now()}`,
        timestamp: new Date().toISOString(),
        rule_id: ruleId,
        parameter: rule.parameter,
        clause_ref: rule.clause_ref,
        policy_value: rule.policy_value,
        old_value: oldValue,
        new_value: newValue,
        changed_by: changedBy,
        reason: reason,
        source_policy: rule.source_policy,
        deviation: newValue !== rule.policy_value ? 
            (newValue > rule.policy_value ? 'Stricter than policy' : 'Relaxed from policy') : 
            'Matches policy'
    };
    
    policyAuditLog.unshift(auditEntry);
    
    // Update the rule
    records[ruleIndex] = {
        ...rule,
        current_value: newValue,
        last_modified: new Date().toISOString(),
        last_modified_by: changedBy,
        modification_reason: reason
    };
    
    mastersData.set('policy_rules', records);
    
    // Save to S3
    saveMastersToS3();
    savePolicyAuditToS3();
    
    return auditEntry;
}

/**
 * Get policy rules with deviation status
 */
function getPolicyRulesWithDeviation() {
    const records = mastersData.get('policy_rules') || [];
    
    return records.map(rule => ({
        ...rule,
        has_deviation: rule.current_value !== rule.policy_value,
        deviation_type: rule.current_value === rule.policy_value ? 'none' :
            (rule.operator === '>=' || rule.operator === '>') ?
                (rule.current_value > rule.policy_value ? 'stricter' : 'relaxed') :
                (rule.current_value < rule.policy_value ? 'stricter' : 'relaxed')
    }));
}

/**
 * Get policy audit log
 */
function getPolicyAuditLog() {
    return policyAuditLog;
}

/**
 * Save policy audit log to S3
 */
async function savePolicyAuditToS3() {
    if (!s3Client.isConfigured()) {
        console.log('S3 not configured, skipping policy audit save');
        return;
    }
    
    try {
        const data = {
            logs: policyAuditLog,
            last_updated: new Date().toISOString()
        };
        await s3Client.saveMasters(POLICY_AUDIT_KEY, data);
        console.log(`Saved ${policyAuditLog.length} policy audit entries to S3`);
    } catch (err) {
        console.error('Error saving policy audit to S3:', err.message);
    }
}

/**
 * Get policy metadata
 */
function getPolicyMetadata() {
    return policyRulesSchema.policy_metadata;
}

/**
 * Bulk import policy rules from uploaded document
 */
function importPolicyRules(extractedRules, sourcePolicyName, importedBy) {
    const existingRules = mastersData.get('policy_rules') || [];
    const importLog = [];
    
    extractedRules.forEach(newRule => {
        // Find matching existing rule by parameter name
        const existingIndex = existingRules.findIndex(
            r => r.parameter.toLowerCase() === newRule.parameter.toLowerCase()
        );
        
        if (existingIndex >= 0) {
            const existing = existingRules[existingIndex];
            
            // Create audit entry for the change
            const auditEntry = {
                id: `PA${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                timestamp: new Date().toISOString(),
                rule_id: existing.rule_code,
                parameter: existing.parameter,
                clause_ref: newRule.clause_ref || existing.clause_ref,
                policy_value: existing.policy_value,
                old_value: existing.current_value,
                new_value: newRule.value,
                changed_by: importedBy,
                reason: `Imported from ${sourcePolicyName}`,
                source_policy: sourcePolicyName,
                deviation: 'Policy Update'
            };
            
            policyAuditLog.unshift(auditEntry);
            
            // Update the rule
            existingRules[existingIndex] = {
                ...existing,
                policy_value: newRule.value,
                current_value: newRule.value,
                source_policy: sourcePolicyName,
                policy_text: newRule.policy_text || existing.policy_text,
                clause_ref: newRule.clause_ref || existing.clause_ref,
                last_modified: new Date().toISOString(),
                last_modified_by: importedBy
            };
            
            importLog.push({ parameter: newRule.parameter, action: 'updated', old: existing.current_value, new: newRule.value });
        } else {
            // Add new rule
            const newRecord = {
                rule_code: `IMP_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                rule_name: newRule.parameter,
                parameter: newRule.parameter,
                clause_ref: newRule.clause_ref || '',
                category: newRule.category || 'imported',
                operator: newRule.operator || '>=',
                policy_value: newRule.value,
                current_value: newRule.value,
                norm_display: `${newRule.operator || '>='} ${newRule.value}`,
                formula: newRule.formula || '',
                policy_text: newRule.policy_text || '',
                source_policy: sourcePolicyName,
                is_mandatory: true,
                applicable_product: 'All',
                severity: 'Critical',
                is_active: true,
                created_at: new Date().toISOString(),
                created_by: importedBy
            };
            
            existingRules.push(newRecord);
            importLog.push({ parameter: newRule.parameter, action: 'added', value: newRule.value });
        }
    });
    
    mastersData.set('policy_rules', existingRules);
    
    // Save to S3
    saveMastersToS3();
    savePolicyAuditToS3();
    
    return importLog;
}

/**
 * Reseed ONLY policy rules from schema (preserves other masters)
 */
function reseedPolicyRules() {
    console.log('🔄 Reseeding policy rules from schema...');
    
    // Clear existing policy rules (correct structure: { records: [] })
    mastersData.set('policy_rules', { records: [] });
    
    // Reload from policy-rules-schema.json
    const policyRulesSchema = require('./policy-rules-schema.json');
    
    policyRulesSchema.policy_rules.forEach(rule => {
        addMasterRecord('policy_rules', {
            rule_code: rule.id,
            rule_name: rule.parameter,
            parameter: rule.parameter,
            clause_ref: rule.clause_ref,
            category: rule.category,
            operator: rule.norm_operator,
            threshold_value: rule.current_value,  // Use current_value as threshold
            policy_value: rule.policy_value,
            current_value: rule.current_value,
            norm_display: rule.norm_display,
            formula: rule.formula,
            policy_text: rule.policy_text,
            source_policy: rule.source_policy,
            is_mandatory: rule.is_mandatory,
            applicable_product: 'All',
            severity: rule.is_mandatory ? 'Critical' : 'Warning',
            description: rule.policy_text,
            is_active: true
        }, 'system');
    });
    
    console.log(`✅ Reseeded ${policyRulesSchema.policy_rules.length} policy rules from MSME Credit Policy`);
    
    // Save to S3
    saveMastersToS3();
    
    return {
        count: policyRulesSchema.policy_rules.length,
        source: 'MSME Credit Policy V2024-25 / 3.2'
    };
}

module.exports = {
    initialize,
    getMasterTypes,
    getMasterSchema,
    getMasterRecords,
    getMasterRecord,
    addMasterRecord,
    updateMasterRecord,
    deleteMasterRecord,
    getAuditLog,
    forceReseed,
    reseedPolicyRules,
    // Policy-specific exports
    updatePolicyRule,
    getPolicyRulesWithDeviation,
    getPolicyAuditLog,
    getPolicyMetadata,
    importPolicyRules
};
