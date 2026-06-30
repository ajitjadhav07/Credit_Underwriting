/**
 * AWS Textract OCR Module
 * Extracts text from scanned documents using AWS Textract (DetectDocumentText)
 *
 * Replaces the previous Google Vision integration (lib/vision-ocr.js).
 * Rationale (per architecture decision):
 *   - Native AWS service — uses the EC2 instance's existing IAM role,
 *     no separate service account / API key to store in Secrets Manager.
 *   - Same AWS bill, same account, no external Google dependency.
 *   - Converts scanned pages to clean text BEFORE they reach Claude,
 *     cutting Claude input tokens by ~80% on scanned documents.
 *
 * Public interface intentionally mirrors vision-ocr.js so ocr-pipeline.js
 * only needs its require() and a few call-site renames.
 */

const {
    TextractClient,
    DetectDocumentTextCommand
} = require('@aws-sdk/client-textract');

// Cost per 1000 pages (DetectDocumentText) - as of 2026
const TEXTRACT_API_COSTS = {
    DETECT_DOCUMENT_TEXT: 1.50 // $1.50 per 1000 pages
};

// Track API usage for cost estimation
let textractApiStats = {
    totalPages: 0,
    totalCalls: 0,
    totalCharactersExtracted: 0,
    estimatedCost: 0,
    lastResetTime: Date.now()
};

// Cache health check result (valid for 5 minutes)
let healthCheckCache = {
    result: null,
    timestamp: 0,
    CACHE_TTL: 5 * 60 * 1000 // 5 minutes
};

let textractClientInstance = null;

/**
 * Check if AWS Textract is configured.
 * Textract uses the same AWS credentials/IAM role as S3 — no separate
 * API key is required. We only need to confirm a region is resolvable.
 * @returns {{configured: boolean, method: string, details: string}}
 */
function isTextractConfigured() {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    const hasExplicitKeys = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    const hasIamRole = process.env.AWS_EXECUTION_ENV || process.env.ECS_CONTAINER_METADATA_URI || true;
    // On EC2 with an instance profile, no env vars are needed at all —
    // the SDK resolves credentials automatically. We treat "region present"
    // as sufficient evidence of configuration, same posture as s3-client.js.
    if (!region) {
        return {
            configured: false,
            method: 'none',
            details: 'AWS_REGION not set. Textract requires a region (e.g. ap-south-1).'
        };
    }

    return {
        configured: true,
        method: hasExplicitKeys ? 'access_key' : 'iam_role',
        details: hasExplicitKeys
            ? 'Using AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY'
            : 'Using EC2 instance IAM role (default credential chain)'
    };
}

/**
 * Lazily initialize the Textract client.
 * @returns {TextractClient|null}
 */
function getTextractClient() {
    if (textractClientInstance) return textractClientInstance;

    const config = isTextractConfigured();
    if (!config.configured) return null;

    try {
        textractClientInstance = new TextractClient({
            region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
        });
        return textractClientInstance;
    } catch (error) {
        console.error('[TextractOCR] Failed to initialize Textract client:', error.message);
        return null;
    }
}

/**
 * Test if Textract actually works (makes a real, minimal API call).
 * Results are cached for 5 minutes to avoid excessive calls.
 * @returns {Promise<{working: boolean, configured: boolean, method: string, details: string, error?: string}>}
 */
async function checkTextractHealth() {
    const now = Date.now();
    if (healthCheckCache.result && (now - healthCheckCache.timestamp) < healthCheckCache.CACHE_TTL) {
        return healthCheckCache.result;
    }

    const config = isTextractConfigured();
    if (!config.configured) {
        const result = { working: false, configured: false, method: 'none', details: config.details };
        healthCheckCache = { result, timestamp: now };
        return result;
    }

    try {
        const client = getTextractClient();
        if (!client) {
            const result = {
                working: false,
                configured: true,
                method: config.method,
                details: 'Failed to initialize Textract client',
                error: 'Client initialization failed'
            };
            healthCheckCache = { result, timestamp: now };
            return result;
        }

        // 1x1 white PNG, minimal cost test image
        const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
        const testImageBuffer = Buffer.from(testImageBase64, 'base64');

        const command = new DetectDocumentTextCommand({
            Document: { Bytes: testImageBuffer }
        });
        await client.send(command);

        const healthResult = {
            working: true,
            configured: true,
            method: config.method,
            details: 'Textract is working correctly',
            lastChecked: new Date().toISOString()
        };
        healthCheckCache = { result: healthResult, timestamp: now };
        console.log('[TextractOCR] Health check passed - Textract is working');
        return healthResult;

    } catch (error) {
        console.error('[TextractOCR] Health check failed:', error.message);

        let errorDetail = error.message;
        if (error.name === 'AccessDeniedException') {
            errorDetail = 'Access denied - EC2 IAM role is missing the textract:DetectDocumentText permission';
        } else if (error.name === 'UnrecognizedClientException' || error.name === 'CredentialsProviderError') {
            errorDetail = 'AWS credentials could not be resolved for Textract';
        } else if (error.name === 'InvalidParameterException') {
            errorDetail = 'Invalid document payload sent to Textract';
        } else if (error.name === 'ThrottlingException') {
            errorDetail = 'Textract request rate exceeded — consider exponential backoff';
        }

        const result = {
            working: false,
            configured: true,
            method: config.method,
            details: errorDetail,
            error: error.message
        };
        healthCheckCache = { result, timestamp: now };
        return result;
    }
}

/**
 * Clear the health check cache (useful after IAM/role changes)
 */
function clearHealthCheckCache() {
    healthCheckCache = { result: null, timestamp: 0, CACHE_TTL: healthCheckCache.CACHE_TTL };
    console.log('[TextractOCR] Health check cache cleared');
}

/**
 * Extract text from a single image using AWS Textract (DetectDocumentText).
 * @param {Buffer} imageBuffer - Image buffer (PNG/JPEG), must be <= 10MB (sync API limit)
 * @returns {Promise<{text: string, confidence: number, blocks: Array, processingTimeMs: number, cost: number}>}
 */
async function extractTextFromImage(imageBuffer) {
    const startTime = Date.now();
    const client = getTextractClient();

    if (!client) {
        throw new Error('AWS Textract not configured (AWS_REGION missing or credentials unresolved)');
    }

    // Textract's synchronous DetectDocumentText caps input at 10MB
    if (imageBuffer.length > 10 * 1024 * 1024) {
        throw new Error('Image exceeds Textract synchronous API limit of 10MB');
    }

    try {
        const command = new DetectDocumentTextCommand({
            Document: { Bytes: imageBuffer }
        });
        const result = await client.send(command);

        const lineBlocks = (result.Blocks || []).filter(b => b.BlockType === 'LINE');
        const wordBlocks = (result.Blocks || []).filter(b => b.BlockType === 'WORD');

        const text = lineBlocks.map(b => b.Text || '').join('\n');

        let totalConfidence = 0;
        const blocks = [];
        for (const line of lineBlocks) {
            totalConfidence += line.Confidence || 0;
            blocks.push({
                text: line.Text || '',
                confidence: line.Confidence,
                boundingBox: line.Geometry ? line.Geometry.BoundingBox : null
            });
        }

        const avgConfidence = lineBlocks.length > 0 ? totalConfidence / lineBlocks.length : 0;
        const cost = TEXTRACT_API_COSTS.DETECT_DOCUMENT_TEXT / 1000;

        textractApiStats.totalPages++;
        textractApiStats.totalCalls++;
        textractApiStats.totalCharactersExtracted += text.length;
        textractApiStats.estimatedCost += cost;

        return {
            text,
            confidence: Math.round(avgConfidence * 10) / 10,
            blocks,
            processingTimeMs: Date.now() - startTime,
            cost,
            characterCount: text.length,
            blockCount: lineBlocks.length,
            wordCount: wordBlocks.length
        };

    } catch (error) {
        console.error('[TextractOCR] Error extracting text:', error.message);
        throw error;
    }
}

/**
 * Extract text from multiple images (multi-page document).
 * @param {Buffer[]} imageBuffers - Array of image buffers
 * @returns {Promise<{pages: Array, fullText: string, avgConfidence: number, totalCost: number, processingTimeMs: number, pageCount: number}>}
 */
async function extractTextFromImages(imageBuffers) {
    const startTime = Date.now();
    const pages = [];
    let fullText = '';
    let totalConfidence = 0;
    let totalCost = 0;

    for (let i = 0; i < imageBuffers.length; i++) {
        try {
            const result = await extractTextFromImage(imageBuffers[i]);
            pages.push({
                pageNumber: i + 1,
                text: result.text,
                confidence: result.confidence,
                characterCount: result.characterCount,
                cost: result.cost
            });

            fullText += `\n--- Page ${i + 1} ---\n${result.text}\n`;
            totalConfidence += result.confidence;
            totalCost += result.cost;

        } catch (error) {
            console.error(`[TextractOCR] Error on page ${i + 1}:`, error.message);
            pages.push({
                pageNumber: i + 1,
                text: '',
                confidence: 0,
                error: error.message
            });
        }
    }

    const avgConfidence = pages.length > 0 ? totalConfidence / pages.length : 0;

    return {
        pages,
        fullText: fullText.trim(),
        avgConfidence: Math.round(avgConfidence * 10) / 10,
        totalCost: Math.round(totalCost * 1000) / 1000,
        processingTimeMs: Date.now() - startTime,
        pageCount: imageBuffers.length
    };
}

/**
 * Reconstruct text with layout preservation (line-based, Textract already
 * returns reading-order LINE blocks so this is mostly whitespace cleanup).
 * @param {string} rawText
 * @returns {string}
 */
function reconstructTextLayout(rawText) {
    if (!rawText) return '';

    let lines = rawText.split('\n');
    lines = lines.map(line => line.trim()).filter((line, index, arr) => {
        if (line) return true;
        const prevHasContent = index > 0 && arr[index - 1];
        const nextHasContent = index < arr.length - 1 && arr[index + 1];
        return prevHasContent && nextHasContent;
    });

    return lines.join('\n');
}

/**
 * Get Textract usage statistics
 */
function getTextractStats() {
    return {
        ...textractApiStats,
        costPerPage: TEXTRACT_API_COSTS.DETECT_DOCUMENT_TEXT / 1000,
        uptime: Date.now() - textractApiStats.lastResetTime
    };
}

/**
 * Reset Textract usage statistics
 */
function resetTextractStats() {
    textractApiStats = {
        totalPages: 0,
        totalCalls: 0,
        totalCharactersExtracted: 0,
        estimatedCost: 0,
        lastResetTime: Date.now()
    };
}

/**
 * Estimate cost for processing a document
 * @param {number} pageCount
 * @returns {{cost: number, details: string}}
 */
function estimateCost(pageCount) {
    const cost = (pageCount * TEXTRACT_API_COSTS.DETECT_DOCUMENT_TEXT) / 1000;
    return {
        cost: Math.round(cost * 1000) / 1000,
        details: `$${cost.toFixed(4)} for ${pageCount} page(s) at $${TEXTRACT_API_COSTS.DETECT_DOCUMENT_TEXT}/1000 pages`
    };
}

module.exports = {
    isTextractConfigured,
    checkTextractHealth,
    clearHealthCheckCache,
    extractTextFromImage,
    extractTextFromImages,
    reconstructTextLayout,
    getTextractStats,
    resetTextractStats,
    estimateCost,
    TEXTRACT_API_COSTS
};
