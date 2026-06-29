/**
 * Investigation & Fraud Database Manager
 * Handles rejected case investigations and fraud tracking
 */

const s3Client = require('./s3-client');

// In-memory storage
let investigationCases = new Map();
let fraudDatabase = new Map();

const INVESTIGATION_COLLECTION_KEY = 'investigation-cases';
const FRAUD_DATABASE_KEY = 'fraud-database';

/**
 * Initialize from S3
 */
async function initialize() {
    console.log('Initializing Investigation & Fraud Database Manager...');
    
    if (s3Client.isConfigured()) {
        try {
            // Load investigation cases
            const cases = await s3Client.getMasters(INVESTIGATION_COLLECTION_KEY);
            if (cases && cases.investigations) {
                investigationCases = new Map(Object.entries(cases.investigations));
                console.log(`Loaded ${investigationCases.size} investigation cases from S3`);
            }
            
            // Load fraud database
            const fraudData = await s3Client.getMasters(FRAUD_DATABASE_KEY);
            if (fraudData && fraudData.entities) {
                fraudDatabase = new Map(Object.entries(fraudData.entities));
                console.log(`Loaded ${fraudDatabase.size} fraud entities from S3`);
            }
        } catch (err) {
            console.error('Error loading investigation data from S3:', err.message);
        }
    }
}

/**
 * Create investigation case from rejected assessment
 */
function createInvestigationCase(assessmentData, rejectionDetails, createdBy = 'system') {
    const investigationId = `INV-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    const investigation = {
        investigation_id: investigationId,
        case_number: `CASE-${new Date().getFullYear()}-${String(investigationCases.size + 1).padStart(4, '0')}`,
        assessment_id: assessmentData.assessment_id,
        
        case_details: {
            case_type: classifyRejectionType(rejectionDetails.rejection_reason),
            case_category: rejectionDetails.rejection_category || 'Other',
            case_priority: determinePriority(rejectionDetails),
            case_status: 'Open',
            
            opened_date: new Date().toISOString(),
            opened_by: createdBy,
            assigned_to: 'fraud_team@axis.com',
            due_date: calculateDueDate(7), // 7 days from now
            closed_date: null
        },
        
        application_details: {
            company_name: assessmentData.company_name,
            cin: assessmentData.cin || '',
            pan: assessmentData.pan || '',
            gstin: assessmentData.gstin || '',
            loan_amount: assessmentData.loan_amount_lakhs || 0,
            product: assessmentData.product || 'WC',
            applied_date: assessmentData.created_at || new Date().toISOString(),
            processed_by: assessmentData.created_by || 'unknown'
        },
        
        rejection_details: {
            rejected_date: new Date().toISOString(),
            rejected_by: rejectionDetails.rejected_by || createdBy,
            rejection_reason: rejectionDetails.rejection_reason,
            rejection_category: rejectionDetails.rejection_category || 'Other',
            rejection_stage: rejectionDetails.rejection_stage || 'Final Decision'
        },
        
        fraud_indicators: [],
        investigation_timeline: [
            {
                event_id: `EVT-${Date.now()}`,
                event_date: new Date().toISOString(),
                event_type: 'Case Opened',
                description: `Investigation case opened for rejected application`,
                performed_by: createdBy,
                details: {}
            }
        ],
        investigation_findings: [],
        interviews_conducted: [],
        related_cases: [],
        
        final_decision: {
            decision: null,
            decision_date: null,
            decided_by: null,
            decision_rationale: null,
            fraud_confirmed_details: null
        },
        
        actions_taken: [],
        
        police_complaint: {
            filed: false,
            fir_number: null,
            police_station: null,
            filing_date: null,
            complaint_copy_url: null,
            status: null,
            status_updated: null
        },
        
        case_notes: [],
        
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
    
    investigationCases.set(investigationId, investigation);
    saveInvestigations();
    
    console.log(`✓ Investigation case created: ${investigationId} - ${assessmentData.company_name}`);
    
    return investigation;
}

/**
 * Classify rejection type
 */
function classifyRejectionType(reason) {
    const reasonLower = reason.toLowerCase();
    
    if (reasonLower.includes('fake') || reasonLower.includes('forged') || 
        reasonLower.includes('tampered') || reasonLower.includes('fraud')) {
        return 'Confirmed Fraud';
    }
    
    if (reasonLower.includes('discrepancy') || reasonLower.includes('mismatch') || 
        reasonLower.includes('unverifiable') || reasonLower.includes('suspicious')) {
        return 'Suspicious Application';
    }
    
    return 'Genuine Rejection';
}

/**
 * Determine case priority
 */
function determinePriority(rejectionDetails) {
    if (rejectionDetails.rejection_reason.toLowerCase().includes('fraud')) {
        return 'Critical';
    }
    if (rejectionDetails.rejection_reason.toLowerCase().includes('suspicious')) {
        return 'High';
    }
    return 'Medium';
}

/**
 * Calculate due date
 */
function calculateDueDate(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString();
}

/**
 * Add fraud indicator
 */
function addFraudIndicator(investigationId, indicator, addedBy) {
    const investigation = investigationCases.get(investigationId);
    if (!investigation) throw new Error('Investigation not found');
    
    const indicatorData = {
        indicator_id: `IND-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        indicator_type: indicator.type,
        description: indicator.description,
        severity: indicator.severity || 'Medium',
        detected_by: indicator.detected_by || 'manual',
        detected_date: new Date().toISOString(),
        detector_name: addedBy,
        evidence: indicator.evidence || [],
        verification_status: 'Unverified'
    };
    
    investigation.fraud_indicators.push(indicatorData);
    investigation.updated_at = new Date().toISOString();
    
    addTimelineEvent(investigationId, 'Evidence Added', 
        `Fraud indicator added: ${indicator.type}`, addedBy);
    
    saveInvestigations();
    return indicatorData;
}

/**
 * Add timeline event
 */
function addTimelineEvent(investigationId, eventType, description, performedBy) {
    const investigation = investigationCases.get(investigationId);
    if (!investigation) return;
    
    const event = {
        event_id: `EVT-${Date.now()}`,
        event_date: new Date().toISOString(),
        event_type: eventType,
        description: description,
        performed_by: performedBy,
        details: {}
    };
    
    investigation.investigation_timeline.push(event);
    saveInvestigations();
}

/**
 * Close investigation case
 */
function closeInvestigation(investigationId, decision, decidedBy, rationale) {
    const investigation = investigationCases.get(investigationId);
    if (!investigation) throw new Error('Investigation not found');
    
    investigation.case_details.case_status = 'Closed';
    investigation.case_details.closed_date = new Date().toISOString();
    
    investigation.final_decision = {
        decision: decision,
        decision_date: new Date().toISOString(),
        decided_by: decidedBy,
        decision_rationale: rationale,
        fraud_confirmed_details: decision === 'Fraud Confirmed' ? {
            fraud_type: 'To be determined',
            fraud_method: 'To be determined',
            estimated_loss_prevented: investigation.application_details.loan_amount,
            perpetrators: []
        } : null
    };
    
    addTimelineEvent(investigationId, 'Case Closed', 
        `Case closed with decision: ${decision}`, decidedBy);
    
    // If fraud confirmed, add to fraud database
    if (decision === 'Fraud Confirmed') {
        addToFraudDatabase(investigation, decidedBy);
    }
    
    investigation.updated_at = new Date().toISOString();
    saveInvestigations();
    
    return investigation;
}

/**
 * Add entity to fraud database
 */
function addToFraudDatabase(investigation, addedBy) {
    const entityId = `FRAUD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    const fraudEntity = {
        entity_id: entityId,
        entity_type: 'Company',
        entry_date: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        
        company_details: {
            company_name: investigation.application_details.company_name,
            cin: investigation.application_details.cin,
            pan: investigation.application_details.pan,
            gstin: investigation.application_details.gstin,
            incorporation_date: null,
            registered_address: null,
            business_type: null
        },
        
        individual_details: null, // For individual fraudsters
        
        fraud_details: {
            fraud_type: investigation.final_decision.fraud_confirmed_details?.fraud_type || 'Document Fraud',
            fraud_method: investigation.rejection_details.rejection_reason,
            fraud_date: investigation.rejection_details.rejected_date,
            amount_attempted: investigation.application_details.loan_amount,
            amount_disbursed: 0,
            detection_stage: investigation.rejection_details.rejection_stage,
            detected_by: investigation.rejection_details.rejected_by
        },
        
        related_entities: {
            directors: [],
            related_companies: [],
            related_individuals: [],
            common_addresses: [],
            common_phones: [],
            common_emails: [],
            common_ip_addresses: []
        },
        
        blacklist_status: {
            blacklisted: true,
            blacklist_date: new Date().toISOString().split('T')[0],
            blacklist_reason: investigation.final_decision.decision_rationale,
            blacklist_level: 'Permanent',
            blacklist_duration_months: null,
            blacklist_expiry: null,
            blacklisted_by: addedBy,
            scope: 'All Products',
            applicable_products: []
        },
        
        application_history: [
            {
                assessment_id: investigation.assessment_id,
                application_date: investigation.application_details.applied_date,
                amount_requested: investigation.application_details.loan_amount,
                product: investigation.application_details.product,
                status: 'Rejected - Fraud',
                rejection_reason: investigation.rejection_details.rejection_reason,
                processed_by: investigation.application_details.processed_by,
                branch: 'Unknown'
            }
        ],
        
        evidence_repository: [],
        
        legal_actions: {
            police_complaint: investigation.police_complaint,
            civil_suit: { filed: false },
            criminal_case: { filed: false }
        },
        
        reporting: {
            rbi_reported: false,
            cibil_reported: false,
            internal_circular_issued: false
        },
        
        monitoring: {
            watch_list: true,
            monitoring_level: 'High',
            last_activity_check: new Date().toISOString(),
            activity_alerts: []
        }
    };
    
    fraudDatabase.set(entityId, fraudEntity);
    saveFraudDatabase();
    
    console.log(`✓ Added to fraud database: ${entityId} - ${fraudEntity.company_details.company_name}`);
    
    return fraudEntity;
}

/**
 * Check if entity is blacklisted
 */
function checkBlacklist(identifiers) {
    const matches = [];
    
    for (const [entityId, entity] of fraudDatabase.entries()) {
        if (!entity.blacklist_status.blacklisted) continue;
        
        let matchFound = false;
        let matchType = [];
        
        // Check company identifiers
        if (identifiers.pan && entity.company_details?.pan === identifiers.pan) {
            matchFound = true;
            matchType.push('PAN');
        }
        if (identifiers.cin && entity.company_details?.cin === identifiers.cin) {
            matchFound = true;
            matchType.push('CIN');
        }
        if (identifiers.gstin && entity.company_details?.gstin === identifiers.gstin) {
            matchFound = true;
            matchType.push('GSTIN');
        }
        
        // Check director PANs
        if (identifiers.directors && Array.isArray(identifiers.directors)) {
            for (const director of identifiers.directors) {
                if (entity.related_entities.directors.some(d => d.pan === director.pan)) {
                    matchFound = true;
                    matchType.push('Director PAN');
                }
            }
        }
        
        if (matchFound) {
            matches.push({
                entity_id: entityId,
                entity_name: entity.company_details?.company_name || 'Unknown',
                match_types: matchType,
                blacklist_reason: entity.blacklist_status.blacklist_reason,
                blacklist_date: entity.blacklist_status.blacklist_date,
                fraud_type: entity.fraud_details.fraud_type,
                previous_applications: entity.application_history.length,
                blacklist_level: entity.blacklist_status.blacklist_level
            });
        }
    }
    
    return {
        blacklisted: matches.length > 0,
        matches: matches,
        risk_level: matches.length > 0 ? 'Critical' : 'Clear'
    };
}

/**
 * Get all investigation cases
 */
function getAllInvestigations(filters = {}) {
    let cases = Array.from(investigationCases.values());
    
    // Filter by status
    if (filters.status) {
        cases = cases.filter(c => c.case_details.case_status === filters.status);
    }
    
    // Filter by type
    if (filters.type) {
        cases = cases.filter(c => c.case_details.case_type === filters.type);
    }
    
    // Filter by priority
    if (filters.priority) {
        cases = cases.filter(c => c.case_details.case_priority === filters.priority);
    }
    
    // Sort by date (newest first)
    cases.sort((a, b) => new Date(b.case_details.opened_date) - new Date(a.case_details.opened_date));
    
    return cases;
}

/**
 * Get investigation by ID
 */
function getInvestigation(investigationId) {
    return investigationCases.get(investigationId) || null;
}

/**
 * Update investigation
 */
function updateInvestigation(investigationId, updates, updatedBy) {
    const investigation = investigationCases.get(investigationId);
    if (!investigation) throw new Error('Investigation not found');
    
    Object.assign(investigation, updates);
    investigation.updated_at = new Date().toISOString();
    
    addTimelineEvent(investigationId, 'Case Updated', 
        'Investigation case updated', updatedBy);
    
    saveInvestigations();
    return investigation;
}

/**
 * Search fraud database
 */
function searchFraudDatabase(query) {
    const results = [];
    const queryLower = query.toLowerCase();
    
    for (const [entityId, entity] of fraudDatabase.entries()) {
        let match = false;
        
        // Search by company name
        if (entity.company_details?.company_name?.toLowerCase().includes(queryLower)) {
            match = true;
        }
        
        // Search by PAN
        if (entity.company_details?.pan?.toLowerCase().includes(queryLower)) {
            match = true;
        }
        
        // Search by CIN
        if (entity.company_details?.cin?.toLowerCase().includes(queryLower)) {
            match = true;
        }
        
        if (match) {
            results.push(entity);
        }
    }
    
    return results;
}

/**
 * Get investigation statistics
 */
function getStatistics() {
    const cases = Array.from(investigationCases.values());
    
    return {
        total_cases: cases.length,
        open_cases: cases.filter(c => c.case_details.case_status === 'Open').length,
        under_investigation: cases.filter(c => c.case_details.case_status === 'Under Investigation').length,
        closed_cases: cases.filter(c => c.case_details.case_status === 'Closed').length,
        fraud_confirmed: cases.filter(c => c.final_decision.decision === 'Fraud Confirmed').length,
        suspicious: cases.filter(c => c.case_details.case_type === 'Suspicious Application').length,
        genuine_rejections: cases.filter(c => c.case_details.case_type === 'Genuine Rejection').length,
        blacklisted_entities: fraudDatabase.size,
        critical_priority: cases.filter(c => c.case_details.case_priority === 'Critical').length
    };
}

/**
 * Save investigations to S3
 */
async function saveInvestigations() {
    if (!s3Client.isConfigured()) return;
    
    try {
        const data = {
            investigations: Object.fromEntries(investigationCases),
            last_updated: new Date().toISOString()
        };
        await s3Client.saveMasters(INVESTIGATION_COLLECTION_KEY, data);
    } catch (err) {
        console.error('Error saving investigations to S3:', err.message);
    }
}

/**
 * Save fraud database to S3
 */
async function saveFraudDatabase() {
    if (!s3Client.isConfigured()) return;
    
    try {
        const data = {
            entities: Object.fromEntries(fraudDatabase),
            last_updated: new Date().toISOString()
        };
        await s3Client.saveMasters(FRAUD_DATABASE_KEY, data);
    } catch (err) {
        console.error('Error saving fraud database to S3:', err.message);
    }
}

module.exports = {
    initialize,
    createInvestigationCase,
    addFraudIndicator,
    closeInvestigation,
    checkBlacklist,
    getAllInvestigations,
    getInvestigation,
    updateInvestigation,
    searchFraudDatabase,
    getStatistics,
    addToFraudDatabase
};
