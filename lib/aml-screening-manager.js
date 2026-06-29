/**
 * AML Screening Manager
 * Uses masters data to screen entities against configured lists
 */

const mastersManager = require('./masters-manager');
const s3Client = require('./s3-client');

// In-memory storage for screening results
let screeningResults = new Map();

const SCREENING_RESULTS_KEY = 'aml-screening-results';

/**
 * Initialize from S3
 */
async function initialize() {
    console.log('Initializing AML Screening Manager...');
    
    if (s3Client.isConfigured()) {
        try {
            const data = await s3Client.getMasters(SCREENING_RESULTS_KEY);
            if (data && data.results) {
                screeningResults = new Map(Object.entries(data.results));
                console.log(`Loaded ${screeningResults.size} AML screening results from S3`);
            }
        } catch (err) {
            console.error('Error loading AML screening results from S3:', err.message);
        }
    }
}

/**
 * Screen an assessment
 */
async function screenAssessment(assessmentData, screenedBy = 'system') {
    console.log(`🔍 Screening assessment: ${assessmentData.assessment_id}`);
    
    const screeningId = `SCR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    // Get active screening lists from masters
    const activeLists = mastersManager.getMasterRecords('aml_screening_lists')
        .filter(list => list.is_active && list.auto_screen);
    
    console.log(`Found ${activeLists.length} active screening lists`);
    
    // Prepare entities to screen
    const entitiesToScreen = prepareEntities(assessmentData);
    
    const screeningResult = {
        screening_id: screeningId,
        assessment_id: assessmentData.assessment_id,
        screening_date: new Date().toISOString(),
        screened_by: screenedBy,
        
        entities_screened: [],
        
        overall_status: 'Clear',
        risk_level: 'Low',
        
        auto_decisions: {
            proceed_to_processing: true,
            require_manual_review: false,
            auto_reject: false
        },
        
        manual_override: {
            overridden: false,
            override_by: null,
            override_date: null,
            override_reason: null,
            override_decision: null
        }
    };
    
    // Screen each entity
    for (const entity of entitiesToScreen) {
        const entityResult = await screenEntity(entity, activeLists);
        screeningResult.entities_screened.push(entityResult);
        
        // Update overall status based on entity results
        if (entityResult.screening_status === 'Confirmed Match') {
            screeningResult.overall_status = 'Blocked';
            screeningResult.risk_level = 'Critical';
            screeningResult.auto_decisions.auto_reject = true;
            screeningResult.auto_decisions.proceed_to_processing = false;
        } else if (entityResult.screening_status === 'Potential Match' && 
                   screeningResult.overall_status !== 'Blocked') {
            screeningResult.overall_status = 'Flagged';
            screeningResult.risk_level = 'High';
            screeningResult.auto_decisions.require_manual_review = true;
            screeningResult.auto_decisions.proceed_to_processing = false;
        }
    }
    
    // Apply screening rules from masters
    applyScreeningRules(screeningResult);
    
    // Save result
    screeningResults.set(screeningId, screeningResult);
    await saveScreeningResults();
    
    console.log(`✓ Screening complete: ${screeningResult.overall_status} - Risk: ${screeningResult.risk_level}`);
    
    return screeningResult;
}

/**
 * Prepare entities for screening
 */
function prepareEntities(assessmentData) {
    const entities = [];
    
    // Add company
    entities.push({
        entity_type: 'Company',
        entity_name: assessmentData.company_name,
        identifiers: {
            pan: assessmentData.pan || null,
            cin: assessmentData.cin || null,
            gstin: assessmentData.gstin || null
        }
    });
    
    // Add directors (if available)
    if (assessmentData.directors && Array.isArray(assessmentData.directors)) {
        assessmentData.directors.forEach(director => {
            entities.push({
                entity_type: 'Director',
                entity_name: director.name,
                identifiers: {
                    pan: director.pan || null,
                    din: director.din || null
                }
            });
        });
    }
    
    return entities;
}

/**
 * Screen single entity against all lists
 */
async function screenEntity(entity, activeLists) {
    const entityResult = {
        entity_type: entity.entity_type,
        entity_name: entity.entity_name,
        identifiers: entity.identifiers,
        screening_status: 'Clear',
        matches: []
    };
    
    // Get watchlist entities from masters
    const watchlistEntities = mastersManager.getMasterRecords('aml_watchlist_entities')
        .filter(e => e.is_active);
    
    // Screen against each watchlist entity
    for (const watchlistEntity of watchlistEntities) {
        const matchScore = calculateMatchScore(entity, watchlistEntity);
        
        if (matchScore > 50) { // Only consider matches above 50%
            const listConfig = activeLists.find(l => 
                watchlistEntity.screening_lists.includes(l.list_code)
            );
            
            if (listConfig) {
                const match = {
                    match_id: `MATCH-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                    list_name: listConfig.list_name,
                    list_code: listConfig.list_code,
                    matched_name: watchlistEntity.entity_name,
                    match_score: matchScore,
                    match_type: matchScore >= 95 ? 'Exact' : matchScore >= 80 ? 'Fuzzy' : 'Partial',
                    match_fields: getMatchFields(entity, watchlistEntity),
                    
                    matched_entity_details: {
                        name: watchlistEntity.entity_name,
                        aliases: watchlistEntity.aliases ? watchlistEntity.aliases.split(',').map(a => a.trim()) : [],
                        identifiers: {
                            [watchlistEntity.identifier_type || 'unknown']: watchlistEntity.identifier_value || ''
                        },
                        addresses: watchlistEntity.addresses ? watchlistEntity.addresses.split('\n') : [],
                        reason_for_listing: watchlistEntity.reason_for_listing,
                        listing_date: watchlistEntity.listed_date,
                        source: watchlistEntity.source
                    },
                    
                    match_status: matchScore >= 95 ? 'True Positive' : 'Under Review',
                    reviewed_by: null,
                    review_date: null,
                    review_comments: null
                };
                
                entityResult.matches.push(match);
                
                // Update entity screening status
                if (matchScore >= listConfig.match_threshold_auto_reject) {
                    entityResult.screening_status = 'Confirmed Match';
                } else if (matchScore >= listConfig.match_threshold_review && 
                           entityResult.screening_status !== 'Confirmed Match') {
                    entityResult.screening_status = 'Potential Match';
                }
            }
        }
    }
    
    // Check whitelist to avoid false positives
    const whitelisted = checkWhitelist(entity);
    if (whitelisted && entityResult.matches.length > 0) {
        entityResult.matches.forEach(match => {
            match.match_status = 'False Positive';
            match.review_comments = 'Whitelisted entity';
        });
        entityResult.screening_status = 'Clear';
    }
    
    return entityResult;
}

/**
 * Calculate match score between entity and watchlist entry
 */
function calculateMatchScore(entity, watchlistEntity) {
    let score = 0;
    let factors = 0;
    
    // Name matching (most important - 60% weight)
    const nameScore = calculateNameSimilarity(
        entity.entity_name.toLowerCase(),
        watchlistEntity.entity_name.toLowerCase()
    );
    score += nameScore * 60;
    factors += 60;
    
    // Identifier matching (40% weight)
    if (entity.identifiers.pan && watchlistEntity.identifier_value) {
        if (entity.identifiers.pan === watchlistEntity.identifier_value) {
            score += 40; // Exact identifier match
        }
        factors += 40;
    }
    
    return factors > 0 ? Math.round(score / factors * 100) : 0;
}

/**
 * Calculate name similarity using Levenshtein distance
 */
function calculateNameSimilarity(name1, name2) {
    // Simple similarity check - in production, use proper fuzzy matching library
    if (name1 === name2) return 1.0;
    
    // Check if one contains the other
    if (name1.includes(name2) || name2.includes(name1)) return 0.85;
    
    // Calculate Levenshtein distance (simplified)
    const maxLength = Math.max(name1.length, name2.length);
    const distance = levenshteinDistance(name1, name2);
    const similarity = 1 - (distance / maxLength);
    
    return Math.max(0, similarity);
}

/**
 * Levenshtein distance algorithm
 */
function levenshteinDistance(str1, str2) {
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix = [];
    
    for (let i = 0; i <= len1; i++) {
        matrix[i] = [i];
    }
    
    for (let j = 0; j <= len2; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }
    
    return matrix[len1][len2];
}

/**
 * Get fields that matched
 */
function getMatchFields(entity, watchlistEntity) {
    const fields = ['name'];
    
    if (entity.identifiers.pan && 
        entity.identifiers.pan === watchlistEntity.identifier_value) {
        fields.push('pan');
    }
    
    return fields;
}

/**
 * Check if entity is whitelisted
 */
function checkWhitelist(entity) {
    const whitelist = mastersManager.getMasterRecords('aml_whitelist')
        .filter(w => w.is_active);
    
    return whitelist.some(w => 
        w.entity_identifier === entity.identifiers.pan ||
        w.entity_identifier === entity.identifiers.cin
    );
}

/**
 * Apply screening rules from masters
 */
function applyScreeningRules(screeningResult) {
    const rules = mastersManager.getMasterRecords('aml_screening_rules')
        .filter(r => r.is_active)
        .sort((a, b) => {
            // Sort by priority: Critical > High > Medium > Low
            const priorityOrder = { 'Critical': 0, 'High': 1, 'Medium': 2, 'Low': 3 };
            return (priorityOrder[a.priority] || 999) - (priorityOrder[b.priority] || 999);
        });
    
    for (const rule of rules) {
        // Check if any matches fall within this rule's score range
        for (const entity of screeningResult.entities_screened) {
            for (const match of entity.matches) {
                if (match.match_score >= rule.match_score_min && 
                    match.match_score <= rule.match_score_max) {
                    
                    // Check if rule applies to this list
                    if (rule.applicable_lists === 'ALL' || 
                        rule.applicable_lists.includes(match.list_code)) {
                        
                        // Apply rule action
                        if (rule.action === 'Auto Reject') {
                            screeningResult.overall_status = 'Blocked';
                            screeningResult.auto_decisions.auto_reject = true;
                            screeningResult.auto_decisions.proceed_to_processing = false;
                            screeningResult.risk_level = 'Critical';
                        } else if (rule.action === 'Manual Review') {
                            if (screeningResult.overall_status !== 'Blocked') {
                                screeningResult.overall_status = 'Flagged';
                                screeningResult.auto_decisions.require_manual_review = true;
                                screeningResult.auto_decisions.proceed_to_processing = false;
                            }
                            if (screeningResult.risk_level === 'Low') {
                                screeningResult.risk_level = 'High';
                            }
                        }
                        
                        console.log(`Applied rule: ${rule.rule_name} for match score ${match.match_score}`);
                    }
                }
            }
        }
    }
}

/**
 * Get screening result
 */
function getScreeningResult(screeningId) {
    return screeningResults.get(screeningId) || null;
}

/**
 * Get screening result by assessment ID
 */
function getScreeningByAssessmentId(assessmentId) {
    for (const [id, result] of screeningResults.entries()) {
        if (result.assessment_id === assessmentId) {
            return result;
        }
    }
    return null;
}

/**
 * Manual override of screening result
 */
function overrideScreening(screeningId, decision, overrideBy, reason) {
    const screening = screeningResults.get(screeningId);
    if (!screening) throw new Error('Screening not found');
    
    screening.manual_override = {
        overridden: true,
        override_by: overrideBy,
        override_date: new Date().toISOString(),
        override_reason: reason,
        override_decision: decision
    };
    
    // Update auto decisions based on override
    if (decision === 'Proceed') {
        screening.auto_decisions.proceed_to_processing = true;
        screening.auto_decisions.auto_reject = false;
        screening.auto_decisions.require_manual_review = false;
    } else if (decision === 'Reject') {
        screening.auto_decisions.auto_reject = true;
        screening.auto_decisions.proceed_to_processing = false;
    }
    
    saveScreeningResults();
    return screening;
}

/**
 * Save screening results to S3
 */
async function saveScreeningResults() {
    if (!s3Client.isConfigured()) return;
    
    try {
        const data = {
            results: Object.fromEntries(screeningResults),
            last_updated: new Date().toISOString()
        };
        await s3Client.saveMasters(SCREENING_RESULTS_KEY, data);
    } catch (err) {
        console.error('Error saving AML screening results to S3:', err.message);
    }
}

module.exports = {
    initialize,
    screenAssessment,
    getScreeningResult,
    getScreeningByAssessmentId,
    overrideScreening
};
