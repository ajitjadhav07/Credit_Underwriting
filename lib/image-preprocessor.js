/**
 * Image Preprocessor Module
 * Enhances scanned document images for better OCR accuracy
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Track if pdftoppm is available
let pdftoppmAvailable = null;

/**
 * Check if pdftoppm is available
 */
async function checkPdftoppm() {
    if (pdftoppmAvailable !== null) return pdftoppmAvailable;
    
    try {
        await execAsync('which pdftoppm');
        pdftoppmAvailable = true;
        console.log('[ImagePreprocessor] pdftoppm is available');
    } catch {
        pdftoppmAvailable = false;
        console.warn('[ImagePreprocessor] pdftoppm NOT available - PDF to image conversion will be limited');
    }
    return pdftoppmAvailable;
}

/**
 * Convert PDF pages to images using pdftoppm (poppler-utils)
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {number} dpi - Resolution (default 300 for OCR quality)
 * @returns {Promise<{images: Buffer[], pageCount: number, processingTimeMs: number, error?: string}>}
 */
async function convertPdfToImages(pdfBuffer, dpi = 300) {
    const startTime = Date.now();
    
    // Check if pdftoppm is available
    const hasPdftoppm = await checkPdftoppm();
    if (!hasPdftoppm) {
        console.warn('[ImagePreprocessor] pdftoppm not available, cannot convert PDF to images');
        return {
            images: [],
            pageCount: 0,
            processingTimeMs: Date.now() - startTime,
            dpi,
            error: 'pdftoppm not installed on server. Install poppler-utils for PDF to image conversion.'
        };
    }
    
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-convert-'));
    const pdfPath = path.join(tempDir, 'input.pdf');
    const outputPrefix = path.join(tempDir, 'page');
    
    try {
        // Write PDF to temp file
        fs.writeFileSync(pdfPath, pdfBuffer);
        
        // Convert using pdftoppm (from poppler-utils)
        // -png for PNG output, -r for resolution
        const { stdout, stderr } = await execAsync(`pdftoppm -png -r ${dpi} "${pdfPath}" "${outputPrefix}" 2>&1`);
        
        if (stderr && stderr.includes('error')) {
            console.error('[ImagePreprocessor] pdftoppm error:', stderr);
        }
        
        // Read generated images
        const files = fs.readdirSync(tempDir)
            .filter(f => f.startsWith('page-') && f.endsWith('.png'))
            .sort();
        
        if (files.length === 0) {
            console.warn('[ImagePreprocessor] pdftoppm produced no images');
            return {
                images: [],
                pageCount: 0,
                processingTimeMs: Date.now() - startTime,
                dpi,
                error: 'pdftoppm produced no images - PDF may be corrupted or password protected'
            };
        }
        
        const images = [];
        for (const file of files) {
            const imagePath = path.join(tempDir, file);
            const imageBuffer = fs.readFileSync(imagePath);
            
            // Validate image is not empty
            if (imageBuffer.length < 1000) {
                console.warn(`[ImagePreprocessor] Warning: ${file} is suspiciously small (${imageBuffer.length} bytes)`);
            }
            
            images.push(imageBuffer);
            console.log(`[ImagePreprocessor] Loaded ${file}: ${Math.round(imageBuffer.length / 1024)} KB`);
        }
        
        const processingTime = Date.now() - startTime;
        
        return {
            images,
            pageCount: images.length,
            processingTimeMs: processingTime,
            dpi
        };
        
    } catch (error) {
        console.error('[ImagePreprocessor] PDF conversion error:', error.message);
        return {
            images: [],
            pageCount: 0,
            processingTimeMs: Date.now() - startTime,
            dpi,
            error: error.message
        };
    } finally {
        // Cleanup temp directory
        try {
            const files = fs.readdirSync(tempDir);
            for (const file of files) {
                fs.unlinkSync(path.join(tempDir, file));
            }
            fs.rmdirSync(tempDir);
        } catch (e) {
            console.error('[ImagePreprocessor] Cleanup error:', e.message);
        }
    }
}

/**
 * Preprocess image for better OCR
 * - Grayscale conversion
 * - Contrast enhancement
 * - Sharpening
 * - Noise reduction
 * @param {Buffer} imageBuffer - Input image buffer
 * @returns {Promise<{processedImage: Buffer, processingTimeMs: number, enhancements: string[]}>}
 */
async function preprocessImage(imageBuffer) {
    const startTime = Date.now();
    const enhancements = [];
    
    try {
        let image = sharp(imageBuffer);
        
        // Get image metadata
        const metadata = await image.metadata();
        
        // 1. Convert to grayscale for text documents
        image = image.grayscale();
        enhancements.push('grayscale');
        
        // 2. Normalize/enhance contrast
        image = image.normalize();
        enhancements.push('contrast_normalized');
        
        // 3. Sharpen for crisper text
        image = image.sharpen({
            sigma: 1.5,
            m1: 0.5,
            m2: 0.5
        });
        enhancements.push('sharpened');
        
        // 4. Reduce noise with median filter
        image = image.median(1);
        enhancements.push('noise_reduced');
        
        // 5. Ensure adequate resolution
        if (metadata.width && metadata.width < 1500) {
            // Upscale small images
            image = image.resize({
                width: Math.min(metadata.width * 2, 3000),
                kernel: 'lanczos3'
            });
            enhancements.push('upscaled');
        }
        
        const processedImage = await image.png().toBuffer();
        
        return {
            processedImage,
            processingTimeMs: Date.now() - startTime,
            enhancements,
            originalSize: imageBuffer.length,
            processedSize: processedImage.length
        };
        
    } catch (error) {
        console.error('[ImagePreprocessor] Error processing image:', error.message);
        // Return original if processing fails
        return {
            processedImage: imageBuffer,
            processingTimeMs: Date.now() - startTime,
            enhancements: ['none - processing failed'],
            error: error.message
        };
    }
}

/**
 * Process all pages of a scanned PDF
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {Object} options - Processing options
 * @returns {Promise<{processedImages: Buffer[], pageCount: number, totalProcessingTimeMs: number, details: Object}>}
 */
async function processScannedPdf(pdfBuffer, options = {}) {
    const startTime = Date.now();
    const dpi = options.dpi || 300;
    
    // Step 1: Convert PDF to images
    const conversionResult = await convertPdfToImages(pdfBuffer, dpi);
    
    // Step 2: Preprocess each image
    const processedImages = [];
    const pageDetails = [];
    
    for (let i = 0; i < conversionResult.images.length; i++) {
        const preprocessResult = await preprocessImage(conversionResult.images[i]);
        processedImages.push(preprocessResult.processedImage);
        pageDetails.push({
            page: i + 1,
            enhancements: preprocessResult.enhancements,
            processingTimeMs: preprocessResult.processingTimeMs
        });
    }
    
    return {
        processedImages,
        pageCount: conversionResult.pageCount,
        totalProcessingTimeMs: Date.now() - startTime,
        conversionTimeMs: conversionResult.processingTimeMs,
        dpi,
        pageDetails
    };
}

/**
 * Check if required system tools are available
 * @returns {Promise<{pdftoppm: boolean, details: string}>}
 */
async function checkDependencies() {
    try {
        await execAsync('which pdftoppm');
        return {
            pdftoppm: true,
            details: 'pdftoppm (poppler-utils) is available'
        };
    } catch {
        return {
            pdftoppm: false,
            details: 'pdftoppm not found. Install with: apt-get install poppler-utils'
        };
    }
}

module.exports = {
    convertPdfToImages,
    preprocessImage,
    processScannedPdf,
    checkDependencies
};
