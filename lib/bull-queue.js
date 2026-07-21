/**
 * BullMQ Job Queue Manager
 * Handles background job processing with Redis
 * 
 * LOGGING PREFIXES:
 *   [QUEUE]  - Queue operations (add, remove, status)
 *   [WORKER] - Worker processing
 *   [REDIS]  - Redis connection/operations
 *   [SOCKET] - WebSocket communications
 *   [OCR]    - OCR Pipeline processing steps
 */

const { Queue, Worker, QueueEvents } = require('bullmq');
const path = require('path');
const crypto = require('crypto');

// Use the SAME extractor as client-side for consistency
let claudeExtractor = null;
try {
    claudeExtractor = require('./claude-extractor');
} catch (err) {
    console.log('[QUEUE] claude-extractor not available:', err.message);
}

// OCR Pipeline for enhanced scanned document processing
let ocrPipeline = null;
try {
    ocrPipeline = require('./ocr-pipeline');
    console.log('[QUEUE] OCR Pipeline loaded successfully');
} catch (err) {
    console.log('[QUEUE] OCR Pipeline not available:', err.message);
}

// Use the SAME calculation engine as client-side
let calculationEngine = null;
try {
    calculationEngine = require('./calculation-engine');
} catch (err) {
    console.log('[QUEUE] calculation-engine not available:', err.message);
}

// External verification APIs (Karza ITR, CIBIL Commercial, Novel) — routed
// through AFL's Middleware. Runs AFTER Claude extraction and BEFORE
// calculationEngine, per the finalized architecture.
let externalApisManager = null;
try {
    externalApisManager = require('./external-apis-manager');
    console.log('[QUEUE] External APIs Manager loaded successfully');
} catch (err) {
    console.log('[QUEUE] External APIs Manager not available:', err.message);
}

// Pennant LOS — called DIRECTLY (no Middleware), per architecture decision
let pennantClient = null;
try {
    pennantClient = require('./pennant-client');
    console.log('[QUEUE] Pennant client loaded successfully');
} catch (err) {
    console.log('[QUEUE] Pennant client not available:', err.message);
}

// Load config files (same as server.js)
let configLoaded = false;
function loadConfig() {
    if (configLoaded) return;
    
    try {
        const policyNorms = require('../config/policy-norms.json');
        const creditScoring = require('../config/credit-scoring.json');
        const limitParams = require('../config/limit-params.json');
        
        const config = {
            policy_rules: policyNorms.policy_rules || [],
            scoring_weights: creditScoring.scoring_weights || [],
            scoring_metrics: creditScoring.scoring_metrics || [],
            scoring_grades: creditScoring.scoring_grades || [],
            limit_params: limitParams.limit_params || []
        };
        
        if (calculationEngine) {
            calculationEngine.setConfig(config);
            console.log(`[QUEUE] Config loaded: Rules=${config.policy_rules.length}, Weights=${config.scoring_weights.length}, Metrics=${config.scoring_metrics.length}, Grades=${config.scoring_grades.length}, Params=${config.limit_params.length}`);
        }
        
        configLoaded = true;
    } catch (err) {
        console.log('[QUEUE] Config loading failed:', err.message);
    }
}

// Year label mapping (same as server.js)
const yearLabels = {
    'fy25': 'FY 2024-25',
    'fy24': 'FY 2023-24', 
    'fy23': 'FY 2022-23'
};

class BullQueueManager {
    constructor() {
        this.queue = null;
        this.worker = null;
        this.queueEvents = null;
        this.connection = null;
        this.initialized = false;
        this.socketManager = null;
        this.s3Client = null;
        this.claudeProcessor = null;
        this.assessments = null;
        this.assessmentsList = null;
        
        // Track active jobs for System Status
        this.activeJobs = new Map(); // assessmentId -> { company, progress, startTime }
        
        // Redis keys for progress (survives restart)
        this.PROGRESS_PREFIX = 'progress:';
        
        // Job handlers
        this.onJobComplete = null;
        this.onJobFailed = null;
        this.onJobProgress = null;
    }

    /**
     * Format timestamp for logs
     */
    timestamp() {
        return new Date().toISOString().substr(11, 12);
    }

    /**
     * Parse document ID to extract type and year
     * Example: "balance-sheet_bs_fy25" -> { type: "balance_sheet", year: "fy25", yearLabel: "FY 2024-25" }
     */
    parseDocumentId(docId) {
        const id = (docId || '').toLowerCase();
        let type = 'unknown';
        let year = null;
        let propertyId = null;
        
        // Extract year - support both formats
        // Format 1: fy24, fy25, fy23 (single upload)
        const fyMatch = id.match(/fy(\d{2})/);
        if (fyMatch) {
            year = `fy${fyMatch[1]}`;
        }
        
        // Format 2: _2024, _2023, _2025 (bulk upload)
        if (!year) {
            const yearMatch = id.match(/_(\d{4})$/);
            if (yearMatch) {
                const fullYear = yearMatch[1];
                // Convert 2024 -> fy24, 2023 -> fy23, 2025 -> fy25
                year = `fy${fullYear.slice(-2)}`;
            }
        }
        
        // Extract property ID for legal documents (format: legal_prop1_tsr, tsr_prop2, etc.)
        const propMatch = id.match(/prop(\d+)/i);
        if (propMatch) {
            propertyId = `prop${propMatch[1]}`;
        }
        
        // Determine type - check legal documents first
        // Legal document patterns: legal_prop1_tsr, tsr_prop1, ec_prop1, etc.
        if (id.includes('tsr') || id.includes('title_search')) {
            type = 'legal-tsr';
        } else if (id.includes('encumbrance') || (id.startsWith('ec_') && !id.includes('commercial'))) {
            type = 'legal-ec';
        } else if (id.includes('legal_opinion') || id.includes('advocate_opinion') || id.includes('adv_')) {
            type = 'legal-opinion';
        } else if (id.includes('roc_search') || id.includes('roc_')) {
            type = 'legal-roc';
        } else if (id.includes('mutation') || id.includes('7_12') || id.includes('khata') || id.includes('ferfar')) {
            type = 'legal-mutation';
        } else if (id.includes('prop_tax') || id.includes('property_tax_receipt')) {
            type = 'legal-tax';
        } else if (id.includes('approved_plan') || id.includes('building_plan') || id.includes('sanction_plan')) {
            type = 'legal-plan';
        } else if (id.includes('occupancy') || (id.includes('oc_') && !id.includes('doc')) || id.includes('completion_cert')) {
            type = 'legal-oc';
        } else if (id.includes('na_order') || id.includes('na_conversion')) {
            type = 'legal-na';
        } else if (id.includes('sale_deed') || id.includes('conveyance')) {
            type = 'legal-deed';
        } else if (id.includes('chain_') || id.includes('prior_deed')) {
            type = 'legal-chain';
        } else if (id.includes('society_noc') || id.includes('share_cert')) {
            type = 'legal-society';
        }
        // Existing document types
        else if (id.includes('balance') || id.includes('bs_') || id.startsWith('bs')) {
            type = 'balance_sheet';
        } else if (id.includes('pnl') || id.includes('profit') || id.includes('loss') || id.includes('p&l')) {
            type = 'profit_and_loss';
        } else if (id.includes('cash') && id.includes('flow') || id.includes('cf_') || id.startsWith('cashflow')) {
            type = 'cash_flow';
        } else if (id.includes('gst') && !id.includes('cibil')) {
            type = 'gst_return';
        } else if (id.includes('bank') && !id.includes('cibil')) {
            type = 'bank_statement';
        } else if (id.includes('itr')) {
            type = 'itr';
        } else if (id.includes('cibil') || id.includes('credit_report') || id.includes('bureau')) {
            type = 'cibil';
        } else if (id.includes('coi') || id.includes('moa') || id.includes('aoa') || id.includes('pan') || 
                   id.includes('cin') || id.includes('aadhaar') || id.includes('gst_certificate') ||
                   id.includes('incorporation') || id.includes('memorandum') || id.includes('article')) {
            type = 'kyc';
        } else if (id.includes('prop') || id.includes('title') || id.includes('deed') || 
                   id.includes('encumbrance') || id.includes('valuation') || id.includes('ec_') ||
                   id.includes('tsr') || id.includes('sale_deed') || id.includes('mutation')) {
            type = 'property';
        }
        
        return {
            type,
            year,
            yearLabel: year ? yearLabels[year] || year.toUpperCase() : null,
            propertyId
        };
    }

    /**
     * Extract document using claude-extractor.js (same as client-side)
     * This ensures identical data structure and prompts
     */
    async extractWithClaudeExtractor(buffer, docInfo, docName) {
        if (!claudeExtractor) {
            throw new Error('claude-extractor not available');
        }

        const { type, year, yearLabel } = docInfo;
        let result = null;

        switch (type) {
            case 'balance_sheet':
                result = await claudeExtractor.extractBalanceSheet(buffer, yearLabel || 'FY 2024-25');
                break;
            case 'profit_and_loss':
                result = await claudeExtractor.extractProfitAndLoss(buffer, yearLabel || 'FY 2024-25');
                break;
            case 'cash_flow':
                result = await claudeExtractor.extractCashFlow(buffer, yearLabel || 'FY 2024-25');
                break;
            case 'gst_return':
                result = await claudeExtractor.extractGSTReturn(buffer, 'Monthly');
                break;
            case 'bank_statement':
                result = await claudeExtractor.extractBankStatement(buffer, 'Monthly');
                break;
            case 'itr':
                result = await claudeExtractor.extractITR(buffer, 'AY 2024-25');
                break;
            case 'kyc':
                result = await claudeExtractor.extractKYC(buffer, docName);
                break;
            case 'cibil':
                // User-uploaded CIBIL report — extracts score, live loans, DPD etc.
                // Replaces the CIBIL Middleware API call entirely.
                result = await claudeExtractor.extractCIBIL(buffer, docName);
                break;
            case 'property':
                result = await claudeExtractor.extractProperty(buffer, docName);
                break;
            default:
                // Try balance sheet as fallback
                result = await claudeExtractor.extractBalanceSheet(buffer, yearLabel || 'FY 2024-25');
        }

        return result;
    }

    /**
     * Store extracted data in client-compatible format
     */
    storeExtractedData(extractedData, result, docInfo, docName = '') {
        const { type, year } = docInfo;
        const documentName = docName || docInfo.name || '';
        
        // Initialize category if needed
        if (!extractedData[type]) {
            if (type === 'gst_return') {
                extractedData.gst_returns = extractedData.gst_returns || [];
            } else if (type === 'bank_statement') {
                extractedData.bank_statements = extractedData.bank_statements || [];
            } else if (type === 'itr') {
                extractedData.itr_returns = extractedData.itr_returns || [];
            } else {
                extractedData[type] = {};
            }
        }

        // Store based on type
        if (type === 'balance_sheet' && result.balance_sheet) {
            const key = year || 'fy25';
            extractedData.balance_sheet[key] = result.balance_sheet;
            console.log(`${this.timestamp()} 💰 [WORKER] Stored BS ${key}: total_assets=${result.balance_sheet.total_assets}, net_worth=${result.balance_sheet.net_worth}`);
        } else if (type === 'profit_and_loss' && result.profit_and_loss) {
            const key = year || 'fy25';
            extractedData.profit_and_loss[key] = result.profit_and_loss;
            console.log(`${this.timestamp()} 💰 [WORKER] Stored P&L ${key}: revenue=${result.profit_and_loss.revenue}, pat=${result.profit_and_loss.profit_after_tax}`);
        } else if (type === 'cash_flow' && result.cash_flow) {
            const key = year || 'fy25';
            if (!extractedData.cash_flow) extractedData.cash_flow = {};
            extractedData.cash_flow[key] = result.cash_flow;
            console.log(`${this.timestamp()} 💰 [WORKER] Stored CF ${key}: operating=${result.cash_flow.operating_cash_flow}, net=${result.cash_flow.net_cash_flow}`);
        } else if (type === 'gst_return' && result.gst_return) {
            extractedData.gst_returns.push(result.gst_return);
        } else if (type === 'bank_statement') {
            // Handle both wrapped and unwrapped bank statement results
            const bankData = result.bank_statement || result;
            if (bankData && (bankData.total_credits !== undefined || bankData.closing_balance !== undefined)) {
                extractedData.bank_statements.push(bankData);
                console.log(`${this.timestamp()} 🏦 [WORKER] Stored bank statement: credits=${bankData.total_credits}, balance=${bankData.closing_balance}`);
            }
        } else if (type === 'cibil') {
            // Store CIBIL data for credit history scoring
            if (!extractedData.cibil) extractedData.cibil = {};
            const cibilData = result.cibil || result;
            if (docInfo.subtype === 'company' || documentName.toLowerCase().includes('company')) {
                extractedData.cibil.company = cibilData;
                console.log(`${this.timestamp()} 📊 [WORKER] Stored company CIBIL: score=${cibilData.cibil_score || cibilData.cmr_rank}`);
            } else {
                extractedData.cibil.director = cibilData;
                console.log(`${this.timestamp()} 📊 [WORKER] Stored director CIBIL: score=${cibilData.cibil_score}`);
            }

            // Feed into external_verification.cibil_commercial — the exact shape
            // calculationEngine.calcCreditScore() reads (cibil_score, max_dpd_last_12m,
            // report_date). Uploaded-report data now replaces the live API call.
            // Company report takes priority over director report if both are uploaded.
            if (!extractedData.external_verification) {
                extractedData.external_verification = { fetchedAt: new Date().toISOString() };
            }
            const preferCompany = extractedData.cibil.company && (extractedData.cibil.company.cibil_score != null);
            const chosen = preferCompany ? extractedData.cibil.company : (extractedData.cibil.director || cibilData);
            if (chosen && chosen.cibil_score != null) {
                extractedData.external_verification.cibil_commercial = {
                    success: true,
                    source: 'uploaded_document',
                    cibil_score: chosen.cibil_score,
                    cibil_rank: chosen.cibil_rank || null,
                    max_dpd_last_12m: chosen.max_dpd_last_12m ?? 0,
                    current_dpd: chosen.current_dpd ?? 0,
                    willful_defaulter: chosen.willful_defaulter ?? false,
                    total_active_accounts: chosen.total_active_accounts || null,
                    total_outstanding: chosen.total_outstanding || null,
                    live_loans: chosen.live_loans || [],
                    report_date: chosen.report_date || null
                };
                console.log(`${this.timestamp()} ✅ [WORKER] CIBIL data from uploaded report feeding into credit score: ${chosen.cibil_score}`);
            }
        } else if (type === 'itr' && result.itr) {
            extractedData.itr_returns.push(result.itr);
        } else if (type === 'kyc') {
            if (!extractedData.kyc) extractedData.kyc = {};
            const kycData = result.kyc || result;
            const docLower = documentName.toLowerCase();
            
            // Store by document type for easier lookup
            if (docLower.includes('coi') || docLower.includes('incorporation')) {
                extractedData.kyc.coi = kycData;
                console.log(`${this.timestamp()} 📄 [WORKER] Stored COI: company=${kycData.company_name}, inc_date=${kycData.date_of_incorporation}`);
            } else if (docLower.includes('moa') || docLower.includes('memorandum')) {
                extractedData.kyc.moa = kycData;
            } else if (docLower.includes('aoa') || docLower.includes('article')) {
                extractedData.kyc.aoa = kycData;
            } else if (docLower.includes('pan')) {
                extractedData.kyc.pan = kycData;
            } else if (docLower.includes('gst')) {
                extractedData.kyc.gst_certificate = kycData;
            } else {
                extractedData.kyc[docInfo.subtype || 'general'] = kycData;
            }
            
            // Also store top-level fields for easy access
            if (kycData.date_of_incorporation) {
                extractedData.kyc.date_of_incorporation = kycData.date_of_incorporation;
            }
            if (kycData.company_name) {
                extractedData.kyc.company_name = kycData.company_name;
            }
            if (kycData.cin) {
                extractedData.kyc.cin = kycData.cin;
            }
        } else if (type === 'property') {
            if (!extractedData.property) extractedData.property = {};
            const propData = result.property || result;
            const docLower = documentName.toLowerCase();
            
            // Store by document type for easier lookup
            if (docLower.includes('valuation')) {
                extractedData.property.prop_valuation = propData;
                // Store market value at top level
                if (propData.market_value || propData.total_market_value) {
                    extractedData.property.market_value = propData.market_value || propData.total_market_value;
                }
                console.log(`${this.timestamp()} 🏠 [WORKER] Stored valuation: market_value=${propData.market_value || propData.total_market_value}`);
            } else if (docLower.includes('title') || docLower.includes('deed') || docLower.includes('sale')) {
                extractedData.property.prop_title = propData;
                if (propData.registration_value || propData.sale_value) {
                    extractedData.property.registration_value = propData.registration_value || propData.sale_value;
                }
                console.log(`${this.timestamp()} 🏠 [WORKER] Stored title deed: address=${propData.property_address}`);
            } else if (docLower.includes('encumbrance') || docLower.includes('ec_')) {
                extractedData.property.prop_enc = propData;
                extractedData.property.encumbrance_status = propData.encumbrance_status || propData.status || 'Unknown';
                console.log(`${this.timestamp()} 🏠 [WORKER] Stored EC: status=${propData.encumbrance_status || propData.status}`);
            } else if (docLower.includes('tsr')) {
                extractedData.property.tsr = propData;
            } else {
                extractedData.property[docInfo.subtype || 'general'] = propData;
            }
        } else if (result.company_info) {
            extractedData.company_info = result.company_info || result;
        }

        return extractedData;
    }

    /**
     * Aggregate GST and Bank data (same as client-side)
     */
    aggregateData(extractedData) {
        if (claudeExtractor) {
            if (extractedData.gst_returns && extractedData.gst_returns.length > 0) {
                extractedData.gst_aggregated = claudeExtractor.aggregateGSTData(extractedData.gst_returns);
            }
            if (extractedData.bank_statements && extractedData.bank_statements.length > 0) {
                extractedData.bank_aggregated = claudeExtractor.aggregateBankData(extractedData.bank_statements);
            }
        }
        return extractedData;
    }

    /**
     * Initialize the queue with Redis connection
     */
    async initialize(options = {}) {
        const redisUrl = process.env.REDIS_URL;
        
        if (!redisUrl) {
            console.log(`${this.timestamp()} ⚠️ [REDIS] REDIS_URL not set - server-side processing disabled`);
            return false;
        }

        try {
            // Parse Redis URL for BullMQ connection
            this.connection = this.parseRedisUrl(redisUrl);
            
            // Test connection first
            console.log(`${this.timestamp()} 🔄 [REDIS] Testing connection...`);
            const testConnection = await this.testRedisConnection();
            if (!testConnection) {
                console.log(`${this.timestamp()} ⚠️ [REDIS] Connection test failed - using client-side processing`);
                return false;
            }
            
            // Create a separate Redis client for progress tracking operations
            // BullMQ's internal connection can't be used directly for custom Redis commands
            const Redis = require('ioredis');
            this.redisClient = new Redis({
                ...this.connection,
                lazyConnect: false
            });
            
            this.redisClient.on('error', (err) => {
                console.log(`${this.timestamp()} ⚠️ [REDIS] Progress client error:`, err.message);
            });
            
            console.log(`${this.timestamp()} ✅ [REDIS] Progress tracking client created`);
            
            // Create queue
            this.queue = new Queue('assessment-processing', {
                connection: this.connection,
                defaultJobOptions: {
                    attempts: 3,
                    backoff: {
                        type: 'exponential',
                        delay: 10000 // 10 seconds
                    },
                    removeOnComplete: { count: 100 },
                    removeOnFail: { count: 50 }
                }
            });

            // Create queue events for monitoring
            this.queueEvents = new QueueEvents('assessment-processing', {
                connection: this.connection
            });

            // Set up event listeners
            this.setupEventListeners();

            // Store references
            this.socketManager = options.socketManager;
            this.s3Client = options.s3Client;
            this.claudeProcessor = options.claudeProcessor;
            this.assessments = options.assessments;
            this.assessmentsList = options.assessmentsList;
            this.jobQueue = options.jobQueue;  // In-memory job queue for progress tracking

            // Create worker
            await this.createWorker();

            this.initialized = true;
            console.log(`${this.timestamp()} ✅ [QUEUE] BullMQ initialized successfully`);
            console.log(`${this.timestamp()} ✅ [QUEUE] Queue: assessment-processing`);
            console.log(`${this.timestamp()} ✅ [WORKER] Worker started with concurrency: 2`);
            
            return true;

        } catch (err) {
            console.error(`${this.timestamp()} ❌ [QUEUE] Failed to initialize BullMQ:`, err.message);
            return false;
        }
    }

    /**
     * Test Redis connection before initializing queue
     */
    async testRedisConnection() {
        const Redis = require('ioredis');
        
        return new Promise((resolve) => {
            const testClient = new Redis({
                ...this.connection,
                lazyConnect: true,
                connectTimeout: 10000 // 10 second timeout
            });
            
            const timeout = setTimeout(() => {
                console.log(`${this.timestamp()} ⚠️ [REDIS] Connection timeout`);
                testClient.disconnect();
                resolve(false);
            }, 10000);
            
            testClient.on('connect', () => {
                console.log(`${this.timestamp()} ✅ [REDIS] Connection successful`);
                clearTimeout(timeout);
                testClient.disconnect();
                resolve(true);
            });
            
            testClient.on('error', (err) => {
                console.log(`${this.timestamp()} ⚠️ [REDIS] Connection error:`, err.message);
                clearTimeout(timeout);
                testClient.disconnect();
                resolve(false);
            });
            
            testClient.connect().catch((err) => {
                console.log(`${this.timestamp()} ⚠️ [REDIS] Connect failed:`, err.message);
                clearTimeout(timeout);
                resolve(false);
            });
        });
    }

    /**
     * Parse Redis URL for BullMQ
     * Upstash requires specific settings
     */
    parseRedisUrl(url) {
        try {
            const parsed = new URL(url);
            const isUpstash = parsed.hostname.includes('upstash.io');
            const isTLS = parsed.protocol === 'rediss:';
            
            const config = {
                host: parsed.hostname,
                port: parseInt(parsed.port) || 6379,
                password: parsed.password || undefined,
                // CRITICAL for Upstash/BullMQ compatibility
                maxRetriesPerRequest: null,  // Required for BullMQ with Upstash
                enableReadyCheck: false,     // Faster connection
                retryStrategy: (times) => {
                    if (times > 3) {
                        console.log(`${this.timestamp()} [REDIS] Retry attempt ${times}, giving up`);
                        return null; // Stop retrying
                    }
                    return Math.min(times * 200, 2000); // Exponential backoff
                }
            };
            
            // Enable TLS for rediss:// URLs (Upstash requires TLS)
            if (isTLS) {
                config.tls = {
                    rejectUnauthorized: false // Required for some Redis providers
                };
            }
            
            console.log(`${this.timestamp()} 📡 [REDIS] Config: ${parsed.hostname}:${parsed.port} (TLS: ${isTLS}, Upstash: ${isUpstash})`);
            
            return config;
        } catch (err) {
            console.error('Invalid Redis URL:', err.message);
            throw err;
        }
    }

    /**
     * Check if queue is ready
     */
    isReady() {
        return this.initialized && this.queue !== null;
    }

    /**
     * Comprehensive health check - tests actual Redis connectivity
     * @returns {Promise<{working: boolean, configured: boolean, details: string, latencyMs?: number, error?: string}>}
     */
    async checkHealth() {
        const redisUrl = process.env.REDIS_URL;
        
        // Check if configured
        if (!redisUrl) {
            return {
                working: false,
                configured: false,
                details: 'REDIS_URL environment variable not set'
            };
        }
        
        // Check if initialized
        if (!this.initialized || !this.queue) {
            return {
                working: false,
                configured: true,
                details: 'Redis configured but queue not initialized - may have failed to connect'
            };
        }
        
        // Test actual connectivity with PING
        try {
            const Redis = require('ioredis');
            const testClient = new Redis({
                ...this.connection,
                lazyConnect: true,
                connectTimeout: 5000
            });
            
            const startTime = Date.now();
            
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    testClient.disconnect();
                    reject(new Error('Connection timeout after 5 seconds'));
                }, 5000);
                
                testClient.connect()
                    .then(() => testClient.ping())
                    .then((result) => {
                        clearTimeout(timeout);
                        resolve(result);
                    })
                    .catch((err) => {
                        clearTimeout(timeout);
                        reject(err);
                    });
            });
            
            const latencyMs = Date.now() - startTime;
            testClient.disconnect();
            
            // Get queue stats for additional info
            const stats = await this.getStats();
            
            return {
                working: true,
                configured: true,
                details: `Redis connected successfully (${latencyMs}ms latency)`,
                latencyMs,
                queueStats: {
                    waiting: stats.waiting,
                    active: stats.active,
                    completed: stats.completed,
                    failed: stats.failed
                }
            };
            
        } catch (error) {
            console.error(`${this.timestamp()} ❌ [REDIS] Health check failed:`, error.message);
            
            // Parse common error messages
            let errorDetail = error.message;
            if (error.message.includes('ECONNREFUSED')) {
                errorDetail = 'Connection refused - Redis server may be down';
            } else if (error.message.includes('ENOTFOUND')) {
                errorDetail = 'Host not found - check REDIS_URL hostname';
            } else if (error.message.includes('WRONGPASS') || error.message.includes('AUTH')) {
                errorDetail = 'Authentication failed - check Redis password';
            } else if (error.message.includes('timeout')) {
                errorDetail = 'Connection timeout - Redis may be unreachable';
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
     * Add assessment job to queue
     */
    async addJob(assessmentId, jobData) {
        if (!this.isReady()) {
            throw new Error('Queue not initialized');
        }

        console.log(`${this.timestamp()} ═══════════════════════════════════════════════════════════`);
        console.log(`${this.timestamp()} 🚀 [QUEUE] NEW JOB SUBMITTED`);
        console.log(`${this.timestamp()} 📋 [QUEUE] Assessment ID: ${assessmentId}`);
        console.log(`${this.timestamp()} 🏢 [QUEUE] Company: ${jobData.companyName}`);
        console.log(`${this.timestamp()} 💰 [QUEUE] Loan Amount: ₹${jobData.loanAmount || 'N/A'}`);
        console.log(`${this.timestamp()} 📄 [QUEUE] Documents: ${jobData.documents?.length || 0}`);
        console.log(`${this.timestamp()} 👤 [QUEUE] User: ${jobData.userId}`);

        const job = await this.queue.add('process-assessment', {
            assessmentId,
            companyName: jobData.companyName,
            loanAmount: jobData.loanAmount,
            documents: jobData.documents, // Array of { id, name, type, s3Key }
            userId: jobData.userId,
            created_by_name: jobData.created_by_name || jobData.userId,
            createdAt: new Date().toISOString()
        }, {
            jobId: assessmentId, // Use assessment ID as job ID for easy lookup
            priority: jobData.priority || 1
        });

        // Get queue position
        const stats = await this.getStats();
        console.log(`${this.timestamp()} ✅ [QUEUE] Job added successfully`);
        console.log(`${this.timestamp()} 📊 [QUEUE] Queue status: Waiting=${stats.waiting}, Active=${stats.active}`);
        console.log(`${this.timestamp()} ═══════════════════════════════════════════════════════════`);
        
        return job;
    }

    /**
     * Get job status
     */
    async getJobStatus(assessmentId) {
        if (!this.isReady()) {
            return { status: 'queue_unavailable' };
        }

        try {
            const job = await this.queue.getJob(assessmentId);
            
            if (!job) {
                return { status: 'not_found' };
            }

            const state = await job.getState();
            const progress = job.progress || 0;

            return {
                status: state,
                progress: typeof progress === 'object' ? progress.percent || 0 : progress,
                data: job.data,
                processedOn: job.processedOn,
                finishedOn: job.finishedOn,
                failedReason: job.failedReason,
                attemptsMade: job.attemptsMade,
                ...job.progress // Include full progress data
            };

        } catch (err) {
            console.error(`${this.timestamp()} ❌ [QUEUE] Error getting job status:`, err.message);
            return { status: 'error', error: err.message };
        }
    }

    /**
     * Cancel/remove a job
     */
    async cancelJob(assessmentId) {
        if (!this.isReady()) return false;

        try {
            const job = await this.queue.getJob(assessmentId);
            if (job) {
                await job.remove();
                console.log(`${this.timestamp()} 🗑️ [QUEUE] Job ${assessmentId} removed from queue`);
                this.activeJobs.delete(assessmentId);
                return true;
            }
            return false;
        } catch (err) {
            console.error(`${this.timestamp()} ❌ [QUEUE] Error canceling job:`, err.message);
            return false;
        }
    }

    /**
     * Get queue statistics
     */
    async getStats() {
        if (!this.isReady()) {
            console.log(`${this.timestamp()} ⚠️ [STATS] BullMQ not ready`);
            return { active: 0, waiting: 0, completed: 0, failed: 0, activeJobs: [], waitingJobs: [] };
        }

        try {
            const [waiting, active, completed, failed] = await Promise.all([
                this.queue.getWaitingCount(),
                this.queue.getActiveCount(),
                this.queue.getCompletedCount(),
                this.queue.getFailedCount()
            ]);
            
            // Get waiting job details from BullMQ
            let waitingJobs = [];
            try {
                const waitingJobsList = await this.queue.getWaiting(0, 20);
                waitingJobs = waitingJobsList.map(job => ({
                    id: job.id,
                    assessmentId: job.data?.assessmentId,
                    company: job.data?.companyName,
                    addedAt: job.timestamp ? new Date(job.timestamp).toISOString() : null
                }));
            } catch (e) {
                console.log(`${this.timestamp()} ⚠️ Could not fetch waiting jobs: ${e.message}`);
            }
            
            // Get active jobs - READ FROM REDIS (single source of truth)
            let activeJobsList = [];
            try {
                // First get all progress data from Redis
                const redisProgress = await this.getAllProgressFromRedis();
                
                if (redisProgress.length > 0) {
                    activeJobsList = redisProgress.map(p => ({
                        assessmentId: p.assessmentId,
                        company: p.company,
                        progress: p.progress,
                        phase: p.phase,
                        currentDocument: p.currentDocument,
                        startTime: p.startTime,
                        updatedAt: p.updatedAt
                    }));
                    console.log(`${this.timestamp()} 📊 [STATS] Got ${activeJobsList.length} active jobs from Redis`);
                } else {
                    // Fallback to BullMQ active jobs
                    const bullActiveJobs = await this.queue.getActive(0, 10);
                    if (bullActiveJobs.length > 0) {
                        activeJobsList = bullActiveJobs.map(job => {
                            const inMemory = this.activeJobs.get(job.data?.assessmentId);
                            return {
                                id: job.id,
                                assessmentId: job.data?.assessmentId,
                                company: job.data?.companyName || inMemory?.company,
                                progress: inMemory?.progress || 0,
                                startTime: inMemory?.startTime || (job.processedOn ? new Date(job.processedOn).toISOString() : null),
                                currentDocument: inMemory?.currentDocument,
                                phase: inMemory?.phase || 'processing'
                            };
                        });
                        console.log(`${this.timestamp()} 📊 [STATS] Got ${activeJobsList.length} active jobs from BullMQ`);
                    }
                }
            } catch (e) {
                console.log(`${this.timestamp()} ⚠️ Could not fetch active jobs: ${e.message}`);
            }

            console.log(`${this.timestamp()} 📊 [STATS] Final: Active=${activeJobsList.length}, Waiting=${waitingJobs.length}`);
            
            return { 
                waiting, 
                active: Math.max(active, activeJobsList.length),
                completed, 
                failed,
                activeJobs: activeJobsList,
                waitingJobs
            };
        } catch (err) {
            console.error(`${this.timestamp()} ❌ [STATS] Error: ${err.message}`);
            return { active: 0, waiting: 0, completed: 0, failed: 0, error: err.message, activeJobs: [], waitingJobs: [] };
        }
    }

    /**
     * Create the worker that processes jobs
     */
    async createWorker() {
        this.worker = new Worker('assessment-processing', async (job) => {
            return this.processAssessmentJob(job);
        }, {
            connection: this.connection,
            concurrency: 2, // Process 2 jobs at a time
            lockDuration: 600000, // 10 minutes lock (for long processing)
            stalledInterval: 60000 // Check for stalled jobs every minute
        });

        // Worker event handlers
        this.worker.on('completed', (job, result) => {
            console.log(`${this.timestamp()} ✅ [WORKER] Job ${job.id} completed successfully`);
            this.activeJobs.delete(job.data.assessmentId);
            this.clearProgressFromRedis(job.data.assessmentId); // Clear from Redis
            if (this.onJobComplete) this.onJobComplete(job, result);
        });

        this.worker.on('failed', (job, err) => {
            console.error(`${this.timestamp()} ❌ [WORKER] Job ${job?.id} failed:`, err.message);
            if (job?.data?.assessmentId) {
                this.activeJobs.delete(job.data.assessmentId);
                this.clearProgressFromRedis(job.data.assessmentId); // Clear from Redis
            }
            if (this.onJobFailed) this.onJobFailed(job, err);
        });

        this.worker.on('progress', (job, progress) => {
            if (this.onJobProgress) this.onJobProgress(job, progress);
        });

        this.worker.on('error', (err) => {
            console.error(`${this.timestamp()} ❌ [WORKER] Worker error:`, err.message);
        });

        this.worker.on('active', (job) => {
            console.log(`${this.timestamp()} 🔄 [WORKER] Job ${job.id} is now active`);
        });

        console.log(`${this.timestamp()} ✅ [WORKER] BullMQ Worker created and listening`);
    }

    /**
     * Main job processor - THIS IS WHERE THE MAGIC HAPPENS
     */
    async processAssessmentJob(job) {
        const { assessmentId, companyName, documents, userId, loanAmount, industryType } = job.data;
        
        // Initialize API logs for this job
        const apiLogs = [];
        const startTime = Date.now();
        
        // Helper to add API log entry
        const addApiLog = (type, message, details = {}) => {
            const entry = {
                timestamp: new Date().toISOString(),
                type, // 'info', 'api', 'success', 'error', 'warning'
                message,
                elapsed: Date.now() - startTime,
                ...details
            };
            apiLogs.push(entry);
            return entry;
        };

        // Track active job
        this.activeJobs.set(assessmentId, {
            company: companyName,
            progress: 0,
            startTime: new Date().toISOString(),
            documentsTotal: documents.length,
            documentsCompleted: 0
        });

        console.log(`${this.timestamp()} ═══════════════════════════════════════════════════════════`);
        console.log(`${this.timestamp()} 🔄 [WORKER] PROCESSING STARTED`);
        console.log(`${this.timestamp()} 📋 [WORKER] Assessment: ${assessmentId}`);
        console.log(`${this.timestamp()} 🏢 [WORKER] Company: ${companyName}`);
        console.log(`${this.timestamp()} 📄 [WORKER] Documents to process: ${documents.length}`);
        console.log(`${this.timestamp()} ═══════════════════════════════════════════════════════════`);

        addApiLog('info', `Job started for ${companyName}`, { assessmentId, documentCount: documents.length });

        // Emit start via WebSocket
        this.emitProgress(assessmentId, {
            status: 'processing',
            phase: 'starting',
            progress: 0,
            message: 'Starting document extraction...',
            apiLogs
        });

        try {
            // 1. Load checkpoint if exists (for recovery)
            const checkpoint = await this.loadCheckpoint(assessmentId);
            const completedDocs = checkpoint?.completedDocs || [];
            
            // Initialize extractedData with SAME structure as client-side
            let extractedData = checkpoint?.extractedData || {
                balance_sheet: {},
                profit_and_loss: {},
                cash_flow: {},
                gst_returns: [],
                bank_statements: [],
                itr_returns: [],
                kyc: {},
                property: {},
                company_info: null,
                legal_documents: {},  // Legal documents per property
                legal_risk_assessment: null  // Final legal assessment
            };
            let apiStats = checkpoint?.apiStats || { calls: 0, inputTokens: 0, outputTokens: 0 };
            let documentTimings = [];
            
            // Track document hashes for duplicate detection
            const documentHashes = new Map();
            const duplicateWarnings = [];

            if (checkpoint) {
                console.log(`${this.timestamp()} 📍 [WORKER] Checkpoint found: ${completedDocs.length}/${documents.length} docs already done`);
                addApiLog('info', `Resuming from checkpoint: ${completedDocs.length}/${documents.length} documents completed`);
            }

            // Check if claudeExtractor is available
            if (!claudeExtractor) {
                throw new Error('claudeExtractor not available - cannot process documents');
            }

            // 2. Process each document using claudeExtractor (SAME as client-side)
            for (let i = 0; i < documents.length; i++) {
                const doc = documents[i];
                const docNum = i + 1;

                // Skip if already processed (recovery)
                if (completedDocs.includes(doc.id)) {
                    console.log(`${this.timestamp()} ⏭️ [WORKER] Skipping ${doc.name} - already in checkpoint`);
                    addApiLog('info', `Skipped ${doc.name} (already processed)`);
                    continue;
                }

                // Parse document ID to get type and year
                const docInfo = this.parseDocumentId(doc.id || doc.name);
                const sizeKB = doc.size ? Math.round(doc.size / 1024) : 0;
                
                console.log(`${this.timestamp()} ─────────────────────────────────────────────────────────`);
                console.log(`${this.timestamp()} 📄 [WORKER] Processing document ${docNum}/${documents.length}`);
                console.log(`${this.timestamp()} 📄 [WORKER] Name: ${doc.name}`);
                console.log(`${this.timestamp()} 📄 [WORKER] Parsed Type: ${docInfo.type}, Year: ${docInfo.year}`);
                console.log(`${this.timestamp()} 📄 [WORKER] S3 Key: ${doc.s3Key}`);

                // Update progress
                const progress = Math.round(((i) / documents.length) * 80);
                
                // Update active job tracking
                this.activeJobs.set(assessmentId, {
                    company: companyName,
                    progress,
                    startTime: this.activeJobs.get(assessmentId)?.startTime,
                    documentsTotal: documents.length,
                    documentsCompleted: completedDocs.length,
                    currentDocument: doc.name
                });

                await job.updateProgress({
                    percent: progress,
                    phase: 'extraction',
                    currentDoc: doc.name,
                    docsCompleted: completedDocs.length,
                    totalDocs: documents.length
                });

                // Emit SSE-compatible doc_start event
                this.emitProgress(assessmentId, {
                    type: 'doc_start',
                    docNum: docNum,
                    docName: doc.name,
                    sizeKB: sizeKB,
                    status: 'processing',
                    phase: 'extraction',
                    progress,
                    apiLogs
                });
                addApiLog('api_call', `[${docNum}] ${doc.name} (${sizeKB} KB) - Processing...`);

                // Load document from S3
                console.log(`${this.timestamp()} 📥 [WORKER] Loading document from S3...`);
                const docBuffer = await this.loadDocumentFromS3(doc.s3Key);
                if (!docBuffer) {
                    console.error(`${this.timestamp()} ❌ [WORKER] Could not load document ${doc.name} from S3`);
                    addApiLog('api_error', `Failed to load ${doc.name} from S3`);
                    continue;
                }
                const actualSizeKB = Math.round(docBuffer.length / 1024);
                console.log(`${this.timestamp()} ✅ [WORKER] Document loaded: ${actualSizeKB} KB`);
                
                // DUPLICATE DETECTION: Check if this file content was already uploaded
                const docHash = crypto.createHash('md5').update(docBuffer).digest('hex');
                const existingDoc = documentHashes.get(docHash);
                
                if (existingDoc) {
                    // Same file uploaded twice with different tags!
                    const warning = `⚠️ DUPLICATE DETECTED: "${doc.name}" is identical to "${existingDoc.name}" - same file uploaded with different year tags`;
                    console.log(`${this.timestamp()} ${warning}`);
                    addApiLog('warning', warning);
                    duplicateWarnings.push({
                        duplicate: doc.name,
                        original: existingDoc.name,
                        duplicateYear: docInfo.year,
                        originalYear: existingDoc.year,
                        type: docInfo.type
                    });
                    
                    // IMPROVED: Always mark as duplicate, copy will happen after original is processed
                    // Store pending duplicate info for later resolution
                    if (!extractedData._pending_duplicates) {
                        extractedData._pending_duplicates = [];
                    }
                    extractedData._pending_duplicates.push({
                        type: docInfo.type,
                        sourceYear: existingDoc.year,
                        targetYear: docInfo.year,
                        docId: doc.id
                    });
                    
                    // Skip processing this duplicate - data will be copied later
                    if (docInfo.type === 'balance_sheet') {
                        // Check if source already processed, if so copy now
                        if (extractedData.balance_sheet[existingDoc.year]) {
                            console.log(`${this.timestamp()} ⏭️ [WORKER] Copying duplicate BS from ${existingDoc.year} to ${docInfo.year}`);
                            extractedData.balance_sheet[docInfo.year] = {
                                ...extractedData.balance_sheet[existingDoc.year],
                                _is_duplicate: true,
                                _duplicate_of: existingDoc.year,
                                _warning: 'This data is from a duplicate upload - same file as ' + existingDoc.year
                            };
                        } else {
                            // Source not yet processed, mark for later
                            console.log(`${this.timestamp()} ⏭️ [WORKER] BS duplicate queued: ${docInfo.year} -> ${existingDoc.year} (pending)`);
                        }
                        completedDocs.push(doc.id);
                        continue;
                    } else if (docInfo.type === 'profit_and_loss') {
                        if (extractedData.profit_and_loss[existingDoc.year]) {
                            console.log(`${this.timestamp()} ⏭️ [WORKER] Copying duplicate P&L from ${existingDoc.year} to ${docInfo.year}`);
                            extractedData.profit_and_loss[docInfo.year] = {
                                ...extractedData.profit_and_loss[existingDoc.year],
                                _is_duplicate: true,
                                _duplicate_of: existingDoc.year,
                                _warning: 'This data is from a duplicate upload - same file as ' + existingDoc.year
                            };
                        }
                        completedDocs.push(doc.id);
                        continue;
                    } else if (docInfo.type === 'cash_flow') {
                        if (extractedData.cash_flow[existingDoc.year]) {
                            console.log(`${this.timestamp()} ⏭️ [WORKER] Copying duplicate CF from ${existingDoc.year} to ${docInfo.year}`);
                            extractedData.cash_flow[docInfo.year] = {
                                ...extractedData.cash_flow[existingDoc.year],
                                _is_duplicate: true,
                                _duplicate_of: existingDoc.year,
                                _warning: 'This data is from a duplicate upload - same file as ' + existingDoc.year
                            };
                        }
                        completedDocs.push(doc.id);
                        continue;
                    }
                } else {
                    // First time seeing this file - record it
                    documentHashes.set(docHash, {
                        name: doc.name,
                        year: docInfo.year,
                        type: docInfo.type
                    });
                }

                // Extract using claudeExtractor (SAME functions as client-side)
                const extractionStart = Date.now();
                let result = null;
                let keyValues = {};
                
                // OCR Pipeline progress callback - emits real-time step updates
                const ocrProgressCallback = (stepLog) => {
                    console.log(`${this.timestamp()} 🔍 [OCR] ${stepLog.formatted}`);
                    addApiLog('ocr_step', `[${docNum}] ${stepLog.message}`);
                    
                    // Emit OCR step progress via WebSocket
                    this.emitProgress(assessmentId, {
                        type: 'ocr_step',
                        docNum: docNum,
                        docName: doc.name,
                        step: stepLog.step,
                        totalSteps: stepLog.totalSteps,
                        message: stepLog.message,
                        details: stepLog.details,
                        status: 'processing',
                        phase: 'ocr_pipeline',
                        progress: Math.round(((i + (stepLog.step / 8)) / documents.length) * 80),
                        apiLogs
                    });
                };

                try {
                    console.log(`${this.timestamp()} 🤖 [WORKER] Calling claudeExtractor for ${docInfo.type}...`);
                    
                    if (docInfo.type === 'balance_sheet') {
                        result = await claudeExtractor.extractBalanceSheet(docBuffer, docInfo.yearLabel || 'FY 2024-25', ocrProgressCallback);
                        
                        // Apply unit conversion if document specifies "amounts in Lakhs/Crores"
                        if (result && result.unit_scale && result.unit_scale !== 'rupees') {
                            console.log(`${this.timestamp()} 📊 [WORKER] Unit conversion: ${result.unit_scale} (multiplier: ${result.unit_multiplier || 'auto'})`);
                            result = claudeExtractor.applyUnitConversion(result, 'balance_sheet');
                        }
                        
                        if (result && result.balance_sheet) {
                            const year = docInfo.year || 'fy25';
                            
                            // POST-EXTRACTION VALIDATION: Total Assets must equal Total Liabilities
                            const bs = result.balance_sheet;
                            if (bs.total_assets && bs.total_liabilities) {
                                const ratio = bs.total_assets / bs.total_liabilities;
                                if (ratio > 1.001 || ratio < 0.999) {
                                    console.log(`${this.timestamp()} ⚠️ [VALIDATION] BS ${year}: Total Assets (${bs.total_assets}) ≠ Total Liabilities (${bs.total_liabilities}), ratio=${ratio.toFixed(4)}`);
                                    // Check if one is ~10x the other (common Indian number misparse)
                                    if (ratio > 9.5 && ratio < 10.5) {
                                        console.log(`${this.timestamp()} 🔧 [VALIDATION] Likely 10x misparse detected - Total Assets is ~10x Total Liabilities`);
                                    } else if (ratio > 0.095 && ratio < 0.105) {
                                        console.log(`${this.timestamp()} 🔧 [VALIDATION] Likely 10x misparse detected - Total Liabilities is ~10x Total Assets`);
                                    }
                                } else {
                                    console.log(`${this.timestamp()} ✅ [VALIDATION] BS ${year}: Total Assets = Total Liabilities (${bs.total_assets})`);
                                }
                            }
                            
                            extractedData.balance_sheet[year] = result.balance_sheet;
                            // Store unit info for reference
                            if (result._unit_conversion) {
                                extractedData.balance_sheet[year]._unit_conversion = result._unit_conversion;
                            }
                            keyValues = {
                                total_assets: result.balance_sheet.total_assets,
                                net_worth: result.balance_sheet.net_worth
                            };
                            console.log(`${this.timestamp()} 💰 [WORKER] Stored BS ${year}: total_assets=${result.balance_sheet.total_assets}`);
                            
                            // Extract company_info from first balance sheet (like client-side)
                            if (!extractedData.company_info) {
                                console.log(`${this.timestamp()} 🏢 [WORKER] Extracting company info...`);
                                try {
                                    extractedData.company_info = await claudeExtractor.extractCompanyInfo(docBuffer);
                                } catch (ciErr) {
                                    console.log(`${this.timestamp()} ⚠️ [WORKER] Company info extraction failed: ${ciErr.message}`);
                                }
                            }
                        }
                    } else if (docInfo.type === 'profit_and_loss') {
                        result = await claudeExtractor.extractProfitAndLoss(docBuffer, docInfo.yearLabel || 'FY 2024-25');
                        
                        // Apply unit conversion if document specifies "amounts in Lakhs/Crores"
                        if (result && result.unit_scale && result.unit_scale !== 'rupees') {
                            console.log(`${this.timestamp()} 📊 [WORKER] Unit conversion: ${result.unit_scale} (multiplier: ${result.unit_multiplier || 'auto'})`);
                            result = claudeExtractor.applyUnitConversion(result, 'profit_and_loss');
                        }
                        
                        if (result && result.profit_and_loss) {
                            const year = docInfo.year || 'fy25';
                            extractedData.profit_and_loss[year] = result.profit_and_loss;
                            // Store unit info for reference
                            if (result._unit_conversion) {
                                extractedData.profit_and_loss[year]._unit_conversion = result._unit_conversion;
                            }
                            keyValues = {
                                revenue: result.profit_and_loss.revenue,
                                pat: result.profit_and_loss.profit_after_tax
                            };
                            console.log(`${this.timestamp()} 💰 [WORKER] Stored P&L ${year}: revenue=${result.profit_and_loss.revenue}`);
                        }
                    } else if (docInfo.type === 'cash_flow') {
                        result = await claudeExtractor.extractCashFlow(docBuffer, docInfo.yearLabel || 'FY 2024-25');
                        
                        // Apply unit conversion if document specifies "amounts in Lakhs/Crores"
                        if (result && result.unit_scale && result.unit_scale !== 'rupees') {
                            console.log(`${this.timestamp()} 📊 [WORKER] Unit conversion for CF: ${result.unit_scale}`);
                            result = claudeExtractor.applyUnitConversion(result, 'cash_flow');
                        }
                        
                        if (result && result.cash_flow) {
                            const year = docInfo.year || 'fy25';
                            if (!extractedData.cash_flow) extractedData.cash_flow = {};
                            extractedData.cash_flow[year] = result.cash_flow;
                            // Store unit info
                            if (result._unit_conversion) {
                                extractedData.cash_flow[year]._unit_conversion = result._unit_conversion;
                            }
                            keyValues = {
                                operating: result.cash_flow.operating_cash_flow,
                                net: result.cash_flow.net_cash_flow
                            };
                            console.log(`${this.timestamp()} 💰 [WORKER] Stored CF ${year}: operating=${result.cash_flow.operating_cash_flow}, net=${result.cash_flow.net_cash_flow}`);
                        }
                    } else if (docInfo.type === 'gst_return') {
                        result = await claudeExtractor.extractGSTReturn(docBuffer, 'Monthly');
                        if (result) {
                            extractedData.gst_returns.push(result);
                            keyValues = {
                                turnover: result.gst_return?.total_turnover || result.total_turnover,
                                tax: result.gst_return?.total_tax_paid || result.total_tax_paid
                            };
                        }
                    } else if (docInfo.type === 'bank_statement') {
                        result = await claudeExtractor.extractBankStatement(docBuffer, 'Monthly');
                        if (result) {
                            extractedData.bank_statements.push(result);
                            keyValues = {
                                closing: result.bank_statement?.closing_balance || result.closing_balance,
                                credits: result.bank_statement?.total_credits || result.total_credits
                            };
                        }
                    } else if (docInfo.type === 'itr') {
                        result = await claudeExtractor.extractITR(docBuffer, 'AY 2024-25');
                        if (result) {
                            // Apply unit conversion for ITR if needed
                            result = claudeExtractor.applyUnitConversion(result, 'itr');
                            extractedData.itr_returns.push(result);
                        }
                    } else if (docInfo.type === 'kyc') {
                        result = await claudeExtractor.extractKYC(docBuffer, doc.name);
                        if (result) {
                            extractedData.kyc[doc.name] = result;
                        }
                    } else if (docInfo.type === 'property') {
                        result = await claudeExtractor.extractProperty(docBuffer, doc.name);
                        if (result) {
                            extractedData.property[doc.name] = result;
                        }
                    } else if (docInfo.type.startsWith('legal-')) {
                        // Legal documents - extract and store for later assessment
                        // Get property info from assessment if available
                        const propertyInfo = job.data.propertyInfo || {};
                        result = await claudeExtractor.extractLegalDocument(docBuffer, docInfo.type, propertyInfo);
                        if (result) {
                            // Initialize legal_documents structure if not exists
                            if (!extractedData.legal_documents) {
                                extractedData.legal_documents = {};
                            }
                            // Store by property ID and document type
                            const propId = docInfo.propertyId || 'prop1';
                            if (!extractedData.legal_documents[propId]) {
                                extractedData.legal_documents[propId] = {};
                            }
                            // Map docType to storage key
                            const legalTypeMap = {
                                'legal-tsr': 'tsr',
                                'legal-ec': 'ec',
                                'legal-opinion': 'legal_opinion',
                                'legal-roc': 'roc',
                                'legal-mutation': 'mutation',
                                'legal-tax': 'tax',
                                'legal-plan': 'building_plan',
                                'legal-oc': 'oc',
                                'legal-na': 'na_conversion',
                                'legal-deed': 'sale_deed',
                                'legal-chain': 'chain_documents',
                                'legal-society': 'society'
                            };
                            const storageKey = legalTypeMap[docInfo.type] || docInfo.type;
                            extractedData.legal_documents[propId][storageKey] = result;
                            
                            keyValues = {
                                doc_type: docInfo.type,
                                has_adverse: result.has_adverse_remarks || result.adverse_entries_count > 0 || false
                            };
                            console.log(`${this.timestamp()} ⚖️ [WORKER] Stored legal doc ${propId}/${storageKey}`);
                        }
                    } else {
                        // Unknown type - try balance sheet extraction
                        console.log(`${this.timestamp()} ⚠️ [WORKER] Unknown doc type, trying balance sheet extraction`);
                        result = await claudeExtractor.extractBalanceSheet(docBuffer, 'FY 2024-25');
                    }

                    const extractionTime = Date.now() - extractionStart;
                    const tokensUsed = result?._tokensUsed || 0;
                    
                    // Update stats
                    apiStats.calls++;
                    apiStats.inputTokens += tokensUsed;
                    apiStats.outputTokens += Math.round(tokensUsed * 0.15); // Estimate output tokens
                    
                    completedDocs.push(doc.id);
                    documentTimings.push({
                        doc: doc.name,
                        time: parseFloat((extractionTime / 1000).toFixed(1)),
                        success: true,
                        tokens: tokensUsed
                    });

                    console.log(`${this.timestamp()} ✅ [WORKER] Document ${docNum}/${documents.length} extracted successfully`);
                    console.log(`${this.timestamp()} ✅ [WORKER] Time: ${(extractionTime/1000).toFixed(2)}s, Tokens: ${tokensUsed}`);

                    // Get OCR pipeline info from result if available
                    const ocrInfo = result?._ocrPipeline || null;
                    
                    // Calculate Vision vs Claude duration
                    const visionDurationMs = ocrInfo?.visionDurationMs || ocrInfo?.totalProcessingTimeMs || 0;
                    const claudeDurationMs = extractionTime - visionDurationMs;
                    
                    if (ocrInfo) {
                        console.log(`${this.timestamp()} 🔍 [OCR] Document type: ${ocrInfo.isScanned ? 'SCANNED' : 'NATIVE'}, Vision: ${(visionDurationMs/1000).toFixed(1)}s, Claude: ${(claudeDurationMs/1000).toFixed(1)}s, Cost: $${ocrInfo.visionCost || 0}`);
                    }

                    // Emit SSE-compatible doc_complete event
                    const tokenUsage = { used: apiStats.inputTokens, limit: 30000 };
                    const inputTokens = tokensUsed;
                    const outputTokens = Math.round(tokensUsed * 0.15);
                    
                    this.emitProgress(assessmentId, {
                        type: 'doc_complete',
                        docNum: docNum,
                        docName: doc.name,
                        duration: parseFloat((extractionTime / 1000).toFixed(1)),
                        // NEW: Separate timing breakdown
                        visionDuration: parseFloat((visionDurationMs / 1000).toFixed(1)),
                        claudeDuration: parseFloat((claudeDurationMs / 1000).toFixed(1)),
                        // NEW: Separate token breakdown
                        inputTokens: inputTokens,
                        outputTokens: outputTokens,
                        tokens: tokensUsed,
                        tokenUsage: tokenUsage,
                        keyValues: keyValues,
                        success: true,
                        status: 'processing',
                        phase: 'extraction',
                        progress: Math.round(((i + 1) / documents.length) * 80),
                        apiLogs,
                        // OCR Pipeline info
                        ocrPipeline: ocrInfo ? {
                            isScanned: ocrInfo.isScanned,
                            contentType: ocrInfo.contentType,
                            ocrConfidence: ocrInfo.ocrConfidence,
                            visionCost: ocrInfo.visionCost,
                            visionDurationMs: visionDurationMs,
                            processingSteps: ocrInfo.processingSteps?.length || 0
                        } : null
                    });

                    // Add colored logs (matching client-side format)
                    addApiLog('api_response', `${(extractionTime/1000).toFixed(1)}s | ${tokensUsed.toLocaleString()} | ${Math.round(tokensUsed * 0.15).toLocaleString()} tokens`);
                    const tokenPct = Math.round((tokenUsage.used / tokenUsage.limit) * 100);
                    addApiLog('rate_limit', `Token usage: ${tokenUsage.used.toLocaleString()} / ${tokenUsage.limit.toLocaleString()} (${tokenPct}%)`);
                    
                    // Add OCR info to logs if available
                    if (ocrInfo) {
                        const ocrStatus = ocrInfo.isScanned ? 'SCANNED' : 'NATIVE';
                        const ocrConf = ocrInfo.ocrConfidence ? ` | OCR: ${ocrInfo.ocrConfidence}%` : '';
                        const visionCost = ocrInfo.visionCost ? ` | Vision: $${ocrInfo.visionCost.toFixed(4)}` : '';
                        addApiLog('ocr_info', `Doc type: ${ocrStatus}${ocrConf}${visionCost}`);
                    }
                    
                    // Add key values log
                    const kvParts = [];
                    Object.keys(keyValues).forEach(k => {
                        if (keyValues[k]) {
                            const v = keyValues[k];
                            if (typeof v === 'number' && v > 1000) {
                                kvParts.push(`${k}: ₹${v.toLocaleString('en-IN')}`);
                            } else if (v) {
                                kvParts.push(`${k}: ${v}`);
                            }
                        }
                    });
                    if (kvParts.length > 0) {
                        addApiLog('field', kvParts.join(' | '));
                    }
                    addApiLog('extraction', 'Complete');

                    // Save checkpoint after each document
                    await this.saveCheckpoint(assessmentId, {
                        completedDocs,
                        extractedData,
                        apiStats,
                        lastUpdated: new Date().toISOString()
                    });
                    console.log(`${this.timestamp()} 💾 [WORKER] Checkpoint saved (${completedDocs.length}/${documents.length})`);

                } catch (extractErr) {
                    const extractionTime = Date.now() - extractionStart;
                    console.error(`${this.timestamp()} ❌ [WORKER] Extraction error: ${extractErr.message}`);
                    
                    documentTimings.push({
                        doc: doc.name,
                        time: parseFloat((extractionTime / 1000).toFixed(1)),
                        success: false,
                        error: extractErr.message
                    });

                    // Check for rate limit
                    if (extractErr.message?.includes('rate') || extractErr.status === 429) {
                        const waitTime = 60;
                        addApiLog('rate_limit', `Rate limited, waiting ${waitTime}s...`);
                        this.emitProgress(assessmentId, {
                            type: 'rate_wait',
                            seconds: waitTime,
                            status: 'processing',
                            phase: 'rate_limited',
                            apiLogs
                        });
                        await this.sleep(waitTime * 1000);
                        i--; // Retry this document
                    } else {
                        addApiLog('api_error', `Extraction failed: ${extractErr.message}`);
                        this.emitProgress(assessmentId, {
                            type: 'doc_error',
                            docNum: docNum,
                            docName: doc.name,
                            error: extractErr.message,
                            apiLogs
                        });
                    }
                }
            }

            // 2.4 RESOLVE PENDING DUPLICATES
            // Some duplicates may have been detected before their source was processed
            if (extractedData._pending_duplicates && extractedData._pending_duplicates.length > 0) {
                console.log(`${this.timestamp()} 🔄 [WORKER] Resolving ${extractedData._pending_duplicates.length} pending duplicate(s)...`);
                for (const pending of extractedData._pending_duplicates) {
                    let sourceData = null;
                    let targetCollection = null;
                    
                    if (pending.type === 'balance_sheet') {
                        sourceData = extractedData.balance_sheet[pending.sourceYear];
                        targetCollection = extractedData.balance_sheet;
                    } else if (pending.type === 'profit_and_loss') {
                        sourceData = extractedData.profit_and_loss[pending.sourceYear];
                        targetCollection = extractedData.profit_and_loss;
                    } else if (pending.type === 'cash_flow') {
                        sourceData = extractedData.cash_flow[pending.sourceYear];
                        targetCollection = extractedData.cash_flow;
                    }
                    
                    if (sourceData && targetCollection && !targetCollection[pending.targetYear]) {
                        console.log(`${this.timestamp()} ✅ [WORKER] Copying ${pending.type} from ${pending.sourceYear} to ${pending.targetYear}`);
                        targetCollection[pending.targetYear] = {
                            ...sourceData,
                            _is_duplicate: true,
                            _duplicate_of: pending.sourceYear,
                            _warning: `This data is from a duplicate upload - same file as ${pending.sourceYear}`
                        };
                    }
                }
                delete extractedData._pending_duplicates; // Clean up
            }

            // 2.5 Aggregate data (like client-side)
            console.log(`${this.timestamp()} 📊 [WORKER] Aggregating GST and Bank data...`);
            if (extractedData.gst_returns && extractedData.gst_returns.length > 0) {
                extractedData.gst_aggregated = claudeExtractor.aggregateGSTData(extractedData.gst_returns);
                console.log(`${this.timestamp()} ✅ [WORKER] GST data aggregated: ${extractedData.gst_returns.length} returns`);
            }
            if (extractedData.bank_statements && extractedData.bank_statements.length > 0) {
                extractedData.bank_aggregated = claudeExtractor.aggregateBankData(extractedData.bank_statements);
                console.log(`${this.timestamp()} ✅ [WORKER] Bank data aggregated: ${extractedData.bank_statements.length} statements`);
            }

            // 2.6 External verification APIs — rebuilt against AFL's real
            // Postman collections (API_Collections.zip), not the earlier
            // generic guess. Only providers that can run unattended are
            // called automatically here:
            //   - Pennant (direct, no Middleware) — needs finReference
            //   - Karza ITR-V (via DataPower)     — needs PAN + ITR ack number
            //   - CIBIL Commercial (via gateway)  — needs borrower name + CIN
            //   - Novel upload (step 1 of 3)      — uses the already-uploaded
            //                                        bank statement file
            // EPFO (OTP-gated), individual CIBIL (SOAP, 2-step), and Novel's
            // autofetch/download steps need a human in the loop (OTP entry,
            // or async polling) and are exposed as on-demand endpoints
            // instead — see /api/external/* routes in server.js.
            console.log(`${this.timestamp()} 🌐 [WORKER] Running automatable external verifications (Pennant/Karza ITR/CIBIL Commercial/Novel upload)...`);
            addApiLog('info', 'Running external verification APIs via Middleware Gateway');

            this.emitProgress(assessmentId, {
                status: 'processing',
                phase: 'external_verification',
                progress: 82,
                message: 'Verifying loan details, ITR, commercial credit score, and uploading bank statements...',
                apiLogs
            });

            // Preserve any data already populated from uploaded documents
            // (e.g. cibil_commercial from an uploaded CIBIL report — see
            // storeExtractedData) rather than wiping it here.
            extractedData.external_verification = {
                ...(extractedData.external_verification || {}),
                fetchedAt: new Date().toISOString()
            };
            const uploadedCibil = extractedData.external_verification.cibil_commercial;

            // Declared here (not inside the if-block below) so it's still
            // accessible later when finalAssessment is built — referencing
            // it out of its original const scope caused every job to crash
            // with "results is not defined" right at the save step.
            let results = {};

            if (externalApisManager || pennantClient) {
                const kyc = extractedData.kyc_documents || extractedData.kyc || extractedData.company_info || {};
                const itrData = extractedData.itr_returns || extractedData.itr_data || null;

                const pan = kyc?.pan_card?.pan_number || kyc?.pan_number || kyc?.pan || null;
                const borrowerName = kyc?.company_name || kyc?.name || companyName || null;
                const cin = kyc?.cin || kyc?.mca_details?.cin || null;
                const ack = itrData?.acknowledgement_number || itrData?.ack || null;
                // No intake field for this exists yet (no UI/API captures it) —
                // Pennant will simply skip until that's added.
                const finReference = job.data.finReference || job.data.fin_reference || null;

                try {
                    if (pennantClient && finReference) {
                        results.pennant = await pennantClient.getLoanDetails({ finReference, assessmentId });
                    } else {
                        results.pennant = { success: false, skipped: true, error: 'finReference not available on this assessment' };
                    }
                } catch (err) {
                    results.pennant = { success: false, error: err.message };
                }

                try {
                    if (externalApisManager && pan && ack) {
                        results.karza_itr = await externalApisManager.verifyITR({ pan, ack, assessmentId });
                    } else {
                        results.karza_itr = { success: false, skipped: true, error: 'PAN or ITR acknowledgment number not available' };
                    }
                } catch (err) {
                    results.karza_itr = { success: false, error: err.message };
                }

                // CIBIL is sourced ONLY from user-uploaded reports now — the
                // live CIBIL Middleware API is never called (per requirement:
                // underwriter uploads the CIBIL report directly instead of the
                // system fetching it live).
                if (uploadedCibil && uploadedCibil.success) {
                    results.cibil_commercial = uploadedCibil;
                    console.log(`${this.timestamp()} 📄 [WORKER] Using uploaded CIBIL report (no API call made): score=${uploadedCibil.cibil_score}`);
                } else {
                    results.cibil_commercial = { success: false, skipped: true, error: 'No CIBIL report uploaded for this assessment' };
                    try {
                        if (this.s3Client && assessmentId) {
                            const key = `assessments/${assessmentId}/api-responses/cibil-commercial.json`;
                            const body = Buffer.from(JSON.stringify({ provider: 'CIBIL', assessmentId, fetchedAt: new Date().toISOString(), ...results.cibil_commercial }, null, 2));
                            await this.s3Client.uploadFile(key, body, 'application/json');
                        }
                    } catch (_) { /* non-fatal — logging only */ }
                }

                try {
                    // Find ALL bank statement documents (not just the first one)
                    const statementDocs = documents.filter(d => {
                        const t = this.parseDocumentId(d.id || d.name)?.type || '';
                        return t.includes('bank_statement');
                    });

                    if (externalApisManager && statementDocs.length > 0) {
                        const novelResults = [];
                        for (const statementDoc of statementDocs) {
                            const fileBuffer = await this.loadDocumentFromS3(statementDoc.s3Key);
                            if (fileBuffer) {
                                const uploadResult = await externalApisManager.novelUploadBankStatement({
                                    fileBuffer,
                                    fileName: statementDoc.name,
                                    assessmentId
                                });
                                novelResults.push({ doc: statementDoc.id || statementDoc.name, ...uploadResult });
                                console.log(`${this.timestamp()} ${uploadResult.success ? '✅' : '❌'} [NOVEL] Upload ${statementDoc.id}: ${uploadResult.success ? 'OK' : uploadResult.error}`);
                                // Small delay between uploads to avoid overwhelming Middleware
                                if (statementDocs.indexOf(statementDoc) < statementDocs.length - 1) {
                                    await this.sleep(2000);
                                }
                            } else {
                                novelResults.push({ doc: statementDoc.id || statementDoc.name, success: false, error: 'Could not load from S3' });
                            }
                        }
                        const anySuccess = novelResults.some(r => r.success);
                        results.novel_upload = {
                            success: anySuccess,
                            total: statementDocs.length,
                            uploaded: novelResults.filter(r => r.success).length,
                            results: novelResults,
                            // Keep first doc_id for downstream steps
                            doc_id: novelResults.find(r => r.doc_id)?.doc_id || null
                        };
                    } else {
                        results.novel_upload = { success: false, skipped: true, error: 'No bank statement document found in this assessment' };
                    }
                } catch (err) {
                    results.novel_upload = { success: false, error: err.message };
                }

                extractedData.external_verification = { ...extractedData.external_verification, ...results };

                const summary = [
                    results.pennant?.success ? 'Pennant✓' : 'Pennant✗',
                    results.karza_itr?.success ? 'ITR✓' : 'ITR✗',
                    results.cibil_commercial?.success ? `CIBIL✓(${results.cibil_commercial.cibil_score ?? 'N/A'})` : 'CIBIL✗',
                    results.novel_upload?.success ? 'Novel✓' : 'Novel✗'
                ].join(' ');
                console.log(`${this.timestamp()} ✅ [WORKER] External verification pass complete: ${summary}`);
                addApiLog('info', `External verification: ${summary} (EPFO/individual-CIBIL/Novel-download require manual trigger via /api/external/*)`);
            } else {
                console.log(`${this.timestamp()} ⚠️ [WORKER] External API clients not available — skipping Pennant/Karza/CIBIL/Novel`);
                extractedData.external_verification.note = 'external-apis-manager / pennant-client module not loaded';
            }

            // 3. Run calculations using calculationEngine (SAME as client-side)
            console.log(`${this.timestamp()} ─────────────────────────────────────────────────────────`);
            console.log(`${this.timestamp()} 🧮 [WORKER] Running financial calculations...`);
            addApiLog('info', 'Running financial calculations');
            
            // Ensure config is loaded
            loadConfig();
            
            this.emitProgress(assessmentId, {
                status: 'processing',
                phase: 'calculations',
                progress: 85,
                message: 'Running financial calculations...',
                apiLogs
            });

            // Use calculationEngine.calculateAll (SAME as client-side)
            let calculations;
            if (calculationEngine) {
                calculations = calculationEngine.calculateAll(extractedData);
                console.log(`${this.timestamp()} ✅ [WORKER] Full calculations complete (using calculationEngine)`);
            } else {
                calculations = this.runCalculations(extractedData);
                console.log(`${this.timestamp()} ⚠️ [WORKER] Basic calculations complete (calculationEngine not available)`);
            }
            addApiLog('success', 'Financial calculations complete');

            // 4. Generate policy compliance using calculationEngine (SAME as client-side)
            console.log(`${this.timestamp()} 📋 [WORKER] Checking policy compliance...`);
            addApiLog('info', 'Checking policy compliance');
            
            this.emitProgress(assessmentId, {
                status: 'processing',
                phase: 'policy_check',
                progress: 90,
                message: 'Checking policy compliance...',
                apiLogs
            });

            // Use calculationEngine.generatePolicyCompliance (SAME as client-side)
            let policyCompliance;
            if (calculationEngine && calculationEngine.generatePolicyCompliance) {
                policyCompliance = calculationEngine.generatePolicyCompliance(calculations);
                console.log(`${this.timestamp()} ✅ [WORKER] Policy compliance generated (using calculationEngine)`);
            } else {
                policyCompliance = this.checkPolicyCompliance(extractedData, calculations);
                console.log(`${this.timestamp()} ⚠️ [WORKER] Basic policy check (calculationEngine not available)`);
            }
            const passCount = policyCompliance.filter(p => p.status === 'pass').length;
            console.log(`${this.timestamp()} ✅ [WORKER] Policy check: ${passCount}/${policyCompliance.length} passed`);
            addApiLog('success', `Policy compliance: ${passCount}/${policyCompliance.length} passed`);

            // 4.5 Legal Risk Assessment (if legal documents present)
            let legalRiskAssessment = null;
            if (extractedData.legal_documents && Object.keys(extractedData.legal_documents).length > 0) {
                console.log(`${this.timestamp()} ⚖️ [WORKER] Running legal risk assessment...`);
                addApiLog('info', 'Running legal risk assessment');
                
                this.emitProgress(assessmentId, {
                    status: 'processing',
                    phase: 'legal_assessment',
                    progress: 88,
                    message: 'Assessing legal/collateral risks...',
                    apiLogs
                });
                
                try {
                    // Load legal risk rules from masters (passed via job data from server.js)
                    const legalRiskRules = job.data.legalRiskRules || [];
                    const stateLegalRules = job.data.stateLegalRules || [];
                    const propertyTypes = job.data.propertyTypes || [];
                    const encumbranceTypes = job.data.encumbranceTypes || [];
                    const propertyInfoMap = job.data.propertyInfoMap || {};
                    
                    // Log masters usage for verification
                    console.log(`📋 Legal Masters for job ${job.id}:`);
                    console.log(`   - Legal Risk Rules: ${legalRiskRules.length} rules loaded`);
                    console.log(`   - State Legal Rules: ${stateLegalRules.length} states loaded`);
                    console.log(`   - Property Types: ${propertyTypes.length} types loaded`);
                    console.log(`   - Encumbrance Types: ${encumbranceTypes.length} types loaded`);
                    console.log(`   - Properties to assess: ${Object.keys(extractedData.legal_documents || {}).length}`);
                    
                    legalRiskAssessment = {
                        assessment_date: new Date().toISOString(),
                        assessed_by: 'Legal/Collateral Agent (Server)',
                        properties: [],
                        summary: {
                            total_properties: 0,
                            high_risk_count: 0,
                            medium_risk_count: 0,
                            low_risk_count: 0,
                            overall_risk_rating: 'Low',
                            overall_enforceability: 'Enforceable',
                            key_findings: [],
                            critical_actions_required: []
                        }
                    };
                    
                    // Process each property's legal documents
                    for (const [propId, legalDocs] of Object.entries(extractedData.legal_documents)) {
                        const propertyInfo = propertyInfoMap[propId] || {
                            property_id: propId,
                            property_address: 'Property ' + propId
                        };
                        
                        // Perform legal risk assessment for this property
                        const propertyAssessment = claudeExtractor.assessLegalRisk(
                            legalDocs,
                            propertyInfo,
                            legalRiskRules,
                            stateLegalRules
                        );
                        
                        legalRiskAssessment.properties.push(propertyAssessment);
                        
                        // Update summary
                        legalRiskAssessment.summary.total_properties++;
                        if (propertyAssessment.risk_rating === 'High') {
                            legalRiskAssessment.summary.high_risk_count++;
                        } else if (propertyAssessment.risk_rating === 'Medium') {
                            legalRiskAssessment.summary.medium_risk_count++;
                        } else {
                            legalRiskAssessment.summary.low_risk_count++;
                        }
                        
                        // Collect key findings
                        if (propertyAssessment.blocking_issues.length > 0) {
                            legalRiskAssessment.summary.key_findings.push(...propertyAssessment.blocking_issues.map(i => `[${propId}] ${i}`));
                        }
                        if (propertyAssessment.recommended_actions.length > 0) {
                            legalRiskAssessment.summary.critical_actions_required.push(...propertyAssessment.recommended_actions.slice(0, 3));
                        }
                    }
                    
                    // Determine overall risk rating
                    if (legalRiskAssessment.summary.high_risk_count > 0) {
                        legalRiskAssessment.summary.overall_risk_rating = 'High';
                        legalRiskAssessment.summary.overall_enforceability = 'Not Enforceable';
                    } else if (legalRiskAssessment.summary.medium_risk_count > 0) {
                        legalRiskAssessment.summary.overall_risk_rating = 'Medium';
                        legalRiskAssessment.summary.overall_enforceability = 'Enforceable with Conditions';
                    }
                    
                    // Store in extracted_data
                    extractedData.legal_risk_assessment = legalRiskAssessment;
                    
                    console.log(`${this.timestamp()} ✅ [WORKER] Legal assessment: ${legalRiskAssessment.summary.total_properties} properties, Overall: ${legalRiskAssessment.summary.overall_risk_rating}`);
                    addApiLog('success', `Legal assessment: ${legalRiskAssessment.summary.overall_risk_rating} risk, ${legalRiskAssessment.summary.overall_enforceability}`);
                    
                } catch (legalErr) {
                    console.error(`${this.timestamp()} ⚠️ [WORKER] Legal assessment error: ${legalErr.message}`);
                    addApiLog('warning', `Legal assessment failed: ${legalErr.message}`);
                }
            } else {
                console.log(`${this.timestamp()} ℹ️ [WORKER] No legal documents - skipping legal risk assessment`);
            }

            // 5. Calculate recommended limits (SAME as client-side)
            console.log(`${this.timestamp()} 💰 [WORKER] Calculating recommended limits...`);
            addApiLog('info', 'Calculating recommended limits');
            
            const bsLatest = extractedData.balance_sheet?.fy25 || extractedData.balance_sheet?.fy24 || {};
            const pnlLatest = extractedData.profit_and_loss?.fy25 || extractedData.profit_and_loss?.fy24 || {};
            
            let recommendedLimits = null;
            if (calculationEngine && calculationEngine.calculateLimits) {
                recommendedLimits = calculationEngine.calculateLimits(bsLatest, pnlLatest, loanAmount);
                console.log(`${this.timestamp()} ✅ [WORKER] Limits calculated: WC=${recommendedLimits.working_capital?.formatted}, TL=${recommendedLimits.term_loan?.formatted}, OD=${recommendedLimits.overdraft?.formatted}`);
                addApiLog('success', `Limits: WC=${recommendedLimits.working_capital?.formatted}, TL=${recommendedLimits.term_loan?.formatted}`);
            } else {
                console.log(`${this.timestamp()} ⚠️ [WORKER] Limits not calculated (calculationEngine not available)`);
            }

            // 6. Credit scoring using calculationEngine
            console.log(`${this.timestamp()} 📊 [WORKER] Calculating credit score...`);
            addApiLog('info', 'Calculating credit score');
            
            this.emitProgress(assessmentId, {
                status: 'processing',
                phase: 'scoring',
                progress: 95,
                message: 'Calculating credit score...',
                apiLogs
            });

            // Use credit_score from calculations if available (SAME as client-side)
            let creditScore;
            if (calculations.credit_score) {
                creditScore = calculations.credit_score;
                console.log(`${this.timestamp()} ✅ [WORKER] Credit score from calculations: ${creditScore.total} (${creditScore.grade})`);
            } else {
                creditScore = this.calculateCreditScore(extractedData, calculations, policyCompliance);
                console.log(`${this.timestamp()} ⚠️ [WORKER] Basic credit score: ${creditScore.total} (${creditScore.grade})`);
            }
            addApiLog('success', `Credit score calculated: ${creditScore.total} (${creditScore.grade})`);

            // 7. Determine final status
            const status = this.determineStatus(creditScore, policyCompliance);
            console.log(`${this.timestamp()} 📋 [WORKER] Assessment status: ${status}`);
            addApiLog('success', `Assessment decision: ${status}`);
            
            // Log duplicate warnings if any
            if (duplicateWarnings.length > 0) {
                console.log(`${this.timestamp()} ⚠️ [WORKER] ${duplicateWarnings.length} duplicate document(s) detected`);
                addApiLog('warning', `DUPLICATE DOCUMENTS DETECTED: ${duplicateWarnings.length} file(s) were uploaded multiple times with different year tags`);
                for (const dw of duplicateWarnings) {
                    addApiLog('warning', `  - ${dw.duplicate} (${dw.duplicateYear}) is same as ${dw.original} (${dw.originalYear})`);
                }
            }

            // 8. Save final assessment (include recommended_limits like client-side)
            const totalTime = Date.now() - startTime;
            const finalAssessment = {
                assessment_id: assessmentId,
                company_name: companyName,
                loan_amount_lakhs: loanAmount,
                industry_type: industryType || null,
                type: 'actual',
                created_by: userId,
                created_by_name: job.data.created_by_name || userId,
                created_at: job.data.createdAt || new Date().toISOString(),
                status,
                score: creditScore.total,
                grade: creditScore.grade,
                extracted_data: extractedData,
                all_extracted_data: extractedData,
                calculations,
                credit_score: creditScore,
                policy_compliance: policyCompliance,
                recommended_limits: recommendedLimits,
                legal_risk_assessment: legalRiskAssessment,
                // Pennant / LOS data — used by CAM report template (Part A/B)
                pennant_data: results?.pennant?.success ? results.pennant : (job.data.pennantData || null),
                // External API results for audit and downstream use
                external_api_results: {
                    pennant:          results?.pennant          || null,
                    karza_itr:        results?.karza_itr        || null,
                    cibil_commercial: results?.cibil_commercial || null,
                    novel_upload:     results?.novel_upload     || null,
                },
                api_stats: apiStats,
                api_logs: apiLogs,
                document_timings: documentTimings,
                document_count: documents.length,
                processing_time: totalTime,
                completed_at: new Date().toISOString(),
                processed_by: 'server',
                duplicate_warnings: duplicateWarnings.length > 0 ? duplicateWarnings : undefined,
                data_quality_issues: this.checkDataQuality(extractedData, duplicateWarnings)
            };

            await this.saveAssessment(assessmentId, finalAssessment);
            console.log(`${this.timestamp()} 💾 [WORKER] Assessment saved to S3`);

            // 9. Delete checkpoint (no longer needed)
            await this.deleteCheckpoint(assessmentId);

            // 10. Emit completion
            this.emitProgress(assessmentId, {
                status: 'complete',
                phase: 'done',
                progress: 100,
                message: 'Assessment complete!',
                result: {
                    status,
                    score: creditScore.total,
                    grade: creditScore.grade
                },
                apiLogs
            });

            // Remove from active jobs and Redis progress
            this.activeJobs.delete(assessmentId);
            await this.clearProgressFromRedis(assessmentId);

            console.log(`${this.timestamp()} ═══════════════════════════════════════════════════════════`);
            console.log(`${this.timestamp()} ✅ [WORKER] JOB COMPLETE`);
            console.log(`${this.timestamp()} 📋 [WORKER] Assessment: ${assessmentId}`);
            console.log(`${this.timestamp()} 🏢 [WORKER] Company: ${companyName}`);
            console.log(`${this.timestamp()} 📊 [WORKER] Result: ${status} (Score: ${creditScore.total}, Grade: ${creditScore.grade})`);
            console.log(`${this.timestamp()} ⏱️  [WORKER] Total time: ${(totalTime/1000).toFixed(1)}s`);
            console.log(`${this.timestamp()} 🤖 [WORKER] API calls: ${apiStats.calls}, Tokens: ${apiStats.inputTokens + apiStats.outputTokens}`);
            console.log(`${this.timestamp()} ═══════════════════════════════════════════════════════════`);

            return { success: true, status, score: creditScore.total, grade: creditScore.grade };

        } catch (err) {
            console.error(`${this.timestamp()} ═══════════════════════════════════════════════════════════`);
            console.error(`${this.timestamp()} ❌ [WORKER] JOB FAILED`);
            console.error(`${this.timestamp()} 📋 [WORKER] Assessment: ${assessmentId}`);
            console.error(`${this.timestamp()} ❌ [WORKER] Error: ${err.message}`);
            console.error(`${this.timestamp()} ═══════════════════════════════════════════════════════════`);

            addApiLog('error', `Job failed: ${err.message}`);

            this.activeJobs.delete(assessmentId);
            await this.clearProgressFromRedis(assessmentId);

            this.emitProgress(assessmentId, {
                status: 'failed',
                phase: 'error',
                progress: 0,
                message: err.message,
                error: err.message,
                apiLogs
            });

            throw err;
        }
    }

    /**
     * Load document from S3
     */
    async loadDocumentFromS3(s3Key) {
        if (!this.s3Client || !s3Key) return null;

        try {
            // s3Client exports getFile, not getObject
            const data = await this.s3Client.getFile(s3Key);
            return data;
        } catch (err) {
            console.error(`${this.timestamp()} ❌ [WORKER] S3 load error:`, err.message);
            return null;
        }
    }

    /**
     * Infer document type from filename
     */
    inferDocType(filename) {
        const lower = filename.toLowerCase();
        if (lower.includes('balance') || lower.includes('bs')) return 'balance_sheet';
        if (lower.includes('profit') || lower.includes('loss') || lower.includes('pl') || lower.includes('p&l') || lower.includes('pnl')) return 'profit_and_loss';
        if (lower.includes('gst')) return 'gst_return';
        if (lower.includes('bank')) return 'bank_statement';
        if (lower.includes('itr')) return 'itr';
        if (lower.includes('cash') && lower.includes('flow')) return 'cash_flow';
        return 'balance_sheet'; // Default
    }

    /**
     * Merge extracted data intelligently
     * IMPORTANT: New schema has data inside a nested object like { balance_sheet: {...} }
     * Frontend expects flat structure: extracted_data.balance_sheet.fy25 = { total_assets, net_worth, ... }
     */
    mergeExtractedData(existing, newData, docType) {
        const merged = { ...existing };

        // Organize by document type and financial year
        const fy = newData.financial_year || newData.assessment_year || newData.period || 'unknown';
        
        // Normalize document type to use underscores
        let type = newData.document_type || docType || 'unknown';
        // Convert balance-sheet to balance_sheet, etc.
        type = type.toLowerCase().replace(/-/g, '_');
        // Map common variations
        if (type === 'pnl' || type === 'p&l' || type === 'pandl') type = 'profit_and_loss';
        if (type === 'bs') type = 'balance_sheet';
        if (type === 'gst' || type === 'gst_return') type = 'gst_return';
        if (type === 'cf' || type === 'cashflow') type = 'cash_flow';

        if (!merged[type]) merged[type] = {};
        
        // Store by FY (normalize FY key)
        const fyKey = fy.toLowerCase().replace(/[^a-z0-9]/g, '');
        
        // Extract the inner data object - new schema has data inside type-specific object
        // e.g., { balance_sheet: { total_assets, net_worth, ... } }
        // We want to store JUST the inner object, not the whole Claude response
        let dataToStore = newData;
        
        // Check if the data has a type-specific inner object
        if (newData[type] && typeof newData[type] === 'object') {
            // New schema - extract inner object and add metadata
            dataToStore = {
                ...newData[type],
                financial_year: fy,
                extraction_confidence: newData.extraction_confidence || 'unknown',
                notes: newData.notes || ''
            };
            console.log(`${this.timestamp()} 📦 [WORKER] Extracted inner ${type} object with ${Object.keys(newData[type]).length} fields`);
        } else {
            // Legacy schema or direct data - use as-is but log warning
            console.log(`${this.timestamp()} ⚠️ [WORKER] No inner ${type} object found, using raw data`);
        }
        
        merged[type][fyKey] = dataToStore;

        // Log key values for debugging
        if (type === 'balance_sheet' && dataToStore.total_assets) {
            console.log(`${this.timestamp()} 💰 [WORKER] BS ${fyKey}: total_assets=${dataToStore.total_assets}, net_worth=${dataToStore.net_worth}`);
        } else if (type === 'profit_and_loss' && dataToStore.revenue) {
            console.log(`${this.timestamp()} 💰 [WORKER] P&L ${fyKey}: revenue=${dataToStore.revenue}, pat=${dataToStore.profit_after_tax}`);
        }

        console.log(`${this.timestamp()} 📦 [WORKER] Merged data: type=${type}, fy=${fyKey}`);

        return merged;
    }

    /**
     * Run financial calculations
     */
    runCalculations(extractedData) {
        // Use existing calculation engine if available
        try {
            const calculationEngine = require('./calculation-engine');
            return calculationEngine.calculateAll(extractedData);
        } catch (err) {
            console.log(`${this.timestamp()} [WORKER] Using basic calculations (engine not available)`);
            return this.basicCalculations(extractedData);
        }
    }

    /**
     * Basic calculations fallback
     * Uses FLAT structure: data.balance_sheet.fy25 = { total_assets, net_worth, current_assets, ... }
     */
    basicCalculations(data) {
        // Get most recent balance sheet (try FY25, then FY24, then any available year)
        const bsYears = Object.keys(data.balance_sheet || {}).sort().reverse();
        const plYears = Object.keys(data.profit_and_loss || {}).sort().reverse();
        
        const bs = bsYears.length > 0 ? data.balance_sheet[bsYears[0]] : {};
        const pl = plYears.length > 0 ? data.profit_and_loss[plYears[0]] : {};

        // FLAT structure - values are directly on the object
        const currentAssets = bs.current_assets || 0;
        // For current liabilities, we might need to estimate from total_liabilities - net_worth
        const totalLiabilities = bs.total_liabilities || bs.total_assets || 0;
        const netWorth = bs.net_worth || 0;
        const currentLiabilities = (bs.trade_payables || 0) + (bs.other_current_liabilities || 0) + (bs.short_term_borrowings || 0);
        const nonCurrentLiabilities = totalLiabilities - netWorth - currentLiabilities;
        
        const longTermBorrowings = bs.long_term_borrowings || 0;
        const shortTermBorrowings = bs.short_term_borrowings || 0;
        const totalDebt = longTermBorrowings + shortTermBorrowings;
        const equity = netWorth || 1;
        
        const pat = pl.profit_after_tax || 0;
        const revenue = pl.revenue || pl.total_revenue || 1;
        const ebitda = pl.ebitda || 0;
        const interestExpense = pl.interest_expense || 0;

        console.log(`${this.timestamp()} 📊 [CALC] BS: currentAssets=${currentAssets}, currentLiab=${currentLiabilities}, netWorth=${netWorth}`);
        console.log(`${this.timestamp()} 📊 [CALC] P&L: revenue=${revenue}, pat=${pat}, ebitda=${ebitda}`);

        // Calculate ratios
        const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : 0;
        const debtEquityRatio = equity > 0 ? totalDebt / equity : 0;
        const netProfitMargin = revenue > 0 ? (pat / revenue) * 100 : 0;
        const returnOnEquity = equity > 0 ? (pat / equity) * 100 : 0;
        const interestCoverageRatio = interestExpense > 0 ? ebitda / interestExpense : 0;

        return {
            current_ratio: parseFloat(currentRatio.toFixed(2)),
            debt_equity_ratio: parseFloat(debtEquityRatio.toFixed(2)),
            net_profit_margin: parseFloat(netProfitMargin.toFixed(2)),
            return_on_equity: parseFloat(returnOnEquity.toFixed(2)),
            interest_coverage_ratio: parseFloat(interestCoverageRatio.toFixed(2)),
            // Additional useful metrics
            total_debt: totalDebt,
            net_worth: netWorth,
            revenue: revenue,
            pat: pat,
            ebitda: ebitda
        };
    }

    /**
     * Check policy compliance
     */
    checkPolicyCompliance(extractedData, calculations) {
        const compliance = [];
        
        // Current Ratio check
        if (calculations.current_ratio !== undefined) {
            compliance.push({
                param: 'Current Ratio',
                rule: 'Current Ratio >= 1.20',
                actual: calculations.current_ratio?.toFixed(2),
                norm: '≥ 1.20',
                status: calculations.current_ratio >= 1.20 ? 'pass' : 'fail'
            });
        }

        // Debt-Equity Ratio check
        if (calculations.debt_equity_ratio !== undefined) {
            compliance.push({
                param: 'Debt-Equity Ratio',
                rule: 'Debt-Equity Ratio <= 2.00',
                actual: calculations.debt_equity_ratio?.toFixed(2),
                norm: '≤ 2.00',
                status: calculations.debt_equity_ratio <= 2.00 ? 'pass' : 'fail'
            });
        }

        // Net Profit Margin check
        if (calculations.net_profit_margin !== undefined) {
            compliance.push({
                param: 'Net Profit Margin',
                rule: 'Net Profit Margin >= 5%',
                actual: calculations.net_profit_margin?.toFixed(2) + '%',
                norm: '≥ 5%',
                status: calculations.net_profit_margin >= 5 ? 'pass' : 'fail'
            });
        }

        return compliance;
    }

    /**
     * Calculate credit score
     */
    calculateCreditScore(extractedData, calculations, policyCompliance) {
        let score = 50; // Base score

        // Add points for good ratios
        if (calculations.current_ratio >= 1.5) score += 15;
        else if (calculations.current_ratio >= 1.2) score += 10;

        if (calculations.debt_equity_ratio <= 1.0) score += 15;
        else if (calculations.debt_equity_ratio <= 2.0) score += 10;

        if (calculations.net_profit_margin > 10) score += 10;
        else if (calculations.net_profit_margin > 5) score += 5;

        // Deduct for policy failures
        const failures = policyCompliance.filter(p => p.status === 'fail').length;
        score -= failures * 5;

        score = Math.max(0, Math.min(100, score)); // Clamp 0-100

        // Determine grade
        let grade = 'D';
        if (score >= 80) grade = 'A';
        else if (score >= 65) grade = 'B';
        else if (score >= 50) grade = 'C';

        return {
            total: Math.round(score),
            grade,
            components: {
                financial_strength: Math.round(score * 0.4),
                business_stability: Math.round(score * 0.3),
                compliance: Math.round(score * 0.3)
            }
        };
    }

    /**
     * Determine assessment status
     */
    determineStatus(creditScore, policyCompliance) {
        // Handle both formats:
        // Old: { rule: 'Current Ratio >= 1.20', status: 'fail' }
        // New: { param: 'Current Ratio', norm: '≥ 1.20', status: 'fail' }
        const criticalFailures = policyCompliance.filter(p => {
            if (p.status !== 'fail') return false;
            // Check if it's a "greater than or equal" rule (critical for minimums)
            const ruleText = p.rule || p.norm || '';
            return ruleText.includes('>=') || ruleText.includes('≥');
        }).length;

        if (creditScore.grade === 'A' && criticalFailures === 0) return 'Approved';
        if (creditScore.grade === 'D' || criticalFailures >= 3) return 'Rejected';
        if (creditScore.grade === 'B' && criticalFailures <= 1) return 'Approved';
        return 'Partial Approval';
    }

    /**
     * Check data quality and return issues
     */
    checkDataQuality(extractedData, duplicateWarnings = []) {
        const issues = [];
        
        // Check for duplicate warnings
        if (duplicateWarnings.length > 0) {
            issues.push(`${duplicateWarnings.length} duplicate document(s) detected - same files uploaded with different year tags`);
        }
        
        // Check Balance Sheet for identical values across years
        if (extractedData.balance_sheet) {
            const bsYears = Object.keys(extractedData.balance_sheet).filter(y => !y.startsWith('_')).sort();
            if (bsYears.length > 1) {
                const firstYear = bsYears[0];
                const firstAssets = extractedData.balance_sheet[firstYear]?.total_assets;
                
                if (firstAssets && firstAssets > 0) {
                    const allSame = bsYears.every(y => 
                        extractedData.balance_sheet[y]?.total_assets === firstAssets &&
                        !extractedData.balance_sheet[y]?._is_duplicate
                    );
                    
                    if (allSame) {
                        issues.push(`Balance Sheet: All ${bsYears.length} years show identical Total Assets (₹${firstAssets.toLocaleString('en-IN')}). This may indicate data extraction from same document.`);
                    }
                }
            }
        }
        
        // Check P&L for identical values across years
        if (extractedData.profit_and_loss) {
            const pnlYears = Object.keys(extractedData.profit_and_loss).filter(y => !y.startsWith('_')).sort();
            if (pnlYears.length > 1) {
                const firstYear = pnlYears[0];
                const firstRevenue = extractedData.profit_and_loss[firstYear]?.revenue;
                
                if (firstRevenue && firstRevenue > 0) {
                    const allSame = pnlYears.every(y => 
                        extractedData.profit_and_loss[y]?.revenue === firstRevenue &&
                        !extractedData.profit_and_loss[y]?._is_duplicate
                    );
                    
                    if (allSame) {
                        issues.push(`P&L Statement: All ${pnlYears.length} years show identical Revenue (₹${firstRevenue.toLocaleString('en-IN')}). This may indicate data extraction from same document.`);
                    }
                }
            }
        }
        
        // Mark duplicates in the data itself
        for (const section of ['balance_sheet', 'profit_and_loss', 'cash_flow']) {
            if (extractedData[section]) {
                const years = Object.keys(extractedData[section]).filter(y => !y.startsWith('_')).sort();
                for (const year of years) {
                    if (extractedData[section][year]?._is_duplicate) {
                        const dupOf = extractedData[section][year]._duplicate_of;
                        issues.push(`${section.replace(/_/g, ' ')} ${year.toUpperCase()}: Duplicate of ${dupOf.toUpperCase()}`);
                    }
                }
            }
        }
        
        return issues.length > 0 ? issues : undefined;
    }

    /**
     * Save checkpoint to S3
     */
    async saveCheckpoint(assessmentId, data) {
        if (!this.s3Client) return;

        try {
            const key = `checkpoints/${assessmentId}.json`;
            const buffer = Buffer.from(JSON.stringify(data));
            await this.s3Client.uploadFile(key, buffer, 'application/json');
        } catch (err) {
            console.error(`${this.timestamp()} ❌ [WORKER] Checkpoint save error:`, err.message);
        }
    }

    /**
     * Load checkpoint from S3
     */
    async loadCheckpoint(assessmentId) {
        if (!this.s3Client) return null;

        try {
            const key = `checkpoints/${assessmentId}.json`;
            const data = await this.s3Client.getFile(key);
            return JSON.parse(data.toString());
        } catch (err) {
            // Checkpoint doesn't exist - that's OK
            return null;
        }
    }

    /**
     * Delete checkpoint from S3
     * Note: S3 client doesn't have delete method, checkpoint will remain
     * but will be overwritten on next run
     */
    async deleteCheckpoint(assessmentId) {
        // No-op: S3 client doesn't expose delete functionality
        // Checkpoints will be overwritten on next processing
        console.log(`${this.timestamp()} 🗑️ [WORKER] Checkpoint cleanup skipped (will be overwritten)`);
    }

    /**
     * Save assessment to memory and S3
     */
    async saveAssessment(assessmentId, assessment) {
        // Update in-memory
        if (this.assessments) {
            this.assessments.set(assessmentId, assessment);
        }

        // Update assessments list
        if (this.assessmentsList) {
            const idx = this.assessmentsList.findIndex(a => 
                (a.assessment_id || a.id) === assessmentId
            );
            if (idx >= 0) {
                this.assessmentsList[idx].status = assessment.status;
                this.assessmentsList[idx].score = assessment.score;
                this.assessmentsList[idx].grade = assessment.grade;
                this.assessmentsList[idx].completed_at = assessment.completed_at;
            }
        }
        
        // Remove from job queue so dashboard shows correct status
        if (this.jobQueue) {
            this.jobQueue.completeJob(assessmentId, { status: assessment.status });
            console.log(`${this.timestamp()} ✅ [WORKER] Removed ${assessmentId} from job queue`);
        }

        // Save to S3
        if (this.s3Client) {
            try {
                await this.s3Client.saveAssessment(assessmentId, assessment);
                console.log(`${this.timestamp()} 💾 [WORKER] Assessment ${assessmentId} saved to S3`);
            } catch (err) {
                console.error(`${this.timestamp()} ❌ [WORKER] S3 save error:`, err.message);
            }
        }
    }

    /**
     * Emit progress via WebSocket AND store in Redis (single source of truth)
     */
    async emitProgress(assessmentId, data) {
        // 1. STORE IN REDIS - This is the single source of truth
        // Use this.redisClient (actual Redis client) instead of this.connection (config object)
        if (this.redisClient && data.phase !== 'done' && data.status !== 'complete') {
            try {
                const progressData = {
                    assessmentId,
                    progress: String(data.progress || 0),
                    phase: data.phase || 'processing',
                    message: data.message || '',
                    currentDocument: data.currentDocument || '',
                    docsCompleted: String(data.docsCompleted || 0),
                    docsTotal: String(data.docsTotal || 0),
                    company: data.company || this.activeJobs.get(assessmentId)?.company || '',
                    startTime: this.activeJobs.get(assessmentId)?.startTime || new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                // hset requires flat key-value pairs, use hmset for objects
                await this.redisClient.hmset(`progress:${assessmentId}`, progressData);
                // Set expiry of 1 hour (progress data is temporary)
                await this.redisClient.expire(`progress:${assessmentId}`, 3600);
            } catch (err) {
                console.error(`${this.timestamp()} ⚠️ [REDIS] Could not store progress: ${err.message}`);
            }
        }
        
        // 2. Update in-memory activeJobs map (for backward compatibility)
        if (data.phase !== 'done' && data.status !== 'complete') {
            const existing = this.activeJobs.get(assessmentId) || {};
            this.activeJobs.set(assessmentId, {
                ...existing,
                company: data.company || existing.company,
                progress: data.progress || 0,
                phase: data.phase,
                currentDocument: data.currentDocument,
                docsCompleted: data.docsCompleted,
                updatedAt: new Date().toISOString()
            });
        }
        
        // 3. Emit via WebSocket for real-time UI updates
        if (this.socketManager) {
            console.log(`${this.timestamp()} 📡 [SOCKET] Emitting progress to ${assessmentId}: ${data.progress}% - ${data.phase}`);
            this.socketManager.emitToAssessment(assessmentId, 'progress', data);
        }
        
        // 4. Also update in-memory job queue for polling fallback
        if (this.jobQueue && data.phase !== 'done' && data.status !== 'complete') {
            this.jobQueue.updateProgress(assessmentId, {
                progress: data.progress,
                phase: data.phase,
                docsCompleted: data.docsCompleted,
                message: data.message,
                currentDocument: data.currentDocument
            });
        }
    }
    
    /**
     * Get progress from Redis (single source of truth)
     */
    async getProgressFromRedis(assessmentId) {
        if (!this.redisClient) return null;
        try {
            const data = await this.redisClient.hgetall(`progress:${assessmentId}`);
            if (data && Object.keys(data).length > 0) {
                return {
                    assessmentId: data.assessmentId || assessmentId,
                    status: 'processing',
                    progress: parseInt(data.progress) || 0,
                    phase: data.phase || 'processing',
                    message: data.message || '',
                    currentDocument: data.currentDocument || '',
                    docsCompleted: parseInt(data.docsCompleted) || 0,
                    docsTotal: parseInt(data.docsTotal) || 0,
                    company: data.company || '',
                    startTime: data.startTime,
                    updatedAt: data.updatedAt
                };
            }
            return null;
        } catch (err) {
            console.error(`${this.timestamp()} ⚠️ [REDIS] Could not get progress: ${err.message}`);
            return null;
        }
    }
    
    /**
     * Clear progress from Redis (called when job completes)
     */
    async clearProgressFromRedis(assessmentId) {
        if (!this.redisClient) return;
        try {
            await this.redisClient.del(`progress:${assessmentId}`);
            console.log(`${this.timestamp()} 🗑️ [REDIS] Cleared progress for ${assessmentId}`);
        } catch (err) {
            console.error(`${this.timestamp()} ⚠️ [REDIS] Could not clear progress: ${err.message}`);
        }
    }
    
    /**
     * Get all active progress from Redis
     */
    async getAllProgressFromRedis() {
        if (!this.redisClient) return [];
        try {
            // Get all progress keys
            const keys = await this.redisClient.keys('progress:*');
            if (keys.length === 0) return [];
            
            const results = [];
            for (const key of keys) {
                const data = await this.redisClient.hgetall(key);
                if (data && Object.keys(data).length > 0) {
                    results.push({
                        assessmentId: data.assessmentId || key.replace('progress:', ''),
                        progress: parseInt(data.progress) || 0,
                        phase: data.phase || 'processing',
                        message: data.message || '',
                        currentDocument: data.currentDocument || '',
                        company: data.company || '',
                        startTime: data.startTime,
                        updatedAt: data.updatedAt
                    });
                }
            }
            return results;
        } catch (err) {
            console.error(`${this.timestamp()} ⚠️ [REDIS] Could not get all progress: ${err.message}`);
            return [];
        }
    }

    /**
     * Set up queue event listeners
     */
    setupEventListeners() {
        this.queueEvents.on('completed', ({ jobId, returnvalue }) => {
            console.log(`${this.timestamp()} 📬 [QUEUE] Job ${jobId} completed event received`);
        });

        this.queueEvents.on('failed', ({ jobId, failedReason }) => {
            console.error(`${this.timestamp()} 📬 [QUEUE] Job ${jobId} failed event:`, failedReason);
        });

        this.queueEvents.on('progress', ({ jobId, data }) => {
            // Progress updates handled by worker
        });

        this.queueEvents.on('waiting', ({ jobId }) => {
            console.log(`${this.timestamp()} 📬 [QUEUE] Job ${jobId} waiting in queue`);
        });

        this.queueEvents.on('active', ({ jobId, prev }) => {
            console.log(`${this.timestamp()} 📬 [QUEUE] Job ${jobId} became active (was: ${prev})`);
        });
    }

    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Graceful shutdown
     */
    async shutdown() {
        console.log(`${this.timestamp()} 🛑 [QUEUE] Shutting down BullMQ...`);
        
        if (this.worker) {
            await this.worker.close();
        }
        if (this.queueEvents) {
            await this.queueEvents.close();
        }
        if (this.queue) {
            await this.queue.close();
        }
        
        console.log(`${this.timestamp()} ✅ [QUEUE] BullMQ shutdown complete`);
    }
}

module.exports = new BullQueueManager();
