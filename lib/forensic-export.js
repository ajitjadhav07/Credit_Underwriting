/**
 * Forensic Export Module - Complete Case Extraction for Audit/Legal
 * 
 * VERSION: 1.0.0
 * CREATED: February 5, 2025
 * 
 * Purpose:
 * - RBI Regulatory Audits
 * - Legal Discovery
 * - Internal Investigations
 * - Disaster Recovery
 * 
 * Features:
 * - Complete assessment data export
 * - Source document retrieval from S3
 * - OCR output inclusion
 * - AI processing logs
 * - Full audit trail
 * - PII access history
 * - Decision trail with policy references
 * - Edit history with before/after values
 * - Tamper-evident checksums (SHA256)
 * - Structured folder hierarchy
 */

'use strict';

const crypto = require('crypto');
const path = require('path');

/**
 * Generate SHA256 hash of content
 */
function generateHash(content) {
    if (Buffer.isBuffer(content)) {
        return crypto.createHash('sha256').update(content).digest('hex');
    }
    return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * Generate timestamp string for filenames
 */
function getTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Create forensic export package
 * @param {Object} assessment - Full assessment object
 * @param {Object} s3Client - S3 client for fetching documents
 * @param {Object} options - Export options
 * @returns {Object} Export package with files and manifest
 */
async function createForensicExport(assessment, s3Client, options = {}) {
    const {
        includeDocuments = true,
        includeOCR = true,
        includeAILogs = true,
        includePIIAccessLogs = true,
        exportReason = 'Not specified',
        exportedBy = 'Unknown',
        piiAccessLogs = [] // Pass filtered PII logs for this case
    } = options;

    const assessmentId = assessment.assessment_id;
    const timestamp = getTimestamp();
    const exportId = `FORENSIC_${assessmentId}_${timestamp}`;
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📦 FORENSIC EXPORT: ${exportId}`);
    console.log(`   Assessment: ${assessmentId}`);
    console.log(`   Company: ${assessment.company_name}`);
    console.log(`   Reason: ${exportReason}`);
    console.log(`   Exported By: ${exportedBy}`);
    console.log(`${'='.repeat(60)}\n`);

    // Initialize export structure
    const exportPackage = {
        exportId: exportId,
        files: {},
        manifest: {
            exportId: exportId,
            assessmentId: assessmentId,
            companyName: assessment.company_name,
            exportedAt: new Date().toISOString(),
            exportedBy: exportedBy,
            exportReason: exportReason,
            platformVersion: '7.4.0',
            files: [],
            checksums: {}
        }
    };

    // ==================== 1. CASE SUMMARY ====================
    const caseSummary = {
        assessment_id: assessmentId,
        company_name: assessment.company_name,
        industry_type: assessment.industry_type,
        loan_amount_lakhs: assessment.loan_amount_lakhs,
        status: assessment.status,
        grade: assessment.grade,
        score: assessment.score,
        decision: assessment.decision,
        created_at: assessment.created_at,
        processed_at: assessment.processed_at,
        last_modified: assessment.last_edited_at || assessment.processed_at,
        created_by: assessment.created_by,
        processed_by: assessment.processed_by,
        documents_uploaded: Object.keys(assessment.documents || {}).length,
        has_edits: !!(assessment.edit_audit_trail?.length > 0),
        edit_count: assessment.edit_audit_trail?.length || 0,
        reprocess_count: assessment.reprocess_history?.length || 0
    };
    
    addFileToExport(exportPackage, 'case_summary.json', caseSummary);
    console.log('✅ Case summary created');

    // ==================== 2. FULL ASSESSMENT DATA ====================
    // Create sanitized assessment (remove binary data)
    const sanitizedAssessment = sanitizeAssessment(assessment);
    
    addFileToExport(exportPackage, 'assessment_data/full_assessment.json', sanitizedAssessment);
    console.log('✅ Full assessment data exported');

    // ==================== 3. EXTRACTED DATA ====================
    if (assessment.extracted_data) {
        addFileToExport(exportPackage, 'assessment_data/extracted_data.json', assessment.extracted_data);
    }
    if (assessment.all_extracted_data) {
        addFileToExport(exportPackage, 'assessment_data/all_extracted_data.json', assessment.all_extracted_data);
    }
    console.log('✅ Extracted data exported');

    // ==================== 4. CALCULATIONS & RATIOS ====================
    if (assessment.calculations) {
        addFileToExport(exportPackage, 'assessment_data/calculations.json', assessment.calculations);
    }
    if (assessment.policy_compliance) {
        addFileToExport(exportPackage, 'assessment_data/policy_compliance.json', assessment.policy_compliance);
    }
    if (assessment.recommended_limits) {
        addFileToExport(exportPackage, 'assessment_data/recommended_limits.json', assessment.recommended_limits);
    }
    console.log('✅ Calculations and ratios exported');

    // ==================== 5. DECISION TRAIL ====================
    const decisionTrail = {
        final_decision: assessment.decision,
        final_status: assessment.status,
        final_grade: assessment.grade,
        final_score: assessment.score,
        policy_compliance: assessment.policy_compliance,
        risk_factors: extractRiskFactors(assessment),
        scoring_breakdown: assessment.calculations?.credit_score || null,
        decision_timestamp: assessment.processed_at,
        decision_by: assessment.processed_by || 'System'
    };
    addFileToExport(exportPackage, 'decision_trail/final_decision.json', decisionTrail);
    
    if (assessment.policy_compliance) {
        addFileToExport(exportPackage, 'decision_trail/policy_rules_applied.json', assessment.policy_compliance);
    }
    console.log('✅ Decision trail exported');

    // ==================== 6. AUDIT TRAIL ====================
    const auditTrail = {
        creation: {
            created_at: assessment.created_at,
            created_by: assessment.created_by
        },
        processing: {
            processing_started_at: assessment.processing_started_at,
            processed_at: assessment.processed_at,
            processed_by: assessment.processed_by,
            processing_mode: assessment.processing_mode,
            processing_time_ms: assessment.processing_time
        },
        edits: assessment.edit_audit_trail || [],
        reprocessing: assessment.reprocess_history || [],
        status_changes: assessment.audit_trail || [],
        last_modified: {
            last_edited_at: assessment.last_edited_at,
            last_edited_by: assessment.last_edited_by,
            last_reprocessed_at: assessment.last_reprocessed_at,
            last_reprocessed_by: assessment.last_reprocessed_by
        }
    };
    addFileToExport(exportPackage, 'audit_trail/full_audit_trail.json', auditTrail);
    
    if (assessment.edit_audit_trail?.length > 0) {
        addFileToExport(exportPackage, 'audit_trail/edit_history.json', assessment.edit_audit_trail);
    }
    if (assessment.reprocess_history?.length > 0) {
        addFileToExport(exportPackage, 'audit_trail/reprocess_history.json', assessment.reprocess_history);
    }
    if (assessment.audit_trail?.length > 0) {
        addFileToExport(exportPackage, 'audit_trail/status_changes.json', assessment.audit_trail);
    }
    console.log('✅ Audit trail exported');

    // ==================== 7. AI PROCESSING LOGS ====================
    if (includeAILogs) {
        if (assessment.api_logs?.length > 0) {
            addFileToExport(exportPackage, 'ai_processing/api_calls.json', assessment.api_logs);
        }
        if (assessment.api_stats) {
            addFileToExport(exportPackage, 'ai_processing/api_stats.json', assessment.api_stats);
        }
        if (assessment.document_timings) {
            addFileToExport(exportPackage, 'ai_processing/document_timings.json', assessment.document_timings);
        }
        if (assessment.extraction_summary) {
            addFileToExport(exportPackage, 'ai_processing/extraction_summary.json', assessment.extraction_summary);
        }
        console.log('✅ AI processing logs exported');
    }

    // ==================== 8. PII ACCESS LOGS ====================
    if (includePIIAccessLogs && piiAccessLogs.length > 0) {
        addFileToExport(exportPackage, 'audit_trail/pii_access_log.json', piiAccessLogs);
        console.log(`✅ PII access logs exported (${piiAccessLogs.length} entries)`);
    }

    // ==================== 9. SOURCE DOCUMENTS ====================
    if (includeDocuments && assessment.documents) {
        const documents = assessment.documents;
        let docCount = 0;
        
        for (const [key, docInfo] of Object.entries(documents)) {
            try {
                let docBuffer = null;
                let docName = docInfo.fileName || `${key}.pdf`;
                
                // Try to get from S3
                if (docInfo.s3Key && s3Client?.isConfigured?.()) {
                    try {
                        docBuffer = await s3Client.getFile(docInfo.s3Key);
                        console.log(`   📄 Retrieved from S3: ${docInfo.s3Key}`);
                    } catch (s3Err) {
                        console.warn(`   ⚠️ Failed to retrieve from S3: ${docInfo.s3Key}`);
                    }
                }
                
                // Fall back to in-memory buffer
                if (!docBuffer && docInfo.buffer) {
                    docBuffer = docInfo.buffer;
                }
                
                if (docBuffer) {
                    const safeName = sanitizeFileName(docName);
                    const docPath = `source_documents/${safeName}`;
                    
                    // Store document metadata
                    const docMeta = {
                        originalKey: key,
                        fileName: docName,
                        docType: docInfo.docType,
                        uploadedAt: docInfo.uploadedAt,
                        size: docInfo.size || docBuffer.length,
                        s3Key: docInfo.s3Key || null
                    };
                    
                    exportPackage.files[docPath] = {
                        content: docBuffer,
                        isBuffer: true
                    };
                    exportPackage.manifest.files.push(docPath);
                    exportPackage.manifest.checksums[docPath] = generateHash(docBuffer);
                    
                    // Also save metadata
                    addFileToExport(exportPackage, `source_documents/metadata/${key}_meta.json`, docMeta);
                    
                    docCount++;
                }
            } catch (err) {
                console.error(`   ❌ Error processing document ${key}:`, err.message);
            }
        }
        console.log(`✅ Source documents exported (${docCount} files)`);
    }

    // ==================== 10. OCR OUTPUT ====================
    if (includeOCR && assessment.ocr_results) {
        for (const [docKey, ocrData] of Object.entries(assessment.ocr_results)) {
            addFileToExport(exportPackage, `ocr_output/${docKey}_ocr.json`, ocrData);
        }
        console.log('✅ OCR output exported');
    }

    // ==================== 11. SYSTEM METADATA ====================
    const systemMetadata = {
        export_version: '1.0.0',
        platform_version: '7.4.0',
        export_timestamp: new Date().toISOString(),
        export_reason: exportReason,
        exported_by: exportedBy,
        node_version: process.version,
        assessment_version: assessment.version || 'unknown',
        s3_bucket: process.env.S3_BUCKET_NAME || 'N/A',
        environment: process.env.NODE_ENV || 'development'
    };
    addFileToExport(exportPackage, 'metadata/system_info.json', systemMetadata);
    console.log('✅ System metadata exported');

    // ==================== 12. README ====================
    const readme = generateReadme(exportPackage, assessment, options);
    exportPackage.files['README.txt'] = { content: readme, isBuffer: false };
    exportPackage.manifest.files.push('README.txt');
    exportPackage.manifest.checksums['README.txt'] = generateHash(readme);

    // ==================== 13. FINALIZE MANIFEST ====================
    // Add manifest hash (hash of all other hashes)
    const allHashes = Object.values(exportPackage.manifest.checksums).join('');
    exportPackage.manifest.integrityHash = generateHash(allHashes);
    exportPackage.manifest.fileCount = exportPackage.manifest.files.length;
    
    // Add manifest to files (after calculating integrity)
    const manifestJson = JSON.stringify(exportPackage.manifest, null, 2);
    exportPackage.files['manifest.json'] = { content: manifestJson, isBuffer: false };

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ FORENSIC EXPORT COMPLETE`);
    console.log(`   Files: ${exportPackage.manifest.fileCount}`);
    console.log(`   Integrity Hash: ${exportPackage.manifest.integrityHash.substring(0, 16)}...`);
    console.log(`${'='.repeat(60)}\n`);

    return exportPackage;
}

/**
 * Add a file to the export package
 */
function addFileToExport(exportPackage, filePath, content) {
    const jsonContent = JSON.stringify(content, null, 2);
    exportPackage.files[filePath] = { content: jsonContent, isBuffer: false };
    exportPackage.manifest.files.push(filePath);
    exportPackage.manifest.checksums[filePath] = generateHash(jsonContent);
}

/**
 * Sanitize assessment object (remove binary data, circular refs)
 */
function sanitizeAssessment(assessment) {
    const sanitized = {};
    
    for (const [key, value] of Object.entries(assessment)) {
        // Skip binary buffers
        if (key === 'documents') {
            // Only include document metadata, not buffers
            sanitized.documents = {};
            if (value) {
                for (const [docKey, docInfo] of Object.entries(value)) {
                    sanitized.documents[docKey] = {
                        docType: docInfo.docType,
                        uploadedAt: docInfo.uploadedAt,
                        size: docInfo.size,
                        fileName: docInfo.fileName,
                        s3Key: docInfo.s3Key
                    };
                }
            }
        } else if (Buffer.isBuffer(value)) {
            sanitized[key] = '[BINARY_DATA]';
        } else if (typeof value === 'object' && value !== null) {
            // Recursively sanitize nested objects
            try {
                sanitized[key] = JSON.parse(JSON.stringify(value));
            } catch (e) {
                sanitized[key] = '[CIRCULAR_REFERENCE]';
            }
        } else {
            sanitized[key] = value;
        }
    }
    
    return sanitized;
}

/**
 * Extract risk factors from assessment
 */
function extractRiskFactors(assessment) {
    const risks = [];
    
    // Check policy compliance
    if (assessment.policy_compliance) {
        for (const [key, compliance] of Object.entries(assessment.policy_compliance)) {
            if (compliance.status === 'fail' || compliance.status === 'warning') {
                risks.push({
                    category: key,
                    status: compliance.status,
                    message: compliance.message || compliance.reason,
                    actual: compliance.actual,
                    threshold: compliance.threshold
                });
            }
        }
    }
    
    // Check calculations for negative indicators
    if (assessment.calculations) {
        const calcs = assessment.calculations;
        
        if (calcs.current_ratio?.fy25 < 1) {
            risks.push({ category: 'liquidity', indicator: 'current_ratio', value: calcs.current_ratio.fy25, threshold: 1 });
        }
        if (calcs.debt_equity_ratio?.fy25 > 3) {
            risks.push({ category: 'leverage', indicator: 'debt_equity_ratio', value: calcs.debt_equity_ratio.fy25, threshold: 3 });
        }
        if (calcs.net_profit_margin?.fy25 < 0) {
            risks.push({ category: 'profitability', indicator: 'net_profit_margin', value: calcs.net_profit_margin.fy25, threshold: 0 });
        }
    }
    
    return risks;
}

/**
 * Sanitize filename for safe storage
 */
function sanitizeFileName(name) {
    return name
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/__+/g, '_')
        .substring(0, 200);
}

/**
 * Generate README file
 */
function generateReadme(exportPackage, assessment, options) {
    return `
================================================================================
                        FORENSIC EXPORT - README
================================================================================

Export ID: ${exportPackage.exportId}
Assessment ID: ${assessment.assessment_id}
Company: ${assessment.company_name}
Export Date: ${new Date().toISOString()}
Exported By: ${options.exportedBy}
Reason: ${options.exportReason}

================================================================================
                           CONTENTS
================================================================================

This forensic export contains the complete audit trail and data for the above
credit assessment case. The following sections are included:

1. CASE SUMMARY (case_summary.json)
   - High-level overview of the assessment

2. ASSESSMENT DATA (assessment_data/)
   - full_assessment.json - Complete assessment object
   - extracted_data.json - All extracted financial data
   - calculations.json - Calculated ratios and metrics
   - policy_compliance.json - Policy rule compliance status
   - recommended_limits.json - Recommended credit limits

3. DECISION TRAIL (decision_trail/)
   - final_decision.json - Final decision with reasoning
   - policy_rules_applied.json - Which rules were triggered

4. AUDIT TRAIL (audit_trail/)
   - full_audit_trail.json - Complete action history
   - edit_history.json - All edits with before/after values
   - reprocess_history.json - Reprocessing events
   - status_changes.json - Status change log
   - pii_access_log.json - Who accessed sensitive data

5. AI PROCESSING (ai_processing/)
   - api_calls.json - Claude API call logs
   - api_stats.json - Token usage statistics
   - document_timings.json - Processing time per document
   - extraction_summary.json - Extraction results summary

6. SOURCE DOCUMENTS (source_documents/)
   - Original uploaded PDF/image files
   - metadata/ - Metadata for each document

7. OCR OUTPUT (ocr_output/)
   - Raw OCR extraction results per document

8. METADATA (metadata/)
   - system_info.json - Platform and export information

================================================================================
                        INTEGRITY VERIFICATION
================================================================================

This export includes SHA256 checksums for all files in manifest.json.

To verify integrity:
1. Open manifest.json
2. For each file listed, compute its SHA256 hash
3. Compare with the hash in manifest.checksums
4. Verify the integrityHash matches the hash of all individual hashes combined

Integrity Hash: ${exportPackage.manifest.integrityHash}

================================================================================
                           LEGAL NOTICE
================================================================================

This export contains CONFIDENTIAL and SENSITIVE information including:
- Personal Identifiable Information (PII)
- Financial data
- Business information
- Credit assessment details

Access to this data should be restricted to authorized personnel only.
Unauthorized disclosure may violate data protection regulations including
RBI guidelines and applicable privacy laws.

Retention: This export should be retained as per RBI regulations (7 years
minimum for audit trail and assessment data).

================================================================================
                         CONTACT
================================================================================

For questions regarding this export:
- Platform: ACC Agentic Underwriting Platform
- Vendor: Applied Cloud Computing
- Export Module Version: 1.0.0

================================================================================
`;
}

/**
 * Create ZIP file from export package
 * Note: Requires 'archiver' package for production use
 * This is a simple implementation that returns the files object
 */
async function createExportZip(exportPackage) {
    // In production, use 'archiver' package to create actual ZIP
    // For now, return the files structure that can be zipped
    return {
        exportId: exportPackage.exportId,
        manifest: exportPackage.manifest,
        files: exportPackage.files
    };
}

// ==================== EXPORTS ====================

module.exports = {
    createForensicExport,
    createExportZip,
    generateHash,
    sanitizeAssessment,
    extractRiskFactors
};
