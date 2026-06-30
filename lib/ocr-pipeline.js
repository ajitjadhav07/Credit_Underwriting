/**
 * Enhanced OCR Pipeline Module
 * Wraps document extraction with AWS Textract for scanned documents
 * Implements 8-step processing with detailed logging
 *
 * NOTE: Field names like `visionApiCost` / `visionCost` are kept for
 * backward compatibility with the frontend (public/index.html) and
 * existing logs, even though the underlying engine is now AWS Textract
 * instead of Google Vision.
 */

const documentDetector = require('./document-detector');
const imagePreprocessor = require('./image-preprocessor');
const visionOcr = require('./textract-ocr');

// Pipeline step logs for real-time updates
let pipelineLogs = [];
let currentDocumentLogs = [];

// Cost tracking
let pipelineCosts = {
    visionApiCost: 0,
    claudeApiCost: 0,
    totalDocuments: 0,
    scannedDocuments: 0,
    nativeDocuments: 0
};

/**
 * Log a pipeline step
 * @param {string} documentName - Name of document being processed
 * @param {number} step - Step number (1-8)
 * @param {string} message - Log message
 * @param {Object} details - Additional details
 */
function logStep(documentName, step, message, details = {}) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        document: documentName,
        step,
        totalSteps: 8,
        message: `Step ${step}/8: ${message}`,
        details,
        formatted: `[${new Date().toLocaleTimeString()}] ${documentName} - Step ${step}/8: ${message}`
    };
    
    pipelineLogs.push(logEntry);
    currentDocumentLogs.push(logEntry);
    
    // Keep only last 500 logs
    if (pipelineLogs.length > 500) {
        pipelineLogs = pipelineLogs.slice(-500);
    }
    
    // Console log for debugging
    console.log(logEntry.formatted);
    
    return logEntry;
}

/**
 * Get current document logs (for real-time updates)
 */
function getCurrentDocumentLogs() {
    return [...currentDocumentLogs];
}

/**
 * Clear current document logs (call at start of new document)
 */
function clearCurrentDocumentLogs() {
    currentDocumentLogs = [];
}

/**
 * Get all pipeline logs
 */
function getPipelineLogs() {
    return [...pipelineLogs];
}

/**
 * Get pipeline cost summary
 */
function getPipelineCosts() {
    return { ...pipelineCosts };
}

/**
 * Reset pipeline costs
 */
function resetPipelineCosts() {
    pipelineCosts = {
        visionApiCost: 0,
        claudeApiCost: 0,
        totalDocuments: 0,
        scannedDocuments: 0,
        nativeDocuments: 0
    };
}

/**
 * Process a PDF through the enhanced OCR pipeline
 * Returns either the original PDF buffer (for native) or extracted text (for scanned)
 * 
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {string} documentName - Name for logging
 * @param {Function} progressCallback - Optional callback for progress updates
 * @returns {Promise<{
 *   isScanned: boolean,
 *   content: Buffer|string,
 *   contentType: 'pdf'|'text',
 *   ocrConfidence: number|null,
 *   visionCost: number,
 *   processingSteps: Array,
 *   totalProcessingTimeMs: number
 * }>}
 */
async function processDocument(pdfBuffer, documentName, progressCallback = null) {
    const startTime = Date.now();
    clearCurrentDocumentLogs();
    const steps = [];
    
    const emitProgress = (step, message, details) => {
        const log = logStep(documentName, step, message, details);
        steps.push(log);
        if (progressCallback) {
            progressCallback(log);
        }
    };
    
    // Check if Vision API is configured
    const visionConfig = visionOcr.isTextractConfigured();
    
    try {
        // ========== STEP 1: Document Type Detection ==========
        emitProgress(1, 'Document Type Detection - Analyzing PDF...', { status: 'in_progress' });
        
        const detectionResult = await documentDetector.detectDocumentType(pdfBuffer);
        
        const docTypeMsg = detectionResult.isScanned 
            ? `SCANNED detected (confidence: ${detectionResult.confidence}%)`
            : `NATIVE detected (confidence: ${detectionResult.confidence}%)`;
        
        emitProgress(1, `Document Type Detection - ${docTypeMsg}`, {
            status: 'complete',
            isScanned: detectionResult.isScanned,
            confidence: detectionResult.confidence,
            textDensity: detectionResult.textDensity,
            pageCount: detectionResult.pageCount,
            details: detectionResult.details
        });
        
        pipelineCosts.totalDocuments++;
        
        // ========== NATIVE PDF PATH ==========
        if (!detectionResult.isScanned) {
            pipelineCosts.nativeDocuments++;
            
            // Steps 2-5 are skipped for native PDFs
            emitProgress(2, 'PDF to Images - SKIPPED (Native PDF)', { status: 'skipped', reason: 'Document is native/digital' });
            emitProgress(3, 'Image Preprocessing - SKIPPED (Native PDF)', { status: 'skipped', reason: 'Document is native/digital' });
            emitProgress(4, 'AWS Textract OCR - SKIPPED (Native PDF)', { status: 'skipped', reason: 'Document is native/digital' });
            emitProgress(5, 'Text Reconstruction - SKIPPED (Native PDF)', { status: 'skipped', reason: 'Document is native/digital' });
            
            // Step 6: Prepare for Claude
            emitProgress(6, 'Preparing payload for Claude API - Using PDF directly', {
                status: 'complete',
                contentType: 'pdf',
                sizeKB: Math.round(pdfBuffer.length / 1024)
            });
            
            return {
                isScanned: false,
                content: pdfBuffer,
                contentType: 'pdf',
                ocrConfidence: null,
                visionCost: 0,
                processingSteps: steps,
                totalProcessingTimeMs: Date.now() - startTime,
                detectionDetails: detectionResult
            };
        }
        
        // ========== SCANNED PDF PATH ==========
        pipelineCosts.scannedDocuments++;
        
        // Check if Vision API is configured
        if (!visionConfig.configured) {
            // Warning: Vision not configured, falling back to Claude-only
            emitProgress(2, 'PDF to Images - WARNING: AWS Textract not configured', {
                status: 'warning',
                message: visionConfig.details,
                fallback: 'Using Claude API directly for scanned document (may have lower accuracy)'
            });
            emitProgress(3, 'Image Preprocessing - SKIPPED (Textract not configured)', { status: 'skipped' });
            emitProgress(4, 'AWS Textract OCR - SKIPPED (Textract not configured)', { 
                status: 'skipped',
                warning: 'Configure AWS_REGION / IAM role with textract:DetectDocumentText for OCR'
            });
            emitProgress(5, 'Text Reconstruction - SKIPPED (Textract not configured)', { status: 'skipped' });
            emitProgress(6, 'Preparing payload for Claude API - Using scanned PDF directly (fallback mode)', {
                status: 'complete',
                contentType: 'pdf',
                sizeKB: Math.round(pdfBuffer.length / 1024),
                warning: 'Extraction accuracy may be reduced for scanned documents without Textract'
            });
            
            return {
                isScanned: true,
                content: pdfBuffer,
                contentType: 'pdf',
                ocrConfidence: null,
                visionCost: 0,
                visionWarning: visionConfig.details,
                processingSteps: steps,
                totalProcessingTimeMs: Date.now() - startTime,
                detectionDetails: detectionResult
            };
        }
        
        // ========== STEP 2: PDF to Images ==========
        emitProgress(2, 'Converting PDF to images...', { status: 'in_progress' });
        
        let conversionResult;
        try {
            conversionResult = await imagePreprocessor.convertPdfToImages(pdfBuffer, 300);
            
            // Check if conversion produced any images
            if (!conversionResult.images || conversionResult.images.length === 0) {
                const errorMsg = conversionResult.error || 'No images produced from PDF';
                emitProgress(2, `Converting PDF to images - FAILED: ${errorMsg}`, {
                    status: 'error',
                    error: errorMsg,
                    fallback: 'Falling back to Claude-only extraction'
                });
                
                // Fallback to Claude-only
                emitProgress(3, 'Image Preprocessing - SKIPPED (no images)', { status: 'skipped' });
                emitProgress(4, 'AWS Textract OCR - SKIPPED (no images)', { status: 'skipped' });
                emitProgress(5, 'Text Reconstruction - SKIPPED (no images)', { status: 'skipped' });
                emitProgress(6, 'Preparing payload for Claude API - Using PDF directly (fallback)', {
                    status: 'complete',
                    contentType: 'pdf',
                    warning: errorMsg + '. Using Claude vision on PDF directly.'
                });
                
                return {
                    isScanned: true,
                    content: pdfBuffer,
                    contentType: 'pdf',
                    ocrConfidence: null,
                    visionCost: 0,
                    conversionError: errorMsg,
                    processingSteps: steps,
                    totalProcessingTimeMs: Date.now() - startTime,
                    detectionDetails: detectionResult
                };
            }
            
            emitProgress(2, `Converting PDF to images - ${conversionResult.pageCount} page(s) at 300 DPI`, {
                status: 'complete',
                pageCount: conversionResult.pageCount,
                processingTimeMs: conversionResult.processingTimeMs,
                dpi: conversionResult.dpi
            });
        } catch (error) {
            emitProgress(2, `Converting PDF to images - FAILED: ${error.message}`, {
                status: 'error',
                error: error.message,
                fallback: 'Falling back to Claude-only extraction'
            });
            
            // Fallback to Claude-only
            emitProgress(3, 'Image Preprocessing - SKIPPED (conversion failed)', { status: 'skipped' });
            emitProgress(4, 'AWS Textract OCR - SKIPPED (conversion failed)', { status: 'skipped' });
            emitProgress(5, 'Text Reconstruction - SKIPPED (conversion failed)', { status: 'skipped' });
            emitProgress(6, 'Preparing payload for Claude API - Using PDF directly (fallback)', {
                status: 'complete',
                contentType: 'pdf',
                warning: 'Image conversion failed, using PDF directly'
            });
            
            return {
                isScanned: true,
                content: pdfBuffer,
                contentType: 'pdf',
                ocrConfidence: null,
                visionCost: 0,
                conversionError: error.message,
                processingSteps: steps,
                totalProcessingTimeMs: Date.now() - startTime,
                detectionDetails: detectionResult
            };
        }
        
        // ========== STEP 3: Image Preprocessing ==========
        emitProgress(3, 'Image preprocessing...', { status: 'in_progress' });
        
        const processedImages = [];
        const preprocessDetails = [];
        
        for (let i = 0; i < conversionResult.images.length; i++) {
            const preprocessResult = await imagePreprocessor.preprocessImage(conversionResult.images[i]);
            processedImages.push(preprocessResult.processedImage);
            preprocessDetails.push({
                page: i + 1,
                enhancements: preprocessResult.enhancements,
                processingTimeMs: preprocessResult.processingTimeMs
            });
        }
        
        emitProgress(3, `Image preprocessing complete - ${processedImages.length} page(s) enhanced`, {
            status: 'complete',
            enhancements: preprocessDetails[0]?.enhancements || [],
            totalProcessingTimeMs: preprocessDetails.reduce((sum, p) => sum + p.processingTimeMs, 0)
        });
        
        // ========== STEP 4: AWS Textract OCR ==========
        emitProgress(4, 'AWS Textract OCR - Processing...', { status: 'in_progress' });
        
        const costEstimate = visionOcr.estimateCost(processedImages.length);
        
        let ocrResult;
        try {
            ocrResult = await visionOcr.extractTextFromImages(processedImages);
            
            pipelineCosts.visionApiCost += ocrResult.totalCost;
            
            // Check if OCR extracted any text
            if (!ocrResult.fullText || ocrResult.fullText.trim().length === 0) {
                emitProgress(4, `AWS Textract OCR - WARNING: No text extracted (0 characters)`, {
                    status: 'warning',
                    confidence: 0,
                    pageCount: ocrResult.pageCount,
                    characterCount: 0,
                    cost: ocrResult.totalCost,
                    warning: 'Textract returned no text. Document may be blank, image-only, or very poor quality.',
                    fallback: 'Falling back to Claude reading PDF directly'
                });
                
                // Fallback to Claude-only since no text was extracted
                emitProgress(5, 'Text Reconstruction - SKIPPED (no text from OCR)', { status: 'skipped' });
                emitProgress(6, 'Preparing payload for Claude API - Using PDF directly (OCR returned no text)', {
                    status: 'complete',
                    contentType: 'pdf',
                    warning: 'Textract extracted no text. Trying Claude vision on PDF directly.'
                });
                
                return {
                    isScanned: true,
                    content: pdfBuffer,
                    contentType: 'pdf',
                    ocrConfidence: 0,
                    visionCost: ocrResult.totalCost,
                    ocrWarning: 'Textract returned no text',
                    processingSteps: steps,
                    totalProcessingTimeMs: Date.now() - startTime,
                    detectionDetails: detectionResult
                };
            }
            
            emitProgress(4, `AWS Textract OCR - confidence ${ocrResult.avgConfidence}%`, {
                status: 'complete',
                confidence: ocrResult.avgConfidence,
                pageCount: ocrResult.pageCount,
                characterCount: ocrResult.fullText.length,
                cost: ocrResult.totalCost,
                costDetails: costEstimate.details,
                processingTimeMs: ocrResult.processingTimeMs
            });
        } catch (error) {
            emitProgress(4, `AWS Textract OCR - FAILED: ${error.message}`, {
                status: 'error',
                error: error.message
            });
            
            // Fallback to Claude-only
            emitProgress(5, 'Text Reconstruction - SKIPPED (OCR failed)', { status: 'skipped' });
            emitProgress(6, 'Preparing payload for Claude API - Using PDF directly (fallback)', {
                status: 'complete',
                contentType: 'pdf',
                warning: 'Textract OCR failed, using PDF directly'
            });
            
            return {
                isScanned: true,
                content: pdfBuffer,
                contentType: 'pdf',
                ocrConfidence: null,
                visionCost: 0,
                ocrError: error.message,
                processingSteps: steps,
                totalProcessingTimeMs: Date.now() - startTime,
                detectionDetails: detectionResult
            };
        }
        
        // ========== STEP 5: Text Reconstruction ==========
        emitProgress(5, 'Text reconstruction...', { status: 'in_progress' });
        
        const reconstructedText = visionOcr.reconstructTextLayout(ocrResult.fullText);
        
        emitProgress(5, `Text reconstruction - ${reconstructedText.length} characters`, {
            status: 'complete',
            originalLength: ocrResult.fullText.length,
            reconstructedLength: reconstructedText.length,
            preview: reconstructedText.substring(0, 100).replace(/\n/g, ' ') + '...'
        });
        
        // ========== STEP 6: Prepare for Claude ==========
        emitProgress(6, 'Preparing payload for Claude API - Using OCR text', {
            status: 'complete',
            contentType: 'text',
            textLength: reconstructedText.length,
            ocrConfidence: ocrResult.avgConfidence
        });
        
        return {
            isScanned: true,
            content: reconstructedText,
            contentType: 'text',
            ocrConfidence: ocrResult.avgConfidence,
            visionCost: ocrResult.totalCost,
            visionDurationMs: ocrResult.processingTimeMs || 0,
            processingSteps: steps,
            totalProcessingTimeMs: Date.now() - startTime,
            detectionDetails: detectionResult,
            ocrDetails: {
                pageCount: ocrResult.pageCount,
                characterCount: reconstructedText.length,
                avgConfidence: ocrResult.avgConfidence
            }
        };
        
    } catch (error) {
        console.error('[OCR Pipeline] Unexpected error:', error);
        
        // Log the error
        emitProgress(1, `Pipeline Error: ${error.message}`, {
            status: 'error',
            error: error.message,
            stack: error.stack
        });
        
        // Return fallback
        return {
            isScanned: false,
            content: pdfBuffer,
            contentType: 'pdf',
            ocrConfidence: null,
            visionCost: 0,
            pipelineError: error.message,
            processingSteps: steps,
            totalProcessingTimeMs: Date.now() - startTime
        };
    }
}

/**
 * Log Steps 7 and 8 (called by extraction functions after Claude API call)
 * @param {string} documentName 
 * @param {Object} claudeResult - Result from Claude API
 * @param {Function} progressCallback 
 */
function logClaudeExtractionSteps(documentName, claudeResult, progressCallback = null) {
    const emitProgress = (step, message, details) => {
        const log = logStep(documentName, step, message, details);
        if (progressCallback) {
            progressCallback(log);
        }
        return log;
    };
    
    // Step 7: Claude Extraction
    emitProgress(7, `Claude extraction - Input: ${claudeResult.inputTokens || 0}, Output: ${claudeResult.outputTokens || 0} tokens`, {
        status: 'complete',
        inputTokens: claudeResult.inputTokens || 0,
        outputTokens: claudeResult.outputTokens || 0,
        totalTokens: (claudeResult.inputTokens || 0) + (claudeResult.outputTokens || 0),
        responseTimeMs: claudeResult.responseTimeMs || 0,
        model: claudeResult.model || 'claude-sonnet-4-20250514'
    });
    
    // Estimate Claude API cost
    // Claude Sonnet pricing: ~$3/1M input tokens, ~$15/1M output tokens
    const claudeCost = ((claudeResult.inputTokens || 0) * 0.003 / 1000) + 
                       ((claudeResult.outputTokens || 0) * 0.015 / 1000);
    pipelineCosts.claudeApiCost += claudeCost;
    
    // Step 8: Extraction Complete
    const fieldsExtracted = claudeResult.fieldsExtracted || 0;
    const confidence = claudeResult.confidence || 'unknown';
    
    emitProgress(8, `Extraction complete - ${fieldsExtracted} fields, confidence: ${confidence.toUpperCase()}`, {
        status: 'complete',
        fieldsExtracted,
        confidence,
        claudeCost: Math.round(claudeCost * 10000) / 10000,
        extractedData: claudeResult.keyValues || {}
    });
}

/**
 * Get combined API statistics (Textract + Claude)
 */
function getCombinedStats() {
    const visionStats = visionOcr.getTextractStats();
    
    return {
        vision: visionStats,
        pipeline: pipelineCosts,
        totalCost: Math.round((pipelineCosts.visionApiCost + pipelineCosts.claudeApiCost) * 10000) / 10000
    };
}

module.exports = {
    processDocument,
    logStep,
    logClaudeExtractionSteps,
    getCurrentDocumentLogs,
    clearCurrentDocumentLogs,
    getPipelineLogs,
    getPipelineCosts,
    resetPipelineCosts,
    getCombinedStats
};
