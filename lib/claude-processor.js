/**
 * Server-Side Claude Processor
 * Handles document extraction using Claude via Amazon Bedrock
 * (falls back to direct Anthropic API only if ANTHROPIC_API_KEY is set
 * and AWS_REGION/Bedrock isn't — kept for local dev / legacy environments)
 *
 * LOGGING PREFIX: [CLAUDE]
 */

const bedrockClient = require('./bedrock-client');

class ClaudeProcessor {
    constructor() {
        this.client = null;
        this.initialized = false;
        this.mode = null; // 'bedrock' | 'direct'
        this.activeRequests = 0;
        this.totalRequests = 0;
        this.totalTokensUsed = { input: 0, output: 0 };
    }

    /**
     * Initialize the client. Prefers Bedrock (IAM role, no API key needed);
     * falls back to a direct Anthropic SDK client only if ANTHROPIC_API_KEY
     * is set and AWS_REGION is not (e.g. local development).
     */
    initialize() {
        if (this.initialized) return true;

        const hasRegion = !!(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION);
        const apiKey = process.env.ANTHROPIC_API_KEY;

        if (hasRegion) {
            // Bedrock mode — auth comes from the task/instance IAM role.
            this.client = bedrockClient;
            this.mode = 'bedrock';
            this.initialized = true;
            console.log('✅ [CLAUDE] Processor initialized via Amazon Bedrock (IAM role auth)');
            return true;
        }

        if (apiKey) {
            // Legacy direct-API fallback (local dev without AWS_REGION set)
            try {
                const Anthropic = require('@anthropic-ai/sdk');
                this.client = new Anthropic({ apiKey });
                this.mode = 'direct';
                this.initialized = true;
                console.log('✅ [CLAUDE] Processor initialized with direct Anthropic API key (legacy mode)');
                return true;
            } catch (err) {
                console.error('❌ [CLAUDE] Failed to initialize direct Anthropic client:', err.message);
                return false;
            }
        }

        console.error('❌ [CLAUDE] Neither AWS_REGION (Bedrock) nor ANTHROPIC_API_KEY (legacy) is set');
        return false;
    }

    /**
     * Check if processor is ready
     */
    isReady() {
        return this.initialized && this.client !== null;
    }

    /**
     * Comprehensive health check - tests actual API connectivity
     * Makes a minimal API call to verify the key works
     * @returns {Promise<{working: boolean, configured: boolean, details: string, latencyMs?: number, error?: string}>}
     */
    async checkHealth() {
        const hasRegion = !!(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION);
        const apiKey = process.env.ANTHROPIC_API_KEY;

        // Check if configured at all
        if (!hasRegion && !apiKey) {
            return {
                working: false,
                configured: false,
                details: 'Neither AWS_REGION (Bedrock) nor ANTHROPIC_API_KEY (legacy) is set'
            };
        }

        // Legacy direct-API key format sanity check only applies in direct mode
        if (!hasRegion && apiKey && !apiKey.startsWith('sk-ant-')) {
            return {
                working: false,
                configured: true,
                details: 'API key format appears invalid (should start with sk-ant-)'
            };
        }

        // Check if initialized
        if (!this.initialized || !this.client) {
            return {
                working: false,
                configured: true,
                details: `${this.mode === 'bedrock' ? 'Bedrock' : 'API key'} configured but client not initialized`
            };
        }

        // Test actual connectivity with a minimal request
        try {
            const startTime = Date.now();

            const response = await this.client.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'Hi' }]
            });

            const latencyMs = Date.now() - startTime;

            return {
                working: true,
                configured: true,
                mode: this.mode,
                details: `Claude connected successfully via ${this.mode === 'bedrock' ? 'Amazon Bedrock' : 'direct Anthropic API'} (${latencyMs}ms latency)`,
                latencyMs,
                model: response.model,
                tokensUsed: response.usage?.input_tokens || 0
            };

        } catch (error) {
            console.error('❌ [CLAUDE] Health check failed:', error.message);

            // Parse common error messages (covers both Bedrock and direct-API errors)
            let errorDetail = error.message;
            if (error.status === 401 || error.message.includes('401') || error.message.includes('Unauthorized') || error.message.includes('AccessDenied')) {
                errorDetail = this.mode === 'bedrock'
                    ? 'Bedrock access denied - check the task/instance IAM role has bedrock:InvokeModel'
                    : 'Authentication failed - API key is invalid or expired';
            } else if (error.status === 403 || error.message.includes('403')) {
                errorDetail = 'Access forbidden - credentials may lack permissions';
            } else if (error.status === 429 || error.message.includes('rate') || error.message.includes('Throttling')) {
                return {
                    working: true,
                    configured: true,
                    details: 'Claude connected (rate limited but functional)',
                    rateLimited: true
                };
            } else if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
                errorDetail = this.mode === 'bedrock'
                    ? 'Network error - cannot reach Bedrock Runtime endpoint (check VPC routing/region)'
                    : 'Network error - cannot reach Anthropic API';
            } else if (error.message.includes('timeout')) {
                errorDetail = 'Connection timeout';
            }

            return {
                working: false,
                configured: true,
                details: errorDetail,
                error: error.message
            };
        }
    }

    /**
     * Get processor statistics
     */
    getStats() {
        return {
            ready: this.isReady(),
            mode: this.mode, // 'bedrock' | 'direct' | null — shows which path is actually active
            activeRequests: this.activeRequests,
            totalRequests: this.totalRequests,
            totalTokensUsed: this.totalTokensUsed
        };
    }

    /**
     * Extract financial data from a document
     */
    async extractFromDocument(docBuffer, docName, docType, options = {}) {
        if (!this.isReady()) {
            throw new Error('Claude processor not initialized');
        }

        const base64 = docBuffer.toString('base64');
        const mediaType = this.getMediaType(docName);
        const systemPrompt = this.buildExtractionPrompt(docType);
        const sizeKB = Math.round(docBuffer.length / 1024);

        this.activeRequests++;
        this.totalRequests++;

        console.log(`🤖 [CLAUDE] ─────────────────────────────────────────────`);
        console.log(`🤖 [CLAUDE] Starting extraction for: ${docName}`);
        console.log(`🤖 [CLAUDE] Document type: ${docType}`);
        console.log(`🤖 [CLAUDE] File size: ${sizeKB} KB`);
        console.log(`🤖 [CLAUDE] Media type: ${mediaType}`);
        console.log(`🤖 [CLAUDE] Active requests: ${this.activeRequests}`);

        try {
            const startTime = Date.now();
            
            console.log(`🤖 [CLAUDE] Calling Anthropic API...`);
            
            const response = await this.client.messages.create({
                model: options.model || 'claude-sonnet-4-20250514',
                max_tokens: options.maxTokens || 8000,
                system: systemPrompt,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'document',
                            source: {
                                type: 'base64',
                                media_type: mediaType,
                                data: base64
                            }
                        },
                        {
                            type: 'text',
                            text: `Extract all financial data from this ${docType}. Return ONLY valid JSON matching the schema provided.`
                        }
                    ]
                }]
            });

            const elapsed = Date.now() - startTime;
            const inputTokens = response.usage?.input_tokens || 0;
            const outputTokens = response.usage?.output_tokens || 0;
            
            this.totalTokensUsed.input += inputTokens;
            this.totalTokensUsed.output += outputTokens;
            this.activeRequests--;

            console.log(`✅ [CLAUDE] Extraction complete!`);
            console.log(`✅ [CLAUDE] Time: ${(elapsed/1000).toFixed(2)}s`);
            console.log(`✅ [CLAUDE] Input tokens: ${inputTokens.toLocaleString()}`);
            console.log(`✅ [CLAUDE] Output tokens: ${outputTokens.toLocaleString()}`);
            console.log(`✅ [CLAUDE] Total tokens used so far: ${(this.totalTokensUsed.input + this.totalTokensUsed.output).toLocaleString()}`);
            console.log(`🤖 [CLAUDE] ─────────────────────────────────────────────`);

            // Parse the response
            const content = response.content[0]?.text || '';
            const extracted = this.parseResponse(content);

            return {
                success: true,
                data: extracted,
                usage: {
                    inputTokens,
                    outputTokens
                },
                elapsed,
                document: docName,
                docType
            };

        } catch (err) {
            this.activeRequests--;
            
            console.error(`❌ [CLAUDE] ─────────────────────────────────────────────`);
            console.error(`❌ [CLAUDE] Extraction FAILED for: ${docName}`);
            console.error(`❌ [CLAUDE] Error: ${err.message}`);
            
            // Check for rate limit
            if (err.status === 429) {
                const retryAfter = err.headers?.['retry-after'] || 60;
                console.error(`⏳ [CLAUDE] Rate limited! Retry after ${retryAfter}s`);
                console.error(`❌ [CLAUDE] ─────────────────────────────────────────────`);
                return {
                    success: false,
                    error: 'rate_limit',
                    retryAfter: parseInt(retryAfter),
                    message: `Rate limited. Retry after ${retryAfter}s`,
                    document: docName,
                    docType
                };
            }

            console.error(`❌ [CLAUDE] ─────────────────────────────────────────────`);
            return {
                success: false,
                error: err.message,
                data: null,
                document: docName,
                docType
            };
        }
    }

    /**
     * Get media type from filename
     */
    getMediaType(filename) {
        const ext = (filename || '').split('.').pop().toLowerCase();
        const types = {
            'pdf': 'application/pdf',
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'gif': 'image/gif',
            'webp': 'image/webp'
        };
        return types[ext] || 'application/pdf';
    }

    /**
     * Build extraction prompt based on document type
     * IMPORTANT: Uses FLAT schema matching client-side claude-extractor.js for compatibility
     */
    buildExtractionPrompt(docType) {
        const basePrompt = `You are an expert financial document analyzer for Indian MSME credit assessment.

CRITICAL INSTRUCTIONS:
1. Extract ALL financial data accurately from the document
2. Return ONLY a valid JSON object - NO explanatory text, NO markdown formatting
3. Do NOT include \`\`\`json or \`\`\` markers
4. Use null for missing/unclear values
5. All monetary values as INTEGERS in Rupees (not Lakhs/Crores) - multiply by 100000 for Lakhs, 10000000 for Crores
6. Dates in YYYY-MM-DD format

Your response must be ONLY the JSON object, starting with { and ending with }`;

        const schemas = {
            'balance_sheet': `
IMPORTANT: Return ONLY the JSON object below with values filled in. No explanation, no markdown, just pure JSON.
All monetary values must be INTEGERS in Rupees.

{
  "financial_year": "FY25",
  "document_type": "balance_sheet",
  "balance_sheet": {
    "total_assets": <integer in rupees>,
    "fixed_assets_gross": <integer or null>,
    "fixed_assets_net": <integer>,
    "current_assets": <integer>,
    "inventory": <integer or null>,
    "trade_receivables": <integer>,
    "cash_bank": <integer>,
    "other_current_assets": <integer or null>,
    "total_liabilities": <integer>,
    "net_worth": <integer>,
    "share_capital": <integer>,
    "reserves_surplus": <integer>,
    "long_term_borrowings": <integer or null>,
    "short_term_borrowings": <integer or null>,
    "trade_payables": <integer>,
    "other_current_liabilities": <integer or null>
  },
  "extraction_confidence": "high",
  "notes": ""
}`,
            'profit_and_loss': `
IMPORTANT: Return ONLY the JSON object below with values filled in. No explanation, no markdown, just pure JSON.
All monetary values must be INTEGERS in Rupees.

{
  "financial_year": "FY25",
  "document_type": "profit_and_loss",
  "profit_and_loss": {
    "revenue": <integer in rupees>,
    "other_income": <integer or null>,
    "total_revenue": <integer or null>,
    "cost_of_goods_sold": <integer or null>,
    "gross_profit": <integer or null>,
    "employee_expenses": <integer>,
    "admin_expenses": <integer or null>,
    "selling_expenses": <integer or null>,
    "other_expenses": <integer or null>,
    "ebitda": <integer>,
    "depreciation": <integer>,
    "ebit": <integer or null>,
    "interest_expense": <integer>,
    "profit_before_tax": <integer>,
    "tax_expense": <integer>,
    "profit_after_tax": <integer>
  },
  "extraction_confidence": "high",
  "notes": ""
}`,
            'cash_flow': `
IMPORTANT: Return ONLY the JSON object below with values filled in. No explanation, no markdown, just pure JSON.

{
  "financial_year": "FY25",
  "document_type": "cash_flow",
  "cash_flow": {
    "operating_activities": <integer>,
    "investing_activities": <integer>,
    "financing_activities": <integer>,
    "net_change_in_cash": <integer>,
    "opening_cash": <integer or null>,
    "closing_cash": <integer>
  },
  "extraction_confidence": "high",
  "notes": ""
}`,
            'gst_return': `
IMPORTANT: Return ONLY the JSON object below with values filled in. No explanation, no markdown, just pure JSON.

{
  "period": "April 2024",
  "document_type": "gst_return",
  "gst_return": {
    "gstin": "<15-char GSTIN>",
    "legal_name": "<company name>",
    "filing_period": "<month/quarter>",
    "taxable_turnover": <integer>,
    "exempt_turnover": <integer or null>,
    "total_turnover": <integer>,
    "cgst_paid": <integer>,
    "sgst_paid": <integer>,
    "igst_paid": <integer>,
    "total_tax_paid": <integer>,
    "itc_claimed": <integer or null>
  },
  "extraction_confidence": "high",
  "notes": ""
}`,
            'bank_statement': `
IMPORTANT: Return ONLY the JSON object below with values filled in. No explanation, no markdown, just pure JSON.

{
  "period": "January 2025",
  "document_type": "bank_statement",
  "bank_statement": {
    "account_number": "<masked or full>",
    "bank_name": "<bank name>",
    "account_holder": "<name>",
    "opening_balance": <integer>,
    "closing_balance": <integer>,
    "total_credits": <integer>,
    "total_debits": <integer>,
    "average_balance": <integer or null>,
    "credit_count": <integer or null>,
    "debit_count": <integer or null>,
    "cheque_returns": <integer or null>,
    "emi_debits": <integer or null>
  },
  "extraction_confidence": "high",
  "notes": ""
}`,
            'itr': `
IMPORTANT: Return ONLY the JSON object below with values filled in. No explanation, no markdown, just pure JSON.

{
  "assessment_year": "AY 2024-25",
  "document_type": "itr",
  "itr": {
    "pan": "<10-char PAN>",
    "name": "<assessee name>",
    "itr_form": "<ITR-1/ITR-2/etc>",
    "gross_total_income": <integer>,
    "total_deductions": <integer or null>,
    "total_taxable_income": <integer>,
    "tax_payable": <integer>,
    "tax_paid": <integer>,
    "refund_due": <integer or null>,
    "filing_date": "<YYYY-MM-DD>"
  },
  "extraction_confidence": "high",
  "notes": ""
}`
        };

        const schema = schemas[docType] || schemas['balance_sheet'];
        return `${basePrompt}\n\nSCHEMA FOR ${docType.toUpperCase()}:\n${schema}`;
    }

    /**
     * Parse Claude response to extract JSON
     */
    parseResponse(content) {
        if (!content || content.trim().length === 0) {
            console.error('[CLAUDE] Empty response received');
            return { parse_error: true, error: 'empty_response' };
        }

        // Clean up common issues
        let cleaned = content.trim();
        
        // Remove BOM and other invisible characters
        cleaned = cleaned.replace(/^\uFEFF/, '');
        
        // Try direct parse first
        try {
            return JSON.parse(cleaned);
        } catch (e) {
            // Not direct JSON, continue
        }

        // Try to extract JSON from markdown code blocks
        const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[1].trim());
            } catch (e2) {
                console.error('[CLAUDE] Failed to parse JSON from code block:', e2.message);
            }
        }

        // Try to find JSON object in text (greedy match for outermost braces)
        const startIdx = cleaned.indexOf('{');
        const endIdx = cleaned.lastIndexOf('}');
        
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            let jsonStr = cleaned.substring(startIdx, endIdx + 1);
            
            // Try to fix common JSON issues
            // Remove trailing commas before closing braces/brackets
            jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
            // Replace single quotes with double quotes (be careful with apostrophes)
            // Only do this if there are no double quotes
            if (!jsonStr.includes('"') && jsonStr.includes("'")) {
                jsonStr = jsonStr.replace(/'/g, '"');
            }
            
            try {
                return JSON.parse(jsonStr);
            } catch (e3) {
                console.error('[CLAUDE] Failed to parse JSON object from text');
                console.error('[CLAUDE] Parse error:', e3.message);
                console.error('[CLAUDE] JSON string length:', jsonStr.length);
                console.error('[CLAUDE] First 300 chars:', jsonStr.substring(0, 300));
                console.error('[CLAUDE] Last 200 chars:', jsonStr.substring(jsonStr.length - 200));
            }
        }

        // Last resort: try to extract any valid JSON-like structure
        try {
            // Sometimes Claude adds explanatory text before/after JSON
            const lines = cleaned.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith('{')) {
                    // Try parsing from this line to the end
                    const remaining = lines.slice(i).join('\n');
                    const lastBrace = remaining.lastIndexOf('}');
                    if (lastBrace !== -1) {
                        try {
                            let jsonAttempt = remaining.substring(0, lastBrace + 1);
                            // Fix trailing commas
                            jsonAttempt = jsonAttempt.replace(/,\s*([}\]])/g, '$1');
                            return JSON.parse(jsonAttempt);
                        } catch (e) {
                            // Continue trying
                        }
                    }
                }
            }
        } catch (e4) {
            // Final fallback failed
        }

        console.error('[CLAUDE] Could not parse response as JSON');
        console.error('[CLAUDE] Full response length:', content.length, 'chars');
        
        // Return partial data with raw text for debugging
        return { 
            raw_text: content.substring(0, 2000), // Store first 2000 chars
            parse_error: true,
            error: 'json_parse_failed'
        };
    }

    /**
     * Process multiple documents with rate limit handling
     * Used by BullMQ worker for batch processing
     */
    async processDocuments(documents, options = {}) {
        const results = [];
        const onProgress = options.onProgress || (() => {});

        console.log(`📦 [CLAUDE] ═══════════════════════════════════════════════`);
        console.log(`📦 [CLAUDE] BATCH PROCESSING: ${documents.length} documents`);
        console.log(`📦 [CLAUDE] Assessment: ${options.assessmentId || 'unknown'}`);
        console.log(`📦 [CLAUDE] ═══════════════════════════════════════════════`);

        for (let i = 0; i < documents.length; i++) {
            const doc = documents[i];
            
            console.log(`📄 [CLAUDE] Document ${i + 1}/${documents.length}: ${doc.name}`);
            
            onProgress({
                current: i + 1,
                total: documents.length,
                document: doc.name,
                docType: doc.type,
                status: 'processing',
                percent: Math.round(((i) / documents.length) * 100)
            });

            const result = await this.extractFromDocument(
                doc.buffer,
                doc.name,
                doc.type,
                options
            );

            // Handle rate limit with retry
            if (!result.success && result.error === 'rate_limit') {
                console.log(`⏳ [CLAUDE] Rate limited, waiting ${result.retryAfter}s before retry...`);
                
                onProgress({
                    current: i + 1,
                    total: documents.length,
                    document: doc.name,
                    status: 'rate_limited',
                    retryAfter: result.retryAfter,
                    percent: Math.round(((i) / documents.length) * 100)
                });

                await this.sleep(result.retryAfter * 1000);
                
                console.log(`🔄 [CLAUDE] Retrying: ${doc.name}`);
                // Retry
                const retryResult = await this.extractFromDocument(
                    doc.buffer,
                    doc.name,
                    doc.type,
                    options
                );
                results.push({ document: doc.name, ...retryResult });
            } else {
                results.push({ document: doc.name, ...result });
            }

            onProgress({
                current: i + 1,
                total: documents.length,
                document: doc.name,
                docType: doc.type,
                status: result.success ? 'complete' : 'failed',
                percent: Math.round(((i + 1) / documents.length) * 100)
            });

            // Small delay between documents to avoid rate limits
            if (i < documents.length - 1) {
                await this.sleep(1000);
            }
        }

        const successCount = results.filter(r => r.success).length;
        console.log(`📦 [CLAUDE] ═══════════════════════════════════════════════`);
        console.log(`📦 [CLAUDE] BATCH COMPLETE: ${successCount}/${documents.length} successful`);
        console.log(`📦 [CLAUDE] Total tokens: ${this.totalTokensUsed.input + this.totalTokensUsed.output}`);
        console.log(`📦 [CLAUDE] ═══════════════════════════════════════════════`);

        return results;
    }

    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = new ClaudeProcessor();
