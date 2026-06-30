/**
 * Claude Extractor Module - Extracts financial data from documents using Claude (via Amazon Bedrock)
 * Enhanced with AWS Textract OCR pipeline for scanned documents
 *
 * NOTE: This module now calls Claude through Amazon Bedrock Runtime
 * (lib/bedrock-client.js) instead of api.anthropic.com directly — the
 * App tier has no internet egress in the UAT/Prod network design.
 * The adapter mimics the Anthropic SDK's messages.create() shape, so
 * all the extraction functions below are unchanged.
 */

const anthropic = require('./bedrock-client');

// OCR Pipeline modules (lazy loaded to handle missing dependencies gracefully)
let ocrPipeline = null;
let documentDetector = null;
let visionOcr = null;

// Try to load OCR modules
try {
    ocrPipeline = require('./ocr-pipeline');
    documentDetector = require('./document-detector');
    visionOcr = require('./textract-ocr');
    console.log('[Claude Extractor] OCR Pipeline modules loaded successfully');
} catch (error) {
    console.warn('[Claude Extractor] OCR Pipeline modules not available:', error.message);
    console.warn('[Claude Extractor] Falling back to Claude-only extraction');
}

// `anthropic` is the Bedrock adapter required above — it already exposes
// .messages.create(), no separate client instantiation needed.

// API stats tracker
let apiStats = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0
};

// Detailed API call logs
let apiCallLogs = [];

// OCR Pipeline stats
let ocrPipelineStats = {
    documentsProcessed: 0,
    scannedDocuments: 0,
    nativeDocuments: 0,
    visionApiCost: 0,
    visionApiCalls: 0
};

// Rate limits - actual Claude API limit is 30,000 tokens per minute
const TOKENS_PER_MINUTE_LIMIT = 30000;
let tokensUsedInLastMinute = 0;
let lastTokenResetTime = Date.now();

// Rate limits from last API call
let lastRateLimits = {
    requests: { remaining: null, limit: null },
    tokens: { remaining: null, limit: null }
};

// Helper to delay execution
const delayMs = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Smart rate limit delay based on tokens used
async function smartRateLimitDelay(estimatedTokens = 5000) {
    const now = Date.now();
    const timeSinceReset = now - lastTokenResetTime;
    
    // Reset token counter every minute
    if (timeSinceReset >= 60000) {
        tokensUsedInLastMinute = 0;
        lastTokenResetTime = now;
    }
    
    // Calculate if we're approaching the limit
    const projectedTokens = tokensUsedInLastMinute + estimatedTokens;
    if (projectedTokens > TOKENS_PER_MINUTE_LIMIT * 0.8) { // 80% threshold
        // Wait for the minute to reset
        const waitTime = Math.max(5000, 60000 - timeSinceReset + 5000); // Add 5s buffer
        console.log(`[Rate Limit] Token limit approaching (${tokensUsedInLastMinute}/${TOKENS_PER_MINUTE_LIMIT}). Waiting ${(waitTime/1000).toFixed(0)}s...`);
        await delayMs(waitTime);
        tokensUsedInLastMinute = 0;
        lastTokenResetTime = Date.now();
    }
}

// Wrapper function with retry logic for rate limits
async function callClaudeWithRetry(apiCall, docName = 'document', maxRetries = 3) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await apiCall();
            
            // Track tokens used in this minute
            if (response.usage) {
                tokensUsedInLastMinute += response.usage.input_tokens || 0;
            }
            
            return response;
        } catch (error) {
            lastError = error;
            
            // Check if it's a rate limit error
            if (error.status === 429 || (error.message && error.message.includes('rate_limit'))) {
                const waitTime = Math.pow(2, attempt) * 30000; // 30s, 60s, 120s
                console.log(`[Rate Limit] 429 error on ${docName} (attempt ${attempt}/${maxRetries}). Waiting ${waitTime/1000}s...`);
                
                // Reset token counter since we hit the limit
                tokensUsedInLastMinute = 0;
                lastTokenResetTime = Date.now() + waitTime;
                
                await delayMs(waitTime);
                continue;
            }
            
            // Non-rate-limit error, throw immediately
            throw error;
        }
    }
    
    throw lastError;
}

function getApiStats() {
    return { ...apiStats };
}

/**
 * Robust JSON extraction from Claude response
 * Handles cases where Claude adds explanatory text before/after JSON
 */
function extractJsonFromResponse(responseText) {
    // Step 1: Clean markdown code fences
    let cleanText = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
    
    // Step 2: Try direct parse first
    try {
        return JSON.parse(cleanText);
    } catch (e) {
        // Continue to extraction attempts
    }
    
    // Step 3: Try to find JSON object in the text
    // Look for the first { and last } to extract JSON object
    const firstBrace = cleanText.indexOf('{');
    const lastBrace = cleanText.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const jsonCandidate = cleanText.substring(firstBrace, lastBrace + 1);
        try {
            return JSON.parse(jsonCandidate);
        } catch (e) {
            // Continue to next attempt
        }
    }
    
    // Step 4: Try to find JSON array
    const firstBracket = cleanText.indexOf('[');
    const lastBracket = cleanText.lastIndexOf(']');
    
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
        const jsonCandidate = cleanText.substring(firstBracket, lastBracket + 1);
        try {
            return JSON.parse(jsonCandidate);
        } catch (e) {
            // Continue to next attempt
        }
    }
    
    // Step 5: Try regex to find JSON-like content (handles nested objects)
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[0]);
        } catch (e) {
            // Last resort failed
        }
    }
    
    // Step 6: Return error details for debugging
    const preview = cleanText.substring(0, 100);
    throw new Error(`Could not extract JSON from response. Preview: "${preview}..."`);
}

function resetApiStats() {
    apiStats = { calls: 0, inputTokens: 0, outputTokens: 0 };
    apiCallLogs = [];
    tokensUsedInLastMinute = 0;
    lastTokenResetTime = Date.now();
}

function getApiCallLogs() {
    return [...apiCallLogs];
}

function getRateLimits() {
    return { ...lastRateLimits };
}

function addApiCallLog(callInfo) {
    apiCallLogs.push({
        ...callInfo,
        timestamp: new Date().toISOString()
    });
    // Keep only last 50 calls
    if (apiCallLogs.length > 50) {
        apiCallLogs = apiCallLogs.slice(-50);
    }
}

// Helper to extract rate limits from response headers (if available)
function updateRateLimits(response) {
    if (response.usage) {
        apiStats.calls++;
        apiStats.inputTokens += response.usage.input_tokens || 0;
        apiStats.outputTokens += response.usage.output_tokens || 0;
        
        // Use actual rate limit (30K tokens/min)
        lastRateLimits = {
            requests: { 
                remaining: Math.max(0, 50 - apiStats.calls),
                limit: 50,
                used: apiStats.calls
            },
            tokens: { 
                remaining: Math.max(0, TOKENS_PER_MINUTE_LIMIT - tokensUsedInLastMinute),
                limit: TOKENS_PER_MINUTE_LIMIT,
                used: tokensUsedInLastMinute
            }
        };
    }
}

/**
 * System prompt for financial statement extraction
 * Simplified for reliability
 */
const EXTRACTION_SYSTEM_PROMPT = `You are an expert financial analyst extracting data from Indian company financial statements.

CRITICAL RULE FOR INDIAN NUMBER FORMAT:
Indian numbers use commas like: 9,27,72,206 or 66,22,30,971
To convert: Simply REMOVE ALL COMMAS. That's it.

Examples:
- 9,27,72,206 → 92772206
- 66,22,30,971 → 662230971  
- 1,00,000 → 100000
- 46,10,00,867 → 461000867

DO NOT add any zeros. DO NOT multiply. Just remove commas.

COLUMN SELECTION:
Indian Balance Sheets have two columns. Extract from the LEFT/FIRST column only (Current Year).
Ignore the RIGHT column (Previous Year).

OUTPUT:
- Return ONLY valid JSON
- All numbers as integers (no decimals, no commas)
- Use null for missing values`;

/**
 * System prompt for bank statement extraction
 */
const BANK_EXTRACTION_PROMPT = `You are an expert at analyzing Indian bank statements.

Extract banking data from the uploaded bank statement. Focus on:
1. Account details and period
2. Transaction summary (credits, debits)
3. Balance information
4. Cheque returns/bounces
5. EMI/loan payments

IMPORTANT:
- Convert all amounts to absolute numbers in Rupees
- If a value is not found, set it to null
- Return ONLY valid JSON`;

/**
 * System prompt for GST return extraction
 */
const GST_EXTRACTION_PROMPT = `You are an expert at analyzing Indian GST returns (GSTR-3B, GSTR-1, GSTR-9).

CRITICAL - NUMBER FORMAT FOR INDIAN NUMBERS:
Indian numbers use commas like: 7,59,14,601 or 5,05,27,67,642
To convert: Simply REMOVE ALL COMMAS. That's it.
- 7,59,14,601 → 75914601 (about 7.59 crore)
- 5,05,27,67,642 → 50527676742 (about 505 crore) 
DO NOT add zeros. Just remove commas.

IMPORTANT FOR GSTR-1 RETURNS:
1. A single PDF may contain MULTIPLE monthly returns (e.g., April, May, June in one quarterly file)
2. For turnover, look at "Table 12 - HSN-wise summary of outward supplies" - the "Total" row "Value" column
3. For tax liability, look at "Total Liability" at the bottom of each month's return
4. If multiple months exist, SUM all the monthly turnovers and taxes

GSTR-1 KEY FIELDS:
- Turnover: Table 12 HSN Summary → Total → Value column (e.g., "7,59,14,601.31")
- IGST: Look for "Integrated Tax" totals
- CGST: Look for "Central Tax" totals  
- SGST: Look for "State/UT Tax" totals
- Filing Date: Look for "ARN date" field

Return ONLY valid JSON with numbers as integers (no decimals, no commas).`;

/**
 * System prompt for ITR extraction
 */
const ITR_EXTRACTION_PROMPT = `You are an expert at analyzing Indian Income Tax Returns.

Extract ITR data including:
1. PAN and Assessment Year
2. Gross Total Income
3. Deductions under Chapter VI-A
4. Total Taxable Income (after deductions)
5. Tax Payable on total income
6. Taxes Paid (TDS/TCS/Advance Tax)
7. Total Tax, Interest and Fees Payable
8. Refund/Balance Due
9. Business income and other income breakup

CRITICAL - TAX COMPUTATION:
Pay special attention to the tax computation table/schedule. Extract:
- "Tax Payable" row → maps to tax_payable
- "Taxes Paid (TDS/TCS/Advance Tax)" row → maps to tax_paid AND taxes_paid_tds_tcs_advance
- "Total Tax, Interest and Fees Payable" row → maps to total_tax_interest_fees_payable
- "Total Taxable Income" row → maps to total_income AND taxable_income
These fields are MANDATORY if the document contains tax computation data.

IMPORTANT:
- Do NOT return null for tax_payable or tax_paid if the document shows these values
- Convert all amounts to absolute numbers
- Return ONLY valid JSON`;

/**
 * System prompt for KYC document extraction
 */
const KYC_EXTRACTION_PROMPT = `You are an expert at analyzing Indian corporate KYC documents.

Extract information including:
1. Company name and CIN
2. Date of incorporation
3. Registered address
4. Authorized and paid-up capital
5. Director names and DINs
6. Main business activity

IMPORTANT:
- Extract exact values as shown in documents
- Return ONLY valid JSON`;

/**
 * System prompt for property document extraction
 */
const PROPERTY_EXTRACTION_PROMPT = `You are an expert at analyzing Indian property documents.

Extract property information including:
1. Property type and address
2. Owner details
3. Property area (sq ft/sq m)
4. Property value/market value
5. Encumbrance status
6. Registration details

IMPORTANT:
- Convert all amounts to absolute numbers in Rupees
- Return ONLY valid JSON`;

const LEGAL_EXTRACTION_PROMPT = `You are an expert legal analyst specializing in Indian property law and mortgage documentation.

You analyze legal documents for mortgage/loan security assessment including:
1. Title Search Reports (TSR) - Analyzing ownership chain, title defects, POA-based transactions
2. Encumbrance Certificates (EC) - Identifying mortgages, charges, liens, attachments, lis pendens
3. Legal Opinions - Extracting advocate's assessment and conditions
4. ROC Search Reports - Company charge registrations
5. Revenue Records (7/12, Khata, Mutation) - Ownership verification
6. Building Approvals, OC/CC - Construction compliance
7. Sale Deeds and Chain Documents - Title verification

KEY LEGAL CONCEPTS:
- Lis Pendens: Pending litigation notice affecting property rights
- Encumbrance: Any charge, claim or liability attached to property
- Mutation: Transfer of property ownership in revenue records
- NA Conversion: Agricultural to Non-Agricultural land use change
- MOD: Memorandum of Deposit for equitable mortgage
- SARFAESI: Securitisation and Reconstruction of Financial Assets Act

IMPORTANT:
- Flag ANY adverse findings explicitly
- Identify ALL existing encumbrances with holder names
- Note any conditions precedent or subsequent from advocate
- Be conservative - when in doubt, flag as risk
- Return ONLY valid JSON`;

/**
 * Extract data from Balance Sheet PDF
 * Enhanced with OCR pipeline for scanned documents
 */
async function extractBalanceSheet(pdfBuffer, financialYear, progressCallback = null) {
    const docName = `Balance Sheet ${financialYear}`;
    const docSizeKB = Math.round(pdfBuffer.length / 1024);
    const startTime = Date.now();
    
    // ========== OCR PIPELINE PROCESSING (Steps 1-6) ==========
    let pipelineResult = null;
    let contentForClaude = null;
    let messageContent = [];
    
    if (ocrPipeline) {
        try {
            pipelineResult = await ocrPipeline.processDocument(pdfBuffer, docName, progressCallback);
            
            // Update OCR stats
            ocrPipelineStats.documentsProcessed++;
            if (pipelineResult.isScanned) {
                ocrPipelineStats.scannedDocuments++;
                ocrPipelineStats.visionApiCost += pipelineResult.visionCost || 0;
                if (pipelineResult.visionCost > 0) ocrPipelineStats.visionApiCalls++;
            } else {
                ocrPipelineStats.nativeDocuments++;
            }
            
            // Prepare content based on pipeline result
            if (pipelineResult.contentType === 'text' && pipelineResult.content) {
                // Use OCR extracted text
                console.log(`[OCR TEXT DUMP] ${docName} (${pipelineResult.content.length} chars):`);
                console.log('--- OCR START ---');
                console.log(pipelineResult.content);
                console.log('--- OCR END ---');
                messageContent = [{
                    type: "text",
                    text: `Here is the extracted text from a scanned Balance Sheet document:\n\n${pipelineResult.content}`
                }];
            } else {
                // Use PDF directly
                const base64Pdf = pdfBuffer.toString('base64');
                messageContent = [
                    {
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data: base64Pdf
                        }
                    }
                ];
            }
        } catch (error) {
            console.error('[OCR Pipeline] Error:', error.message);
            // Fallback to direct PDF
            const base64Pdf = pdfBuffer.toString('base64');
            messageContent = [
                {
                    type: "document",
                    source: {
                        type: "base64",
                        media_type: "application/pdf",
                        data: base64Pdf
                    }
                }
            ];
        }
    } else {
        // No OCR pipeline available, use PDF directly
        const base64Pdf = pdfBuffer.toString('base64');
        messageContent = [
            {
                type: "document",
                source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: base64Pdf
                }
            }
        ];
    }
    
    const userPrompt = `Extract the Balance Sheet data for ${financialYear} from this document.

CRITICAL - UNIT DETECTION:
First, check if the document header says "All amounts in ₹ Lakhs" or "₹ in Lakhs" or "in Crores" or "(In Rupees)" etc.
- If "in Lakhs", numbers like "4,285.60" mean ₹4,285.60 Lakhs
- If "in Crores", numbers like "42.86" mean ₹42.86 Crores
- If "in Thousands", just set unit_scale to "thousands" - DO NOT multiply
- If "(In Rupees)" or no unit specified, numbers are already in actual rupees

CRITICAL - INDIAN NUMBER FORMAT:
Indian balance sheets use the Indian comma system (lakhs/crores grouping):
- First comma after 3 digits from right, then every 2 digits
- 70,66,01,271 → strip commas → 706601271 (≈70.66 crores)
- 50,57,57,525 → strip commas → 505757525 (≈50.57 crores)
- 19,22,63,804 → strip commas → 192263804 (≈19.22 crores)
- 4,43,70,300 → strip commas → 44370300 (≈4.43 crores)
- 51,21,52,429 → strip commas → 512152429 (≈51.21 crores)
- 21,85,038 → strip commas → 2185038 (≈21.85 lakhs)
- 1,00,000 → strip commas → 100000 (1 lakh)
RULE: Simply remove ALL commas from the number. Do NOT insert, add, or remove any digits. 
The digit count before and after stripping commas MUST be the same.
Example: "70,66,01,271" has digits 7-0-6-6-0-1-2-7-1 = 9 digits → 706601271 (9 digits). NOT 7066001271 (10 digits).

CRITICAL - NEGATIVE NUMBERS:
Some Balance Sheet items can be negative. Watch for:
- Numbers with minus sign: -1,285.45
- Numbers in parentheses: (1,285.45) - these are NEGATIVE
- Reserves & Surplus can be NEGATIVE if accumulated losses exceed reserves
- Retained Earnings can be NEGATIVE

PRESERVE THE SIGN: If document shows (1,285.45) or -1,285.45, return -1285.45

COLUMN: Extract from the FIRST/LEFT numeric column only (Current Year / ${financialYear}).
The document may have 2 columns - current year and previous year. Only extract the FIRST/LEFT column.

MANDATORY CROSS-CHECK: After extraction, verify that Total Assets = Total Liabilities (Equity + Liabilities). 
If they don't match, re-read the numbers carefully - you likely misread a digit.

FIELDS TO EXTRACT:
- Total Assets
- Fixed Assets (Net) / Property Plant Equipment
- Current Assets (subtotal)
- Inventories
- Trade Receivables  
- Cash and Cash Equivalents
- Other Current Assets
- Total Equity and Liabilities
- Shareholders' Funds / Net Worth (can be negative if losses exceed capital)
- Share Capital
- Reserves and Surplus (CAN BE NEGATIVE - accumulated losses)
- Long-term Borrowings
- Short-term Borrowings
- Trade Payables (MANDATORY — also called "Sundry Creditors", "Trade and Other Payables", "Accounts Payable")
- Other Current Liabilities

CRITICAL - TRADE PAYABLES:
Trade Payables is a MANDATORY field. It ALWAYS exists on a Balance Sheet. Look for these labels:
- "Trade Payables"
- "Sundry Creditors" 
- "Trade and Other Payables"
- "Accounts Payable"
- "Creditors"
If you see "Trade Payables" as a separate line item, extract that value.
If Trade Payables is grouped with other items (e.g., "Trade Payables and Other Current Liabilities"), 
extract the combined amount as trade_payables and set other_current_liabilities to 0.
Do NOT skip this field. If the value is zero, return 0. Never return null for trade_payables.

CRITICAL - LIABILITIES CROSS-CHECK:
Total Liabilities = Net Worth + Long Term Borrowings + Short Term Borrowings + Trade Payables + Other Current Liabilities
If your extracted values don't add up to Total Liabilities, re-read the liabilities section carefully.
Common mistake: missing Trade Payables or merging it into Other Current Liabilities.

Return this JSON structure:
{
  "financial_year": "${financialYear}",
  "unit_scale": "lakhs" | "crores" | "thousands" | "rupees",

  "balance_sheet": {
    "total_assets": <number>,
    "fixed_assets_gross": <number or null>,
    "fixed_assets_net": <number>,
    "current_assets": <number>,
    "inventory": <number or null>,
    "trade_receivables": <number>,
    "cash_bank": <number>,
    "other_current_assets": <number or null>,
    "total_liabilities": <number>,
    "net_worth": <number - CAN BE NEGATIVE>,
    "share_capital": <number>,
    "reserves_surplus": <number - CAN BE NEGATIVE if losses>,
    "long_term_borrowings": <number or null>,
    "short_term_borrowings": <number or null>,
    "trade_payables": <number - MANDATORY, never null, use 0 if not found>,
    "other_current_liabilities": <number or null>
  },
  "extraction_confidence": "high" | "medium" | "low",
  "notes": "<mention any negative values found>"
}

CRITICAL: Preserve negative signs! (1,285) or -1,285 should be returned as -1285.

CRITICAL: Extract numbers EXACTLY as printed in the document. DO NOT multiply by any unit.
If document says "In Crore" and shows 23,500 — return 23500 (NOT 235000000000).
If document says "In Lakhs" and shows 4,285 — return 4285 (NOT 428500000).
Just specify the unit_scale and we will handle the conversion.

Return ONLY valid JSON, no other text.`;

    // Add prompt to message content
    messageContent.push({
        type: "text",
        text: userPrompt
    });

    try {
        // ========== STEP 7: Claude Extraction ==========
        const claudeStartTime = Date.now();
        
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            temperature: 0,
            system: EXTRACTION_SYSTEM_PROMPT,
            messages: [{
                role: "user",
                content: messageContent
            }]
        });

        const responseTime = (Date.now() - startTime) / 1000;
        const claudeResponseTime = Date.now() - claudeStartTime;
        
        // Update rate limits and stats
        updateRateLimits(response);
        
        const inputTokens = response.usage?.input_tokens || 0;
        const outputTokens = response.usage?.output_tokens || 0;
        
        console.log(`[API] BS ${financialYear} - Time: ${responseTime}s, Input: ${inputTokens}, Output: ${outputTokens}`);

        const responseText = response.content[0].text;
        console.log(`[CLAUDE RESPONSE] BS ${financialYear}:`);
        console.log('--- CLAUDE JSON START ---');
        console.log(responseText);
        console.log('--- CLAUDE JSON END ---');
        const result = extractJsonFromResponse(responseText);
        
        // Count extracted fields
        const fieldsExtracted = result.balance_sheet ? 
            Object.values(result.balance_sheet).filter(v => v !== null && v !== undefined).length : 0;
        
        // ========== STEP 7 & 8: Log Claude extraction steps ==========
        if (ocrPipeline) {
            ocrPipeline.logClaudeExtractionSteps(docName, {
                inputTokens,
                outputTokens,
                responseTimeMs: claudeResponseTime,
                fieldsExtracted,
                confidence: result.extraction_confidence || 'unknown',
                keyValues: {
                    total_assets: result.balance_sheet?.total_assets,
                    net_worth: result.balance_sheet?.net_worth,
                    current_assets: result.balance_sheet?.current_assets
                }
            }, progressCallback);
        }
        
        // Log detailed call info
        addApiCallLog({
            callType: 'balance_sheet_extraction',
            document: docName,
            documentSize: docSizeKB,
            model: 'claude-sonnet-4-20250514',
            promptSummary: `Extract Balance Sheet data for ${financialYear}. Fields: total_assets, fixed_assets, current_assets, net_worth, borrowings, etc.`,
            responseTime: responseTime,
            tokensUsed: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
            fieldsExtracted: fieldsExtracted,
            confidence: result.extraction_confidence || 'unknown',
            keyValues: {
                total_assets: result.balance_sheet?.total_assets,
                net_worth: result.balance_sheet?.net_worth,
                current_assets: result.balance_sheet?.current_assets
            },
            rateLimits: getRateLimits(),
            success: true,
            // OCR Pipeline details
            ocrPipeline: pipelineResult ? {
                isScanned: pipelineResult.isScanned,
                contentType: pipelineResult.contentType,
                ocrConfidence: pipelineResult.ocrConfidence,
                visionCost: pipelineResult.visionCost,
                processingSteps: pipelineResult.processingSteps?.length || 0
            } : null
        });

        // Return result WITH token usage for rate limiting
        result._tokensUsed = inputTokens;
        result._ocrPipeline = pipelineResult;
        return result;
    } catch (error) {
        const responseTime = (Date.now() - startTime) / 1000;
        
        // Log failed call
        addApiCallLog({
            callType: 'balance_sheet_extraction',
            document: `Balance Sheet ${financialYear}`,
            documentSize: docSizeKB,
            model: 'claude-sonnet-4-20250514',
            promptSummary: `Extract Balance Sheet data for ${financialYear}`,
            responseTime: responseTime,
            error: error.message,
            success: false
        });
        
        console.error('Balance Sheet extraction error:', error);
        throw new Error(`Failed to extract Balance Sheet: ${error.message}`);
    }
}

/**
 * Extract data from P&L Statement PDF
 */
async function extractProfitAndLoss(pdfBuffer, financialYear) {
    const base64Pdf = pdfBuffer.toString('base64');
    const docSizeKB = Math.round(pdfBuffer.length / 1024);
    const startTime = Date.now();
    
    const userPrompt = `Extract the Profit & Loss Statement data for ${financialYear} from this document.

CRITICAL - UNIT DETECTION:
First, check if the document header says "All amounts in ₹ Lakhs" or "in Crores" etc.
- If "in Lakhs", numbers like "4,285.60" mean ₹4,285.60 Lakhs
- If "in Crores", numbers like "42.86" mean ₹42.86 Crores
- If "in Thousands", just set unit_scale to "thousands" - DO NOT multiply
- If no unit specified, assume actual rupees

CRITICAL - NEGATIVE NUMBERS:
P&L statements can have NEGATIVE values. Watch for:
- Numbers with minus sign: -125.50
- Numbers in parentheses: (125.50) - these are NEGATIVE
- Loss situations: Profit Before Tax or Profit After Tax can be NEGATIVE
- Tax credit (negative tax expense) when there's a loss
- Exceptional items can be negative

PRESERVE THE SIGN: If document shows (125.50) or -125.50, return -125.50

CRITICAL - INDIAN NUMBER FORMAT:
Indian financial statements use the Indian comma system (lakhs/crores grouping):
- First comma after 3 digits from right, then every 2 digits
- 70,66,01,271 → strip commas → 706601271 (≈70.66 crores)
- 50,57,57,525 → strip commas → 505757525 (≈50.57 crores)
- 4,43,70,300 → strip commas → 44370300 (≈4.43 crores)
- 1,00,000 → strip commas → 100000 (1 lakh)
RULE: Simply remove ALL commas from the number. Do NOT insert, add, or remove any digits.
The digit count before and after stripping commas MUST be the same.
Example: "70,66,01,271" has digits 7-0-6-6-0-1-2-7-1 = 9 digits → 706601271 (9 digits). NOT 7066001271 (10 digits).

NUMBER FORMAT: Remove commas but KEEP negative signs.
- "4,285.60" → 4285.60
- "-125.50" → -125.50
- "(125.50)" → -125.50

COLUMN: Extract from the FIRST/LEFT numeric column only (Current Year / ${financialYear}).

FIELDS TO EXTRACT:
- Revenue from Operations (NOT "Total Revenue")
- Other Income
- Cost of Materials Consumed / Purchases
- Employee Benefit Expenses
- Finance Costs (interest expense)
- Depreciation and Amortization
- Other Expenses
- Profit Before Tax (CAN BE NEGATIVE = Loss)
- Tax Expense (can be negative if tax credit)
- Profit for the Period / PAT (CAN BE NEGATIVE = Net Loss)

CALCULATED FIELDS:
- EBITDA = Profit Before Tax + Depreciation + Finance Costs
- EBIT = EBITDA - Depreciation

Return this JSON structure:
{
  "financial_year": "${financialYear}",
  "unit_scale": "lakhs" | "crores" | "thousands" | "rupees",

  "profit_and_loss": {
    "revenue": <number>,
    "other_income": <number or null>,
    "total_revenue": <number or null>,
    "cost_of_goods_sold": <number or null>,
    "gross_profit": <number or null - can be negative>,
    "employee_expenses": <number>,
    "admin_expenses": <number or null>,
    "selling_expenses": <number or null>,
    "other_expenses": <number or null>,
    "ebitda": <number - can be negative>,
    "depreciation": <number>,
    "ebit": <number or null - can be negative>,
    "interest_expense": <number>,
    "profit_before_tax": <number - NEGATIVE if loss>,
    "tax_expense": <number - can be negative if credit>,
    "profit_after_tax": <number - NEGATIVE if net loss>
  },
  "extraction_confidence": "high" | "medium" | "low",
  "notes": "<mention any negative values/losses found>"
}

CRITICAL: Preserve negative signs! (125.50) or -125.50 should return -125.50

CRITICAL: Extract numbers EXACTLY as printed in the document. DO NOT multiply by any unit.
If document says "In Crore" and shows 500 — return 500 (NOT 5000000000).
If document says "In Lakhs" and shows 1,285 — return 1285 (NOT 128500000).
Just specify the unit_scale and we will handle the conversion.

Return ONLY valid JSON, no other text.`;

    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            temperature: 0,
            system: EXTRACTION_SYSTEM_PROMPT,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data: base64Pdf
                        }
                    },
                    {
                        type: "text",
                        text: userPrompt
                    }
                ]
            }]
        });

        const responseTime = (Date.now() - startTime) / 1000;
        updateRateLimits(response);
        
        const inputTokens = response.usage?.input_tokens || 0;
        const outputTokens = response.usage?.output_tokens || 0;
        
        console.log(`[API] P&L ${financialYear} - Time: ${responseTime}s, Input: ${inputTokens}, Output: ${outputTokens}`);

        const responseText = response.content[0].text;
        const result = extractJsonFromResponse(responseText);
        
        const fieldsExtracted = result.profit_and_loss ? 
            Object.values(result.profit_and_loss).filter(v => v !== null && v !== undefined).length : 0;
        
        addApiCallLog({
            callType: 'pnl_extraction',
            document: `P&L Statement ${financialYear}`,
            documentSize: docSizeKB,
            model: 'claude-sonnet-4-20250514',
            promptSummary: `Extract P&L data for ${financialYear}. Fields: revenue, COGS, gross_profit, EBITDA, PAT, etc.`,
            responseTime: responseTime,
            tokensUsed: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
            fieldsExtracted: fieldsExtracted,
            confidence: result.extraction_confidence || 'unknown',
            keyValues: {
                revenue: result.profit_and_loss?.revenue,
                ebitda: result.profit_and_loss?.ebitda,
                profit_after_tax: result.profit_and_loss?.profit_after_tax
            },
            rateLimits: getRateLimits(),
            success: true
        });
        
        result._tokensUsed = inputTokens;
        return result;
    } catch (error) {
        const responseTime = (Date.now() - startTime) / 1000;
        addApiCallLog({
            callType: 'pnl_extraction',
            document: `P&L Statement ${financialYear}`,
            documentSize: docSizeKB,
            responseTime: responseTime,
            error: error.message,
            success: false
        });
        console.error('P&L extraction error:', error);
        throw new Error(`Failed to extract P&L: ${error.message}`);
    }
}

/**
 * Extract data from Bank Statement PDF
 */
async function extractCashFlow(pdfBuffer, financialYear) {
    const base64Pdf = pdfBuffer.toString('base64');
    const docSizeKB = Math.round(pdfBuffer.length / 1024);
    const startTime = Date.now();
    
    const userPrompt = `Extract the Cash Flow Statement data for ${financialYear} from this document.

CRITICAL - UNIT DETECTION:
First, check if the document header says "All figures in crore" or "in Lakhs" or similar.
- If "in crore/crores", numbers like "28,104" mean ₹28,104 Crores
- If "in Lakhs", numbers like "4,285.60" mean ₹4,285.60 Lakhs
- If no unit specified, assume amounts are in actual rupees

CRITICAL - NEGATIVE NUMBERS:
Cash flow statements contain many NEGATIVE values. Look carefully for:
- Numbers with minus sign: -492, -251, -14
- Numbers in parentheses: (492), (251), (14) - these are NEGATIVE
- Words like "(Increase)" before a positive number means the cash impact is NEGATIVE

For working capital changes:
- "(Increase)/Decrease in Trade Receivables: -492" → return -492 (negative)
- "(Increase)/Decrease in Inventories: -251" → return -251 (negative)
- "Increase/(Decrease) in Trade Payables: -14" → return -14 (negative)

PRESERVE THE SIGN: If the document shows -14, return -14 (not 14).

CRITICAL - INDIAN NUMBER FORMAT:
Indian financial statements use the Indian comma system (lakhs/crores grouping):
- First comma after 3 digits from right, then every 2 digits
- 70,66,01,271 → strip commas → 706601271 (≈70.66 crores)
- 50,57,57,525 → strip commas → 505757525 (≈50.57 crores)
- 4,43,70,300 → strip commas → 44370300 (≈4.43 crores)
- 1,00,000 → strip commas → 100000 (1 lakh)
RULE: Simply remove ALL commas from the number. Do NOT insert, add, or remove any digits.
The digit count before and after stripping commas MUST be the same.

NUMBER FORMAT: Indian numbers have commas (e.g., 28,104). Remove commas but KEEP the negative sign.
- "-28,104" → -28104
- "(28,104)" → -28104
- "28,104" → 28104

COLUMN: Extract from the FIRST/LEFT numeric column only (Current Year / ${financialYear}). Ignore the second column.

FIELDS TO EXTRACT:

A. CASH FLOW FROM OPERATING ACTIVITIES:
- Net Profit Before Tax
- Depreciation and Amortization (positive - add-back)
- Interest Expense (positive - add-back)
- Changes in Working Capital (WATCH FOR NEGATIVES):
  - (Increase)/Decrease in Inventories - often NEGATIVE when inventory increases
  - (Increase)/Decrease in Trade Receivables - often NEGATIVE when receivables increase
  - Increase/(Decrease) in Trade Payables - can be positive or negative
- Cash Generated from Operations
- Net Cash from Operating Activities
  - Increase/(Decrease) in Trade Payables
- Cash Generated from Operations
- Net Cash from Operating Activities

B. CASH FLOW FROM INVESTING ACTIVITIES:
- Capital Expenditure (Purchase of Fixed Assets) - usually NEGATIVE (outflow)
- Sale of Fixed Assets - usually positive (inflow)
- Net Cash from Investing Activities - often NEGATIVE

C. CASH FLOW FROM FINANCING ACTIVITIES:
- Proceeds from Borrowings - positive (inflow)
- Repayment of Borrowings - NEGATIVE (outflow)
- Interest Paid - NEGATIVE (outflow)
- Dividends Paid - NEGATIVE (outflow)
- Net Cash from Financing Activities - can be positive or negative

D. NET CHANGE IN CASH:
- Net Increase/(Decrease) in Cash
- Opening Cash and Cash Equivalents
- Closing Cash and Cash Equivalents

Return this JSON structure:
{
  "financial_year": "${financialYear}",
  "unit_scale": "lakhs" | "crores" | "thousands" | "rupees",

  "cash_flow": {
    "operating_cash_flow": <number - can be positive or negative>,
    "net_profit_before_tax": <number or null>,
    "depreciation_amortization": <positive number - add-back>,
    "increase_decrease_inventory": <PRESERVE SIGN: negative if inventory increased>,
    "increase_decrease_receivables": <PRESERVE SIGN: negative if receivables increased>,
    "increase_decrease_payables": <PRESERVE SIGN: as shown in document>,
    "investing_cash_flow": <number - often negative>,
    "capital_expenditure": <NEGATIVE number for purchases>,
    "sale_of_assets": <positive number or null>,
    "financing_cash_flow": <number>,
    "loan_proceeds": <positive number or null>,
    "loan_repayment": <NEGATIVE number for repayments>,
    "interest_paid": <NEGATIVE number>,
    "dividend_paid": <NEGATIVE number>,
    "net_cash_flow": <number>,
    "opening_cash": <positive number>,
    "closing_cash": <positive number>
  },
  "extraction_confidence": "high" | "medium" | "low",
  "notes": "<mention any negative values extracted>"
}

CRITICAL: Preserve negative signs! If document shows -492, return -492 (NOT 492).
Extract numbers EXACTLY as shown including the sign, then specify the unit_scale.

CRITICAL: DO NOT multiply numbers by any unit. Return the raw number as printed.
If document says "In Crore" and shows 3,000 — return 3000 (NOT 30000000000).
Just specify the unit_scale and we will handle the conversion.

Return ONLY valid JSON, no other text.`;

    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            temperature: 0,
            system: EXTRACTION_SYSTEM_PROMPT,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data: base64Pdf
                        }
                    },
                    {
                        type: "text",
                        text: userPrompt
                    }
                ]
            }]
        });

        const responseTime = (Date.now() - startTime) / 1000;
        updateRateLimits(response);
        
        const inputTokens = response.usage?.input_tokens || 0;
        const outputTokens = response.usage?.output_tokens || 0;
        
        console.log(`[API] Cash Flow ${financialYear} - Time: ${responseTime}s, Input: ${inputTokens}, Output: ${outputTokens}`);

        const responseText = response.content[0].text;
        const result = extractJsonFromResponse(responseText);
        
        const fieldsExtracted = result.cash_flow ? 
            Object.values(result.cash_flow).filter(v => v !== null && v !== undefined).length : 0;
        
        addApiCallLog({
            callType: 'cashflow_extraction',
            document: `Cash Flow Statement ${financialYear}`,
            documentSize: docSizeKB,
            model: 'claude-sonnet-4-20250514',
            promptSummary: `Extract Cash Flow data for ${financialYear}. Fields: operating, investing, financing cash flows.`,
            responseTime: responseTime,
            tokensUsed: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
            fieldsExtracted: fieldsExtracted,
            confidence: result.extraction_confidence || 'unknown',
            keyValues: {
                operating_cash_flow: result.cash_flow?.operating_cash_flow,
                investing_cash_flow: result.cash_flow?.investing_cash_flow,
                financing_cash_flow: result.cash_flow?.financing_cash_flow,
                net_cash_flow: result.cash_flow?.net_cash_flow
            },
            rateLimits: getRateLimits(),
            success: true
        });
        
        result._tokensUsed = inputTokens;
        return result;
    } catch (error) {
        const responseTime = (Date.now() - startTime) / 1000;
        addApiCallLog({
            callType: 'cashflow_extraction',
            document: `Cash Flow Statement ${financialYear}`,
            documentSize: docSizeKB,
            responseTime: responseTime,
            error: error.message,
            success: false
        });
        console.error('Cash Flow extraction error:', error);
        throw new Error(`Failed to extract Cash Flow: ${error.message}`);
    }
}

/**
 * Extract data from Bank Statement PDF
 */
async function extractBankStatement(pdfBuffer, month) {
    const base64Pdf = pdfBuffer.toString('base64');
    
    const userPrompt = `Extract banking data from this bank statement for ${month}.

Return a JSON object with this structure:
{
  "month": "${month}",
  "account_number": "<masked account number or null>",
  "bank_name": "<bank name or null>",
  "opening_balance": <number or null>,
  "closing_balance": <number or null>,
  "total_credits": <number or null>,
  "total_debits": <number or null>,
  "credit_count": <number or null>,
  "debit_count": <number or null>,
  "average_balance": <number or null>,
  "minimum_balance": <number or null>,
  "cheque_returns": <number or null>,
  "cheque_return_amount": <number or null>,
  "emi_payments": [
    {"lender": "<name>", "amount": <number>, "date": "<date>"}
  ],
  "high_value_credits": [
    {"amount": <number>, "date": "<date>", "description": "<desc>"}
  ],
  "extraction_confidence": "high" | "medium" | "low"
}

Return ONLY the JSON object, no other text.`;

    const docSizeKB = Math.round(pdfBuffer.length / 1024);
    const startTime = Date.now();

    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            temperature: 0,
            system: BANK_EXTRACTION_PROMPT,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data: base64Pdf
                        }
                    },
                    {
                        type: "text",
                        text: userPrompt
                    }
                ]
            }]
        });

        const responseTime = (Date.now() - startTime) / 1000;
        updateRateLimits(response);
        const inputTokens = response.usage?.input_tokens || 0;
        const outputTokens = response.usage?.output_tokens || 0;
        console.log(`[API] Bank ${month} - Time: ${responseTime}s, Input: ${inputTokens}, Output: ${outputTokens}`);

        const responseText = response.content[0].text;
        const result = extractJsonFromResponse(responseText);
        
        addApiCallLog({
            callType: 'bank_statement_extraction',
            document: `Bank Statement ${month}`,
            documentSize: docSizeKB,
            model: 'claude-sonnet-4-20250514',
            promptSummary: `Extract bank data for ${month}. Fields: balance, credits, debits.`,
            responseTime: responseTime,
            tokensUsed: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
            keyValues: { total_credits: result.total_credits, total_debits: result.total_debits, closing_balance: result.closing_balance },
            confidence: result.extraction_confidence || 'unknown',
            rateLimits: getRateLimits(),
            success: true
        });
        
        result._tokensUsed = inputTokens;
        return result;
    } catch (error) {
        const responseTime = (Date.now() - startTime) / 1000;
        addApiCallLog({ callType: 'bank_statement_extraction', document: `Bank ${month}`, responseTime, error: error.message, success: false });
        console.error('Bank statement extraction error:', error);
        throw new Error(`Failed to extract bank statement: ${error.message}`);
    }
}

/**
 * Extract data from GST Return PDF
 */
async function extractGSTReturn(pdfBuffer, period) {
    const base64Pdf = pdfBuffer.toString('base64');
    
    const userPrompt = `Extract GST data from this GSTR-1 return for period: ${period}

IMPORTANT: This PDF may contain MULTIPLE months of data. If so, SUM all values.

Look for these specific fields:
1. GSTIN: Found at top (e.g., "27AAMCA8514C1ZR")
2. Legal Name: Found under GSTIN
3. Turnover: Find "Table 12 - HSN-wise summary" → look for TOTAL row → Value column
   - If multiple months exist, ADD all monthly totals
4. Tax amounts: Look at each "Total Liability" row at bottom of each month
   - IGST = Integrated Tax column total
   - CGST = Central Tax column total  
   - SGST = State/UT Tax column total
5. Filing Date: Look for "ARN date" (e.g., "11/05/2025")

NUMBER CONVERSION: Remove commas, keep digits only.
- 7,59,14,601.31 → 75914601
- 5,05,27,67,642 → 5052767642

Return JSON:
{
  "period": "${period}",
  "gstin": "<GSTIN>",
  "legal_name": "<company name>",
  "return_type": "GSTR-1",
  "filing_status": "Filed",
  "filing_date": "<latest ARN date in DD/MM/YYYY>",
  "months_in_file": <count of monthly returns in this PDF>,
  "taxable_turnover": <sum of all Table 12 totals as integer>,
  "exempt_turnover": 0,
  "total_turnover": <same as taxable_turnover>,
  "cgst_liability": <sum of all Central Tax as integer>,
  "sgst_liability": <sum of all State/UT Tax as integer>,
  "igst_liability": <sum of all Integrated Tax as integer>,
  "total_tax_liability": <cgst + sgst + igst>,
  "itc_claimed": null,
  "tax_paid": <total_tax_liability>,
  "extraction_confidence": "high" | "medium" | "low"
}

Return ONLY the JSON object.`;

    const docSizeKB = Math.round(pdfBuffer.length / 1024);
    const startTime = Date.now();

    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            temperature: 0,
            system: GST_EXTRACTION_PROMPT,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data: base64Pdf
                        }
                    },
                    {
                        type: "text",
                        text: userPrompt
                    }
                ]
            }]
        });

        const responseTime = (Date.now() - startTime) / 1000;
        updateRateLimits(response);
        const inputTokens = response.usage?.input_tokens || 0;
        const outputTokens = response.usage?.output_tokens || 0;
        console.log(`[API] GST ${period} - Time: ${responseTime}s, Input: ${inputTokens}, Output: ${outputTokens}`);

        const responseText = response.content[0].text;
        const result = extractJsonFromResponse(responseText);
        
        addApiCallLog({
            callType: 'gst_return_extraction',
            document: `GST Return ${period}`,
            documentSize: docSizeKB,
            model: 'claude-sonnet-4-20250514',
            promptSummary: `Extract GST data for ${period}. Fields: turnover, tax liability, ITC claimed.`,
            responseTime: responseTime,
            tokensUsed: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
            keyValues: { total_turnover: result.total_turnover, tax_paid: result.tax_paid, itc_claimed: result.itc_claimed },
            confidence: result.extraction_confidence || 'unknown',
            rateLimits: getRateLimits(),
            success: true
        });
        
        result._tokensUsed = inputTokens;
        return result;
    } catch (error) {
        const responseTime = (Date.now() - startTime) / 1000;
        addApiCallLog({ callType: 'gst_return_extraction', document: `GST ${period}`, responseTime, error: error.message, success: false });
        console.error('GST return extraction error:', error);
        throw new Error(`Failed to extract GST return: ${error.message}`);
    }
}

/**
 * Extract data from ITR PDF
 */
async function extractITR(pdfBuffer, assessmentYear) {
    const base64Pdf = pdfBuffer.toString('base64');
    
    const userPrompt = `Extract income tax data from this ITR for ${assessmentYear}.

CRITICAL - UNIT DETECTION:
Check if amounts are shown "in Lakhs" or "in Crores" or actual rupees.
- ITR forms typically show amounts in actual rupees
- But some schedules may show amounts in Lakhs
- Look for headers like "Amount (in ₹)" or "Amount (in Lakhs)"

CRITICAL - INDIAN NUMBER FORMAT:
Indian documents use the Indian comma system (lakhs/crores grouping):
- First comma after 3 digits from right, then every 2 digits
- 70,66,01,271 → strip commas → 706601271 (≈70.66 crores)
- 12,34,567 → strip commas → 1234567 (≈12.34 lakhs)
- 1,00,000 → strip commas → 100000 (1 lakh)
RULE: Simply remove ALL commas. Do NOT insert, add, or remove any digits.
The digit count before and after stripping commas MUST be the same.

NUMBER FORMAT: Remove commas but KEEP negative signs.
- "12,34,567" → 1234567
- "(1,23,456)" → -123456 (brackets mean negative)

Return a JSON object with this structure:
{
  "assessment_year": "${assessmentYear}",
  "unit_scale": "lakhs" | "crores" | "rupees",

  "pan": "<PAN or null>",
  "name": "<name or null>",
  "itr_form": "ITR-3" | "ITR-4" | "ITR-5" | "ITR-6" | null,
  "filing_date": "<date or null>",
  "acknowledgment_number": "<number or null>",
  "gross_total_income": <number or null>,
  "business_income": <number or null>,
  "other_income": <number or null>,
  "total_deductions": <number or null>,
  "taxable_income": <number or null>,
  "total_income": <number or null>,
  "tax_computed": <number or null>,
  "tds_claimed": <number or null>,
  "advance_tax_paid": <number or null>,
  "self_assessment_tax": <number or null>,
  "refund_due": <number or null>,
  "tax_payable": <number or null>,
  "tax_paid": <number or null>,
  "total_tax_interest_fees_payable": <number or null>,
  "taxes_paid_tds_tcs_advance": <number or null>,
  "extraction_confidence": "high" | "medium" | "low"
}

CRITICAL: DO NOT multiply numbers by any unit. Return the raw number as printed.
Just specify the unit_scale and we will handle the conversion.

CRITICAL - TAX FIELDS:
- "tax_payable" = Tax Payable amount from the computation
- "tax_paid" = Taxes Paid / TDS+TCS+Advance Tax (the total taxes already paid)
- "total_tax_interest_fees_payable" = Total Tax + Interest + Fees Payable
- "taxes_paid_tds_tcs_advance" = Taxes Paid (TDS/TCS/Advance Tax) line
- "total_income" = Total Taxable Income (after deductions)
- "taxable_income" = same as total_income (Total Taxable Income)
These are CRITICAL fields. Look for them in the tax computation schedule.
Do NOT return null for these if the document shows tax computation data.

Return ONLY the JSON object, no other text.`;

    const docSizeKB = Math.round(pdfBuffer.length / 1024);
    const startTime = Date.now();

    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            temperature: 0,
            system: ITR_EXTRACTION_PROMPT,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data: base64Pdf
                        }
                    },
                    {
                        type: "text",
                        text: userPrompt
                    }
                ]
            }]
        });

        const responseTime = (Date.now() - startTime) / 1000;
        updateRateLimits(response);
        const inputTokens = response.usage?.input_tokens || 0;
        const outputTokens = response.usage?.output_tokens || 0;
        console.log(`[API] ITR ${assessmentYear} - Time: ${responseTime}s, Input: ${inputTokens}, Output: ${outputTokens}`);

        const responseText = response.content[0].text;
        const result = extractJsonFromResponse(responseText);
        
        addApiCallLog({
            callType: 'itr_extraction',
            document: `ITR ${assessmentYear}`,
            documentSize: docSizeKB,
            model: 'claude-sonnet-4-20250514',
            promptSummary: `Extract ITR data for ${assessmentYear}. Fields: total income, tax computed, refund.`,
            responseTime: responseTime,
            tokensUsed: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
            keyValues: { taxable_income: result.taxable_income, tax_computed: result.tax_computed, tax_payable: result.tax_payable, tax_paid: result.tax_paid },
            confidence: result.extraction_confidence || 'unknown',
            rateLimits: getRateLimits(),
            success: true
        });
        
        result._tokensUsed = inputTokens;
        return result;
    } catch (error) {
        const responseTime = (Date.now() - startTime) / 1000;
        addApiCallLog({ callType: 'itr_extraction', document: `ITR ${assessmentYear}`, responseTime, error: error.message, success: false });
        console.error('ITR extraction error:', error);
        throw new Error(`Failed to extract ITR: ${error.message}`);
    }
}

/**
 * Extract data from KYC documents (COI, MOA, AOA, PAN, etc.)
 */
async function extractKYC(pdfBuffer, docType) {
    const base64Pdf = pdfBuffer.toString('base64');
    
    const userPrompt = `Extract KYC information from this ${docType} document.

Return a JSON object with this structure:
{
  "document_type": "${docType}",
  "company_name": "<legal name or null>",
  "cin": "<CIN or null>",
  "date_of_incorporation": "<date or null>",
  "registered_address": "<address or null>",
  "authorized_capital": <number or null>,
  "paid_up_capital": <number or null>,
  "main_objects": "<main business activity or null>",
  "directors": [
    {"name": "<name>", "din": "<DIN>", "designation": "<designation>"}
  ],
  "pan": "<PAN or null>",
  "gstin": "<GSTIN or null>",
  "extraction_confidence": "high" | "medium" | "low"
}

Return ONLY the JSON object, no other text.`;

    const docSizeKB = Math.round(pdfBuffer.length / 1024);
    const startTime = Date.now();

    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            temperature: 0,
            system: KYC_EXTRACTION_PROMPT,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data: base64Pdf
                        }
                    },
                    {
                        type: "text",
                        text: userPrompt
                    }
                ]
            }]
        });

        const responseTime = (Date.now() - startTime) / 1000;
        updateRateLimits(response);
        const inputTokens = response.usage?.input_tokens || 0;
        const outputTokens = response.usage?.output_tokens || 0;
        console.log(`[API] KYC ${docType} - Time: ${responseTime}s, Input: ${inputTokens}, Output: ${outputTokens}`);

        const responseText = response.content[0].text;
        const result = extractJsonFromResponse(responseText);
        
        addApiCallLog({
            callType: 'kyc_extraction',
            document: `KYC ${docType}`,
            documentSize: docSizeKB,
            model: 'claude-sonnet-4-20250514',
            promptSummary: `Extract KYC data from ${docType}. Fields: company name, CIN, directors.`,
            responseTime: responseTime,
            tokensUsed: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
            keyValues: { company_name: result.company_name, cin: result.cin },
            confidence: result.extraction_confidence || 'unknown',
            rateLimits: getRateLimits(),
            success: true
        });
        
        result._tokensUsed = inputTokens;
        return result;
    } catch (error) {
        const responseTime = (Date.now() - startTime) / 1000;
        addApiCallLog({ callType: 'kyc_extraction', document: `KYC ${docType}`, responseTime, error: error.message, success: false });
        console.error('KYC extraction error:', error);
        throw new Error(`Failed to extract KYC: ${error.message}`);
    }
}

/**
 * Extract data from Property documents
 */
async function extractProperty(pdfBuffer, docType) {
    const base64Pdf = pdfBuffer.toString('base64');
    
    const userPrompt = `Extract property information from this ${docType} document.

Return a JSON object with this structure:
{
  "document_type": "${docType}",
  "property_type": "Commercial" | "Residential" | "Industrial" | "Land" | null,
  "property_address": "<full address or null>",
  "survey_number": "<survey/plot number or null>",
  "property_area_sqft": <number or null>,
  "built_up_area_sqft": <number or null>,
  "owner_name": "<owner name or null>",
  "registration_number": "<registration number or null>",
  "registration_date": "<date or null>",
  "registration_value": <number or null>,
  "market_value": <number or null>,
  "encumbrance_status": "Clear" | "Encumbered" | null,
  "encumbrance_details": "<details if encumbered or null>",
  "existing_mortgage": <number or null>,
  "extraction_confidence": "high" | "medium" | "low"
}

Return ONLY the JSON object, no other text.`;

    const docSizeKB = Math.round(pdfBuffer.length / 1024);
    const startTime = Date.now();

    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            temperature: 0,
            system: PROPERTY_EXTRACTION_PROMPT,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data: base64Pdf
                        }
                    },
                    {
                        type: "text",
                        text: userPrompt
                    }
                ]
            }]
        });

        const responseTime = (Date.now() - startTime) / 1000;
        updateRateLimits(response);
        const inputTokens = response.usage?.input_tokens || 0;
        const outputTokens = response.usage?.output_tokens || 0;
        console.log(`[API] Property ${docType} - Time: ${responseTime}s, Input: ${inputTokens}, Output: ${outputTokens}`);

        const responseText = response.content[0].text;
        const result = extractJsonFromResponse(responseText);
        
        addApiCallLog({
            callType: 'property_extraction',
            document: `Property ${docType}`,
            documentSize: docSizeKB,
            model: 'claude-sonnet-4-20250514',
            promptSummary: `Extract property data from ${docType}. Fields: address, area, value.`,
            responseTime: responseTime,
            tokensUsed: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
            keyValues: { market_value: result.market_value, property_area: result.property_area_sqft },
            confidence: result.extraction_confidence || 'unknown',
            rateLimits: getRateLimits(),
            success: true
        });
        
        result._tokensUsed = inputTokens;
        return result;
    } catch (error) {
        const responseTime = (Date.now() - startTime) / 1000;
        addApiCallLog({ callType: 'property_extraction', document: `Property ${docType}`, responseTime, error: error.message, success: false });
        console.error('Property extraction error:', error);
        throw new Error(`Failed to extract property data: ${error.message}`);
    }
}

/**
 * Extract company information from financial documents
 */
async function extractCompanyInfo(pdfBuffer) {
    const base64Pdf = pdfBuffer.toString('base64');
    
    const userPrompt = `Extract company information from this financial document.

Return a JSON object with this structure:
{
  "company_name": "<company legal name or null>",
  "cin": "<CIN if found or null>",
  "pan": "<PAN if found or null>",
  "gstin": "<GSTIN if found or null>",
  "registered_address": "<registered address or null>",
  "auditor_name": "<auditor firm name or null>",
  "financial_year_end": "<date or null>"
}

Return ONLY the JSON object, no other text.`;

    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1024,
            temperature: 0,
            system: EXTRACTION_SYSTEM_PROMPT,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data: base64Pdf
                        }
                    },
                    {
                        type: "text",
                        text: userPrompt
                    }
                ]
            }]
        });

        const responseText = response.content[0].text;
        return extractJsonFromResponse(responseText);
    } catch (error) {
        console.error('Company info extraction error:', error);
        return {
            company_name: null,
            cin: null,
            pan: null,
            gstin: null,
            registered_address: null,
            auditor_name: null,
            financial_year_end: null
        };
    }
}

/**
 * Validate extracted data and identify missing fields
 */
function validateExtractedData(balanceSheetData, pnlData) {
    const missingFields = [];
    
    const requiredBSFields = ['total_assets', 'current_assets', 'net_worth', 'trade_payables'];
    const bs = balanceSheetData?.balance_sheet || {};
    
    requiredBSFields.forEach(field => {
        if (bs[field] === null || bs[field] === undefined) {
            missingFields.push({
                field: field,
                category: 'balance_sheet',
                label: field.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                year: balanceSheetData?.financial_year || 'Unknown',
                type: 'currency'
            });
        }
    });
    
    const requiredPnLFields = ['revenue', 'profit_after_tax', 'ebitda', 'interest_expense'];
    const pnl = pnlData?.profit_and_loss || {};
    
    requiredPnLFields.forEach(field => {
        if (pnl[field] === null || pnl[field] === undefined) {
            missingFields.push({
                field: field,
                category: 'profit_and_loss',
                label: field.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                year: pnlData?.financial_year || 'Unknown',
                type: 'currency'
            });
        }
    });
    
    return {
        isComplete: missingFields.length === 0,
        missingFields: missingFields,
        balanceSheetConfidence: balanceSheetData?.extraction_confidence || 'low',
        pnlConfidence: pnlData?.extraction_confidence || 'low'
    };
}

/**
 * Aggregate bank statement data for analysis
 */
function aggregateBankData(bankStatements) {
    if (!bankStatements || bankStatements.length === 0) {
        return null;
    }
    
    let totalCredits = 0, totalDebits = 0;
    let totalChequeReturns = 0, totalChequeReturnAmount = 0;
    let balances = [];
    let allEMIs = [];
    
    bankStatements.forEach(stmt => {
        totalCredits += stmt.total_credits || 0;
        totalDebits += stmt.total_debits || 0;
        totalChequeReturns += stmt.cheque_returns || 0;
        totalChequeReturnAmount += stmt.cheque_return_amount || 0;
        if (stmt.average_balance) balances.push(stmt.average_balance);
        if (stmt.emi_payments) allEMIs = allEMIs.concat(stmt.emi_payments);
    });
    
    const avgBalance = balances.length > 0 ? balances.reduce((a,b) => a+b, 0) / balances.length : 0;
    const chequeReturnRate = totalDebits > 0 ? (totalChequeReturnAmount / totalDebits) * 100 : 0;
    
    return {
        period_months: bankStatements.length,
        total_credits: totalCredits,
        total_debits: totalDebits,
        average_monthly_credits: totalCredits / bankStatements.length,
        average_monthly_debits: totalDebits / bankStatements.length,
        average_balance: avgBalance,
        total_cheque_returns: totalChequeReturns,
        cheque_return_rate: chequeReturnRate,
        emi_payments: allEMIs,
        monthly_emi_total: allEMIs.reduce((sum, emi) => sum + (emi.amount || 0), 0)
    };
}

/**
 * Aggregate GST data for analysis
 */
function aggregateGSTData(gstReturns) {
    if (!gstReturns || gstReturns.length === 0) {
        return null;
    }
    
    let totalTurnover = 0, totalTaxPaid = 0;
    let filedCount = 0, lateFilings = 0;
    
    gstReturns.forEach(gst => {
        totalTurnover += gst.total_turnover || 0;
        totalTaxPaid += gst.tax_paid || 0;
        if (gst.filing_status === 'Filed') filedCount++;
    });
    
    return {
        returns_count: gstReturns.length,
        filed_count: filedCount,
        compliance_rate: (filedCount / gstReturns.length) * 100,
        total_turnover: totalTurnover,
        average_monthly_turnover: totalTurnover / gstReturns.length,
        total_tax_paid: totalTaxPaid,
        gstin: gstReturns[0]?.gstin
    };
}

/**
 * Extract legal document data (TSR, EC, Legal Opinion, etc.)
 * @param {Buffer} pdfBuffer - PDF document buffer
 * @param {string} docType - Type of legal document (tsr, ec, legal_opinion, roc, mutation, etc.)
 * @param {object} propertyInfo - Property metadata (address, state, type)
 * @returns {object} Extracted legal data
 */
async function extractLegalDocument(pdfBuffer, docType, propertyInfo = {}) {
    const base64Pdf = pdfBuffer.toString('base64');
    const docSizeKB = Math.round(pdfBuffer.length / 1024);
    const startTime = Date.now();
    
    // Define extraction schema based on document type
    const extractionSchemas = {
        'legal-tsr': `{
  "document_type": "Title Search Report",
  "tsr_date": "<date of TSR or null>",
  "advocate_name": "<name of advocate or null>",
  "property_address": "<property address from TSR>",
  "title_chain_years_covered": <number of years covered or null>,
  "current_owner": "<current owner name>",
  "ownership_type": "Freehold" | "Leasehold" | "POA-based" | "Other",
  "title_chain_status": "Clean" | "Break" | "POA-based" | "Unregistered" | "Disputed",
  "title_chain_summary": "<brief summary of ownership chain>",
  "title_defects": [{"defect": "<description>", "severity": "High" | "Medium" | "Low"}],
  "previous_owners": [{"name": "<name>", "period": "<period>", "document": "<deed type>"}],
  "encumbrances_noted": [{"type": "<type>", "holder": "<name>", "date": "<date>", "status": "Subsisting" | "Released"}],
  "litigation_mentioned": [{"case_details": "<details>", "status": "<status>"}],
  "advocate_remarks": "<key remarks>",
  "conditions_precedent": ["<condition 1>", "<condition 2>"],
  "conditions_subsequent": ["<condition 1>", "<condition 2>"],
  "extraction_confidence": "high" | "medium" | "low"
}`,
        'legal-ec': `{
  "document_type": "Encumbrance Certificate",
  "ec_number": "<EC number or null>",
  "issuing_authority": "<Sub-Registrar office>",
  "ec_date": "<date of EC>",
  "period_from": "<start date of EC period>",
  "period_to": "<end date of EC period>",
  "property_description": "<property schedule from EC>",
  "survey_number": "<survey/CTS number or null>",
  "encumbrance_status": "NIL" | "Encumbered",
  "encumbrances": [{
    "serial_no": <number>,
    "document_type": "<Sale/Mortgage/Release/Attachment/etc>",
    "document_number": "<registration number>",
    "registration_date": "<date>",
    "parties": {"executant": "<name>", "claimant": "<name>"},
    "consideration_amount": <number or null>,
    "remarks": "<any remarks>",
    "is_adverse": true | false
  }],
  "adverse_entries_count": <number>,
  "prior_mortgages": [{"holder": "<name>", "date": "<date>", "status": "Subsisting" | "Released"}],
  "attachments": [{"authority": "<court/revenue>", "date": "<date>", "status": "<status>"}],
  "lis_pendens": [{"case_number": "<number>", "court": "<court>", "date": "<date>"}],
  "extraction_confidence": "high" | "medium" | "low"
}`,
        'legal-opinion': `{
  "document_type": "Legal Opinion",
  "opinion_date": "<date>",
  "advocate_name": "<name>",
  "advocate_enrollment": "<bar council number or null>",
  "property_address": "<address>",
  "overall_opinion": "Positive" | "Negative" | "Conditional",
  "title_opinion": "Marketable" | "Not Marketable" | "Marketable with Conditions",
  "title_remarks": "<remarks on title>",
  "encumbrance_opinion": "<opinion on encumbrances>",
  "litigation_opinion": "<opinion on litigation>",
  "enforceability_opinion": "Enforceable" | "Not Enforceable" | "Enforceable with Conditions",
  "has_adverse_remarks": true | false,
  "adverse_remarks": ["<remark 1>", "<remark 2>"],
  "conditions_precedent": ["<condition 1>", "<condition 2>"],
  "conditions_subsequent": ["<condition 1>", "<condition 2>"],
  "recommended_actions": ["<action 1>", "<action 2>"],
  "extraction_confidence": "high" | "medium" | "low"
}`,
        'legal-roc': `{
  "document_type": "ROC Search Report",
  "search_date": "<date>",
  "company_name": "<name>",
  "cin": "<CIN number>",
  "charges_found": true | false,
  "total_charges": <number>,
  "charges": [{
    "charge_id": "<id>",
    "charge_holder": "<name>",
    "date_of_creation": "<date>",
    "date_of_modification": "<date or null>",
    "amount_secured": <number>,
    "property_covered": "<description>",
    "status": "Open" | "Satisfied" | "Modified"
  }],
  "open_charges_count": <number>,
  "satisfied_charges_count": <number>,
  "property_specific_charges": [{"charge_id": "<id>", "details": "<details>"}],
  "extraction_confidence": "high" | "medium" | "low"
}`,
        'legal-mutation': `{
  "document_type": "Revenue Record",
  "record_type": "7/12 Extract" | "Khata" | "Mutation Entry" | "Ferfar" | "Other",
  "record_date": "<date>",
  "village": "<village name>",
  "taluka": "<taluka>",
  "district": "<district>",
  "survey_number": "<survey/gat number>",
  "hissa_number": "<hissa if applicable>",
  "area": "<area with unit>",
  "land_type": "Agricultural" | "Non-Agricultural" | "NA Converted",
  "current_owner": "<owner name>",
  "mutation_entries": [{"entry_no": "<number>", "date": "<date>", "from": "<name>", "to": "<name>", "reason": "<sale/inheritance/gift>"}],
  "mutation_status": "Done" | "Pending" | "Not Initiated",
  "encumbrances_in_record": ["<entry 1>", "<entry 2>"],
  "government_dues": <amount or null>,
  "extraction_confidence": "high" | "medium" | "low"
}`,
        'legal-tax': `{
  "document_type": "Property Tax Receipt",
  "receipt_number": "<number>",
  "receipt_date": "<date>",
  "assessment_year": "<year>",
  "property_id": "<municipal property ID>",
  "owner_name": "<name>",
  "property_address": "<address>",
  "tax_amount": <number>,
  "tax_paid": <number>,
  "arrears": <number or 0>,
  "payment_status": "Paid" | "Partial" | "Unpaid",
  "extraction_confidence": "high" | "medium" | "low"
}`,
        'legal-deed': `{
  "document_type": "Sale Deed",
  "deed_type": "Sale Deed" | "Conveyance Deed" | "Gift Deed" | "Partition Deed" | "Other",
  "registration_number": "<number>",
  "registration_date": "<date>",
  "sub_registrar_office": "<office>",
  "vendor": "<seller name>",
  "vendee": "<buyer name>",
  "property_description": "<schedule>",
  "consideration_amount": <number>,
  "stamp_duty_paid": <number or null>,
  "registration_fee": <number or null>,
  "property_area": "<area with unit>",
  "boundaries": {"north": "<>", "south": "<>", "east": "<>", "west": "<>"},
  "prior_document_reference": "<previous deed reference or null>",
  "extraction_confidence": "high" | "medium" | "low"
}`
    };
    
    // Default schema for other document types
    const defaultSchema = `{
  "document_type": "${docType}",
  "document_date": "<date or null>",
  "key_information": "<summary of key information>",
  "adverse_findings": ["<finding 1>", "<finding 2>"],
  "extraction_confidence": "high" | "medium" | "low"
}`;
    
    const schema = extractionSchemas[docType] || defaultSchema;
    
    const userPrompt = `Extract information from this ${docType} legal document.
${propertyInfo.property_address ? `Property Address: ${propertyInfo.property_address}` : ''}
${propertyInfo.state ? `State: ${propertyInfo.state}` : ''}

Return a JSON object with this structure:
${schema}

IMPORTANT:
- Flag any adverse findings (litigation, encumbrances, title defects)
- Be conservative - if information is unclear, note it as a risk
- Extract all dates in YYYY-MM-DD format where possible
- Return ONLY the JSON object, no other text.`;

    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 4096,
            temperature: 0,
            system: LEGAL_EXTRACTION_PROMPT,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data: base64Pdf
                        }
                    },
                    {
                        type: "text",
                        text: userPrompt
                    }
                ]
            }]
        });

        const responseTime = (Date.now() - startTime) / 1000;
        updateRateLimits(response);
        const inputTokens = response.usage?.input_tokens || 0;
        const outputTokens = response.usage?.output_tokens || 0;
        console.log(`[API] Legal ${docType} - Time: ${responseTime}s, Input: ${inputTokens}, Output: ${outputTokens}`);

        const responseText = response.content[0].text;
        const result = extractJsonFromResponse(responseText);
        
        addApiCallLog({
            callType: 'legal_extraction',
            document: `Legal ${docType}`,
            documentSize: docSizeKB,
            model: 'claude-sonnet-4-20250514',
            promptSummary: `Extract legal data from ${docType}. Property: ${propertyInfo.property_address || 'N/A'}`,
            responseTime: responseTime,
            tokensUsed: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
            keyValues: { doc_type: docType, has_adverse: result.has_adverse_remarks || result.adverse_entries_count > 0 },
            confidence: result.extraction_confidence || 'unknown',
            rateLimits: getRateLimits(),
            success: true
        });
        
        result._tokensUsed = inputTokens;
        result._docType = docType;
        return result;
    } catch (error) {
        const responseTime = (Date.now() - startTime) / 1000;
        addApiCallLog({ callType: 'legal_extraction', document: `Legal ${docType}`, responseTime, error: error.message, success: false });
        console.error('Legal extraction error:', error);
        throw new Error(`Failed to extract legal data from ${docType}: ${error.message}`);
    }
}

/**
 * Perform legal risk assessment based on extracted legal documents
 * Applies rules from legal_risk_rules master
 * @param {object} extractedLegalData - All extracted legal documents for a property
 * @param {object} propertyInfo - Property metadata
 * @param {array} legalRiskRules - Rules from masters
 * @param {array} stateLegalRulesArray - State-specific rules array from masters
 * @returns {object} Legal risk assessment result
 */
function assessLegalRisk(extractedLegalData, propertyInfo, legalRiskRules = [], stateLegalRulesArray = []) {
    // Find the state-specific rules for this property's state
    const propertyState = propertyInfo.state || 'MH'; // Default to Maharashtra
    const stateLegalRules = stateLegalRulesArray.find(r => 
        r.state_code === propertyState || 
        r.state_name === propertyState ||
        r.state_name?.toLowerCase().includes(propertyState.toLowerCase())
    ) || {};
    
    console.log(`⚖️ Legal Assessment for ${propertyInfo.property_id}:`);
    console.log(`   - State: ${propertyState}, State Rules Found: ${Object.keys(stateLegalRules).length > 0 ? 'Yes' : 'No (using defaults)'}`);
    console.log(`   - Risk Rules to evaluate: ${legalRiskRules.length}`);
    
    const assessment = {
        property_id: propertyInfo.property_id,
        property_address: propertyInfo.property_address,
        property_type: propertyInfo.property_type,
        state: propertyInfo.state,
        assessment_date: new Date().toISOString(),
        
        // Analysis sections (will be populated from extracted data)
        ownership_analysis: {
            title_chain_status: 'Clean',
            current_owner: null,
            chain_verified_years: 0,
            defects_found: [],
            confidence: 'low'
        },
        encumbrance_analysis: {
            has_adverse_entries: false,
            encumbrances: [],
            prior_charge_subsisting: false,
            subsequent_charges_after_mortgage: false, // NEW: Column 9
            subsequent_charge_details: [],            // NEW: Details of subsequent charges
            lis_pendens_found: false
        },
        roc_charge_analysis: {
            applicable: false,
            charges_found: [],
            open_charges: 0
        },
        litigation_analysis: {
            has_litigation: false,
            lis_pendens: false,
            cases: [],
            attachments: []
        },
        revenue_municipal_analysis: {
            mutation_status: 'Not Verified',
            revenue_records_match: false,
            property_tax_current: false,
            dues_amount: 0
        },
        land_use_analysis: {
            current_use: null,
            zoning_compliant: true,
            na_conversion_status: 'Not Required',
            building_approval_valid: false
        },
        stamping_registration_analysis: {
            properly_stamped: true,
            properly_registered: true,
            deficiencies: []
        },
        mortgage_perfection_analysis: {
            mortgage_type: null,
            mod_registered: false,
            our_mortgage_date: propertyInfo.our_mortgage_date || null, // NEW: For date comparison
            schedule_correct: true,
            deficiencies: []
        },
        advocate_remarks: {
            has_adverse_remarks: false,
            remarks_summary: null,
            conditions_precedent: [],
            conditions_subsequent: []
        },
        
        // Final assessment
        rules_triggered: [],
        risk_rating: 'Low',
        enforceability_decision: 'Enforceable',
        enforceability_rationale: '',
        recommended_actions: [],
        blocking_issues: [],
        
        // NEW: Missing columns 23, 25
        next_review_due_date: null,   // Column 23
        prepared_by: 'System',        // Column 24 (renamed from assessed_by)
        reviewed_by: null             // Column 25
    };
    
    // Populate from TSR data
    if (extractedLegalData.tsr) {
        const tsr = extractedLegalData.tsr;
        assessment.ownership_analysis.title_chain_status = tsr.title_chain_status || 'Clean';
        assessment.ownership_analysis.current_owner = tsr.current_owner;
        assessment.ownership_analysis.chain_verified_years = tsr.title_chain_years_covered || 0;
        assessment.ownership_analysis.defects_found = tsr.title_defects || [];
        assessment.ownership_analysis.confidence = tsr.extraction_confidence || 'low';
        
        if (tsr.encumbrances_noted) {
            assessment.encumbrance_analysis.encumbrances.push(...tsr.encumbrances_noted);
        }
        if (tsr.litigation_mentioned && tsr.litigation_mentioned.length > 0) {
            assessment.litigation_analysis.has_litigation = true;
            assessment.litigation_analysis.cases.push(...tsr.litigation_mentioned);
        }
        
        assessment.advocate_remarks.conditions_precedent = tsr.conditions_precedent || [];
        assessment.advocate_remarks.conditions_subsequent = tsr.conditions_subsequent || [];
    }
    
    // Populate from EC data
    if (extractedLegalData.ec) {
        const ec = extractedLegalData.ec;
        if (ec.encumbrance_status === 'Encumbered' || ec.adverse_entries_count > 0) {
            assessment.encumbrance_analysis.has_adverse_entries = true;
        }
        if (ec.encumbrances) {
            assessment.encumbrance_analysis.encumbrances.push(...ec.encumbrances.filter(e => e.is_adverse));
        }
        if (ec.prior_mortgages) {
            const subsisting = ec.prior_mortgages.filter(m => m.status === 'Subsisting');
            if (subsisting.length > 0) {
                assessment.encumbrance_analysis.prior_charge_subsisting = true;
                assessment.encumbrance_analysis.encumbrances.push(...subsisting);
            }
        }
        if (ec.lis_pendens && ec.lis_pendens.length > 0) {
            assessment.litigation_analysis.lis_pendens = true;
            assessment.encumbrance_analysis.lis_pendens_found = true;
        }
        if (ec.attachments && ec.attachments.length > 0) {
            assessment.litigation_analysis.attachments = ec.attachments;
        }
    }
    
    // Populate from Legal Opinion
    if (extractedLegalData.legal_opinion) {
        const opinion = extractedLegalData.legal_opinion;
        assessment.advocate_remarks.has_adverse_remarks = opinion.has_adverse_remarks || false;
        assessment.advocate_remarks.remarks_summary = opinion.title_remarks;
        if (opinion.conditions_precedent) {
            assessment.advocate_remarks.conditions_precedent.push(...opinion.conditions_precedent);
        }
        if (opinion.conditions_subsequent) {
            assessment.advocate_remarks.conditions_subsequent.push(...opinion.conditions_subsequent);
        }
        if (opinion.recommended_actions) {
            assessment.recommended_actions.push(...opinion.recommended_actions);
        }
    }
    
    // Populate from ROC data
    if (extractedLegalData.roc) {
        const roc = extractedLegalData.roc;
        assessment.roc_charge_analysis.applicable = true;
        assessment.roc_charge_analysis.charges_found = roc.charges || [];
        assessment.roc_charge_analysis.open_charges = roc.open_charges_count || 0;
    }
    
    // Populate from Mutation/Revenue data
    if (extractedLegalData.mutation) {
        const mutation = extractedLegalData.mutation;
        assessment.revenue_municipal_analysis.mutation_status = mutation.mutation_status || 'Not Verified';
        assessment.revenue_municipal_analysis.revenue_records_match = mutation.current_owner === assessment.ownership_analysis.current_owner;
        assessment.land_use_analysis.current_use = mutation.land_type;
        if (mutation.land_type === 'Agricultural' && stateLegalRules.na_conversion_required) {
            assessment.land_use_analysis.na_conversion_status = 'Required';
        }
    }
    
    // Populate from Tax Receipt
    if (extractedLegalData.tax) {
        const tax = extractedLegalData.tax;
        assessment.revenue_municipal_analysis.property_tax_current = tax.payment_status === 'Paid';
        assessment.revenue_municipal_analysis.dues_amount = tax.arrears || 0;
    }
    
    // Apply rules to determine risk rating
    let highRiskCount = 0;
    let mediumRiskCount = 0;
    let blockingCount = 0;
    
    // Check each rule
    for (const rule of legalRiskRules) {
        if (!rule.is_active) continue;
        
        let triggered = false;
        
        // Simple rule matching based on condition_field
        try {
            const fieldPath = rule.condition_field;
            if (fieldPath) {
                const value = getNestedValue(assessment, fieldPath);
                triggered = evaluateCondition(value, rule.condition_operator, rule.condition_value);
            }
        } catch (e) {
            // Rule evaluation failed, skip
        }
        
        if (triggered) {
            console.log(`   ✓ Rule triggered: ${rule.rule_code} - ${rule.rule_name} [${rule.risk_rating}]`);
            assessment.rules_triggered.push({
                rule_code: rule.rule_code,
                rule_name: rule.rule_name,
                risk_category: rule.risk_category,
                risk_rating: rule.risk_rating,
                enforceability_impact: rule.enforceability_impact,
                recommended_action: rule.recommended_action
            });
            
            if (rule.risk_rating === 'High') highRiskCount++;
            if (rule.risk_rating === 'Medium') mediumRiskCount++;
            if (rule.is_blocking) {
                blockingCount++;
                assessment.blocking_issues.push(rule.rule_name);
            }
            
            if (rule.recommended_action && !assessment.recommended_actions.includes(rule.recommended_action)) {
                assessment.recommended_actions.push(rule.recommended_action);
            }
        }
    }
    
    console.log(`   📊 Results: ${assessment.rules_triggered.length} rules triggered (High:${highRiskCount}, Medium:${mediumRiskCount}, Blocking:${blockingCount})`);
    
    // Determine final risk rating
    if (blockingCount > 0 || highRiskCount >= 2) {
        assessment.risk_rating = 'High';
    } else if (highRiskCount === 1 || mediumRiskCount >= 2) {
        assessment.risk_rating = 'Medium';
    } else {
        assessment.risk_rating = 'Low';
    }
    
    // Determine enforceability
    if (blockingCount > 0) {
        assessment.enforceability_decision = 'Not Enforceable';
        assessment.enforceability_rationale = `Blocking issues found: ${assessment.blocking_issues.join(', ')}`;
    } else if (highRiskCount > 0 || assessment.advocate_remarks.conditions_precedent.length > 0) {
        assessment.enforceability_decision = 'Enforceable with Conditions';
        assessment.enforceability_rationale = `${highRiskCount} high-risk issues and ${assessment.advocate_remarks.conditions_precedent.length} conditions precedent require resolution.`;
    } else {
        assessment.enforceability_decision = 'Enforceable';
        assessment.enforceability_rationale = 'No blocking issues. Title appears clear for mortgage creation.';
    }
    
    // Check for subsequent charges after our mortgage date (Column 9)
    if (assessment.mortgage_perfection_analysis.our_mortgage_date && assessment.encumbrance_analysis.encumbrances.length > 0) {
        const ourMortgageDate = new Date(assessment.mortgage_perfection_analysis.our_mortgage_date);
        assessment.encumbrance_analysis.encumbrances.forEach(enc => {
            if (enc.date || enc.registration_date) {
                const encDate = new Date(enc.date || enc.registration_date);
                if (encDate > ourMortgageDate && enc.status !== 'Released') {
                    assessment.encumbrance_analysis.subsequent_charges_after_mortgage = true;
                    assessment.encumbrance_analysis.subsequent_charge_details.push({
                        type: enc.type || enc.document_type,
                        holder: enc.holder || enc.parties?.claimant,
                        date: enc.date || enc.registration_date,
                        status: enc.status
                    });
                }
            }
        });
        
        // Add to high risk if subsequent charges found
        if (assessment.encumbrance_analysis.subsequent_charges_after_mortgage) {
            assessment.risk_rating = 'High';
            assessment.blocking_issues.push('Subsequent charge created after our mortgage');
            assessment.recommended_actions.push('Obtain NOC from subsequent charge holder or inter-creditor agreement.');
        }
    }
    
    // Calculate next_review_due_date based on risk rating (Column 23)
    const today = new Date();
    if (assessment.risk_rating === 'High') {
        // High risk: Review in 30 days
        today.setDate(today.getDate() + 30);
    } else if (assessment.risk_rating === 'Medium') {
        // Medium risk: Review in 90 days
        today.setDate(today.getDate() + 90);
    } else {
        // Low risk: Review in 180 days
        today.setDate(today.getDate() + 180);
    }
    assessment.next_review_due_date = today.toISOString().split('T')[0];
    
    return assessment;
}

// Helper function to get nested object value
function getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current && current[key], obj);
}

// Helper function to evaluate condition
function evaluateCondition(value, operator, expected) {
    switch (operator) {
        case 'equals': return value === expected || String(value) === expected;
        case 'not_equals': return value !== expected && String(value) !== expected;
        case 'is_true': return value === true || value === 'true';
        case 'is_false': return value === false || value === 'false';
        case 'contains': return String(value).toLowerCase().includes(String(expected).toLowerCase());
        case 'greater_than': return Number(value) > Number(expected);
        case 'less_than': return Number(value) < Number(expected);
        default: return false;
    }
}

/**
 * Get OCR Pipeline statistics
 */
function getOcrPipelineStats() {
    const baseStats = { ...ocrPipelineStats };
    
    if (ocrPipeline) {
        const pipelineStats = ocrPipeline.getCombinedStats();
        return {
            ...baseStats,
            pipeline: pipelineStats
        };
    }
    
    return baseStats;
}

/**
 * Get OCR Pipeline logs
 */
function getOcrPipelineLogs() {
    if (ocrPipeline) {
        return ocrPipeline.getPipelineLogs();
    }
    return [];
}

/**
 * Check if OCR Pipeline is available and configured
 */
function isOcrPipelineAvailable() {
    const visionConfigured = visionOcr ? visionOcr.isTextractConfigured() : { configured: false, method: 'none', details: 'Vision OCR module not loaded' };
    
    return {
        pipelineLoaded: !!ocrPipeline,
        visionConfigured: visionConfigured.configured,
        visionMethod: visionConfigured.method,
        details: visionConfigured.details
    };
}

/**
 * Check if Vision API is actually working (makes a test API call)
 * Results are cached for 5 minutes
 * @returns {Promise<{working: boolean, configured: boolean, method: string, details: string}>}
 */
async function checkVisionHealth() {
    if (!visionOcr || !visionOcr.checkTextractHealth) {
        return {
            working: false,
            configured: false,
            method: 'none',
            details: 'Vision OCR module not loaded or health check not available'
        };
    }
    
    return await visionOcr.checkTextractHealth();
}

/**
 * Reset OCR Pipeline statistics
 */
function resetOcrPipelineStats() {
    ocrPipelineStats = {
        documentsProcessed: 0,
        scannedDocuments: 0,
        nativeDocuments: 0,
        visionApiCost: 0,
        visionApiCalls: 0
    };
    
    if (ocrPipeline) {
        ocrPipeline.resetPipelineCosts();
    }
    
    if (visionOcr) {
        visionOcr.resetTextractStats();
    }
}

/**
 * Helper function to prepare content for Claude API with OCR pipeline
 * Can be used by other extraction functions
 */
async function prepareContentWithOcr(pdfBuffer, documentName, progressCallback = null) {
    if (!ocrPipeline) {
        // No OCR pipeline, return PDF as base64
        return {
            messageContent: [{
                type: "document",
                source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: pdfBuffer.toString('base64')
                }
            }],
            pipelineResult: null
        };
    }
    
    try {
        const pipelineResult = await ocrPipeline.processDocument(pdfBuffer, documentName, progressCallback);
        
        // Update stats
        ocrPipelineStats.documentsProcessed++;
        if (pipelineResult.isScanned) {
            ocrPipelineStats.scannedDocuments++;
            ocrPipelineStats.visionApiCost += pipelineResult.visionCost || 0;
            if (pipelineResult.visionCost > 0) ocrPipelineStats.visionApiCalls++;
        } else {
            ocrPipelineStats.nativeDocuments++;
        }
        
        // Prepare content based on pipeline result
        let messageContent;
        if (pipelineResult.contentType === 'text' && pipelineResult.content) {
            console.log(`[OCR TEXT DUMP] ${documentName} (${pipelineResult.content.length} chars):`);
            console.log('--- OCR START ---');
            console.log(pipelineResult.content);
            console.log('--- OCR END ---');
            messageContent = [{
                type: "text",
                text: `Here is the extracted text from a scanned document:\n\n${pipelineResult.content}`
            }];
        } else {
            messageContent = [{
                type: "document",
                source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: pdfBuffer.toString('base64')
                }
            }];
        }
        
        return {
            messageContent,
            pipelineResult
        };
    } catch (error) {
        console.error('[OCR Pipeline] Error:', error.message);
        // Fallback to PDF
        return {
            messageContent: [{
                type: "document",
                source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: pdfBuffer.toString('base64')
                }
            }],
            pipelineResult: null,
            error: error.message
        };
    }
}

/**
 * Log Claude extraction steps (Steps 7 & 8)
 */
function logClaudeSteps(documentName, claudeResult, progressCallback = null) {
    if (ocrPipeline) {
        ocrPipeline.logClaudeExtractionSteps(documentName, claudeResult, progressCallback);
    }
}

/**
 * Convert extracted financial data to actual rupees based on unit_scale
 * Documents often state "All amounts in ₹ Lakhs" - this function normalizes to rupees
 * 
 * @param {Object} extractedData - The extracted data with unit_scale and unit_multiplier
 * @param {string} dataKey - The key containing financial values ('balance_sheet', 'profit_and_loss', 'cash_flow', 'itr')
 * @returns {Object} - Data with values converted to actual rupees
 */
function applyUnitConversion(extractedData, dataKey) {
    if (!extractedData) {
        return extractedData;
    }
    
    // For ITR, the data is flat (not nested under a key)
    const isFlat = dataKey === 'itr';
    
    if (!isFlat && !extractedData[dataKey]) {
        return extractedData;
    }
    
    // Determine multiplier from unit_scale (the label Claude identified from document header)
    let multiplier = 1;
    const rawUnitScale = (extractedData.unit_scale || '').toLowerCase().trim();
    
    // Normalize unit_scale — Claude returns variations like "lakhs", "in lakhs", "₹ in lakhs", "rs. in crores"
    let unitScale = rawUnitScale;
    if (rawUnitScale.includes('lakh')) unitScale = 'lakhs';
    else if (rawUnitScale.includes('crore')) unitScale = 'crores';
    else if (rawUnitScale.includes('million')) unitScale = 'millions';
    else if (rawUnitScale.includes('thousand')) unitScale = 'thousands';
    else if (rawUnitScale.includes('rupee') || rawUnitScale === 'inr' || rawUnitScale === 'rs' || rawUnitScale === 'rs.' || rawUnitScale === '₹') unitScale = 'rupees';
    
    if (rawUnitScale !== unitScale) {
        console.log(`[Unit Conversion] Normalized unit_scale: "${rawUnitScale}" → "${unitScale}"`);
    }
    
    const expectedMultiplierFromScale = {
        'lakhs': 100000, 'lakh': 100000,
        'crores': 10000000, 'crore': 10000000,
        'millions': 1000000, 'million': 1000000,
        'thousands': 1000, 'thousand': 1000,
        'rupees': 1, 'rupee': 1
    };
    
    // TRUST unit_scale over unit_multiplier — Claude sometimes returns wrong multiplier
    // e.g., unit_scale="lakhs" but unit_multiplier=10000000 (crore multiplier)
    if (expectedMultiplierFromScale[unitScale]) {
        multiplier = expectedMultiplierFromScale[unitScale];
        
        // Log mismatch if unit_multiplier disagrees with unit_scale
        if (extractedData.unit_multiplier && extractedData.unit_multiplier > 1 
            && extractedData.unit_multiplier !== multiplier) {
            console.log(`⚠️ [Unit Conversion] MISMATCH: unit_scale="${unitScale}" (×${multiplier}) but unit_multiplier=${extractedData.unit_multiplier}. TRUSTING unit_scale.`);
        }
    } else if (extractedData.unit_multiplier && extractedData.unit_multiplier > 1) {
        // Only use unit_multiplier if unit_scale is unrecognized
        multiplier = extractedData.unit_multiplier;
        console.log(`⚠️ [Unit Conversion] Unrecognized unit_scale="${unitScale}", using unit_multiplier=${multiplier}`);
    }
    
    // If multiplier is 1, no conversion needed
    if (multiplier === 1) {
        console.log(`[Unit Conversion] No conversion needed for ${dataKey} - unit_scale: ${unitScale || 'rupees'}`);
        return extractedData;
    }
    
    // GUARD: Detect if Claude already pre-multiplied the values
    // If unit_scale is "crores" and a value like total_assets is already > 10^9 (100 Cr+),
    // Claude likely already multiplied. Raw values in crores should be small numbers.
    // e.g., "23,500 crores" → raw = 23500, pre-multiplied = 235,000,000,000
    if (!isFlat && extractedData[dataKey]) {
        const section = extractedData[dataKey];
        const checkFields = dataKey === 'balance_sheet' ? ['total_assets', 'total_liabilities', 'net_worth'] :
                           dataKey === 'profit_and_loss' ? ['revenue', 'profit_before_tax'] :
                           dataKey === 'cash_flow' ? ['operating_cash_flow', 'net_cash_flow'] : [];
        
        for (const field of checkFields) {
            const val = section[field];
            if (val && typeof val === 'number') {
                const absVal = Math.abs(val);
                // If unit is crores and value > 10^8 (10 crore as raw number = would mean ₹100 Cr),
                // or unit is lakhs and value > 10^7 (100 lakh as raw number = would mean ₹100 L),
                // the value is likely already in rupees (pre-multiplied)
                const threshold = multiplier === 10000000 ? 1e8 : multiplier === 100000 ? 1e7 : 1e6;
                if (absVal > threshold) {
                    // Check if value / multiplier gives a more reasonable raw number
                    const rawIfPreMultiplied = absVal / multiplier;
                    if (rawIfPreMultiplied >= 1 && rawIfPreMultiplied < threshold) {
                        console.log(`🚨 [Unit Conversion] PRE-MULTIPLIED DETECTED: ${dataKey}.${field} = ${val} looks already converted (÷${multiplier} = ${rawIfPreMultiplied}). SKIPPING conversion.`);
                        extractedData._unit_conversion = {
                            applied: false,
                            unit_scale: unitScale,
                            multiplier: multiplier,
                            skipped: true,
                            reason: `${field}=${val} appears pre-multiplied (÷${multiplier}=${rawIfPreMultiplied})`
                        };
                        return extractedData;
                    }
                }
            }
        }
    }
    
    console.log(`[Unit Conversion] Applying multiplier ${multiplier} to ${dataKey} (unit_scale: ${unitScale})`);
    
    // Create a deep copy
    const converted = JSON.parse(JSON.stringify(extractedData));
    
    // Fields to exclude from conversion (non-financial fields)
    const excludeFields = ['unit_scale', 'unit_multiplier', 'extraction_confidence', 'financial_year', 
                          'assessment_year', 'pan', 'name', 'itr_form', 'filing_date', 'acknowledgment_number',
                          '_original_values', '_unit_conversion', '_tokensUsed', '_is_duplicate'];
    
    if (isFlat) {
        // For ITR: convert numeric fields directly at root level
        const originalValues = {};
        for (const key in converted) {
            const value = converted[key];
            if (typeof value === 'number' && value !== null && !excludeFields.includes(key)) {
                originalValues[key] = value;
                converted[key] = Math.round(value * multiplier);
            }
        }
        converted._original_values = originalValues;
    } else {
        // For nested structures: convert fields within the dataKey section
        const dataSection = converted[dataKey];
        const originalValues = {};
        for (const key in dataSection) {
            const value = dataSection[key];
            if (typeof value === 'number' && value !== null && !excludeFields.includes(key)) {
                originalValues[key] = value;
                dataSection[key] = Math.round(value * multiplier);
            }
        }
        converted._original_values = originalValues;
        
        // SANITY CHECK: For MSME balance sheets, total_assets > ₹50,000 Cr is suspicious
        // Most MSME companies have assets under ₹500 Cr
        if (dataKey === 'balance_sheet' && dataSection.total_assets) {
            const totalAssetsCr = dataSection.total_assets / 10000000;
            if (totalAssetsCr > 50000) {
                console.log(`🚨 [Unit Conversion] SANITY FAIL: total_assets = ₹${totalAssetsCr.toFixed(2)} Cr after ×${multiplier} conversion. Original value: ${originalValues.total_assets}. Likely wrong unit_scale.`);
                // Check if dividing by 100 gives a reasonable value (lakhs vs crores confusion)
                const correctedCr = totalAssetsCr / 100;
                if (correctedCr > 0.1 && correctedCr < 50000) {
                    console.log(`🔧 [Unit Conversion] AUTO-CORRECTING: Was likely lakhs (×100K), not crores (×10M). Corrected total_assets = ₹${correctedCr.toFixed(2)} Cr`);
                    // Re-apply with correct multiplier (lakhs instead of crores)
                    const correctMultiplier = multiplier / 100;
                    for (const key in dataSection) {
                        if (typeof originalValues[key] === 'number') {
                            dataSection[key] = Math.round(originalValues[key] * correctMultiplier);
                        }
                    }
                    converted._unit_conversion = {
                        applied: true,
                        unit_scale: unitScale,
                        multiplier: correctMultiplier,
                        original_multiplier: multiplier,
                        auto_corrected: true,
                        reason: 'total_assets exceeded ₹50,000 Cr sanity threshold'
                    };
                    return converted;
                }
            }
        }
        
        // SANITY CHECK: For P&L, revenue > ₹50,000 Cr is suspicious for MSME
        if (dataKey === 'profit_and_loss' && dataSection.revenue) {
            const revenueCr = dataSection.revenue / 10000000;
            if (revenueCr > 50000) {
                console.log(`🚨 [Unit Conversion] SANITY FAIL: revenue = ₹${revenueCr.toFixed(2)} Cr after ×${multiplier} conversion. Original value: ${originalValues.revenue}. Likely wrong unit_scale.`);
                const correctedCr = revenueCr / 100;
                if (correctedCr > 0.1 && correctedCr < 50000) {
                    console.log(`🔧 [Unit Conversion] AUTO-CORRECTING: Was likely lakhs (×100K), not crores (×10M). Corrected revenue = ₹${correctedCr.toFixed(2)} Cr`);
                    const correctMultiplier = multiplier / 100;
                    for (const key in dataSection) {
                        if (typeof originalValues[key] === 'number') {
                            dataSection[key] = Math.round(originalValues[key] * correctMultiplier);
                        }
                    }
                    converted._unit_conversion = {
                        applied: true,
                        unit_scale: unitScale,
                        multiplier: correctMultiplier,
                        original_multiplier: multiplier,
                        auto_corrected: true,
                        reason: 'revenue exceeded ₹50,000 Cr sanity threshold'
                    };
                    return converted;
                }
            }
        }
    }
    
    // Store conversion info for audit trail
    converted._unit_conversion = {
        applied: true,
        unit_scale: unitScale,
        multiplier: multiplier
    };
    
    return converted;
}

/**
 * Normalize extracted data by applying unit conversions for all financial documents
 */
function normalizeExtractedData(extractedData) {
    let normalized = { ...extractedData };
    
    // Apply conversion for balance sheet data
    if (normalized.balance_sheet) {
        const bsData = applyUnitConversion(normalized, 'balance_sheet');
        normalized = { ...normalized, ...bsData };
    }
    
    // Apply conversion for P&L data
    if (normalized.profit_and_loss) {
        const pnlData = applyUnitConversion(normalized, 'profit_and_loss');
        normalized = { ...normalized, ...pnlData };
    }
    
    // Apply conversion for cash flow data
    if (normalized.cash_flow) {
        const cfData = applyUnitConversion(normalized, 'cash_flow');
        normalized = { ...normalized, ...cfData };
    }
    
    return normalized;
}

module.exports = {
    extractBalanceSheet,
    extractProfitAndLoss,
    extractCashFlow,
    extractBankStatement,
    extractGSTReturn,
    extractITR,
    extractKYC,
    extractProperty,
    extractCompanyInfo,
    extractLegalDocument,
    assessLegalRisk,
    validateExtractedData,
    aggregateBankData,
    aggregateGSTData,
    getApiStats,
    resetApiStats,
    getApiCallLogs,
    getRateLimits,
    // OCR Pipeline exports
    getOcrPipelineStats,
    getOcrPipelineLogs,
    isOcrPipelineAvailable,
    checkVisionHealth,
    resetOcrPipelineStats,
    prepareContentWithOcr,
    logClaudeSteps,
    // Unit conversion
    applyUnitConversion,
    normalizeExtractedData
};
