/**
 * Document Detector Module
 * Detects if a PDF is native (text-selectable) or scanned (image-based)
 */

const pdfParse = require('pdf-parse');

/**
 * Detect if PDF is scanned (image-based) or native (text-selectable)
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @returns {Promise<{isScanned: boolean, confidence: number, textLength: number, pageCount: number, details: string}>}
 */
async function detectDocumentType(pdfBuffer) {
    const startTime = Date.now();
    
    try {
        // pdf-parse options for better text extraction
        const options = {
            max: 10 // Max pages to parse
        };
        
        const pdfData = await pdfParse(pdfBuffer, options);
        
        const pageCount = pdfData.numpages || 1;
        const extractedText = pdfData.text || '';
        const textLength = extractedText.trim().length;
        
        // Calculate text density (characters per page)
        const textDensity = textLength / pageCount;
        
        // Log for debugging
        console.log(`[DocumentDetector] PDF Analysis: ${pageCount} pages, ${textLength} chars, density: ${Math.round(textDensity)} chars/page`);
        console.log(`[DocumentDetector] Text preview: "${extractedText.substring(0, 200).replace(/\s+/g, ' ')}..."`);
        
        // Thresholds for detection - ADJUSTED for better accuracy
        const DEFINITELY_SCANNED = 50;   // Less than 50 chars per page = definitely scanned
        const PROBABLY_SCANNED = 200;    // Less than 200 chars per page = probably scanned
        const DEFINITELY_NATIVE = 300;   // More than 300 chars per page = definitely native
        
        let isScanned = false;
        let confidence = 0;
        let details = '';
        
        // Check for common native PDF indicators in the extracted text
        const hasTableStructure = /\||\t|^\s{2,}\d/.test(extractedText);
        const hasFinancialData = /₹|Rs\.?|INR|Rupees|Crore|Lakh|\d{1,3}(,\d{2,3})+/.test(extractedText);
        const hasCommonWords = /Total|Balance|Assets|Liabilities|Revenue|Profit|Cash|Statement/i.test(extractedText);
        const hasDatePattern = /\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{4}[-\/]\d{2}|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(extractedText);
        
        // Calculate native indicators score
        const nativeIndicators = [hasTableStructure, hasFinancialData, hasCommonWords, hasDatePattern].filter(Boolean).length;
        
        console.log(`[DocumentDetector] Native indicators: table=${hasTableStructure}, financial=${hasFinancialData}, words=${hasCommonWords}, date=${hasDatePattern} (score: ${nativeIndicators})`);
        
        if (textDensity < DEFINITELY_SCANNED && nativeIndicators === 0) {
            // Very low text and no native indicators = definitely scanned
            isScanned = true;
            confidence = 95;
            details = `Very low text density (${Math.round(textDensity)} chars/page) with no native PDF indicators. Document appears to be scanned.`;
        } else if (textDensity < PROBABLY_SCANNED && nativeIndicators < 2) {
            // Low text but some indicators = probably scanned but check further
            isScanned = true;
            confidence = 70 - (nativeIndicators * 15);
            details = `Low text density (${Math.round(textDensity)} chars/page). May be partially scanned. Found ${nativeIndicators} native indicators.`;
        } else if (textDensity >= DEFINITELY_NATIVE || nativeIndicators >= 2) {
            // Good text OR multiple native indicators = definitely native
            isScanned = false;
            confidence = Math.min(98, 70 + (textDensity / 100) + (nativeIndicators * 5));
            details = `Text density: ${Math.round(textDensity)} chars/page. Native indicators: ${nativeIndicators}. Document is native/digital.`;
        } else {
            // Ambiguous case - lean towards native if any indicators found
            isScanned = nativeIndicators === 0;
            confidence = 60;
            details = `Ambiguous: ${Math.round(textDensity)} chars/page, ${nativeIndicators} native indicators. Treating as ${isScanned ? 'scanned' : 'native'}.`;
        }
        
        // Special override: If we detect Indian number format, it's almost certainly native
        // Scanned PDFs rarely have perfectly extractable formatted numbers like 23,24,54,422
        if (hasFinancialData && /\d{1,2},\d{2},\d{2,3}/.test(extractedText)) {
            if (isScanned) {
                console.log('[DocumentDetector] Override: Indian number format detected, treating as NATIVE');
                isScanned = false;
                confidence = 85;
                details += ' [Override: Indian number format indicates native PDF]';
            }
        }
        
        const processingTime = Date.now() - startTime;
        
        console.log(`[DocumentDetector] Result: ${isScanned ? 'SCANNED' : 'NATIVE'} (confidence: ${Math.round(confidence)}%)`);
        
        return {
            isScanned,
            confidence: Math.round(confidence * 10) / 10,
            textLength,
            pageCount,
            textDensity: Math.round(textDensity),
            details,
            processingTimeMs: processingTime,
            extractedTextPreview: extractedText.substring(0, 300).replace(/\s+/g, ' ').trim(),
            nativeIndicators: {
                hasTableStructure,
                hasFinancialData,
                hasCommonWords,
                hasDatePattern,
                score: nativeIndicators
            }
        };
        
    } catch (error) {
        // If pdf-parse fails, use file size heuristic
        const fileSizeKB = pdfBuffer.length / 1024;
        console.error('[DocumentDetector] Error parsing PDF:', error.message);
        console.log(`[DocumentDetector] Fallback: Using file size heuristic (${Math.round(fileSizeKB)} KB)`);
        
        // Large files (>300KB) are more likely scanned
        const isLikelyScanned = fileSizeKB > 300;
        
        return {
            isScanned: isLikelyScanned,
            confidence: 60,
            textLength: 0,
            pageCount: 1,
            textDensity: 0,
            details: `Could not parse PDF text: ${error.message}. Using file size heuristic (${Math.round(fileSizeKB)} KB).`,
            processingTimeMs: Date.now() - startTime,
            error: error.message
        };
    }
}

/**
 * Quick check if PDF has any extractable text
 * @param {Buffer} pdfBuffer 
 * @returns {Promise<boolean>}
 */
async function hasExtractableText(pdfBuffer) {
    try {
        const result = await detectDocumentType(pdfBuffer);
        return !result.isScanned;
    } catch {
        return false;
    }
}

module.exports = {
    detectDocumentType,
    hasExtractableText
};
