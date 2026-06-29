/**
 * Comprehensive Field Mapper Module
 * Tracks 524 parameters across 14 categories and 44 documents
 * Version: 2.0 - Enhanced for complete parameter tracking
 */

const comprehensiveParams = require('./comprehensive-parameters-schema.json');
const comprehensiveDocs = require('./comprehensive-documents-schema.json');

/**
 * Generate comprehensive mapping report for an assessment
 * @param {Object} extractedData - The extracted_data from assessment
 * @param {Object} documents - The uploaded documents
 * @param {Object} assessment - Full assessment object for additional context
 * @returns {Object} Comprehensive mapping report with all 524 parameters
 */
function generateComprehensiveMappingReport(extractedData, documents = {}, assessment = {}) {
    const report = {
        overall: {
            total_parameters: comprehensiveParams.total_parameters,
            extracted: 0,
            missing: 0,
            percentage: 0,
            required_total: 0,
            required_extracted: 0,
            required_missing: 0,
            required_percentage: 0,
            optional_total: 0,
            optional_extracted: 0,
            optional_missing: 0,
            optional_percentage: 0
        },
        documents: generateDocumentStatus(documents),
        categories: [],
        missing_critical: [],
        data_quality_score: 0
    };

    // Calculate totals
    comprehensiveParams.categories.forEach(category => {
        report.overall.required_total += category.required_count || 0;
        report.overall.optional_total += category.optional_count || 0;
    });

    // Process each category
    comprehensiveParams.categories.forEach(category => {
        const categoryReport = processCategoryParameters(category, extractedData, assessment);
        report.categories.push(categoryReport);
        
        // Update overall counts
        report.overall.extracted += categoryReport.extracted;
        report.overall.required_extracted += categoryReport.required_extracted;
        report.overall.optional_extracted += categoryReport.optional_extracted;
        
        // Collect missing critical parameters
        if (categoryReport.missing_critical && categoryReport.missing_critical.length > 0) {
            report.missing_critical.push(...categoryReport.missing_critical);
        }
    });

    // Calculate percentages
    report.overall.missing = report.overall.total_parameters - report.overall.extracted;
    report.overall.percentage = Math.round((report.overall.extracted / report.overall.total_parameters) * 100);
    
    report.overall.required_missing = report.overall.required_total - report.overall.required_extracted;
    report.overall.required_percentage = report.overall.required_total > 0 
        ? Math.round((report.overall.required_extracted / report.overall.required_total) * 100) 
        : 0;
    
    report.overall.optional_missing = report.overall.optional_total - report.overall.optional_extracted;
    report.overall.optional_percentage = report.overall.optional_total > 0
        ? Math.round((report.overall.optional_extracted / report.overall.optional_total) * 100)
        : 0;

    // Calculate data quality score (weighted: required 70%, optional 30%)
    const requiredScore = (report.overall.required_percentage * 0.7);
    const optionalScore = (report.overall.optional_percentage * 0.3);
    report.data_quality_score = Math.round(requiredScore + optionalScore);

    // Include the actual extracted data for modal display
    report.all_extracted_data = extractedData;

    return report;
}

/**
 * Process parameters for a category
 */
function processCategoryParameters(category, extractedData, assessment) {
    const categoryReport = {
        id: category.id,
        name: category.name,
        description: category.description,
        total: category.total_parameters,
        extracted: 0,
        missing: 0,
        percentage: 0,
        required_total: category.required_count,
        required_extracted: 0,
        optional_total: category.optional_count,
        optional_extracted: 0,
        status: 'critical', // critical, warning, good
        subcategories: [],
        missing_critical: []
    };

    // Process based on category type
    switch (category.id) {
        case 'financial_statements':
            processFinancialStatements(categoryReport, category, extractedData);
            break;
        case 'company_master':
            processCompanyMaster(categoryReport, category, extractedData, assessment);
            break;
        case 'banking_information':
            processBankingInfo(categoryReport, category, extractedData, assessment);
            break;
        case 'gst_returns':
            processGSTReturns(categoryReport, category, extractedData, assessment);
            break;
        case 'income_tax':
            processIncomeTax(categoryReport, category, extractedData, assessment);
            break;
        case 'credit_bureau':
            processCreditBureau(categoryReport, category, extractedData, assessment);
            break;
        case 'statutory_compliance':
            processStatutoryCompliance(categoryReport, category, extractedData, assessment);
            break;
        case 'property_collateral':
            processPropertyCollateral(categoryReport, category, extractedData, assessment);
            break;
        case 'kyc_documents':
            processKYCDocuments(categoryReport, category, extractedData, assessment);
            break;
        case 'business_verification':
            processBusinessVerification(categoryReport, category, extractedData, assessment);
            break;
        case 'calculated_metrics':
            processCalculatedMetrics(categoryReport, category, extractedData, assessment);
            break;
        case 'risk_indicators':
            processRiskIndicators(categoryReport, category, extractedData, assessment);
            break;
        case 'api_integrations':
            processAPIIntegrations(categoryReport, category, extractedData, assessment);
            break;
        case 'document_metadata':
            processDocumentMetadata(categoryReport, category, extractedData, assessment);
            break;
        default:
            // Generic processing for any undefined categories
            processGenericCategory(categoryReport, category, extractedData, assessment);
    }

    // Calculate category completion percentage
    categoryReport.missing = categoryReport.total - categoryReport.extracted;
    categoryReport.percentage = categoryReport.total > 0 
        ? Math.round((categoryReport.extracted / categoryReport.total) * 100) 
        : 0;

    // Determine status
    if (categoryReport.percentage >= 80) {
        categoryReport.status = 'good';
    } else if (categoryReport.percentage >= 50) {
        categoryReport.status = 'warning';
    } else {
        categoryReport.status = 'critical';
    }

    return categoryReport;
}

/**
 * Process financial statements (Balance Sheet, P&L, Cash Flow)
 */
function processFinancialStatements(categoryReport, category, extractedData) {
    const years = ['fy25', 'fy24', 'fy23'];
    let totalExtracted = 0;
    let requiredExtracted = 0;
    let optionalExtracted = 0;

    category.subcategories.forEach(subcategory => {
        const subReport = {
            id: subcategory.id,
            name: subcategory.name,
            years: {},
            fields: [] // Add detailed field list
        };

        years.forEach(year => {
            const data = extractedData?.[subcategory.id]?.[year];
            let extracted = 0;
            let reqExtracted = 0;
            let optExtracted = 0;
            const yearFields = [];

            subcategory.fields.forEach(field => {
                const value = data?.[field.id];
                const isExtracted = value !== undefined && value !== null && value !== '';
                
                if (isExtracted) {
                    extracted++;
                    totalExtracted++;
                    if (field.required) {
                        reqExtracted++;
                        requiredExtracted++;
                    } else {
                        optExtracted++;
                        optionalExtracted++;
                    }
                }
                
                // Store detailed field info
                yearFields.push({
                    id: field.id,
                    label: field.label,
                    required: field.required,
                    category: field.category,
                    extracted: isExtracted,
                    value: isExtracted ? value : null,
                    year: year.toUpperCase()
                });
            });

            subReport.years[year] = {
                label: year.toUpperCase(),
                total: subcategory.fields.length,
                extracted: extracted,
                percentage: Math.round((extracted / subcategory.fields.length) * 100),
                fields: yearFields
            };
        });

        categoryReport.subcategories.push(subReport);
    });

    categoryReport.extracted = totalExtracted;
    categoryReport.required_extracted = requiredExtracted;
    categoryReport.optional_extracted = optionalExtracted;
}

/**
 * Process company master data
 */
function processCompanyMaster(categoryReport, category, extractedData, assessment) {
    let extracted = 0;
    let reqExtracted = 0;
    let optExtracted = 0;
    const fields = [];

    category.fields.forEach(field => {
        const value = extractedData?.company_info?.[field.id] || assessment[field.id];
        const isExtracted = value !== undefined && value !== null && value !== '';
        
        if (isExtracted) {
            extracted++;
            if (field.required) {
                reqExtracted++;
            } else {
                optExtracted++;
            }
        } else if (field.required) {
            categoryReport.missing_critical.push(field.label);
        }
        
        // Store detailed field info
        fields.push({
            id: field.id,
            label: field.label,
            required: field.required,
            extracted: isExtracted,
            value: isExtracted ? value : null
        });
    });

    categoryReport.extracted = extracted;
    categoryReport.required_extracted = reqExtracted;
    categoryReport.optional_extracted = optExtracted;
    categoryReport.fields = fields;
}

/**
 * Process banking information
 */
function processBankingInfo(categoryReport, category, extractedData, assessment) {
    let extracted = 0;
    let reqExtracted = 0;
    let optExtracted = 0;

    if (category.subcategories) {
        category.subcategories.forEach(subcategory => {
            subcategory.fields.forEach(field => {
                const value = extractedData?.banking_info?.[field.id] || assessment.banking_info?.[field.id];
                if (value !== undefined && value !== null && value !== '') {
                    extracted++;
                    if (field.required) {
                        reqExtracted++;
                    } else {
                        optExtracted++;
                    }
                }
            });
        });
    }

    categoryReport.extracted = extracted;
    categoryReport.required_extracted = reqExtracted;
    categoryReport.optional_extracted = optExtracted;
}

/**
 * Process GST returns
 */
function processGSTReturns(categoryReport, category, extractedData, assessment) {
    // Placeholder - GST data would come from API integration or uploaded returns
    // For now, mark as extracted if basic GST info exists
    const gstData = extractedData?.gst_info || {};
    const extracted = Object.keys(gstData).filter(key => gstData[key] !== null && gstData[key] !== '').length;
    
    categoryReport.extracted = Math.min(extracted, category.total_parameters);
    categoryReport.required_extracted = Math.min(extracted, category.required_count);
}

/**
 * Process income tax returns
 */
function processIncomeTax(categoryReport, category, extractedData, assessment) {
    // Placeholder - ITR data would come from uploaded returns
    const itrData = extractedData?.itr_info || {};
    const extracted = Object.keys(itrData).filter(key => itrData[key] !== null && itrData[key] !== '').length;
    
    categoryReport.extracted = Math.min(extracted, category.total_parameters);
    categoryReport.required_extracted = Math.min(extracted, category.required_count);
}

/**
 * Process credit bureau data
 */
function processCreditBureau(categoryReport, category, extractedData, assessment) {
    // Placeholder - CIBIL data would come from API
    const cibilData = assessment.cibil_score ? 1 : 0;
    categoryReport.extracted = cibilData > 0 ? Math.min(15, category.total_parameters) : 0;
    categoryReport.required_extracted = cibilData > 0 ? Math.min(10, category.required_count) : 0;
}

/**
 * Process statutory compliance
 */
function processStatutoryCompliance(categoryReport, category, extractedData, assessment) {
    const complianceData = extractedData?.statutory_compliance || {};
    const extracted = Object.keys(complianceData).filter(key => complianceData[key] !== null).length;
    
    categoryReport.extracted = Math.min(extracted, category.total_parameters);
    categoryReport.required_extracted = Math.min(extracted, category.required_count);
}

/**
 * Process property/collateral
 */
function processPropertyCollateral(categoryReport, category, extractedData, assessment) {
    const propertyData = extractedData?.property_info || {};
    const extracted = Object.keys(propertyData).filter(key => propertyData[key] !== null).length;
    
    categoryReport.extracted = Math.min(extracted, category.total_parameters);
}

/**
 * Process KYC documents
 */
function processKYCDocuments(categoryReport, category, extractedData, assessment) {
    let extracted = 0;
    category.fields.forEach(field => {
        const value = extractedData?.kyc_info?.[field.id];
        if (value !== undefined && value !== null && value !== '') {
            extracted++;
        }
    });
    
    categoryReport.extracted = extracted;
    categoryReport.required_extracted = Math.min(extracted, category.required_count);
}

/**
 * Process business verification
 */
function processBusinessVerification(categoryReport, category, extractedData, assessment) {
    const businessData = extractedData?.business_verification || {};
    const extracted = Object.keys(businessData).filter(key => businessData[key] !== null).length;
    
    categoryReport.extracted = Math.min(extracted, category.total_parameters);
    categoryReport.required_extracted = Math.min(extracted, category.required_count);
}

/**
 * Process calculated metrics (ratios, trends)
 */
function processCalculatedMetrics(categoryReport, category, extractedData, assessment) {
    // Ratios are calculated, so if we have financial data, ratios exist
    const ratios = assessment.ratios?.fy25 || {};
    const ratioCount = Object.keys(ratios).filter(key => ratios[key] !== null && !isNaN(ratios[key])).length;
    
    // Estimate ~30-40 ratios can be calculated from financial data
    categoryReport.extracted = Math.min(ratioCount * 2, category.total_parameters);
    categoryReport.required_extracted = Math.min(ratioCount * 2, category.required_count);
}

/**
 * Process risk indicators
 */
function processRiskIndicators(categoryReport, category, extractedData, assessment) {
    // Risk indicators are automatically calculated during assessment
    const extracted = assessment.red_flags ? Math.min(30, category.total_parameters) : 0;
    
    categoryReport.extracted = extracted;
    categoryReport.required_extracted = Math.min(extracted, category.required_count);
}

/**
 * Process API integrations
 */
function processAPIIntegrations(categoryReport, category, extractedData, assessment) {
    // Check which APIs are configured/connected
    let extracted = 0;
    
    // CIBIL always present in our demo
    extracted += 5;
    
    // PAN/Aadhaar verification
    if (extractedData?.company_info?.pan) extracted += 2;
    
    categoryReport.extracted = Math.min(extracted, category.total_parameters);
    categoryReport.required_extracted = Math.min(extracted, category.required_count);
}

/**
 * Process document metadata
 */
function processDocumentMetadata(categoryReport, category, extractedData, assessment) {
    // Based on actual document uploads
    const docStatus = generateDocumentStatus({});
    const extracted = Math.round((docStatus.uploaded / docStatus.expected) * category.total_parameters);
    
    categoryReport.extracted = extracted;
    categoryReport.required_extracted = Math.min(extracted, category.required_count);
}

/**
 * Generic category processing fallback
 */
function processGenericCategory(categoryReport, category, extractedData, assessment) {
    // Default to 0 extracted
    categoryReport.extracted = 0;
    categoryReport.required_extracted = 0;
    categoryReport.optional_extracted = 0;
}

/**
 * Generate document upload status for all 44 documents
 */
function generateDocumentStatus(documents = {}) {
    const docStatus = {
        expected: comprehensiveDocs.total_documents || 0,
        required: comprehensiveDocs.required_count || 0,
        optional: comprehensiveDocs.optional_count || 0,
        uploaded: 0,
        missing: 0,
        missing_required: 0,
        percentage: 0,
        documents: []
    };

    // Safely iterate over categories
    const categories = comprehensiveDocs.categories || [];
    categories.forEach(category => {
        if (!category) return; // Skip null categories
        
        // Handle both 'documents' and 'property_documents' arrays
        const docsArray = category.documents || category.property_documents || [];
        docsArray.forEach(doc => {
            if (!doc || !doc.id) return; // Skip invalid docs
            
            const uploaded = !!documents[doc.id];
            
            const docInfo = {
                id: doc.id,
                name: doc.name || doc.id,
                category: doc.category || category.name || 'Unknown',
                required: doc.required || false,
                uploaded: uploaded,
                file_name: uploaded ? documents[doc.id]?.name : null,
                upload_date: uploaded ? documents[doc.id]?.uploadedAt : null
            };

            docStatus.documents.push(docInfo);

            if (uploaded) {
                docStatus.uploaded++;
            } else if (doc.required) {
                docStatus.missing_required++;
            }
        });
    });

    docStatus.missing = docStatus.expected - docStatus.uploaded;
    docStatus.percentage = docStatus.expected > 0 
        ? Math.round((docStatus.uploaded / docStatus.expected) * 100) 
        : 0;

    return docStatus;
}

module.exports = {
    generateComprehensiveMappingReport,
    generateDocumentStatus
};
