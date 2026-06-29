/**
 * Google Vision OCR Module
 * Extracts text from scanned documents using Google Cloud Vision API
 */

// Cost per 1000 units (pages) - as of 2024
const VISION_API_COSTS = {
    DOCUMENT_TEXT_DETECTION: 1.50,  // $1.50 per 1000 pages
    TEXT_DETECTION: 1.50,           // $1.50 per 1000 pages
    LABEL_DETECTION: 1.50           // Not used but for reference
};

// Track API usage for cost estimation
let visionApiStats = {
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

/**
 * Check if Google Vision API is configured (basic check - env vars only)
 * @returns {{configured: boolean, method: string, details: string}}
 */
function isVisionConfigured() {
    const hasCredentialsFile = process.env.GOOGLE_APPLICATION_CREDENTIALS && 
        require('fs').existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    const hasApiKey = !!process.env.GOOGLE_VISION_API_KEY;
    const hasProjectId = !!process.env.GOOGLE_CLOUD_PROJECT;
    
    if (hasCredentialsFile) {
        return {
            configured: true,
            method: 'service_account',
            details: `Using service account from ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`
        };
    }
    
    if (hasApiKey) {
        return {
            configured: true,
            method: 'api_key',
            details: 'Using API key authentication'
        };
    }
    
    return {
        configured: false,
        method: 'none',
        details: 'Google Vision API not configured. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_VISION_API_KEY'
    };
}

/**
 * Test if Vision API actually works (makes a real API call)
 * Results are cached for 5 minutes to avoid excessive API calls
 * @returns {Promise<{working: boolean, configured: boolean, method: string, details: string, error?: string}>}
 */
async function checkVisionHealth() {
    // Check cache first
    const now = Date.now();
    if (healthCheckCache.result && (now - healthCheckCache.timestamp) < healthCheckCache.CACHE_TTL) {
        return healthCheckCache.result;
    }
    
    const config = isVisionConfigured();
    
    if (!config.configured) {
        const result = {
            working: false,
            configured: false,
            method: 'none',
            details: config.details
        };
        healthCheckCache = { result, timestamp: now };
        return result;
    }
    
    // Try to make a simple API call to verify access
    try {
        const client = getVisionClient();
        if (!client) {
            const result = {
                working: false,
                configured: true,
                method: config.method,
                details: 'Failed to initialize Vision client',
                error: 'Client initialization failed'
            };
            healthCheckCache = { result, timestamp: now };
            return result;
        }
        
        // Create a tiny 1x1 white PNG image for testing (minimal cost)
        // PNG header + IHDR + IDAT + IEND for a 1x1 white pixel
        const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
        const testImageBuffer = Buffer.from(testImageBase64, 'base64');
        
        // Use documentTextDetection (same as actual processing) instead of labelDetection
        // This ensures the health check tests the same API permissions as actual usage
        const [result] = await client.documentTextDetection({
            image: { content: testImageBuffer.toString('base64') }
        });
        
        // If we get here without error, the API is working
        const healthResult = {
            working: true,
            configured: true,
            method: config.method,
            details: 'Vision API is working correctly',
            lastChecked: new Date().toISOString()
        };
        healthCheckCache = { result: healthResult, timestamp: now };
        console.log('[VisionOCR] Health check passed - API is working');
        return healthResult;
        
    } catch (error) {
        console.error('[VisionOCR] Health check failed:', error.message);
        
        // Parse common error messages
        let errorDetail = error.message;
        if (error.message.includes('PERMISSION_DENIED')) {
            errorDetail = 'Permission denied - Cloud Vision API may not be enabled or API key lacks access';
        } else if (error.message.includes('UNAUTHENTICATED')) {
            errorDetail = 'Authentication failed - Check API key or service account credentials';
        } else if (error.message.includes('API has not been used')) {
            errorDetail = 'Cloud Vision API is not enabled in Google Cloud Console';
        } else if (error.message.includes('invalid')) {
            errorDetail = 'Invalid API key format';
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
 * Clear the health check cache (useful after config changes)
 */
function clearHealthCheckCache() {
    healthCheckCache = { result: null, timestamp: 0, CACHE_TTL: healthCheckCache.CACHE_TTL };
    console.log('[VisionOCR] Health check cache cleared');
}

/**
 * Initialize Vision client based on available credentials
 * @returns {Object|null} Vision client or null if not configured
 */
function getVisionClient() {
    const config = isVisionConfigured();
    
    if (!config.configured) {
        return null;
    }
    
    try {
        const vision = require('@google-cloud/vision');
        
        if (config.method === 'service_account') {
            return new vision.ImageAnnotatorClient({
                keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
            });
        } else if (config.method === 'api_key') {
            return new vision.ImageAnnotatorClient({
                apiKey: process.env.GOOGLE_VISION_API_KEY
            });
        }
    } catch (error) {
        console.error('[VisionOCR] Failed to initialize Vision client:', error.message);
        return null;
    }
    
    return null;
}

/**
 * Extract text from a single image using Google Vision API
 * @param {Buffer} imageBuffer - Image buffer (PNG/JPEG)
 * @returns {Promise<{text: string, confidence: number, blocks: Array, processingTimeMs: number, cost: number}>}
 */
async function extractTextFromImage(imageBuffer) {
    const startTime = Date.now();
    const client = getVisionClient();
    
    if (!client) {
        throw new Error('Google Vision API not configured');
    }
    
    try {
        // Use DOCUMENT_TEXT_DETECTION for better structure preservation
        const [result] = await client.documentTextDetection({
            image: { content: imageBuffer.toString('base64') }
        });
        
        const fullTextAnnotation = result.fullTextAnnotation;
        
        if (!fullTextAnnotation) {
            return {
                text: '',
                confidence: 0,
                blocks: [],
                processingTimeMs: Date.now() - startTime,
                cost: VISION_API_COSTS.DOCUMENT_TEXT_DETECTION / 1000,
                pageCount: 1
            };
        }
        
        // Extract text with structure
        const text = fullTextAnnotation.text || '';
        
        // Calculate average confidence from pages
        let totalConfidence = 0;
        let blockCount = 0;
        const blocks = [];
        
        if (fullTextAnnotation.pages) {
            for (const page of fullTextAnnotation.pages) {
                if (page.blocks) {
                    for (const block of page.blocks) {
                        blockCount++;
                        totalConfidence += block.confidence || 0;
                        
                        // Extract block text
                        let blockText = '';
                        if (block.paragraphs) {
                            for (const para of block.paragraphs) {
                                if (para.words) {
                                    for (const word of para.words) {
                                        if (word.symbols) {
                                            for (const symbol of word.symbols) {
                                                blockText += symbol.text || '';
                                            }
                                        }
                                        blockText += ' ';
                                    }
                                }
                                blockText += '\n';
                            }
                        }
                        
                        blocks.push({
                            text: blockText.trim(),
                            confidence: block.confidence,
                            boundingBox: block.boundingBox
                        });
                    }
                }
            }
        }
        
        const avgConfidence = blockCount > 0 ? (totalConfidence / blockCount) * 100 : 0;
        const cost = VISION_API_COSTS.DOCUMENT_TEXT_DETECTION / 1000;
        
        // Update stats
        visionApiStats.totalPages++;
        visionApiStats.totalCalls++;
        visionApiStats.totalCharactersExtracted += text.length;
        visionApiStats.estimatedCost += cost;
        
        return {
            text,
            confidence: Math.round(avgConfidence * 10) / 10,
            blocks,
            processingTimeMs: Date.now() - startTime,
            cost,
            characterCount: text.length,
            blockCount
        };
        
    } catch (error) {
        console.error('[VisionOCR] Error extracting text:', error.message);
        throw error;
    }
}

/**
 * Extract text from multiple images (multi-page document)
 * @param {Buffer[]} imageBuffers - Array of image buffers
 * @returns {Promise<{pages: Array, fullText: string, avgConfidence: number, totalCost: number, processingTimeMs: number}>}
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
            console.error(`[VisionOCR] Error on page ${i + 1}:`, error.message);
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
 * Reconstruct text with layout preservation
 * Attempts to maintain table structure and columns
 * @param {string} rawText - Raw OCR text
 * @returns {string} Reconstructed text
 */
function reconstructTextLayout(rawText) {
    if (!rawText) return '';
    
    // Split into lines
    let lines = rawText.split('\n');
    
    // Remove empty lines but preserve structure
    lines = lines.map(line => line.trim()).filter((line, index, arr) => {
        // Keep line if it has content OR if it's between content lines (preserve spacing)
        if (line) return true;
        const prevHasContent = index > 0 && arr[index - 1];
        const nextHasContent = index < arr.length - 1 && arr[index + 1];
        return prevHasContent && nextHasContent;
    });
    
    // Join back
    return lines.join('\n');
}

/**
 * Get Vision API usage statistics
 * @returns {Object} Usage stats including estimated cost
 */
function getVisionStats() {
    return {
        ...visionApiStats,
        costPerPage: VISION_API_COSTS.DOCUMENT_TEXT_DETECTION / 1000,
        uptime: Date.now() - visionApiStats.lastResetTime
    };
}

/**
 * Reset Vision API statistics
 */
function resetVisionStats() {
    visionApiStats = {
        totalPages: 0,
        totalCalls: 0,
        totalCharactersExtracted: 0,
        estimatedCost: 0,
        lastResetTime: Date.now()
    };
}

/**
 * Estimate cost for processing a document
 * @param {number} pageCount - Number of pages
 * @returns {{cost: number, details: string}}
 */
function estimateCost(pageCount) {
    const cost = (pageCount * VISION_API_COSTS.DOCUMENT_TEXT_DETECTION) / 1000;
    return {
        cost: Math.round(cost * 1000) / 1000,
        details: `$${cost.toFixed(4)} for ${pageCount} page(s) at $${VISION_API_COSTS.DOCUMENT_TEXT_DETECTION}/1000 pages`
    };
}

module.exports = {
    isVisionConfigured,
    checkVisionHealth,
    clearHealthCheckCache,
    extractTextFromImage,
    extractTextFromImages,
    reconstructTextLayout,
    getVisionStats,
    resetVisionStats,
    estimateCost,
    VISION_API_COSTS
};
