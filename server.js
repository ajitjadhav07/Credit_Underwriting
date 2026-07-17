/**
 * ACC Agentic Underwriting Platform - Server
 * 
 * VERSION: 7.1.0-SERVER-SIDE-PROCESSING
 * DEPLOYED: January 2, 2025
 * 
 * Features:
 * - Comprehensive 524 Parameter Tracking ✅
 * - 44 Document Tracking ✅
 * - 14 Category Breakdown ✅
 * - Data Quality Scoring ✅
 * - Mapped Data Tab with All Parameters ✅
 * - Export PDF Functionality ✅
 * - User Dropdown Menu ✅
 * - Case ID Filter ✅
 * - Masters Management (21 types) ✅
 * - AML Screening Engine ✅
 * - Investigation & Fraud Database ✅
 * - Blacklist Checking ✅
 * - Server-Side Processing with BullMQ ✅ (NEW)
 * - Real-time WebSocket Updates ✅ (NEW)
 * - Checkpoint Recovery ✅ (NEW)
 * 
 * Status: Production Ready - All Features Working
 */

require('dotenv').config();

// AFL internal API hosts use private TLS certificates issued to hostnames
// (e.g. afloasuatweb.axisb.com), not to their IP addresses. Since we connect
// via IP directly (to bypass VPC DNS resolution failure), Node/undici rejects
// the cert because the IP doesn't match the hostname on the cert.
// Setting this before any require() ensures ALL fetch() calls (via undici)
// skip cert validation. Safe because ALL AFL IPs (10.0.252.13, 192.168.x.x)
// are confirmed internal private-network hosts — traffic never leaves AFL's
// private network. Remove this once AFL provides Route53 Private Hosted Zone
// DNS records so we can connect via hostname instead of IP.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '1') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const express = require('express');
const fs = require('fs'); // File system operations
const http = require('http'); // NEW: For Socket.io
const multer = require('multer');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet'); // Security headers
const rateLimit = require('express-rate-limit'); // Rate limiting
const { passport, ensureAuthenticated, ensureNotAuthenticated, requireRole, ensureNotReadOnly, ROLES } = require('./lib/auth-config');

// Import modules
const s3Client = require('./lib/s3-client');
const claudeExtractor = require('./lib/claude-extractor');
// REMOVED: const ratioCalculator = require('./lib/ratio-calculator'); // Dead code - calculation-engine.js handles everything
// REMOVED: const dummyGenerator = require('./lib/dummy-generator'); // Legacy demo code - removed for production
const calculationEngine = require('./lib/calculation-engine');
const { createEngine } = require('./lib/calculation-engine');
// REMOVED: const demoSeeder = require('./lib/demo-seeder'); // Legacy demo seeder - removed for production
const userManager = require('./lib/user-manager');
// REMOVED: const fieldMapper = require('./lib/field-mapper'); // Dead code - comprehensive-field-mapper.js handles everything
const comprehensiveMapper = require('./lib/comprehensive-field-mapper');
const mastersManager = require('./lib/masters-manager');
const amlScreening = require('./lib/aml-screening-manager');
const investigationManager = require('./lib/investigation-fraud-manager');
const JobQueue = require('./lib/job-queue');

// NEW: Server-side processing modules
const socketManager = require('./lib/socket-manager');
const bullQueue = require('./lib/bull-queue');
const claudeProcessor = require('./lib/claude-processor');
let externalApisManager = null;
try { externalApisManager = require('./lib/external-apis-manager'); } catch (e) { console.log('[SERVER] external-apis-manager not available:', e.message); }
let pennantClient = null;
try { pennantClient = require('./lib/pennant-client'); } catch (e) { console.log('[SERVER] pennant-client not available:', e.message); }
let cibilSoapClient = null;
try { cibilSoapClient = require('./lib/cibil-soap-client'); } catch (e) { console.log('[SERVER] cibil-soap-client not available:', e.message); }

// NEW: PII-safe logging modules
const { maskPII, maskObject, maskIP, detectPII, createSafeLogEntry } = require('./lib/pii-handler');
const { SecurityLogger, createAccessLogMiddleware, createPIIAccessMiddleware, createErrorLogMiddleware, LOG_LEVELS } = require('./lib/security-logger');

// NEW: SIEM / Centralized Logging modules
const { CentralizedLogger, correlationMiddleware, accessLogMiddleware, sessionTrackingMiddleware } = require('./lib/centralized-logger');
const { SIEMStorage } = require('./lib/siem-storage');
const { createSIEMRouter } = require('./lib/siem-api');

const app = express();
const server = http.createServer(app); // NEW: HTTP server for Socket.io
const PORT = process.env.PORT || 3000;

// Trust proxy - CRITICAL for Render.com (behind reverse proxy)
app.set('trust proxy', 1);

// Security Headers - Helmet middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],  // Allow inline scripts
            scriptSrcAttr: ["'unsafe-inline'"],  // Allow onclick, onchange, etc. event handlers
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:", "https:"],
            connectSrc: [
                "'self'", 
                "wss:", 
                "ws:",  // WebSocket for Socket.io
                "https://*.amazonaws.com"
            ],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
        }
    },
    crossOriginEmbedderPolicy: false, // Required for some external resources
    crossOriginResourcePolicy: { policy: "cross-origin" } // Required for S3 resources
}));
console.log('✓ Helmet security headers enabled');

// Rate Limiting - Prevent brute force and DoS attacks
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    skip: (req) => {
        // Skip rate limiting for health checks
        return req.path === '/api/health' || req.path === '/health';
    }
});

// Stricter rate limit for authentication endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // Limit each IP to 20 auth attempts per windowMs
    message: { error: 'Too many login attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

// Apply rate limiting to API routes
app.use('/api/', apiLimiter);
app.use('/auth/', authLimiter);
console.log('✓ Rate limiting enabled (API: 100/15min, Auth: 20/15min)');

// Error sanitization - Hide internal details in production
function sanitizeError(err) {
    if (process.env.NODE_ENV === 'production') {
        // Log full error for debugging
        console.error('Internal error:', err.message, err.stack);
        // Return generic message to client
        return 'An error occurred. Please try again or contact support.';
    }
    return err.message;
}

// Input validation helper - Max lengths for common fields
const INPUT_LIMITS = {
    companyName: 200,
    gstin: 15,
    pan: 10,
    email: 100,
    comment: 1000,
    reason: 500,
    filename: 255
};

function validateInputLength(value, field) {
    const limit = INPUT_LIMITS[field] || 500;
    if (value && typeof value === 'string' && value.length > limit) {
        throw new Error(`${field} exceeds maximum length of ${limit} characters`);
    }
    return true;
}

// ==================== PII-SAFE SECURITY LOGGING ====================
// Initialize the security logger with S3 client
const securityLogger = new SecurityLogger(s3Client, {
    bufferSize: 50,
    flushIntervalMs: 60000,
    logLevel: LOG_LEVELS.INFO,
    consoleEnabled: true,
    s3Enabled: true
});

// Wrapper function for backward compatibility
async function logSecurityEvent(eventType, details, req) {
    // Use the new PII-safe logger which automatically masks sensitive data
    return securityLogger.logSecurityEvent(eventType, details, req);
}

// Log PII access for compliance
function logPIIAccess(userId, action, dataType, recordId, req, reason = 'user_request') {
    return securityLogger.logPIIAccess({
        userId,
        action,
        dataType,
        recordId,
        reason,
        req
    });
}

// ==================== SIEM / CENTRALIZED LOGGING ====================
// Initialize SIEM storage (writes to S3 logs/ folder)
const siemStorage = new SIEMStorage(s3Client, {
    basePath: 'logs',
    indexPath: 'logs/index'
});

// Initialize centralized logger
const centralizedLogger = new CentralizedLogger(siemStorage, {
    minLevel: 0, // DEBUG level - log everything
    bufferSize: 50,
    flushIntervalMs: 30000,
    consoleEnabled: true,
    consoleLevel: 1, // INFO level for console
    platform: {
        name: 'AFL-Underwriting',
        version: '7.7.7',
        environment: process.env.NODE_ENV || 'development'
    }
});

// Check if SIEM API is configured
const siemConfigured = !!(process.env.SIEM_API_KEY && process.env.SIEM_API_SECRET);
if (siemConfigured) {
    console.log('✓ SIEM API configured (API Key + HMAC + IP Whitelist)');
    const allowedIPs = (process.env.SIEM_ALLOWED_IPS || '').split(',').filter(Boolean);
    if (allowedIPs.length > 0) {
        console.log(`  Allowed IPs: ${allowedIPs.join(', ')}`);
    } else {
        console.log('  IP whitelist: Not configured (all IPs allowed)');
    }
} else {
    console.log('⚠️ SIEM API not configured (set SIEM_API_KEY, SIEM_API_SECRET, SIEM_ALLOWED_IPS)');
}
console.log('✓ Centralized logging initialized (S3: logs/ folder)');

// CRITICAL: Body parsers MUST come first (before session and passport)
// ADFS POSTs the SAML assertion to /auth/saml/callback - we need to parse it!
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Security check: Require SESSION_SECRET in production
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    console.error('❌ CRITICAL: SESSION_SECRET environment variable is required in production!');
    console.error('   Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
    process.exit(1);
}

// Session configuration (after body parsers, before passport)
app.use(cookieParser());
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-only-secret-not-for-production',
    resave: false,
    saveUninitialized: true, // CRITICAL: Must be true for OAuth to work (stores state parameter)
    proxy: true, // Trust the reverse proxy
    name: 'acc.sid', // Custom session cookie name
    cookie: {
        secure: process.env.NODE_ENV === 'production', // HTTPS only in production
        httpOnly: true, // Prevent XSS cookie theft
        maxAge: 8 * 60 * 60 * 1000, // 8 hours
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // Allow cross-site in production for OAuth
        path: '/',
        domain: undefined // Let Express set it automatically based on request
    }
}));

// Debug session middleware
app.use((req, res, next) => {
    if (req.path.startsWith('/auth/')) {
        console.log(`🔍 Session debug for ${req.path}:`);
        console.log('   Session ID:', req.sessionID);
        console.log('   Session exists:', !!req.session);
        console.log('   Is authenticated:', req.isAuthenticated ? req.isAuthenticated() : 'N/A');
        console.log('   Cookie header:', req.headers.cookie ? 'Present' : 'Missing');
        console.log('   Session cookie:', req.cookies ? req.cookies['acc.sid'] : 'N/A');
    }
    next();
});

// Initialize passport (after session)
app.use(passport.initialize());
app.use(passport.session());

// Rate limit: Claude allows 30,000 input tokens per minute
const TOKENS_PER_MINUTE = 30000;
let tokensThisMinute = 0;
let lastHighTokenRequestStart = 0;  // Track when last high-token request STARTED
let currentWindowStart = Date.now();

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Estimate tokens based on file size and type (rough estimate)
function estimateTokens(sizeKB, docType) {
    // PDFs typically convert to ~100-200 tokens per KB for text-heavy docs
    // GST returns and bank statements are very token-heavy
    if (docType === 'gst' || docType === 'bank') {
        return Math.round(sizeKB * 180); // ~180 tokens per KB for GST/Bank
    }
    return Math.round(sizeKB * 12); // ~12 tokens per KB for financial statements
}

// Check rate limit BEFORE making a request
async function checkRateLimitBefore(estimatedTokens, docName, assessmentId) {
    const now = Date.now();
    
    // Reset window if 65 seconds have passed
    if (now - currentWindowStart >= 65000) {
        tokensThisMinute = 0;
        currentWindowStart = now;
        console.log(`    📊 Rate limit window reset`);
    }
    
    // For high-token documents (>25K estimated), check if we need to wait
    if (estimatedTokens > 25000) {
        const timeSinceLastHigh = now - lastHighTokenRequestStart;
        
        // If last high-token request was less than 65s ago, wait
        if (lastHighTokenRequestStart > 0 && timeSinceLastHigh < 65000) {
            const waitTime = 65000 - timeSinceLastHigh;
            console.log(`    ⏳ Pre-wait ${Math.round(waitTime/1000)}s for rate limit (high-token doc)`);
            sendProgress(assessmentId, { 
                type: 'rate_wait', 
                docName: docName,
                seconds: Math.round(waitTime/1000),
                reason: 'Pre-extraction wait for rate limit window'
            });
            await delay(waitTime);
            tokensThisMinute = 0;
            currentWindowStart = Date.now();
        }
        
        // Mark this as the start of a high-token request
        lastHighTokenRequestStart = Date.now();
    }
    
    // If current window is already near limit, wait
    if (tokensThisMinute + estimatedTokens > TOKENS_PER_MINUTE * 0.9) {
        const elapsed = now - currentWindowStart;
        const waitTime = Math.max(5000, 65000 - elapsed);
        console.log(`    ⏳ Window near limit. Waiting ${Math.round(waitTime/1000)}s...`);
        sendProgress(assessmentId, { 
            type: 'rate_wait', 
            docName: docName,
            seconds: Math.round(waitTime/1000),
            reason: 'Token window near limit'
        });
        await delay(waitTime);
        tokensThisMinute = 0;
        currentWindowStart = Date.now();
    }
}

// Update token count AFTER successful request
function updateTokenCount(tokensUsed) {
    const now = Date.now();
    
    // Reset window if needed
    if (now - currentWindowStart >= 65000) {
        tokensThisMinute = 0;
        currentWindowStart = now;
    }
    
    tokensThisMinute += tokensUsed;
    const pct = Math.round((tokensThisMinute / TOKENS_PER_MINUTE) * 100);
    console.log(`    📊 Tokens: ${tokensThisMinute.toLocaleString()} / ${TOKENS_PER_MINUTE.toLocaleString()} (${pct}%)`);
    
    return { used: tokensThisMinute, limit: TOKENS_PER_MINUTE, pct };
}

// Retry wrapper for Claude API calls with 429 handling
async function withRetry(fn, maxRetries = 3, docName = '', assessmentId = '') {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const is429 = err.message && err.message.includes('429');
            
            if (is429 && attempt < maxRetries) {
                console.log(`    ⚠️ Rate limit 429 on attempt ${attempt}. Waiting 65s to retry...`);
                sendProgress(assessmentId, { 
                    type: 'rate_retry', 
                    docName: docName,
                    attempt: attempt,
                    maxRetries: maxRetries
                });
                await delay(65000);
                tokensThisMinute = 0;
                currentWindowStart = Date.now();
                lastHighTokenRequestStart = 0;
                continue;
            }
            throw err;
        }
    }
}

// ==================== ACCESS LOGGING MIDDLEWARE ====================
// Log all HTTP requests with PII masking
app.use(createAccessLogMiddleware(securityLogger));

// ==================== SIEM / CENTRALIZED LOGGING MIDDLEWARE ====================
// Add correlation ID to all requests
app.use(correlationMiddleware());

// Log all access to centralized logger (in addition to security logger)
app.use(accessLogMiddleware(centralizedLogger));

// Track user sessions
app.use(sessionTrackingMiddleware(centralizedLogger));

// Mount SIEM API routes (before static files to ensure API takes precedence)
const siemRouter = createSIEMRouter(siemStorage, centralizedLogger);
app.use('/api/siem', siemRouter);
console.log('✓ SIEM API mounted at /api/siem');

// CRITICAL FIX: Serve static files but disable automatic index.html serving
// This forces all requests to / to go through the authenticated route below
app.use(express.static('public', { 
    index: false  // Prevents Express from automatically serving index.html
}));

// Serve test data files for Legal Module testing
app.use('/test-data', express.static('test-data'));

// ==================== AUTHENTICATION ROUTES ====================

// Login page - show login UI (publicly accessible)
app.get('/login', ensureNotAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Initiate ADFS login (SAML AuthnRequest -> redirect to adfsuat.axisb.com)
app.get('/auth/saml/login',
    passport.authenticate('adfs-saml', { failureRedirect: '/login' })
);

// SAML assertion callback from ADFS (HTTP-POST binding, per Federation Metadata)
app.post('/auth/saml/callback',
    function(req, res, next) {
        console.log('📨 Received SAML assertion from ADFS');
        console.log('   Body present:', !!req.body);
        console.log('   SAMLResponse present:', !!req.body?.SAMLResponse);
        next();
    },
    function(req, res, next) {
        // Custom callback to catch authentication errors
        passport.authenticate('adfs-saml', function(err, user, info) {
            if (err) {
                console.error('❌ Passport SAML authentication error:', err.message);
                console.error('   Error details:', err);
                return res.redirect('/login?error=auth_error');
            }
            
            if (!user) {
                console.error('❌ Authentication failed: No user returned');
                console.error('   Info:', info);
                return res.redirect('/login?error=no_user');
            }
            
            console.log('✅ Passport returned user:', user.email);
            
            // Manually log the user in
            req.logIn(user, function(err) {
                if (err) {
                    console.error('❌ Session login error:', err.message);
                    console.error('   Error details:', err);
                    logSecurityEvent('LOGIN_FAILED', { email: user?.email, error: err.message }, req);
                    return next(err);
                }
                
                console.log('✅ Session created successfully for:', user.email);
                console.log('   Session ID:', req.sessionID);
                console.log('   Is authenticated:', req.isAuthenticated());
                
                // Audit log successful login
                logSecurityEvent('LOGIN_SUCCESS', { email: user.email, role: user.role }, req);
                
                // SIEM: Log session start
                centralizedLogger.sessionStart(req.sessionID, {
                    id: user.id || user.email,
                    email: user.email,
                    role: user.role,
                    auth_method: 'adfs_saml'
                }, req);
                centralizedLogger.security('LOGIN_SUCCESS', {
                    success: true,
                    role: user.role
                }, req);
                
                const returnTo = req.session.returnTo || '/';
                delete req.session.returnTo;
                console.log('   Redirecting to:', returnTo);
                
                return res.redirect(returnTo);
            });
        })(req, res, next);
    }
);

// Logout
app.get('/auth/logout', (req, res) => {
    const userEmail = req.user?.email || 'unknown';
    logSecurityEvent('LOGOUT', { email: userEmail }, req);
    
    // SIEM: Log session end
    if (req.sessionID) {
        centralizedLogger.sessionEnd(req.sessionID, 'user_logout', req);
        centralizedLogger.security('LOGOUT', { success: true }, req);
    }
    
    req.logout((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        req.session.destroy(() => {
            res.redirect('/login');
        });
    });
});

// Get current user info
app.get('/api/user', ensureAuthenticated, (req, res) => {
    res.json({
        email: req.user.email,
        displayName: req.user.displayName,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        jobTitle: req.user.jobTitle,
        department: req.user.department
    });
});

// Protect the main application - MUST be authenticated
app.get('/', ensureAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// SIEM API Documentation - Super Admin only
app.get('/siem-docs', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'siem-docs.html'));
});

// Compliance Dashboard - Super Admin only
app.get('/compliance', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'compliance.html'));
});

// ==================== COMPLIANCE API ENDPOINTS ====================

/**
 * GET /api/compliance/latest
 * Get latest compliance scan results
 */
app.get('/api/compliance/latest', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
    try {
        // Try to get from S3 first
        const s3Key = 'compliance/latest.json';
        try {
            const s3Data = await s3Client.getFile(s3Key);
            if (s3Data) {
                return res.json(JSON.parse(s3Data));
            }
        } catch (s3Err) {
            // S3 doesn't have it, check local file
        }
        
        // Check local compliance folder
        const localPath = path.join(__dirname, 'compliance', 'scan-results.json');
        if (fs.existsSync(localPath)) {
            const localData = fs.readFileSync(localPath, 'utf8');
            const results = JSON.parse(localData);
            
            // Upload to S3 for future use
            try {
                await s3Client.uploadFile(s3Key, Buffer.from(localData), 'application/json');
            } catch (uploadErr) {
                console.warn('Could not upload compliance results to S3:', uploadErr.message);
            }
            
            return res.json(results);
        }
        
        // No scan results found
        res.status(404).json({
            error: 'No compliance scan results found',
            message: 'Run npm run compliance:scan to generate scan results'
        });
        
    } catch (err) {
        console.error('Error fetching compliance results:', err);
        res.status(500).json({ error: 'Failed to fetch compliance results' });
    }
});

/**
 * POST /api/compliance/rescan
 * Trigger a compliance rescan (Super Admin only)
 */
app.post('/api/compliance/rescan', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
    try {
        // Import and run the scanner
        const { runComplianceScan } = require('./lib/compliance-scanner');
        
        // Run scan
        const results = await runComplianceScan();
        
        // Upload to S3
        try {
            await s3Client.uploadFile(
                'compliance/latest.json',
                Buffer.from(JSON.stringify(results, null, 2)),
                'application/json'
            );
            
            // Also save historical copy
            const historyKey = `compliance/history/${new Date().toISOString().split('T')[0]}.json`;
            await s3Client.uploadFile(
                historyKey,
                Buffer.from(JSON.stringify(results, null, 2)),
                'application/json'
            );
        } catch (uploadErr) {
            console.warn('Could not upload compliance results to S3:', uploadErr.message);
        }
        
        // Log the rescan
        logSecurityEvent('COMPLIANCE_RESCAN', {
            triggered_by: req.user?.email,
            overall_score: results.overall_score
        }, req);
        
        res.json({
            success: true,
            message: 'Compliance scan completed',
            results
        });
        
    } catch (err) {
        console.error('Error running compliance scan:', err);
        res.status(500).json({ error: 'Failed to run compliance scan' });
    }
});

/**
 * GET /api/compliance/report
 * Download compliance report as JSON
 */
app.get('/api/compliance/report', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
    try {
        // Get latest results
        const localPath = path.join(__dirname, 'compliance', 'scan-results.json');
        let results;
        
        if (fs.existsSync(localPath)) {
            results = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        } else {
            // Try S3
            try {
                const s3Data = await s3Client.getFile('compliance/latest.json');
                results = JSON.parse(s3Data);
            } catch (s3Err) {
                return res.status(404).json({ error: 'No compliance report available' });
            }
        }
        
        // Log the download
        logSecurityEvent('COMPLIANCE_REPORT_DOWNLOAD', {
            downloaded_by: req.user?.email,
            scan_date: results.scan_info?.timestamp
        }, req);
        
        // Set headers for download
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=compliance-report-${new Date().toISOString().split('T')[0]}.json`);
        res.json(results);
        
    } catch (err) {
        console.error('Error downloading compliance report:', err);
        res.status(500).json({ error: 'Failed to download compliance report' });
    }
});

// Compliance Dashboard - Super Admin only
app.get('/compliance', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'compliance.html'));
});

// ==================== COMPLIANCE API ENDPOINTS ====================

// REMOVED: Duplicate compliance routes (latest, rescan, report) — originals at lines 546-678


/**
 * GET /api/compliance/history
 * Get list of historical compliance scans
 */
app.get('/api/compliance/history', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
    try {
        const history = await s3Client.listFiles('compliance/history/');
        
        const scans = history
            .filter(f => f.key.endsWith('.json'))
            .map(f => ({
                date: f.key.replace('compliance/history/', '').replace('.json', ''),
                key: f.key,
                size: f.size,
                lastModified: f.lastModified
            }))
            .sort((a, b) => b.date.localeCompare(a.date));
        
        res.json({ history: scans });
        
    } catch (err) {
        console.error('Error fetching compliance history:', err);
        res.json({ history: [] });
    }
});

// ==================== END AUTHENTICATION ROUTES ====================

// Protect all API routes (except health check)
app.use('/api', (req, res, next) => {
    // Allow health check without authentication
    if (req.path === '/health' || req.path.startsWith('/health')) {
        return next();
    }
    // All other API routes require authentication
    ensureAuthenticated(req, res, next);
});


// Store active SSE connections for progress updates
const sseConnections = new Map();

/**
 * GET /api/extraction-progress/:assessmentId
 * Server-Sent Events endpoint for real-time extraction progress
 */
app.get('/api/extraction-progress/:assessmentId', ensureAuthenticated, (req, res) => {
    const { assessmentId } = req.params;
    
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // CORS: Allow only same origin or configured origin
    const allowedOrigin = process.env.ALLOWED_ORIGIN || req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.flushHeaders();
    
    // Store connection
    sseConnections.set(assessmentId, res);
    
    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'SSE connected' })}\n\n`);
    
    // Clean up on close
    req.on('close', () => {
        sseConnections.delete(assessmentId);
    });
});

// Helper to send progress update to client
function sendProgress(assessmentId, data) {
    const connection = sseConnections.get(assessmentId);
    if (connection) {
        connection.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

// CORS headers - restrict to allowed origins
// Always set explicitly via ALLOWED_ORIGINS env var in real deployments
// (CloudFormation injects this); fallback here is just a safety net for
// local/dev runs without that env var set.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://aflcuwuat.axisb.com,https://aflcuwprod.axisb.com').split(',');
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin) || process.env.NODE_ENV !== 'production') {
        res.header('Access-Control-Allow-Origin', origin || '*');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Health check endpoint (public - needed for load balancers)
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Version/Build info endpoint (public - no auth required for login page)
app.get('/api/version', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    
    // Read version from VERSION file
    let version = '7.7.7';
    try {
        const versionFile = path.join(__dirname, 'VERSION');
        if (fs.existsSync(versionFile)) {
            version = fs.readFileSync(versionFile, 'utf8').trim();
        }
    } catch (e) { /* ignore */ }
    
    // Build number - must be set manually in Render environment variables
    // In Render Dashboard: Settings > Environment Variables > Add BUILD_NUMBER
    // Example: BUILD_NUMBER = "build-2026-01-18-001" or use deployment timestamp
    const buildNumber = process.env.BUILD_NUMBER || null;
    
    // Git commit from environment (set during deployment)
    const gitCommit = process.env.GIT_COMMIT || process.env.RENDER_GIT_COMMIT || null;
    
    // Build date from environment or current date
    const buildDate = process.env.BUILD_DATE || process.env.RENDER_GIT_COMMIT_DATE || null;
    
    res.json({
        version,
        buildNumber,
        gitCommit,
        buildDate,
        nodeEnv: process.env.NODE_ENV || 'development'
    });
});

// Configure multer for file uploads with security validation
const storage = multer.memoryStorage();
const ALLOWED_MIME_TYPES = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/json'
];
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
    fileFilter: (req, file, cb) => {
        if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            console.warn(`⚠️ Rejected file upload: ${file.originalname} (${file.mimetype})`);
            cb(new Error('Invalid file type. Allowed: PDF, PNG, JPEG, Excel, CSV, JSON'), false);
        }
    }
});

// Assessment cache with TTL (Time To Live)
// S3 is the source of truth. Map is only a short-lived cache to avoid repeated S3 calls.
// On server restart, cache is empty — all reads go to S3 and re-populate cache.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL
const _assessmentCache = new Map(); // { id: { data, timestamp } }

const assessments = {
    get(id) {
        const entry = _assessmentCache.get(id);
        if (!entry) return undefined;
        // Check TTL - expire after 5 minutes
        if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
            _assessmentCache.delete(id);
            return undefined;
        }
        return entry.data;
    },
    set(id, data) {
        _assessmentCache.set(id, { data, timestamp: Date.now() });
    },
    delete(id) {
        _assessmentCache.delete(id);
    },
    has(id) {
        const entry = _assessmentCache.get(id);
        if (!entry) return false;
        if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
            _assessmentCache.delete(id);
            return false;
        }
        return true;
    },
    // For iteration (used by some endpoints)
    values() {
        return Array.from(_assessmentCache.values())
            .filter(e => Date.now() - e.timestamp <= CACHE_TTL_MS)
            .map(e => e.data);
    },
    size: 0 // Proxy for logging
};
Object.defineProperty(assessments, 'size', { get() { return _assessmentCache.size; } });

let assessmentsList = []; // Dashboard list - refreshed from S3 on each dashboard call
let assessmentsListTimestamp = 0; // When the list was last loaded
const LIST_TTL_MS = 2 * 60 * 1000; // Refresh dashboard list every 2 minutes

/**
 * Get assessment by ID — cache first, S3 fallback, re-caches on hit
 * USE THIS instead of bare assessments.get() to survive server restarts
 * @param {string} id - Assessment ID
 * @returns {Object|null} Assessment or null
 */
async function getAssessmentById(id) {
    if (!id) return null;
    
    // 1. Check cache
    let assessment = assessments.get(id);
    if (assessment) return assessment;
    
    // 2. S3 fallback (cache expired or server restarted)
    if (s3Client.isConfigured()) {
        try {
            assessment = await s3Client.getAssessment(id);
            if (assessment) {
                assessments.set(id, assessment); // Re-cache
                return assessment;
            }
        } catch (err) {
            console.error(`[CACHE] S3 fallback failed for ${id}:`, err.message);
        }
    }
    
    return null;
}

// Job queue for background processing
const jobQueue = new JobQueue({
    maxConcurrent: 3,
    s3Client: s3Client,
    onJobComplete: (assessmentId, job) => {
        console.log(`✅ Background job ${assessmentId} completed`);
    },
    onJobError: (assessmentId, job) => {
        console.log(`❌ Background job ${assessmentId} failed`);
    }
});

// ============================================
// CONFIGURATION CACHE (from Masters)
// ============================================
let configCache = {
    policy_rules: [],
    scoring_weights: [],
    scoring_metrics: [],
    scoring_grades: [],
    limit_params: [],
    lastLoaded: null,
    isLoaded: false
};

/**
 * Load configuration from Masters (primary) or config files (fallback)
 */
async function loadConfigCache() {
    console.log('🔄 Loading configuration...');
    
    try {
        const fs = require('fs');
        const path = require('path');
        
        const policyNormsPath = path.join(__dirname, 'config', 'policy-norms.json');
        const creditScoringPath = path.join(__dirname, 'config', 'credit-scoring.json');
        const limitParamsPath = path.join(__dirname, 'config', 'limit-params.json');
        
        // MASTERS IS PRIMARY - config files are fallback only
        
        // Load policy rules - Masters first, then config file fallback
        const mastersRules = mastersManager.getMasterRecords('policy_rules') || [];
        if (mastersRules.length > 0) {
            configCache.policy_rules = mastersRules;
            console.log(`   ✅ Loaded ${configCache.policy_rules.length} policy rules from Masters`);
        } else if (fs.existsSync(policyNormsPath)) {
            const policyNorms = JSON.parse(fs.readFileSync(policyNormsPath, 'utf8'));
            configCache.policy_rules = policyNorms.policy_rules || [];
            console.log(`   ⚠️ Masters empty, loaded ${configCache.policy_rules.length} policy rules from config/policy-norms.json`);
        } else {
            configCache.policy_rules = [];
            console.log(`   ❌ No policy rules found in Masters or config files`);
        }
        
        // Load scoring weights - Masters first
        const mastersWeights = mastersManager.getMasterRecords('scoring_weights') || [];
        if (mastersWeights.length > 0) {
            configCache.scoring_weights = mastersWeights;
            console.log(`   ✅ Loaded ${configCache.scoring_weights.length} scoring weights from Masters`);
        } else if (fs.existsSync(creditScoringPath)) {
            const creditScoring = JSON.parse(fs.readFileSync(creditScoringPath, 'utf8'));
            configCache.scoring_weights = creditScoring.scoring_weights || [];
            console.log(`   ⚠️ Masters empty, loaded scoring weights from config file`);
        }
        
        // Load scoring metrics - Masters first
        const mastersMetrics = mastersManager.getMasterRecords('scoring_metrics') || [];
        if (mastersMetrics.length > 0) {
            configCache.scoring_metrics = mastersMetrics;
            console.log(`   ✅ Loaded ${configCache.scoring_metrics.length} scoring metrics from Masters`);
        } else if (fs.existsSync(creditScoringPath)) {
            const creditScoring = JSON.parse(fs.readFileSync(creditScoringPath, 'utf8'));
            configCache.scoring_metrics = creditScoring.scoring_metrics || [];
            console.log(`   ⚠️ Masters empty, loaded scoring metrics from config file`);
        }
        
        // Load scoring grades - Masters first
        const mastersGrades = mastersManager.getMasterRecords('scoring_grades') || [];
        if (mastersGrades.length > 0) {
            configCache.scoring_grades = mastersGrades;
            console.log(`   ✅ Loaded ${configCache.scoring_grades.length} scoring grades from Masters`);
        } else if (fs.existsSync(creditScoringPath)) {
            const creditScoring = JSON.parse(fs.readFileSync(creditScoringPath, 'utf8'));
            configCache.scoring_grades = creditScoring.scoring_grades || [];
            console.log(`   ⚠️ Masters empty, loaded scoring grades from config file`);
        }
        
        // Load limit params - Masters first
        const mastersParams = mastersManager.getMasterRecords('limit_params') || [];
        if (mastersParams.length > 0) {
            configCache.limit_params = mastersParams;
            console.log(`   ✅ Loaded ${configCache.limit_params.length} limit params from Masters`);
        } else if (fs.existsSync(limitParamsPath)) {
            const limitParams = JSON.parse(fs.readFileSync(limitParamsPath, 'utf8'));
            configCache.limit_params = limitParams.limit_params || [];
            console.log(`   ⚠️ Masters empty, loaded limit params from config file`);
        }
        
        configCache.lastLoaded = new Date().toISOString();
        configCache.isLoaded = true;
        
        console.log(`✅ Config cache loaded at ${configCache.lastLoaded}`);
        console.log(`   Summary: Rules=${configCache.policy_rules.length}, Weights=${configCache.scoring_weights.length}, Metrics=${configCache.scoring_metrics.length}, Grades=${configCache.scoring_grades.length}, Params=${configCache.limit_params.length}`);
        
        // Update calculation engine with new config
        calculationEngine.setConfig(configCache);
        console.log('   ✅ Calculation engine updated with config');
        
        return configCache;
    } catch (err) {
        console.error('❌ Error loading config cache:', err.message);
        throw err;
    }
}

/**
 * Get config cache (load if not loaded)
 */
function getConfigCache() {
    if (!configCache.isLoaded) {
        console.warn('⚠️ Config cache not loaded, returning empty');
    }
    return configCache;
}

/**
 * Flush and reload config cache
 */
async function flushConfigCache() {
    console.log('🗑️ Flushing configuration cache...');
    configCache = {
        policy_rules: [],
        scoring_weights: [],
        scoring_metrics: [],
        scoring_grades: [],
        limit_params: [],
        lastLoaded: null,
        isLoaded: false
    };
    return await loadConfigCache();
}

/**
 * Initialize data from S3 or seed demo data
 */
async function initializeData() {
    // Initialize users first
    try {
        console.log('👥 Initializing user management...');
        await userManager.initializeUsers();
    } catch (err) {
        console.error('❌ Error initializing users:', err.message);
    }
    
    // Initialize masters
    try {
        console.log('📋 Initializing masters management...');
        await mastersManager.initialize();
        console.log('✅ Masters initialized successfully');
        
        // Load config cache from masters
        await loadConfigCache();
    } catch (err) {
        console.error('❌ Error initializing masters:', err.message);
    }
    
    // Initialize AML screening
    try {
        console.log('🔍 Initializing AML screening...');
        await amlScreening.initialize();
        console.log('✅ AML screening initialized successfully');
    } catch (err) {
        console.error('❌ Error initializing AML screening:', err.message);
    }
    
    // Initialize investigation & fraud database
    try {
        console.log('🔎 Initializing investigation & fraud database...');
        await investigationManager.initialize();
        console.log('✅ Investigation & fraud database initialized successfully');
    } catch (err) {
        console.error('❌ Error initializing investigation:', err.message);
    }
    
    if (!s3Client.isConfigured()) {
        console.log('⚠️  S3 not configured - using in-memory storage only');
        console.log('📦 No demo data seeded - production mode');
        assessmentsList = [];
        return;
    }

    try {
        console.log('🔄 Loading assessment summaries from S3...');
        
        // Load summaries only (single S3 call) - full data loaded on demand via getAssessmentById
        const summaries = await s3Client.getAllAssessmentSummaries();
        assessmentsList = summaries;
        assessmentsListTimestamp = Date.now();
        
        console.log(`✅ Loaded ${summaries.length} assessment summaries from S3 index`);
        
        // Restore job queue state
        await jobQueue.restore();
        
    } catch (err) {
        console.error('❌ Error initializing data:', err.message);
        console.log('📦 Starting with empty assessment list');
        assessmentsList = [];
    }
}

// ============== API ENDPOINTS ==============

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        version: '3.0.0',
        features: ['s3-persistence', 'calculation-transparency', 'server-side-processing'],
        assessments_loaded: assessments.size
    });
});

// ============== USER MANAGEMENT ENDPOINTS ==============

/**
 * GET /api/users/me
 * Get current user info
 */
app.get('/api/users/me', ensureAuthenticated, (req, res) => {
    res.json({
        email: req.user.email,
        displayName: req.user.displayName,
        role: req.user.role,
        canManageUsers: userManager.canManageUsers(req.user.email),
        canSeeAllCases: userManager.canSeeAllCases(req.user.email),
        isReadOnly: userManager.isReadOnly(req.user.email)
    });
});

/**
 * GET /api/users
 * Get all users (Super Admin and Admin only)
 */
app.get('/api/users', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    const users = userManager.getAllUsers();
    res.json(users);
});

/**
 * POST /api/users
 * Add new user (Super Admin and Admin)
 */
app.post('/api/users', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), async (req, res) => {
    try {
        const { email, role } = req.body;
        
        if (!email || !role) {
            return res.status(400).json({ error: 'Email and role are required' });
        }
        
        const newUser = await userManager.addUser(email, role, req.user.email);
        logSecurityEvent('USER_CREATED', { targetEmail: email, role: role, createdBy: req.user.email }, req);
        res.json({ success: true, user: newUser });
    } catch (err) {
        console.error('Error adding user:', err.message);
        res.status(400).json({ error: err.message });
    }
});

/**
 * DELETE /api/users/:email
 * Delete user (Super Admin only)
 */
app.delete('/api/users/:email', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
    try {
        const email = req.params.email;
        await userManager.deleteUser(email, req.user.email);
        logSecurityEvent('USER_DELETED', { targetEmail: email, deletedBy: req.user.email }, req);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting user:', err.message);
        res.status(400).json({ error: err.message });
    }
});

/**
 * PUT /api/users/:email
 * Update user role (Super Admin only)
 */
app.put('/api/users/:email', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
    try {
        const email = req.params.email;
        const { role } = req.body;
        
        if (!role) {
            return res.status(400).json({ error: 'Role is required' });
        }
        
        const updatedUser = await userManager.updateUserRole(email, role, req.user.email);
        logSecurityEvent('USER_ROLE_CHANGED', { targetEmail: email, newRole: role, changedBy: req.user.email }, req);
        res.json({ success: true, user: updatedUser });
    } catch (err) {
        console.error('Error updating user:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// ============== ASSESSMENT ENDPOINTS ==============

/**
 * GET /api/assessments
 * Get all assessments for the case queue (filtered by role)
 */
app.get('/api/assessments', ensureAuthenticated, async (req, res) => {
    const userEmail = req.user.email;
    const userRole = req.user.role;
    
    // Refresh assessmentsList from S3 if stale or empty (uses summaries - single S3 call)
    if (s3Client.isConfigured() && (Date.now() - assessmentsListTimestamp > LIST_TTL_MS || assessmentsList.length === 0)) {
        try {
            const summaries = await s3Client.getAllAssessmentSummaries();
            assessmentsList = summaries;
            assessmentsListTimestamp = Date.now();
            console.log(`📋 Dashboard list refreshed from S3 index: ${summaries.length} assessments`);
        } catch (err) {
            console.error('Error refreshing assessments from S3:', err.message);
            // Continue with existing list if S3 fails
        }
    }
    
    let filteredList = assessmentsList;
    
    // Normalize for comparison
    const normalizedEmail = (userEmail || '').toLowerCase();
    const normalizedRole = (userRole || '').toLowerCase();
    
    // Filter based on role
    if (normalizedRole === 'super_admin' || normalizedRole === ROLES.AUDITOR) {
        // Super Admin and Auditor can see all cases
        filteredList = assessmentsList;
    } else if (normalizedRole === 'admin' || normalizedRole === ROLES.UNDERWRITER) {
        // Admin and Underwriter can see:
        // 1. All demo cases
        // 2. Their own actual cases (case-insensitive email match)
        // 3. Other admins' actual cases (for Admin role)
        filteredList = assessmentsList.filter(a => {
            if (a.type === 'demo') return true;
            if ((a.created_by || '').toLowerCase() === normalizedEmail) return true;
            if (normalizedRole === 'admin' && a.created_by) {
                const creator = userManager.getUser(a.created_by.toLowerCase());
                return creator && (creator.role === ROLES.ADMIN || creator.role === ROLES.SUPER_ADMIN);
            }
            return false;
        });
    }
    // Note: if role doesn't match any condition, filteredList = all assessments (fail-open for unknown roles)
    
    console.log(`📋 [Dashboard] user=${userEmail} role=${userRole} total=${assessmentsList.length} visible=${filteredList.length}`);
    
    // Pre-fetch all Redis progress data for active assessments
    let redisProgressMap = new Map();
    if (bullQueue.isReady()) {
        try {
            const allProgress = await bullQueue.getAllProgressFromRedis();
            allProgress.forEach(p => {
                redisProgressMap.set(p.assessmentId, p);
            });
        } catch (e) {
            console.log('Could not fetch Redis progress:', e.message);
        }
    }
    
    const list = filteredList.map(a => {
        const id = a.assessment_id || a.id;
        
        // Check Redis for progress (SINGLE SOURCE OF TRUTH)
        const redisProgress = redisProgressMap.get(id);
        
        // Fallback to in-memory job queue
        const queueStatus = jobQueue.getStatus(id);
        
        let status = a.status || 'Pending';
        let queuePosition = null;
        let queueProgress = null;
        let isStale = false;
        let staleDuration = 0;
        let currentPhase = null;
        let currentDocument = null;
        
        // Priority: Redis > in-memory queue > stored status
        if (redisProgress) {
            // Job is actively processing (has Redis progress)
            status = 'Processing';
            queueProgress = redisProgress.progress || 0;
            currentPhase = redisProgress.phase;
            currentDocument = redisProgress.currentDocument;
            
            // Check if stale (no update in 5 minutes)
            const lastUpdate = redisProgress.updatedAt ? new Date(redisProgress.updatedAt).getTime() : 0;
            const staleThreshold = 5 * 60 * 1000;
            if (lastUpdate && (Date.now() - lastUpdate > staleThreshold)) {
                isStale = true;
                staleDuration = Math.round((Date.now() - lastUpdate) / 60000);
            }
        } else if (queueStatus.status === 'stalled') {
            status = 'Processing';
            queueProgress = queueStatus.progress || 0;
            isStale = true;
            staleDuration = queueStatus.staleDuration || 0;
        } else if (queueStatus.status === 'processing') {
            status = 'Processing';
            queueProgress = queueStatus.progress || 0;
        } else if (queueStatus.status === 'queued') {
            status = 'Queued';
            queuePosition = queueStatus.position;
        }
        
        return {
            id: id,
            company: a.company_name,
            gstin: a.gstin || '',
            pan: a.pan || '',
            amount: (a.loan_amount_lakhs || a.loan_amount || 0) / 100,
            product: a.product || 'WC',
            lender: a.branch || 'Mumbai',
            priority: a.priority || 'Medium',
            status: status,
            tat: a.tat || 0,
            sla: a.sla || 3,
            score: a.score,
            grade: a.grade,
            type: a.type || 'actual',
            created_by: a.created_by || '',
            created_by_name: a.created_by_name || a.created_by || '',
            created_at: a.created_at || null,
            processedAt: a.completed_at || a.processed_at || null,
            status_override: a.status_override || false,
            status_changed_by: a.status_changed_by || null,
            documentCount: a.document_count || queueStatus.docsCount || 0,
            queuePosition: queuePosition,
            queueProgress: queueProgress,
            currentPhase: currentPhase,
            currentDocument: currentDocument,
            isStale: isStale,
            staleDuration: staleDuration
        };
    });
    res.json(list);
});

/**
 * GET /api/assessment/:id
 * Get full assessment details
 * Query param: refresh=true to force S3 reload
 */
app.get('/api/assessment/:id', ensureAuthenticated, async (req, res) => {
    const id = req.params.id;
    const forceRefresh = req.query.refresh === 'true';
    
    // Log PII access for compliance
    logPIIAccess(req.user?.email, 'view', 'assessment', id, req, 'view_assessment');
    
    let assessment = null;
    
    // If forcing refresh or not in memory, try S3 first
    if (forceRefresh && s3Client.isConfigured()) {
        try {
            assessment = await s3Client.getAssessment(id);
            if (assessment) {
                assessments.set(id, assessment); // Update memory cache
                console.log(`✅ Refreshed assessment ${id} from S3`);
            }
        } catch (err) {
            console.error('Error fetching from S3:', err.message);
        }
    }
    
    // Get from cache or S3 (getAssessmentById handles fallback)
    if (!assessment) {
        assessment = await getAssessmentById(id);
    }
    
    if (!assessment) {
        return res.status(404).json({ error: 'Assessment not found' });
    }
    
    res.json(assessment);
});

/**
 * GET /api/assessment/:id/mapping-report
 * Get field mapping report for an assessment
 */
app.get('/api/assessment/:id/mapping-report', ensureAuthenticated, async (req, res) => {
    const id = req.params.id;
    
    try {
        let assessment = await getAssessmentById(id);
        
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        // Generate comprehensive mapping report with all 524 parameters
        // Check multiple property locations (for backward compatibility)
        const extractedData = assessment.extracted_data || 
                              assessment.all_extracted_data || 
                              {};
        
        const mappingReport = comprehensiveMapper.generateComprehensiveMappingReport(
            extractedData,
            assessment.documents || {}, 
            assessment
        );
        
        res.json(mappingReport);
    } catch (err) {
        console.error(`Error generating mapping report for ${id}:`, err);
        res.status(500).json({ 
            error: 'Failed to generate mapping report', 
            message: err.message,
            overall: {
                total_parameters: 524,
                extracted: 0,
                percentage: 0,
                error: true
            }
        });
    }
});

/**
 * DELETE /api/assessment/:id
 * Delete an assessment (Super Admin only)
 */
app.delete('/api/assessment/:id', ensureAuthenticated, async (req, res) => {
    const id = req.params.id;
    
    // Only super_admin can delete
    if (!req.user || req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only Super Admin can delete assessments' });
    }
    
    try {
        let assessment = await getAssessmentById(id);
        
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        // Delete from memory cache
        assessments.delete(id);
        
        // Remove from assessmentsList
        const delIdx = assessmentsList.findIndex(a => (a.assessment_id || a.id) === id);
        if (delIdx >= 0) {
            assessmentsList.splice(delIdx, 1);
        }
        
        console.log(`Deleted assessment ${id} from memory by ${req.user.email}`);
        
        // Delete from S3 if configured
        if (s3Client.isConfigured()) {
            try {
                await s3Client.deleteAssessment(id);
                console.log(`Deleted assessment ${id} from S3 by ${req.user.email}`);
            } catch (err) {
                console.error('Error deleting from S3:', err.message);
                // Continue even if S3 deletion fails
            }
        }
        
        res.json({ 
            success: true, 
            message: `Assessment ${id} deleted successfully`,
            deleted_by: req.user.email,
            deleted_at: new Date().toISOString()
        });
        
    } catch (err) {
        console.error('Delete assessment error:', err);
        res.status(500).json({ error: sanitizeError(err) });
    }
});

// ============================================
// BACKGROUND PROCESSING API ENDPOINTS
// ============================================

/**
 * GET /api/assessment/:id/progress
 * Get real-time processing progress for an assessment
 */
app.get('/api/assessment/:id/progress', ensureAuthenticated, async (req, res) => {
    const assessmentId = req.params.id;
    
    // PRIMARY: Check Redis via bull-queue (most up-to-date progress)
    if (bullQueue.isReady()) {
        try {
            const redisProgress = await bullQueue.getProgressFromRedis(assessmentId);
            if (redisProgress) {
                return res.json(redisProgress);
            }
        } catch (e) {
            // Redis failed, fall through to jobQueue
        }
    }
    
    // FALLBACK: Check in-memory job queue for processing status
    const jobStatus = jobQueue.getStatus(assessmentId);
    
    if (jobStatus.status === 'not_found') {
        // Check if assessment exists and what its status is
        const assessment = await getAssessmentById(assessmentId);
        if (assessment) {
            const status = (assessment.status || '').toUpperCase();
            
            // Only return 'complete' if status is actually a completion status
            if (status === 'APPROVED' || status === 'REJECTED' || status === 'PENDING' || status === 'PARTIAL APPROVAL') {
                return res.json({
                    status: 'complete',
                    assessmentId: assessmentId,
                    finalStatus: assessment.status
                });
            }
            
            // If status is PARTIAL, return partial (not complete)
            if (status === 'PARTIAL') {
                return res.json({
                    status: 'partial',
                    assessmentId: assessmentId,
                    message: 'Processing incomplete',
                    finalStatus: assessment.status
                });
            }
            
            // If still PROCESSING or QUEUED, but not in queue - might be stale
            if (status === 'PROCESSING' || status === 'QUEUED') {
                return res.json({
                    status: 'stalled',
                    assessmentId: assessmentId,
                    message: 'Job not found in queue but status is ' + status,
                    finalStatus: assessment.status
                });
            }
            
            // Otherwise return not_found (status is CREATED or unknown)
            return res.json({ 
                status: 'not_found',
                finalStatus: assessment.status
            });
        }
        return res.json({ status: 'not_found' });
    }
    
    res.json(jobStatus);
});

/**
 * POST /api/assessment/:id/update-progress
 * Update processing progress from client
 */
app.post('/api/assessment/:id/update-progress', ensureAuthenticated, (req, res) => {
    const assessmentId = req.params.id;
    const { progress, commentary, metrics, currentPhase, currentDocument } = req.body;
    
    // Update job queue progress
    const updated = jobQueue.updateProgress(assessmentId, {
        progress,
        commentary,
        metrics,
        currentPhase,
        currentDocument
    });
    
    if (updated) {
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Job not found in queue' });
    }
});

/**
 * GET /api/queue/stats
 * Get current queue statistics
 */
// REMOVED: Simple jobQueue.getStats() route — comprehensive bull-queue version below handles this

/**
 * POST /api/assessment/:id/cancel
 * Cancel a queued assessment (not processing ones)
 */
app.post('/api/assessment/:id/cancel', ensureAuthenticated, (req, res) => {
    const assessmentId = req.params.id;
    
    const cancelled = jobQueue.cancelJob(assessmentId);
    
    if (cancelled) {
        res.json({ success: true, message: 'Assessment cancelled from queue' });
    } else {
        res.json({ success: false, message: 'Cannot cancel - assessment is already processing or not in queue' });
    }
});

/**
 * POST /api/assessment/:id/stop-processing
 * Stop a processing assessment (saves as Partial)
 */
app.post('/api/assessment/:id/stop-processing', ensureAuthenticated, async (req, res) => {
    const assessmentId = req.params.id;
    
    try {
        let assessment = await getAssessmentById(assessmentId);
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        // Update assessment status to Partial
        assessment.status = 'Partial';
        assessment.stopped_at = new Date().toISOString();
        assessment.stopped_by = req.user.email;
        
        // Update in assessmentsList
        const listIdx = assessmentsList.findIndex(a => (a.assessment_id || a.id) === assessmentId);
        if (listIdx >= 0) {
            assessmentsList[listIdx].status = 'Partial';
        }
        
        // Remove from job queue
        jobQueue.cancelJob(assessmentId);
        
        // Also try to remove from processing map
        if (jobQueue.processing && jobQueue.processing.has) {
            jobQueue.processing.delete(assessmentId);
        }
        
        // Save to S3
        if (s3Client.isConfigured()) {
            try {
                await s3Client.saveAssessment(assessmentId, assessment);
                console.log(`⏹️ Stopped and saved assessment ${assessmentId} as Partial`);
            } catch (err) {
                console.error('Error saving to S3:', err.message);
            }
        }
        
        console.log(`⏹️ Assessment ${assessmentId} stopped by ${req.user.email}`);
        
        res.json({
            success: true,
            message: 'Processing stopped. Assessment saved as Partial.',
            assessmentId: assessmentId,
            status: 'Partial'
        });
    } catch (error) {
        console.error('Stop processing error:', error);
        res.status(500).json({ error: 'Failed to stop processing' });
    }
});

/**
 * POST /api/assessment/:id/reprocess
 * Reprocess assessment with edited extracted data (Human in Loop)
 * Admin only - recalculates all metrics and generates new decision
 */
app.post('/api/assessment/:id/reprocess', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), async (req, res) => {
    const assessmentId = req.params.id;
    const { extracted_data, audit_trail, edited_by } = req.body;
    
    try {
        console.log(`🔄 [Human in Loop] Reprocessing assessment ${assessmentId}`);
        console.log(`   Changes: ${audit_trail?.length || 0} modifications`);
        console.log(`   Extracted data keys: ${extracted_data ? Object.keys(extracted_data).join(', ') : 'NONE'}`);
        
        // Validate input
        if (!extracted_data || Object.keys(extracted_data).length === 0) {
            console.error('   ❌ No extracted_data provided in request body');
            return res.status(400).json({ error: 'No extracted data provided' });
        }
        
        // RELOAD CONFIG FILES before recalculating (to pick up any changes)
        try {
            await loadConfigCache();
            console.log(`   ✅ Config reloaded from files`);
        } catch (configErr) {
            console.error('   ⚠️ Config reload warning:', configErr.message);
            // Continue with existing config
        }
        
        // Get existing assessment
        let assessment = await getAssessmentById(assessmentId);
        
        if (!assessment) {
            console.error(`   ❌ Assessment ${assessmentId} not found`);
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        console.log(`   ✅ Assessment found: ${assessment.company || assessment.company_name || 'Unknown Company'}`);
        
        // Store original values for audit
        const originalExtractedData = JSON.parse(JSON.stringify(assessment.all_extracted_data || assessment.extracted_data || {}));
        const originalCalculations = JSON.parse(JSON.stringify(assessment.calculations || {}));
        const originalDecision = assessment.decision || 'PENDING';
        const originalScore = assessment.calculations?.credit_score?.total || 0;
        
        // Update extracted data with edited values
        assessment.all_extracted_data = extracted_data;
        assessment.extracted_data = extracted_data;
        
        // DEBUG: Log what we're recalculating with
        const debugPnl = extracted_data?.profit_and_loss || {};
        const debugBs = extracted_data?.balance_sheet || {};
        const debugYears = Object.keys(debugPnl).filter(k => !k.startsWith('_'));
        console.log(`   📊 [REPROCESS DEBUG] P&L years: ${debugYears.join(', ')}`);
        debugYears.forEach(y => {
            const p = debugPnl[y];
            if (p) console.log(`   📊 [REPROCESS DEBUG] P&L ${y}: revenue=${p.revenue}, pat=${p.profit_after_tax}, ebit=${p.ebit}, employee_expenses=${p.employee_expenses}`);
        });
        const debugBsYears = Object.keys(debugBs).filter(k => !k.startsWith('_'));
        console.log(`   📊 [REPROCESS DEBUG] BS years: ${debugBsYears.join(', ')}`);
        debugBsYears.forEach(y => {
            const b = debugBs[y];
            if (b) console.log(`   📊 [REPROCESS DEBUG] BS ${y}: net_worth=${b.net_worth}, total_assets=${b.total_assets}`);
        });
        
        // Recalculate all metrics using calculation engine
        let newCalculations;
        let policyCompliance;
        try {
            const config = getConfigCache();
            calculationEngine.setConfig(config);
            newCalculations = calculationEngine.calculateAll(extracted_data);
            console.log(`   ✅ Calculations completed`);
            console.log(`   📊 [REPROCESS DEBUG] New credit score: ${newCalculations.credit_score?.total}/${newCalculations.credit_score?.max}, Grade: ${newCalculations.credit_score?.grade}`);
            console.log(`   📊 [REPROCESS DEBUG] Financial Strength: ${newCalculations.credit_score?.components?.financial_strength?.score}/${newCalculations.credit_score?.components?.financial_strength?.max}`);
            
            // Generate policy compliance from calculations
            policyCompliance = calculationEngine.generatePolicyCompliance(newCalculations);
            console.log(`   ✅ Policy compliance generated`);
        } catch (calcErr) {
            console.error('   ❌ Calculation error:', calcErr.message);
            console.error(calcErr.stack);
            return res.status(500).json({ error: 'Calculation failed: ' + calcErr.message });
        }
        
        assessment.policy_compliance = policyCompliance;
        
        // Update assessment with new calculations
        assessment.calculations = newCalculations;
        
        // Determine new decision based on credit score
        const creditScore = newCalculations.credit_score;
        let newDecision = 'REFER TO CREDIT COMMITTEE';
        if (creditScore) {
            const gradeInfo = calculationEngine.getScoringGrade(creditScore.total);
            if (gradeInfo) {
                assessment.risk_grade = gradeInfo.grade;
                if (gradeInfo.decision.toLowerCase().includes('approve')) {
                    newDecision = 'RECOMMEND APPROVE';
                } else if (gradeInfo.decision.toLowerCase().includes('decline') || gradeInfo.decision.toLowerCase().includes('reject')) {
                    newDecision = 'RECOMMEND REJECT';
                } else {
                    newDecision = gradeInfo.decision.toUpperCase();
                }
            }
        }
        assessment.decision = newDecision;
        
        // Recalculate recommended limits using calculation engine (same logic as initial processing)
        const bs = extracted_data.balance_sheet || {};
        const pnl = extracted_data.profit_and_loss || {};
        const latestYear = Object.keys(bs).sort().reverse()[0] || 'fy25';
        const bsLatest = bs[latestYear] || {};
        const pnlLatest = pnl[latestYear] || {};
        
        assessment.recommended_limits = calculationEngine.calculateLimits(bsLatest, pnlLatest, assessment.loan_amount_lakhs);
        console.log(`   📊 [REPROCESS DEBUG] Latest year for limits: ${latestYear}`);
        console.log(`   📊 [REPROCESS DEBUG] pnlLatest.revenue=${pnlLatest.revenue}, pnlLatest.pat=${pnlLatest.profit_after_tax}`);
        console.log(`   📊 [REPROCESS DEBUG] Limits: WC=${assessment.recommended_limits?.working_capital?.amount}, TL=${assessment.recommended_limits?.term_loan?.amount}, OD=${assessment.recommended_limits?.overdraft?.amount}`);
        
        // Add reprocess audit trail
        if (!assessment.reprocess_history) {
            assessment.reprocess_history = [];
        }
        assessment.reprocess_history.push({
            reprocessed_at: new Date().toISOString(),
            reprocessed_by: edited_by || req.user?.email || 'unknown',
            changes: audit_trail,
            original_decision: originalDecision,
            new_decision: newDecision,
            original_score: originalScore,
            new_score: creditScore?.total,
            changes_count: audit_trail?.length || 0
        });
        
        assessment.last_reprocessed_at = new Date().toISOString();
        assessment.last_reprocessed_by = edited_by || req.user?.email;
        
        // Also update status, grade, score for dashboard consistency
        const creditTotal = creditScore?.total || 0;
        let status = 'PARTIAL APPROVAL';
        if (creditTotal >= 75) status = 'APPROVED';
        else if (creditTotal < 50) status = 'REJECTED';
        
        assessment.status = status;
        assessment.grade = creditScore?.grade || 'C';
        assessment.score = creditTotal;
        
        // Update in memory
        assessments.set(assessmentId, assessment);
        
        // Update assessments list with all fields for dashboard
        const listIdx = assessmentsList.findIndex(a => (a.assessment_id || a.id) === assessmentId);
        if (listIdx >= 0) {
            assessmentsList[listIdx].decision = newDecision;
            assessmentsList[listIdx].risk_grade = assessment.risk_grade;
            assessmentsList[listIdx].last_reprocessed_at = assessment.last_reprocessed_at;
            assessmentsList[listIdx].status = status;
            assessmentsList[listIdx].grade = assessment.grade;
            assessmentsList[listIdx].score = creditTotal;
            console.log(`   ✅ Updated assessmentsList[${listIdx}] with new status: ${status}, score: ${creditTotal}`);
        }
        
        // Save to S3
        if (s3Client.isConfigured()) {
            try {
                const assessmentToSave = { ...assessment };
                // Clean document buffers before saving
                if (assessmentToSave.documents) {
                    Object.keys(assessmentToSave.documents).forEach(k => {
                        if (assessmentToSave.documents[k]?.buffer) {
                            delete assessmentToSave.documents[k].buffer;
                        }
                    });
                }
                await s3Client.saveAssessment(assessmentId, assessmentToSave);
                console.log(`✅ [Human in Loop] Reprocessed assessment ${assessmentId} saved to S3`);
            } catch (s3Err) {
                console.error('Error saving to S3:', s3Err.message);
                // Continue - don't fail the whole operation for S3 errors
            }
        }
        
        console.log(`✅ [Human in Loop] Assessment ${assessmentId} reprocessed: ${originalDecision} → ${newDecision}, Score: ${originalScore} → ${creditScore?.total}`);
        
        res.json({
            success: true,
            message: 'Assessment reprocessed successfully',
            assessmentId: assessmentId,
            original_decision: originalDecision,
            new_decision: newDecision,
            original_score: originalScore,
            new_score: creditScore?.total,
            changes_applied: audit_trail?.length || 0,
            assessment: assessment
        });
        
    } catch (error) {
        console.error('Reprocess error:', error);
        res.status(500).json({ error: 'Failed to reprocess assessment: ' + error.message });
    }
});

/**
 * POST /api/assessment/:id/save-edit
 * Save individual field edit with audit trail (Human in Loop)
 * Immediately persists the change without full reprocessing
 */
app.post('/api/assessment/:id/save-edit', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), async (req, res) => {
    const assessmentId = req.params.id;
    const { field_key, category, year, field, old_value, new_value, reason, edited_by } = req.body;
    
    try {
        console.log(`📝 [Human in Loop] Saving edit for assessment ${assessmentId}`);
        console.log(`   Field: ${field_key}, Old: ${old_value}, New: ${new_value}`);
        console.log(`   Reason: ${reason}`);
        
        // Validate input
        if (!field_key || new_value === undefined) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        if (!reason || reason.trim() === '') {
            return res.status(400).json({ error: 'Reason is required for audit trail' });
        }
        
        // Get existing assessment
        let assessment = await getAssessmentById(assessmentId);
        
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        // Update the extracted data
        if (!assessment.all_extracted_data) assessment.all_extracted_data = {};
        if (!assessment.extracted_data) assessment.extracted_data = {};
        
        if (year) {
            // Financial data with year
            if (!assessment.all_extracted_data[category]) assessment.all_extracted_data[category] = {};
            if (!assessment.all_extracted_data[category][year]) assessment.all_extracted_data[category][year] = {};
            assessment.all_extracted_data[category][year][field] = new_value;
            
            if (!assessment.extracted_data[category]) assessment.extracted_data[category] = {};
            if (!assessment.extracted_data[category][year]) assessment.extracted_data[category][year] = {};
            assessment.extracted_data[category][year][field] = new_value;
        } else {
            // Non-year data (company_info, etc.)
            if (!assessment.all_extracted_data[category]) assessment.all_extracted_data[category] = {};
            assessment.all_extracted_data[category][field] = new_value;
            
            if (!assessment.extracted_data[category]) assessment.extracted_data[category] = {};
            assessment.extracted_data[category][field] = new_value;
        }
        
        // Add to edit audit trail
        if (!assessment.edit_audit_trail) assessment.edit_audit_trail = [];
        assessment.edit_audit_trail.push({
            field_key: field_key,
            category: category,
            year: year,
            field: field,
            old_value: old_value,
            new_value: new_value,
            reason: reason,
            edited_by: edited_by || req.user?.email || 'unknown',
            edited_at: new Date().toISOString()
        });
        
        assessment.last_edited_at = new Date().toISOString();
        assessment.last_edited_by = edited_by || req.user?.email;
        assessment.has_pending_edits = true;
        
        // Update in memory
        assessments.set(assessmentId, assessment);
        
        // Save to S3
        if (s3Client.isConfigured()) {
            try {
                const assessmentToSave = { ...assessment };
                if (assessmentToSave.documents) {
                    Object.keys(assessmentToSave.documents).forEach(k => {
                        if (assessmentToSave.documents[k]?.buffer) {
                            delete assessmentToSave.documents[k].buffer;
                        }
                    });
                }
                await s3Client.saveAssessment(assessmentId, assessmentToSave);
                console.log(`✅ [Human in Loop] Edit saved to S3 for ${assessmentId}`);
            } catch (s3Err) {
                console.error('Error saving to S3:', s3Err.message);
            }
        }
        
        console.log(`✅ [Human in Loop] Edit saved: ${field_key} = ${new_value} (Reason: ${reason})`);
        
        res.json({
            success: true,
            message: 'Edit saved successfully',
            assessment: assessment
        });
        
    } catch (error) {
        console.error('Save edit error:', error);
        res.status(500).json({ error: 'Failed to save edit: ' + error.message });
    }
});

// Helper function for server-side INR formatting
function formatINRServer(num) {
    if (num === null || num === undefined || isNaN(num) || num === 0) return '0';
    const absNum = Math.abs(Math.round(num));
    let x = absNum.toString();
    let lastThree = x.substring(x.length - 3);
    let otherNumbers = x.substring(0, x.length - 3);
    if (otherNumbers !== '') lastThree = ',' + lastThree;
    const formatted = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + lastThree;
    return (num < 0 ? '-' : '') + formatted;
}

// ============================================
// SERVER-SIDE PROCESSING API ENDPOINTS (NEW)
// ============================================

/**
 * GET /api/processing/status
 * Check if server-side processing is available
 * Performs actual health checks on all services IN PARALLEL with timeout
 */
app.get('/api/processing/status', ensureAuthenticated, async (req, res) => {
    const HEALTH_CHECK_TIMEOUT = 5000; // 5 second timeout for each health check
    
    // Helper to wrap health check with timeout
    const withTimeout = (promise, fallback, name) => {
        return Promise.race([
            promise,
            new Promise(resolve => setTimeout(() => {
                console.log(`[API] ${name} health check timed out after ${HEALTH_CHECK_TIMEOUT}ms`);
                resolve(fallback);
            }, HEALTH_CHECK_TIMEOUT))
        ]).catch(err => {
            console.error(`[API] ${name} health check error:`, err.message);
            return { ...fallback, error: err.message };
        });
    };
    
    // Get OCR Pipeline status (sync - fast)
    let ocrPipelineStatus = { pipelineLoaded: false, visionConfigured: false };
    let ocrStats = null;
    
    if (claudeExtractor.isOcrPipelineAvailable) {
        ocrPipelineStatus = claudeExtractor.isOcrPipelineAvailable();
    }
    if (claudeExtractor.getOcrPipelineStats) {
        ocrStats = claudeExtractor.getOcrPipelineStats();
    }
    
    // Run all health checks IN PARALLEL with timeouts
    const [visionHealthStatus, redisHealthStatus, claudeHealthStatus, socketHealthStatus] = await Promise.all([
        // Vision API health check (cached internally for 5 min)
        claudeExtractor.checkVisionHealth 
            ? withTimeout(
                claudeExtractor.checkVisionHealth(),
                { working: false, configured: ocrPipelineStatus.visionConfigured, details: 'Health check timed out' },
                'Vision API'
            )
            : Promise.resolve({ working: false, configured: false, details: 'Not available' }),
        
        // Redis health check
        bullQueue.checkHealth
            ? withTimeout(
                bullQueue.checkHealth(),
                { working: bullQueue.isReady(), configured: !!process.env.REDIS_URL, details: 'Health check timed out' },
                'Redis'
            )
            : Promise.resolve({ working: bullQueue.isReady(), configured: !!process.env.REDIS_URL, details: bullQueue.isReady() ? 'Connected' : 'Not connected' }),
        
        // Claude (via Bedrock) health check - SKIP actual API call, just check if initialized
        // The actual API test is expensive and slow, rely on initialization status.
        // Bedrock is "configured" if AWS_REGION is set (IAM role provides auth);
        // ANTHROPIC_API_KEY is checked too for legacy direct-API deployments.
        Promise.resolve({
            working: claudeProcessor.isReady(),
            configured: !!process.env.AWS_REGION || !!process.env.ANTHROPIC_API_KEY,
            mode: claudeProcessor.mode, // 'bedrock' | 'direct' | null — verifiable proof of which path is live
            details: claudeProcessor.isReady()
                ? `Claude (${claudeProcessor.mode === 'bedrock' ? 'Amazon Bedrock' : 'direct Anthropic API'}) initialized`
                : (process.env.AWS_REGION ? 'Bedrock region set but not initialized' : 'AWS_REGION / ANTHROPIC_API_KEY not set')
        }),
        
        // WebSocket health check (sync - fast)
        Promise.resolve(
            socketManager.checkHealth 
                ? socketManager.checkHealth() 
                : { working: socketManager.isReady(), configured: true, details: socketManager.isReady() ? 'Connected' : 'Not connected' }
        )
    ]);
    
    const status = {
        serverSideAvailable: bullQueue.isReady(),
        mode: bullQueue.isReady() ? 'server' : 'client',
        
        // Redis (Upstash) - detailed health
        redisConfigured: redisHealthStatus.configured,
        redisWorking: redisHealthStatus.working,
        redisDetails: redisHealthStatus.details,
        redisLatency: redisHealthStatus.latencyMs,
        redisError: redisHealthStatus.error,
        
        // Claude API - detailed health
        claudeConfigured: claudeHealthStatus.configured,
        claudeWorking: claudeHealthStatus.working,
        claudeReady: claudeHealthStatus.working, // Backward compatibility
        claudeDetails: claudeHealthStatus.details,
        claudeLatency: claudeHealthStatus.latencyMs,
        claudeError: claudeHealthStatus.error,
        
        // WebSocket - detailed health
        socketConfigured: socketHealthStatus.configured,
        socketWorking: socketHealthStatus.working,
        socketConnected: socketHealthStatus.working, // Backward compatibility
        socketDetails: socketHealthStatus.details,
        socketClients: socketHealthStatus.connectedClients,
        socketError: socketHealthStatus.error,
        
        // OCR Pipeline Status
        ocrPipelineLoaded: ocrPipelineStatus.pipelineLoaded,
        
        // Vision API - detailed health
        visionApiConfigured: visionHealthStatus ? visionHealthStatus.configured : ocrPipelineStatus.visionConfigured,
        visionApiWorking: visionHealthStatus ? visionHealthStatus.working : false,
        visionApiMethod: visionHealthStatus?.method || ocrPipelineStatus.visionMethod,
        visionApiDetails: visionHealthStatus?.details || ocrPipelineStatus.details,
        visionApiError: visionHealthStatus?.error || null,
        
        ocrStats: ocrStats
    };
    
    // Get BullMQ queue stats (Redis-based)
    if (bullQueue.isReady()) {
        status.queueStats = await bullQueue.getStats();
    } else {
        status.queueStats = { waiting: 0, active: 0, completed: 0, failed: 0, activeJobs: [], waitingJobs: [] };
    }
    
    // Also include in-memory job queue data (for completeness)
    const inMemoryJobs = {
        queued: jobQueue.queue?.length || 0,
        processing: jobQueue.processing?.size || 0,
        queuedJobs: (jobQueue.queue || []).map(j => ({
            assessmentId: j.id,
            company: j.company,
            addedAt: j.createdAt
        })),
        processingJobs: Array.from(jobQueue.processing?.entries() || []).map(([id, job]) => ({
            assessmentId: id,
            company: job.company,
            progress: job.progress,
            phase: job.phase,
            startTime: job.startedAt,
            currentDocument: job.currentDocument
        }))
    };
    status.inMemoryQueue = inMemoryJobs;
    
    // Merge: combine BullMQ and in-memory for display
    // If BullMQ has no active jobs, use in-memory
    if (status.queueStats.activeJobs.length === 0 && inMemoryJobs.processingJobs.length > 0) {
        status.queueStats.activeJobs = inMemoryJobs.processingJobs;
        status.queueStats.active = inMemoryJobs.processing;
    }
    if (status.queueStats.waitingJobs.length === 0 && inMemoryJobs.queuedJobs.length > 0) {
        status.queueStats.waitingJobs = inMemoryJobs.queuedJobs;
        status.queueStats.waiting = inMemoryJobs.queued;
    }
    
    res.json(status);
});

/**
 * POST /api/assessment/:id/process-server
 * Start server-side processing for an assessment
 */
app.post('/api/assessment/:id/process-server', ensureAuthenticated, ensureNotReadOnly, async (req, res) => {
    const assessmentId = req.params.id;
    const { documents } = req.body; // Array of { id, name, type, s3Key }
    
    // Check if server-side processing is available
    if (!bullQueue.isReady()) {
        return res.status(503).json({
            error: 'Server-side processing not available',
            message: 'REDIS_URL not configured. Using client-side processing.',
            fallback: 'client'
        });
    }
    
    if (!claudeProcessor.isReady()) {
        return res.status(503).json({
            error: 'Claude API not available',
            message: 'Neither AWS_REGION (Bedrock) nor ANTHROPIC_API_KEY (legacy) is configured on server.',
            fallback: 'client'
        });
    }
    
    try {
        // Get assessment info
        let assessment = await getAssessmentById(assessmentId);
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        // GUARD: Don't allow re-processing if already completed
        const completedStatuses = ['Approved', 'Rejected', 'Partial Approval', 'Complete', 'Completed'];
        if (completedStatuses.includes(assessment.status)) {
            console.log(`⚠️ Ignoring process-server for ${assessmentId} - already ${assessment.status}`);
            return res.json({
                success: true,
                message: 'Assessment already completed',
                status: assessment.status,
                alreadyComplete: true
            });
        }
        
        // Prepare document list
        const docList = documents || [];
        if (docList.length === 0) {
            // Try to build from assessment.documents
            if (assessment.documents) {
                for (const [key, doc] of Object.entries(assessment.documents)) {
                    if (doc && doc.s3Key) {
                        docList.push({
                            id: key,
                            name: doc.filename || doc.originalName || key,
                            type: doc.docType || 'balance_sheet',
                            s3Key: doc.s3Key
                        });
                    }
                }
            }
        }
        
        if (docList.length === 0) {
            return res.status(400).json({ error: 'No documents to process' });
        }
        
        // Load legal masters for legal risk assessment
        const legalRiskRules = mastersManager.getMasterRecords('legal_risk_rules') || [];
        const stateLegalRules = mastersManager.getMasterRecords('state_legal_rules') || [];
        const propertyTypes = mastersManager.getMasterRecords('property_types') || [];
        const encumbranceTypes = mastersManager.getMasterRecords('encumbrance_types') || [];
        
        console.log(`📋 Legal masters loaded: ${legalRiskRules.length} risk rules, ${stateLegalRules.length} state rules, ${propertyTypes.length} property types, ${encumbranceTypes.length} encumbrance types`);
        
        // Add job to queue
        const job = await bullQueue.addJob(assessmentId, {
            companyName: assessment.company_name,
            loanAmount: assessment.loan_amount_lakhs,
            industryType: assessment.industry_type || null,
            documents: docList,
            userId: assessment.created_by || req.user.email,  // Preserve original creator, not who clicks Process
            created_by_name: assessment.created_by_name || req.user.displayName || req.user.name || req.user.email,
            priority: req.body.priority || 1,
            // Legal masters for risk assessment
            legalRiskRules: legalRiskRules,
            stateLegalRules: stateLegalRules,
            propertyTypes: propertyTypes,
            encumbranceTypes: encumbranceTypes
        });
        
        // Update assessment status
        assessment.status = 'Processing';
        assessment.processing_mode = 'server';
        assessment.job_id = job.id;
        
        // Update in list
        const listIdx = assessmentsList.findIndex(a => (a.assessment_id || a.id) === assessmentId);
        if (listIdx >= 0) {
            assessmentsList[listIdx].status = 'Processing';
        }
        
        // Save to S3
        if (s3Client.isConfigured()) {
            await s3Client.saveAssessment(assessmentId, assessment);
        }
        
        console.log(`🚀 Server-side processing started for ${assessmentId} (${docList.length} docs)`);
        
        res.json({
            success: true,
            message: 'Server-side processing started',
            assessmentId,
            jobId: job.id,
            documentsCount: docList.length,
            mode: 'server'
        });
        
    } catch (err) {
        console.error('Error starting server processing:', err);
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * GET /api/assessment/:id/job-status
 * Get detailed job status from BullMQ
 */
app.get('/api/assessment/:id/job-status', ensureAuthenticated, async (req, res) => {
    const assessmentId = req.params.id;
    
    if (!bullQueue.isReady()) {
        return res.json({ status: 'not_available', mode: 'client' });
    }
    
    try {
        const status = await bullQueue.getJobStatus(assessmentId);
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * POST /api/assessment/:id/cancel-job
 * Cancel a queued/processing job
 */
app.post('/api/assessment/:id/cancel-job', ensureAuthenticated, ensureNotReadOnly, async (req, res) => {
    const assessmentId = req.params.id;
    
    if (!bullQueue.isReady()) {
        return res.json({ success: false, message: 'Queue not available' });
    }
    
    try {
        const cancelled = await bullQueue.cancelJob(assessmentId);
        
        if (cancelled) {
            // Update assessment status
            const assessment = await getAssessmentById(assessmentId);
            if (assessment) {
                assessment.status = 'Cancelled';
                if (s3Client.isConfigured()) {
                    await s3Client.saveAssessment(assessmentId, assessment);
                }
            }
            
            res.json({ success: true, message: 'Job cancelled' });
        } else {
            res.json({ success: false, message: 'Job not found or already completed' });
        }
    } catch (err) {
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * GET /api/queue/stats
 * Get queue statistics (for monitoring)
 */
app.get('/api/queue/stats', ensureAuthenticated, async (req, res) => {
    if (!bullQueue.isReady()) {
        return res.json({
            available: false,
            mode: 'client',
            stats: { waiting: 0, active: 0, completed: 0, failed: 0 }
        });
    }
    
    const stats = await bullQueue.getStats();
    res.json({
        available: true,
        mode: 'server',
        stats,
        activeSubscriptions: socketManager.getActiveSubscriptions()
    });
});

// ============================================
// MASTERS MANAGEMENT API ENDPOINTS
// ============================================

/**
 * GET /api/masters/types
 * Get all master types with record counts
 */
app.get('/api/masters/types', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    try {
        console.log(`✅ Masters access granted for user: ${req.user.email}, role: "${req.user.role}"`);
        const types = mastersManager.getMasterTypes();
        res.json(types);
    } catch (err) {
        console.error('Error getting master types:', err);
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * POST /api/masters/force-reseed
 * Force reseed all masters (clears existing data and reseeds)
 */
app.post('/api/masters/force-reseed', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), async (req, res) => {
    try {
        console.log(`⚠️  Force reseed requested by user: ${req.user.email}`);
        
        // Call force reseed function
        const result = await mastersManager.forceReseed();
        
        console.log(`✅ Force reseed complete: ${result.types_count} types, ${result.records_count} records`);
        
        res.json({
            success: true,
            types_count: result.types_count,
            records_count: result.records_count,
            message: 'All masters reseeded successfully'
        });
    } catch (err) {
        console.error('Error force reseeding masters:', err);
        res.status(500).json({ 
            success: false,
            error: err.message 
        });
    }
});

/**
 * POST /api/masters/reseed-policy-rules
 * Reseed ONLY policy rules from the policy schema (preserves other masters)
 */
app.post('/api/masters/reseed-policy-rules', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), async (req, res) => {
    try {
        console.log(`🔄 Reseed policy rules requested by: ${req.user.email}`);
        
        const result = mastersManager.reseedPolicyRules();
        
        // Also flush config cache to pick up new values
        await loadConfigCache();
        
        console.log(`✅ Policy rules reseeded: ${result.count} rules from ${result.source}`);
        
        res.json({
            success: true,
            count: result.count,
            source: result.source,
            message: `Reseeded ${result.count} policy rules from ${result.source}`,
            reseededBy: req.user.email,
            reseededAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('Error reseeding policy rules:', err);
        res.status(500).json({ 
            success: false,
            error: err.message 
        });
    }
});

/**
 * GET /api/parameters-schema
 * Get the comprehensive parameters schema
 */
app.get('/api/parameters-schema', ensureAuthenticated, (req, res) => {
    try {
        const schema = require('./lib/comprehensive-parameters-schema.json');
        res.json(schema);
    } catch (err) {
        console.error('Error loading parameters schema:', err);
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * GET /api/masters/all
 * Get all masters data in one call
 */
app.get('/api/masters/all', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    try {
        const types = mastersManager.getMasterTypes();
        const allData = {};
        
        types.forEach(type => {
            allData[type.key] = mastersManager.getMasterRecords(type.key);
        });
        
        res.json(allData);
    } catch (err) {
        console.error('Error getting all masters:', err);
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * GET /api/masters/:masterType/schema
 * Get schema definition for a master type
 */
app.get('/api/masters/:masterType/schema', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    const schema = mastersManager.getMasterSchema(req.params.masterType);
    if (!schema) {
        return res.status(404).json({ error: 'Master type not found' });
    }
    res.json(schema);
});

/**
 * GET /api/masters/:masterType
 * Get all records for a master type
 */
app.get('/api/masters/:masterType', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    const records = mastersManager.getMasterRecords(req.params.masterType);
    res.json({ records });
});

/**
 * GET /api/masters/:masterType/:id
 * Get single master record by ID
 */
app.get('/api/masters/:masterType/:id', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    const record = mastersManager.getMasterRecord(req.params.masterType, req.params.id);
    if (!record) {
        return res.status(404).json({ error: 'Record not found' });
    }
    res.json(record);
});

/**
 * POST /api/masters/:masterType
 * Create new master record
 */
app.post('/api/masters/:masterType', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    try {
        const record = mastersManager.addMasterRecord(
            req.params.masterType,
            req.body,
            req.user.email
        );
        res.json({ success: true, record });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * PUT /api/masters/:masterType/:id
 * Update existing master record
 */
app.put('/api/masters/:masterType/:id', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    try {
        const record = mastersManager.updateMasterRecord(
            req.params.masterType,
            req.params.id,
            req.body,
            req.user.email
        );
        res.json({ success: true, record });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * DELETE /api/masters/:masterType/:id
 * Delete master record
 */
app.delete('/api/masters/:masterType/:id', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    try {
        mastersManager.deleteMasterRecord(
            req.params.masterType,
            req.params.id,
            req.user.email
        );
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * GET /api/masters/audit/log
 * Get audit trail log with optional filters
 */
app.get('/api/masters/audit/log', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    const filters = {
        masterType: req.query.masterType,
        recordId: req.query.recordId,
        action: req.query.action,
        performedBy: req.query.performedBy,
        fromDate: req.query.fromDate,
        toDate: req.query.toDate,
        limit: parseInt(req.query.limit) || 100
    };
    
    const logs = mastersManager.getAuditLog(filters);
    res.json({ logs });
});

// ============================================
// POLICY RULES API ENDPOINTS
// ============================================

/**
 * GET /api/policy/rules
 * Get all policy rules with deviation status
 */
app.get('/api/policy/rules', ensureAuthenticated, (req, res) => {
    try {
        const rules = mastersManager.getPolicyRulesWithDeviation();
        const metadata = mastersManager.getPolicyMetadata();
        res.json({ 
            metadata,
            rules,
            total: rules.length
        });
    } catch (err) {
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * PUT /api/policy/rules/:ruleId
 * Update a policy rule with audit trail
 */
app.put('/api/policy/rules/:ruleId', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    try {
        const { ruleId } = req.params;
        const { newValue, reason } = req.body;
        const changedBy = req.user?.displayName || req.user?.email || 'Unknown';
        
        if (newValue === undefined || !reason) {
            return res.status(400).json({ error: 'newValue and reason are required' });
        }
        
        const auditEntry = mastersManager.updatePolicyRule(ruleId, newValue, changedBy, reason);
        res.json({ 
            success: true, 
            message: 'Policy rule updated successfully',
            audit: auditEntry
        });
    } catch (err) {
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * GET /api/policy/audit
 * Get policy change audit log
 */
app.get('/api/policy/audit', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    try {
        const logs = mastersManager.getPolicyAuditLog();
        res.json({ logs });
    } catch (err) {
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * POST /api/policy/import
 * Import policy rules from uploaded document
 */
app.post('/api/policy/import', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    try {
        const { extractedRules, sourcePolicyName } = req.body;
        const importedBy = req.user?.displayName || req.user?.email || 'Unknown';
        
        if (!extractedRules || !sourcePolicyName) {
            return res.status(400).json({ error: 'extractedRules and sourcePolicyName are required' });
        }
        
        const importLog = mastersManager.importPolicyRules(extractedRules, sourcePolicyName, importedBy);
        res.json({ 
            success: true, 
            message: `Imported ${importLog.length} policy rules`,
            importLog
        });
    } catch (err) {
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * GET /api/policy/metadata
 * Get policy metadata
 */
app.get('/api/policy/metadata', ensureAuthenticated, (req, res) => {
    try {
        const metadata = mastersManager.getPolicyMetadata();
        res.json(metadata);
    } catch (err) {
        res.status(500).json({ error: sanitizeError(err) });
    }
});

// ============================================
// CONFIGURATION CACHE API ENDPOINTS
// ============================================

/**
 * GET /api/config/cache
 * Get current configuration cache
 */
app.get('/api/config/cache', ensureAuthenticated, (req, res) => {
    try {
        const cache = getConfigCache();
        res.json({
            success: true,
            cache: {
                policy_rules_count: cache.policy_rules.length,
                scoring_weights_count: cache.scoring_weights.length,
                scoring_metrics_count: cache.scoring_metrics.length,
                scoring_grades_count: cache.scoring_grades.length,
                limit_params_count: cache.limit_params.length,
                lastLoaded: cache.lastLoaded,
                isLoaded: cache.isLoaded
            }
        });
    } catch (err) {
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * GET /api/config/all
 * Get full configuration data (for calculation engine)
 */
app.get('/api/config/all', ensureAuthenticated, (req, res) => {
    try {
        const cache = getConfigCache();
        res.json({
            success: true,
            policy_rules: cache.policy_rules,
            scoring_weights: cache.scoring_weights,
            scoring_metrics: cache.scoring_metrics,
            scoring_grades: cache.scoring_grades,
            limit_params: cache.limit_params,
            lastLoaded: cache.lastLoaded
        });
    } catch (err) {
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * POST /api/config/flush
 * Flush and reload configuration cache
 */
app.post('/api/config/flush', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), async (req, res) => {
    try {
        const newCache = await flushConfigCache();
        const user = req.user?.displayName || req.user?.email || 'Unknown';
        
        console.log(`🔄 Config cache flushed by ${user}`);
        
        res.json({
            success: true,
            message: 'Configuration cache flushed and reloaded successfully',
            cache: {
                policy_rules_count: newCache.policy_rules.length,
                scoring_weights_count: newCache.scoring_weights.length,
                scoring_metrics_count: newCache.scoring_metrics.length,
                scoring_grades_count: newCache.scoring_grades.length,
                limit_params_count: newCache.limit_params.length,
                lastLoaded: newCache.lastLoaded
            },
            flushedBy: user,
            flushedAt: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * GET /api/admin/s3-index
 * View the raw S3 assessment index — Super Admin only
 * Returns all assessment summaries as stored in S3 index
 */
app.get('/api/admin/s3-index', ensureAuthenticated, requireRole('Super Admin', 'super_admin'), async (req, res) => {
    try {
        if (!s3Client.isConfigured()) {
            return res.status(400).json({ error: 'S3 not configured' });
        }
        
        const summaries = await s3Client.getAllAssessmentSummaries();
        
        // Collect unique created_by values
        const creators = [...new Set(summaries.map(s => s.created_by).filter(Boolean))].sort();
        
        // Summary stats
        const stats = {
            total: summaries.length,
            byStatus: {},
            byCreator: {},
            byType: {},
            oldestDate: null,
            newestDate: null
        };
        
        summaries.forEach(s => {
            const status = s.status || 'Unknown';
            stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
            
            const creator = s.created_by || 'Unknown';
            stats.byCreator[creator] = (stats.byCreator[creator] || 0) + 1;
            
            const type = s.type || 'actual';
            stats.byType[type] = (stats.byType[type] || 0) + 1;
            
            const date = s.created_at || s.updated_at;
            if (date) {
                if (!stats.oldestDate || date < stats.oldestDate) stats.oldestDate = date;
                if (!stats.newestDate || date > stats.newestDate) stats.newestDate = date;
            }
        });
        
        res.json({
            stats,
            creators,
            assessments: summaries.map(s => ({
                assessment_id: s.assessment_id || s.id,
                company_name: s.company_name || 'N/A',
                status: s.status || 'Unknown',
                created_by: s.created_by || 'N/A',
                type: s.type || 'actual',
                loan_amount_lakhs: s.loan_amount_lakhs || 0,
                product: s.product || '',
                branch: s.branch || '',
                grade: s.grade || '',
                score: s.score || '',
                created_at: s.created_at || '',
                updated_at: s.updated_at || '',
                completed_at: s.completed_at || ''
            }))
        });
    } catch (err) {
        console.error('Error fetching S3 index:', err.message);
        res.status(500).json({ error: 'Failed to fetch S3 index', message: err.message });
    }
});

/**
 * POST /api/admin/clear-job-queue
 * Clear all stuck jobs from the in-memory job queue
 * This fixes assessments showing "Queued" or "Processing" when they're actually complete
 */
app.post('/api/admin/clear-job-queue', ensureAuthenticated, requireRole('Super Admin', 'super_admin'), async (req, res) => {
    try {
        const user = req.user?.displayName || req.user?.email || 'Unknown';
        
        // Get queue stats before clearing
        const beforeStats = {
            queued: jobQueue.queue?.length || 0,
            processing: jobQueue.processing?.size || 0
        };
        
        // Clear the in-memory job queue
        if (jobQueue.queue) jobQueue.queue = [];
        if (jobQueue.processing) jobQueue.processing.clear();
        
        // Also clear BullMQ active jobs tracking if available
        if (bullQueue && bullQueue.activeJobs) {
            bullQueue.activeJobs.clear();
        }
        
        // Optionally drain BullMQ queue (remove waiting jobs)
        let bullStats = { drained: false };
        if (bullQueue && bullQueue.isReady()) {
            try {
                await bullQueue.queue.drain();
                bullStats.drained = true;
            } catch (e) {
                bullStats.error = e.message;
            }
        }
        
        console.log(`🧹 Job queue cleared by ${user}`);
        console.log(`   Before: ${beforeStats.queued} queued, ${beforeStats.processing} processing`);
        
        res.json({
            success: true,
            message: 'Job queue cleared successfully',
            before: beforeStats,
            after: {
                queued: 0,
                processing: 0
            },
            bullQueue: bullStats,
            clearedBy: user,
            clearedAt: new Date().toISOString(),
            note: 'Refresh the dashboard to see updated statuses'
        });
    } catch (err) {
        console.error('Error clearing job queue:', err);
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * POST /api/admin/reset-stuck-assessments
 * Reset assessments stuck in Processing/Queued status
 */
app.post('/api/admin/reset-stuck-assessments', ensureAuthenticated, requireRole('Super Admin', 'super_admin'), async (req, res) => {
    try {
        const user = req.user?.displayName || req.user?.email || 'Unknown';
        const resetted = [];
        
        // Find assessments with stuck status
        for (const assessment of assessmentsList) {
            const id = assessment.assessment_id || assessment.id;
            const status = assessment.status;
            
            // Check if status is stuck (Queued, Processing) but has completed_at
            if ((status === 'Queued' || status === 'Processing' || status === 'Pending') && assessment.completed_at) {
                // This assessment was completed but status wasn't updated
                // Try to get the full assessment to find the real status
                const fullAssessment = await getAssessmentById(id);
                if (fullAssessment && fullAssessment.status && fullAssessment.status !== status) {
                    assessment.status = fullAssessment.status;
                    assessment.score = fullAssessment.score;
                    assessment.grade = fullAssessment.grade;
                    resetted.push({ id, from: status, to: fullAssessment.status });
                }
            }
        }
        
        // Also clear job queue
        if (jobQueue.queue) jobQueue.queue = [];
        if (jobQueue.processing) jobQueue.processing.clear();
        
        console.log(`🔧 Reset ${resetted.length} stuck assessments by ${user}`);
        
        res.json({
            success: true,
            message: `Reset ${resetted.length} stuck assessments`,
            resetted,
            clearedBy: user,
            clearedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('Error resetting stuck assessments:', err);
        res.status(500).json({ error: sanitizeError(err) });
    }
});

// ============================================
// AML SCREENING API ENDPOINTS
// ============================================

/**
 * POST /api/aml/screen/:assessmentId
 * Trigger AML screening for an assessment
 */
app.post('/api/aml/screen/:assessmentId', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), async (req, res) => {
    try {
        const assessmentId = req.params.assessmentId;
        const assessment = await getAssessmentById(assessmentId);
        
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        const screeningResult = await amlScreening.screenAssessment(assessment, req.user.email);
        
        // If auto-reject, create investigation case
        if (screeningResult.auto_decisions.auto_reject) {
            investigationManager.createInvestigationCase(
                assessment,
                {
                    rejection_reason: 'AML screening match - sanctioned entity',
                    rejection_category: 'AML',
                    rejected_by: 'system',
                    rejection_stage: 'AML Screening'
                },
                'system'
            );
        }
        
        res.json({ success: true, screening: screeningResult });
    } catch (err) {
        console.error('AML screening error:', err);
        res.status(500).json({ error: sanitizeError(err) });
    }
});

/**
 * GET /api/aml/screening/:assessmentId
 * Get AML screening result for assessment
 */
app.get('/api/aml/screening/:assessmentId', ensureAuthenticated, (req, res) => {
    const screening = amlScreening.getScreeningByAssessmentId(req.params.assessmentId);
    if (!screening) {
        return res.status(404).json({ error: 'No screening found for this assessment' });
    }
    res.json(screening);
});

/**
 * POST /api/aml/screening/:screeningId/override
 * Manual override of AML screening result
 */
app.post('/api/aml/screening/:screeningId/override', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    try {
        const { decision, reason } = req.body;
        const screening = amlScreening.overrideScreening(
            req.params.screeningId,
            decision,
            req.user.email,
            reason
        );
        res.json({ success: true, screening });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ============================================
// INVESTIGATION & FRAUD DATABASE ENDPOINTS
// ============================================

/**
 * GET /api/investigation/list
 * Get all investigation cases
 */
app.get('/api/investigation/list', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    const filters = {
        status: req.query.status,
        type: req.query.type,
        priority: req.query.priority
    };
    
    const cases = investigationManager.getAllInvestigations(filters);
    res.json({ cases });
});

/**
 * GET /api/investigation/:investigationId
 * Get single investigation case
 */
app.get('/api/investigation/:investigationId', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    const investigation = investigationManager.getInvestigation(req.params.investigationId);
    if (!investigation) {
        return res.status(404).json({ error: 'Investigation not found' });
    }
    res.json(investigation);
});

/**
 * POST /api/investigation/create
 * Create investigation case manually
 */
app.post('/api/investigation/create', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), async (req, res) => {
    try {
        const { assessmentId, rejectionReason } = req.body;
        const assessment = await getAssessmentById(assessmentId);
        
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        const investigation = investigationManager.createInvestigationCase(
            assessment,
            {
                rejection_reason: rejectionReason,
                rejection_category: 'Manual',
                rejected_by: req.user.email
            },
            req.user.email
        );
        
        res.json({ success: true, investigation });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * PUT /api/investigation/:investigationId/update
 * Update investigation case
 */
app.put('/api/investigation/:investigationId/update', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    try {
        const investigation = investigationManager.updateInvestigation(
            req.params.investigationId,
            req.body,
            req.user.email
        );
        res.json({ success: true, investigation });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * POST /api/investigation/:investigationId/indicator
 * Add fraud indicator to investigation
 */
app.post('/api/investigation/:investigationId/indicator', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    try {
        const indicator = investigationManager.addFraudIndicator(
            req.params.investigationId,
            req.body,
            req.user.email
        );
        res.json({ success: true, indicator });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * POST /api/investigation/:investigationId/close
 * Close investigation case
 */
app.post('/api/investigation/:investigationId/close', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    try {
        const { decision, rationale } = req.body;
        const investigation = investigationManager.closeInvestigation(
            req.params.investigationId,
            decision,
            req.user.email,
            rationale
        );
        res.json({ success: true, investigation });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * GET /api/investigation/statistics
 * Get investigation statistics
 */
app.get('/api/investigation/statistics', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    const stats = investigationManager.getStatistics();
    res.json(stats);
});

/**
 * POST /api/fraud/check
 * Check if entity is blacklisted
 */
app.post('/api/fraud/check', ensureAuthenticated, async (req, res) => {
    try {
        const { pan, cin, gstin, directors } = req.body;
        const result = investigationManager.checkBlacklist({
            pan,
            cin,
            gstin,
            directors
        });
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * GET /api/fraud/search
 * Search fraud database
 */
app.get('/api/fraud/search', ensureAuthenticated, requireRole(ROLES.SUPER_ADMIN, ROLES.ADMIN), (req, res) => {
    const query = req.query.q || '';
    const results = investigationManager.searchFraudDatabase(query);
    res.json({ results });
});

/**
 * GET /api/assessment/:id/export-pdf
 * Export assessment report as PDF
 */
app.get('/api/assessment/:id/export-pdf', ensureAuthenticated, async (req, res) => {
    const id = req.params.id;
    
    // Log PII access - exports contain sensitive financial data
    logPIIAccess(req.user?.email, 'export', 'assessment_pdf', id, req, 'export_pdf_report');
    logSecurityEvent('DATA_EXPORT', { assessmentId: id, format: 'PDF' }, req);
    
    let assessment = await getAssessmentById(id);
    
    if (!assessment) {
        return res.status(404).json({ error: 'Assessment not found' });
    }
    
    try {
        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ 
            margin: 50,
            size: 'A4',
            bufferPages: true,
            info: {
                Title: 'Credit Assessment Report',
                Author: 'Agentic Underwriting Platform',
                Subject: `Assessment for ${assessment.company_name}`,
                Creator: 'Applied Cloud Computing'
            }
        });
        
        // Set response headers
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${id}_Assessment_Report.pdf"`);
        
        // Pipe PDF to response
        doc.pipe(res);
        
        // Professional color scheme
        const COLOR_PRIMARY = '#1e40af';
        const COLOR_SUCCESS = '#16a34a';
        const COLOR_DANGER = '#dc2626';
        const COLOR_WARNING = '#ea580c';
        const COLOR_TEXT = '#1f2937';
        const COLOR_LIGHT = '#6b7280';
        const COLOR_BG = '#f9fafb';
        const PAGE_WIDTH = doc.page.width - 100;
        
        // Helper functions
        const formatCurrency = (val) => {
            if (!val || val === 0) return 'N/A';
            return '₹' + (val / 10000000).toFixed(2) + ' Cr';
        };
        
        const formatPercent = (val) => {
            if (!val && val !== 0) return 'N/A';
            return val.toFixed(2) + '%';
        };
        
        const drawLine = () => {
            doc.strokeColor('#e5e7eb').lineWidth(0.5)
               .moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
        };
        
        const addSectionHeader = (title, subtitle = null) => {
            doc.fontSize(16).fillColor(COLOR_PRIMARY).font('Helvetica-Bold').text(title);
            if (subtitle) {
                doc.fontSize(10).fillColor(COLOR_LIGHT).font('Helvetica').text(subtitle);
            }
            doc.moveDown(0.5);
            drawLine();
            doc.moveDown(0.8);
            doc.fillColor(COLOR_TEXT).font('Helvetica');
        };
        
        const decision = assessment.status === 'Approved' ? 'APPROVED' : 
                        assessment.status === 'Rejected' ? 'REJECTED' : 'PARTIAL APPROVAL';
        const grade = assessment.grade || 'N/A';
        const score = assessment.score || assessment.credit_score?.total || 0;
        const decisionColor = decision.includes('APPROVED') ? COLOR_SUCCESS : 
                             decision.includes('REJECTED') ? COLOR_DANGER : COLOR_WARNING;
        
        // ===================================
        // PAGE 1: PROFESSIONAL COVER PAGE
        // ===================================
        
        // Header banner
        doc.fillColor(COLOR_PRIMARY).rect(0, 0, doc.page.width, 100).fill();
        doc.fillColor('#ffffff').fontSize(26).font('Helvetica-Bold')
           .text('CREDIT ASSESSMENT REPORT', 50, 30, { align: 'center' });
        doc.fontSize(11).font('Helvetica')
           .text('Comprehensive Underwriting Analysis', 50, 65, { align: 'center' });
        
        doc.moveDown(3);
        
        // Company name box
        const boxY = 130;
        doc.fillColor(COLOR_BG).rect(50, boxY, PAGE_WIDTH, 50).fill()
           .strokeColor('#e5e7eb').rect(50, boxY, PAGE_WIDTH, 50).stroke();
        doc.fillColor(COLOR_TEXT).fontSize(20).font('Helvetica-Bold')
           .text(assessment.company_name || 'Company Name', 60, boxY + 15, {
               width: PAGE_WIDTH - 20, align: 'center'
           });
        
        doc.moveDown(3);
        
        // Decision card
        const cardY = 210;
        doc.fillColor('#ffffff').rect(50, cardY, PAGE_WIDTH, 160).fill()
           .strokeColor('#e5e7eb').lineWidth(1).rect(50, cardY, PAGE_WIDTH, 160).stroke();
        
        // Decision header
        doc.fillColor(decisionColor).rect(50, cardY, PAGE_WIDTH, 35).fill();
        doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold')
           .text(decision, 60, cardY + 10);
        
        // Summary details
        doc.fillColor(COLOR_TEXT).fontSize(10).font('Helvetica');
        const details = [
            {y: 60, items: [['Credit Grade:', grade, 80], ['Credit Score:', score + '/100', 320]]},
            {y: 85, items: [['Assessment ID:', id, 80], ['Generated:', new Date().toLocaleDateString('en-IN'), 320]]},
            {y: 110, items: [['Loan Amount:', formatCurrency(assessment.loan_amount_lakhs ? assessment.loan_amount_lakhs * 100000 : 0), 80], 
                            ['Date:', assessment.created_at ? new Date(assessment.created_at).toLocaleDateString('en-IN') : 'N/A', 320]]}
        ];
        
        details.forEach(row => {
            row.items.forEach(([label, value, x]) => {
                doc.fillColor(COLOR_LIGHT).text(label, 60, cardY + row.y);
                doc.fillColor(COLOR_TEXT).font('Helvetica-Bold').text(value, x, cardY + row.y);
                doc.font('Helvetica');
            });
        });
        
        // Confidentiality notice
        doc.fontSize(8).fillColor(COLOR_LIGHT).font('Helvetica-Oblique')
           .text('CONFIDENTIAL - This report contains proprietary information', 50, doc.page.height - 80, { align: 'center' });
        doc.font('Helvetica')
           .text('© 2025 Applied Cloud Computing Private Limited | CIN: U72900MH2023PTC379649', 50, doc.page.height - 60, { align: 'center' });
        
        // ===================================
        // PAGE 2: CREDIT SCORE BREAKDOWN
        // ===================================
        doc.addPage();
        addSectionHeader('Credit Score Analysis', 'Detailed component breakdown and scoring methodology');
        
        const cs = assessment.credit_score || assessment.calculations?.credit_score;
        
        if (cs && cs.components) {
            // Score summary
            doc.fillColor(COLOR_PRIMARY).rect(50, doc.y, PAGE_WIDTH, 45).fill();
            doc.fillColor('#ffffff').fontSize(13).font('Helvetica-Bold')
               .text(`Total Score: ${cs.total}/${cs.max} | Grade: ${cs.grade}`, 60, doc.y - 35);
            doc.fontSize(10).font('Helvetica')
               .text(`Decision: ${cs.decision}`, 60, doc.y - 18);
            doc.moveDown(3);
            
            // Component table header
            doc.fillColor(COLOR_PRIMARY).rect(50, doc.y, PAGE_WIDTH, 22).fill();
            doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
            doc.text('Component', 55, doc.y - 17, { width: 200 });
            doc.text('Score', 300, doc.y - 17, { width: 80, align: 'center' });
            doc.text('Achievement', 420, doc.y - 17, { width: 100, align: 'right' });
            
            let tableY = doc.y + 5;
            doc.fillColor(COLOR_TEXT).font('Helvetica');
            
            const compNames = [
                { key: 'financial_strength', label: 'Financial Strength' },
                { key: 'banking_conduct', label: 'Banking Conduct' },
                { key: 'credit_history', label: 'Credit History' },
                { key: 'business_stability', label: 'Business Stability' },
                { key: 'security_coverage', label: 'Security Coverage' }
            ];
            
            compNames.forEach((item, i) => {
                const comp = cs.components[item.key];
                if (comp) {
                    const bg = i % 2 === 0 ? '#ffffff' : COLOR_BG;
                    doc.fillColor(bg).rect(50, tableY, PAGE_WIDTH, 18).fill();
                    
                    doc.fillColor(COLOR_TEXT).fontSize(9);
                    doc.text(item.label, 55, tableY + 5, { width: 200 });
                    doc.text(`${comp.score}/${comp.max}`, 300, tableY + 5, { width: 80, align: 'center' });
                    doc.text(((comp.score/comp.max)*100).toFixed(0) + '%', 420, tableY + 5, { width: 100, align: 'right' });
                    
                    tableY += 18;
                }
            });
            
            doc.y = tableY + 15;
            
            // Detailed breakdown
            doc.fontSize(11).fillColor(COLOR_PRIMARY).font('Helvetica-Bold').text('Detailed Component Analysis');
            doc.moveDown(0.8);
            
            compNames.forEach(item => {
                const comp = cs.components[item.key];
                if (comp && comp.breakdown && comp.breakdown.length > 0) {
                    doc.fontSize(10).fillColor(COLOR_TEXT).font('Helvetica-Bold').text(item.label);
                    doc.fontSize(8).fillColor(COLOR_LIGHT).font('Helvetica');
                    comp.breakdown.forEach(b => {
                        doc.text(`  • ${b.metric}: ${b.value} → Score: ${b.score}/${b.max || '-'}`, { indent: 10 });
                    });
                    doc.moveDown(0.6);
                }
            });
        }
        
        // Add page numbers
        const pages = doc.bufferedPageRange();
        for (let i = 0; i < pages.count; i++) {
            doc.switchToPage(i);
            doc.fontSize(8).fillColor(COLOR_LIGHT)
               .text(`Page ${i + 1} of ${pages.count}`, 50, doc.page.height - 30, { align: 'center' });
        }
        
        // Finalize
        doc.end();
        
    } catch (err) {
        console.error('PDF generation error:', err);
        res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
    }
});

/**
 * GET /api/assessment/:id/export-docx
/**
 * ============================================================
 * External Integration APIs — manual/human-interactive steps
 * ============================================================
 * These cannot run unattended in the background pipeline (bull-queue.js)
 * because they require a human in the loop (OTP entry) or async polling
 * (Novel's autofetch/download). The automatable subset (Pennant by
 * finReference, Karza ITR, CIBIL Commercial, Novel upload) already runs
 * automatically during assessment processing — see bull-queue.js.
 *
 * ⚠️ Response field mappings for CIBIL Commercial/Individual and Novel's
 * download step are NOT YET VERIFIED against real UAT responses (the
 * provided API specs only included sample requests for these). Raw
 * responses are always saved to S3 regardless of normalization accuracy.
 */

// Manual Pennant lookup (e.g. once finReference is captured at intake,
// or for ad-hoc lookup by an underwriter)
app.post('/api/external/pennant', ensureAuthenticated, async (req, res) => {
    if (!pennantClient) return res.status(503).json({ error: 'Pennant client not available' });
    const { finReference, assessmentId } = req.body || {};
    try {
        const result = await pennantClient.getLoanDetails({ finReference, assessmentId });
        res.json({ success: result.success, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// EPFO UAN lookup — step 1: send OTP to borrower's mobile
app.post('/api/external/epfo/send-otp', ensureAuthenticated, async (req, res) => {
    if (!externalApisManager) return res.status(503).json({ error: 'External APIs manager not available' });
    const { mobile, assessmentId } = req.body || {};
    try {
        const result = await externalApisManager.epfoLookupOTP({ mobile, assessmentId });
        res.json({ success: result.success, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// EPFO UAN lookup — step 2: authenticate with the OTP the borrower received
app.post('/api/external/epfo/authenticate', ensureAuthenticated, async (req, res) => {
    if (!externalApisManager) return res.status(503).json({ error: 'External APIs manager not available' });
    const { requestId, otp, assessmentId } = req.body || {};
    try {
        const result = await externalApisManager.epfoAuthenticate({ requestId, otp, assessmentId });
        res.json({ success: result.success, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Individual CIBIL (SOAP) — step 1: submit request, get bureauOneRefNo
app.post('/api/external/cibil-individual/submit', ensureAuthenticated, async (req, res) => {
    if (!cibilSoapClient) return res.status(503).json({ error: 'CIBIL SOAP client not available' });
    try {
        const result = await cibilSoapClient.processIndividualRequest({ ...req.body });
        res.json({ success: result.success, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Individual CIBIL (SOAP) — step 2: download report by reference number
app.post('/api/external/cibil-individual/download', ensureAuthenticated, async (req, res) => {
    if (!cibilSoapClient) return res.status(503).json({ error: 'CIBIL SOAP client not available' });
    const { bureauOneRefNo, assessmentId } = req.body || {};
    try {
        const result = await cibilSoapClient.downloadByRefNo({ bureauOneRefNo, assessmentId });
        res.json({ success: result.success, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Novel — generate auto-fetch URL (borrower net-banking flow)
app.post('/api/external/novel/autofetch', ensureAuthenticated, async (req, res) => {
    if (!externalApisManager) return res.status(503).json({ error: 'External APIs manager not available' });
    try {
        const result = await externalApisManager.novelGenerateAutoFetchURL({ ...req.body });
        res.json({ success: result.success, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Novel — download processed bank statement analysis by document ID
app.post('/api/external/novel/download', ensureAuthenticated, async (req, res) => {
    if (!externalApisManager) return res.status(503).json({ error: 'External APIs manager not available' });
    const { docId, assessmentId } = req.body || {};
    try {
        const result = await externalApisManager.novelDownloadBankStatement({ docId, assessmentId });
        res.json({ success: result.success, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * ============================================================
 * CAM (Credit Assessment Model) Eligibility API
 * ============================================================
 * Surrogate eligibility programs: GROSS_MARGIN, PROFESSIONAL_RECEIPT,
 * BANKING, CASH_PROFIT. All amounts are in INR Lakhs.
 */

// Reference config for building CAM input forms (programs, LTV table, methods)
app.get('/api/cam/config', ensureAuthenticated, (req, res) => {
    try {
        const cfg = calculationEngine.cam.getDefaultConfig();
        res.json({ success: true, config: cfg });
    } catch (err) {
        console.error('[CAM] config error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Stateless ad-hoc CAM evaluation (no assessment required)
app.post('/api/cam/evaluate', ensureAuthenticated, (req, res) => {
    try {
        const camInput = req.body || {};
        if (!camInput.program) {
            return res.status(400).json({ success: false, error: 'program is required' });
        }
        const result = calculationEngine.calculateCamEligibility(camInput);
        res.json({ success: true, result });
    } catch (err) {
        console.error('[CAM] evaluate error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// Suggested CAM input defaults derived from an assessment's extracted data
app.get('/api/assessment/:id/cam/defaults', ensureAuthenticated, async (req, res) => {
    try {
        const assessment = await getAssessmentById(req.params.id);
        if (!assessment) return res.status(404).json({ success: false, error: 'Assessment not found' });
        const ed = assessment.all_extracted_data || assessment.extracted_data || {};
        const defaults = calculationEngine.deriveCamDefaults(ed);
        res.json({ success: true, defaults });
    } catch (err) {
        console.error('[CAM] defaults error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Fetch stored CAM input + result for an assessment
app.get('/api/assessment/:id/cam', ensureAuthenticated, async (req, res) => {
    try {
        const assessment = await getAssessmentById(req.params.id);
        if (!assessment) return res.status(404).json({ success: false, error: 'Assessment not found' });
        res.json({
            success: true,
            cam_input: assessment.cam_input || null,
            cam_eligibility: assessment.cam_eligibility || assessment.calculations?.cam_eligibility || null
        });
    } catch (err) {
        console.error('[CAM] get error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Accept + store CAM input, evaluate, persist to S3
app.post('/api/assessment/:id/cam', ensureAuthenticated, ensureNotReadOnly, async (req, res) => {
    const assessmentId = req.params.id;
    try {
        const camInput = req.body || {};
        if (!camInput.program) {
            return res.status(400).json({ success: false, error: 'program is required' });
        }

        const assessment = await getAssessmentById(assessmentId);
        if (!assessment) return res.status(404).json({ success: false, error: 'Assessment not found' });

        // Evaluate
        const result = calculationEngine.calculateCamEligibility(camInput);

        // Persist onto the assessment (both top-level and inside calculations for the report)
        assessment.cam_input = camInput;
        assessment.cam_eligibility = result;
        if (!assessment.calculations) assessment.calculations = {};
        assessment.calculations.cam_eligibility = result;

        // Also persist cam_input into extracted data so future recalculations include CAM
        assessment.all_extracted_data = assessment.all_extracted_data || assessment.extracted_data || {};
        assessment.all_extracted_data.cam_input = camInput;
        if (assessment.extracted_data) assessment.extracted_data.cam_input = camInput;

        assessment.cam_updated_at = new Date().toISOString();
        assessment.cam_updated_by = req.user?.email || 'unknown';

        assessments.set(assessmentId, assessment);

        if (s3Client.isConfigured()) {
            try {
                await s3Client.saveAssessment(assessmentId, assessment);
            } catch (s3err) {
                console.error('[CAM] S3 save warning:', s3err.message);
            }
        }

        res.json({ success: true, cam_eligibility: result });
    } catch (err) {
        console.error('[CAM] save error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * Export assessment report as Word document (comprehensive)
 */
app.get('/api/assessment/:id/export-docx', ensureAuthenticated, async (req, res) => {
    const id = req.params.id;
    
    // Log PII access - exports contain sensitive financial data
    logPIIAccess(req.user?.email, 'export', 'assessment_docx', id, req, 'export_docx_report');
    logSecurityEvent('DATA_EXPORT', { assessmentId: id, format: 'DOCX' }, req);
    
    let assessment = await getAssessmentById(id);
    
    if (!assessment) {
        return res.status(404).json({ error: 'Assessment not found' });
    }
    
    try {
        const docxGenerator = require('./lib/docx-generator');
        const buffer = await docxGenerator.generateReport(assessment);
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${id}_Assessment_Report.docx"`);
        res.send(buffer);
        
    } catch (err) {
        console.error('DOCX generation error:', err);
        res.status(500).json({ error: 'Failed to generate DOCX: ' + err.message });
    }
});

/**
 * GET /api/assessment/:id/forensic-export
 * Generate complete forensic export for audit/legal purposes
 * Requires Super Admin role
 */
app.get('/api/assessment/:id/forensic-export', ensureAuthenticated, requireRole('Super Admin', 'super_admin'), async (req, res) => {
    const id = req.params.id;
    const reason = req.query.reason || 'Not specified';
    const includeDocuments = req.query.include_documents !== 'false';
    
    // Log this sensitive action
    logPIIAccess(req.user?.email, 'forensic_export', 'full_assessment', id, req, reason);
    logSecurityEvent('FORENSIC_EXPORT', { 
        assessmentId: id, 
        reason: reason,
        includeDocuments: includeDocuments
    }, req);
    
    console.log(`\n🔒 FORENSIC EXPORT REQUESTED`);
    console.log(`   Assessment: ${id}`);
    console.log(`   By: ${req.user?.email}`);
    console.log(`   Reason: ${reason}`);
    
    // Validate reason is provided
    if (!reason || reason === 'Not specified') {
        return res.status(400).json({ 
            error: 'Export reason is required',
            message: 'Please provide a reason for the forensic export via ?reason=<your_reason>'
        });
    }
    
    let assessment = await getAssessmentById(id);
    
    if (!assessment) {
        return res.status(404).json({ error: 'Assessment not found' });
    }
    
    try {
        const forensicExport = require('./lib/forensic-export');
        
        // Get PII access logs for this assessment (if available)
        // In production, filter from S3 PII audit logs
        const piiAccessLogs = []; // TODO: Fetch from S3 logs filtered by assessmentId
        
        // Create forensic export
        const exportPackage = await forensicExport.createForensicExport(
            assessment,
            s3Client,
            {
                includeDocuments: includeDocuments,
                includeOCR: true,
                includeAILogs: true,
                includePIIAccessLogs: true,
                exportReason: reason,
                exportedBy: req.user?.email || 'Unknown',
                piiAccessLogs: piiAccessLogs
            }
        );
        
        // Create ZIP response
        const archiver = require('archiver');
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        // Set response headers
        const filename = `${exportPackage.exportId}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        // Pipe archive to response
        archive.pipe(res);
        
        // Add all files to archive
        for (const [filePath, fileData] of Object.entries(exportPackage.files)) {
            if (fileData.isBuffer) {
                archive.append(fileData.content, { name: filePath });
            } else {
                archive.append(fileData.content, { name: filePath });
            }
        }
        
        // Finalize archive
        await archive.finalize();
        
        console.log(`✅ Forensic export sent: ${filename}`);
        
    } catch (err) {
        console.error('Forensic export error:', err);
        res.status(500).json({ error: 'Failed to generate forensic export: ' + err.message });
    }
});

/**
 * POST /api/assessment/create
 * Create a new assessment session
 */
app.post('/api/assessment/create', ensureAuthenticated, ensureNotReadOnly, (req, res) => {
    try {
        const { companyName, loanAmount, industryType, loanAccountNumber, pennantData } = req.body;
        
        if (!companyName) {
            return res.status(400).json({ error: 'Company name is required' });
        }
        
        const assessmentId = `ACC-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
        
        const assessment = {
            assessment_id: assessmentId,
            company_name: companyName,
            loan_amount_lakhs: parseFloat(loanAmount) || 0,
            industry_type: industryType || null,
            loan_account_number: loanAccountNumber || null, // Pennant LOS finReference — sourced applicant details from here, not manual entry
            pennant_data: pennantData || null,
            type: 'actual',
            created_by: req.user.email,  // Email for identification
            created_by_name: req.user.displayName || req.user.name || req.user.email, // Full name for display
            status: 'created',
            created_at: new Date().toISOString(),
            documents: {},
            extracted_data: {},
            calculations: {}
        };
        
        assessments.set(assessmentId, assessment);
        
        // FIX: Add to assessmentsList immediately (don't wait for completion)
        const existingIdx = assessmentsList.findIndex(a => a.assessment_id === assessmentId);
        if (existingIdx >= 0) {
            assessmentsList[existingIdx] = assessment;
        } else {
            assessmentsList.unshift(assessment);
        }
        
        res.json({
            success: true,
            assessmentId: assessmentId,
            message: 'Assessment created successfully'
        });
    } catch (error) {
        console.error('Create assessment error:', error);
        res.status(500).json({ error: 'Failed to create assessment' });
    }
});

/**
 * POST /api/assessment/:id/start-processing
 * Mark assessment as Processing (for background processing tracking)
 */
app.post('/api/assessment/:id/start-processing', ensureAuthenticated, ensureNotReadOnly, async (req, res) => {
    try {
        const assessmentId = req.params.id;
        const { companyName, documentCount } = req.body;
        
        let assessment = await getAssessmentById(assessmentId);
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        // GUARD: Don't allow re-processing if already completed
        const completedStatuses = ['Approved', 'Rejected', 'Partial Approval', 'Complete', 'Completed'];
        if (completedStatuses.includes(assessment.status)) {
            console.log(`⚠️ Ignoring start-processing for ${assessmentId} - already ${assessment.status}`);
            return res.json({
                success: true,
                message: 'Assessment already completed',
                status: assessment.status,
                alreadyComplete: true
            });
        }
        
        // GUARD: Don't re-queue if already processing
        if (assessment.status === 'Processing') {
            console.log(`⚠️ Assessment ${assessmentId} already Processing - not re-queuing`);
            return res.json({
                success: true,
                message: 'Assessment already processing',
                status: 'Processing',
                alreadyProcessing: true
            });
        }
        
        // Update assessment status
        assessment.status = 'Processing';
        assessment.processing_started_at = new Date().toISOString();
        assessment.document_count = documentCount || 0;
        
        // Update in assessmentsList
        const listIdx = assessmentsList.findIndex(a => (a.assessment_id || a.id) === assessmentId);
        if (listIdx >= 0) {
            assessmentsList[listIdx].status = 'Processing';
            assessmentsList[listIdx].document_count = documentCount || 0;
        }
        
        // Save to S3 so dashboard shows updated status
        if (s3Client.isConfigured()) {
            try {
                await s3Client.saveAssessment(assessmentId, assessment);
                console.log(`💾 Saved Processing status to S3 for ${assessmentId}`);
            } catch (err) {
                console.error('Error saving to S3:', err.message);
            }
        }
        
        // Add to job queue for tracking
        jobQueue.enqueue(assessmentId, {
            companyName: companyName || assessment.company_name,
            loanAmount: assessment.loan_amount_lakhs,
            documentCount: documentCount || 0,
            userId: req.user.email
        });
        
        // Start the job immediately if slots available
        if (jobQueue.canStartNew()) {
            jobQueue.startProcessing(assessmentId);
        }
        
        const queueStatus = jobQueue.getStatus(assessmentId);
        
        console.log(`🚀 Assessment ${assessmentId} marked as Processing (queue position: ${queueStatus.position || 'active'})`);
        
        res.json({
            success: true,
            status: queueStatus.status,
            position: queueStatus.position,
            message: queueStatus.status === 'queued' 
                ? `Queued at position ${queueStatus.position}` 
                : 'Processing started'
        });
    } catch (error) {
        console.error('Start processing error:', error);
        res.status(500).json({ error: 'Failed to start processing' });
    }
});

/**
 * POST /api/assessment/:id/complete-processing
 * Mark assessment as complete after client-side processing
 */
app.post('/api/assessment/:id/complete-processing', ensureAuthenticated, ensureNotReadOnly, async (req, res) => {
    try {
        const assessmentId = req.params.id;
        const { status, score, grade, extractedData, calculations, creditScore, policyCompliance, recommendedLimits, apiStats, documentCount, documentTimings, extractionSummary } = req.body;
        
        let assessment = await getAssessmentById(assessmentId);
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        // Update assessment with results
        assessment.status = status || 'Pending';
        assessment.score = score;
        assessment.grade = grade;
        assessment.extracted_data = extractedData;
        assessment.calculations = calculations;
        assessment.credit_score = creditScore;
        assessment.policy_compliance = policyCompliance;
        assessment.recommended_limits = recommendedLimits;
        assessment.completed_at = new Date().toISOString();
        // Add API stats and document info
        assessment.api_stats = apiStats;
        assessment.document_count = documentCount;
        assessment.document_timings = documentTimings;
        assessment.extraction_summary = extractionSummary;
        
        // Update in assessmentsList
        const listIdx = assessmentsList.findIndex(a => (a.assessment_id || a.id) === assessmentId);
        if (listIdx >= 0) {
            assessmentsList[listIdx].status = assessment.status;
            assessmentsList[listIdx].score = score;
            assessmentsList[listIdx].grade = grade;
        }
        
        // Remove from job queue
        jobQueue.completeJob(assessmentId, { status, score, grade });
        
        // Save to S3
        if (s3Client.isConfigured()) {
            try {
                await s3Client.saveAssessment(assessmentId, assessment);
                console.log(`✅ Saved completed assessment ${assessmentId} to S3`);
            } catch (err) {
                console.error('Error saving to S3:', err.message);
            }
        }
        
        console.log(`✅ Assessment ${assessmentId} completed with status: ${status}, score: ${score}`);
        
        res.json({
            success: true,
            assessmentId: assessmentId,
            status: assessment.status
        });
    } catch (error) {
        console.error('Complete processing error:', error);
        res.status(500).json({ error: 'Failed to complete processing' });
    }
});

/**
 * POST /api/upload/direct
 * Direct file upload (for smaller files, converted to base64 on client)
 */
app.post('/api/upload/direct', ensureAuthenticated, ensureNotReadOnly, async (req, res) => {
    try {
        const { assessmentId, docType, year, docKey, fileData, fileName, contentType } = req.body;
        
        if (!assessmentId || !fileData) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Decode base64
        const buffer = Buffer.from(fileData, 'base64');
        
        // Get assessment from cache
        const assessment = await getAssessmentById(assessmentId);
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        // Generate document storage key
        // For bulk upload: use docKey directly (e.g., 'balance_sheet_2024')
        // For single upload: use docType_year (e.g., 'balance-sheet_fy24')
        let storageKey;
        if (docKey && (docKey.includes('_20') || docKey.match(/balance_sheet_|pnl_|cashflow_|director\d|cibil_|bank_statement_|odcc_/))) {
            // Bulk upload format - use docKey directly
            storageKey = docKey;
        } else if (docKey) {
            // Single upload with docKey - use docType_docKey
            storageKey = `${docType}_${docKey}`;
        } else if (year) {
            // Single upload with year - use docType_year
            storageKey = `${docType}_${year}`;
        } else {
            storageKey = docType;
        }
        console.log(`📁 Upload: docType=${docType}, docKey=${docKey}, year=${year} → storageKey=${storageKey}`);
        
        // Check if S3 is configured
        if (s3Client.isConfigured()) {
            // Upload to S3
            const s3Key = s3Client.generateS3Key(assessmentId, docType, year || docKey || 'misc', fileName || 'document.pdf');
            const result = await s3Client.uploadFile(s3Key, buffer, contentType || 'application/pdf');
            
            // Store reference in assessment
            assessment.documents[storageKey] = {
                s3Key: result.key,
                docType: docType,
                uploadedAt: new Date().toISOString(),
                size: buffer.length,
                fileName: fileName
            };
            
            res.json({
                success: true,
                s3Key: result.key,
                storageKey: storageKey,
                message: 'File uploaded to S3 successfully'
            });
        } else {
            // Store in memory (for demo/testing without S3)
            assessment.documents[storageKey] = {
                buffer: buffer,
                docType: docType,
                uploadedAt: new Date().toISOString(),
                size: buffer.length,
                fileName: fileName
            };
            
            res.json({
                success: true,
                storageKey: storageKey,
                message: 'File stored in memory (S3 not configured)'
            });
        }
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Failed to upload file: ' + error.message });
    }
});

/**
 * POST /api/extract-financials
 * Extract ALL data from uploaded documents using Claude
 * Handles: Financial Statements, GST Returns, Bank Statements, ITR, KYC, Property
 */
app.post('/api/extract-financials', ensureAuthenticated, ensureNotReadOnly, async (req, res) => {
    try {
        const { assessmentId } = req.body;
        const startTime = Date.now();
        
        console.log('\n' + '='.repeat(60));
        console.log('=== EXTRACT ALL DOCUMENTS ===');
        console.log('Assessment ID:', assessmentId);
        console.log('Started at:', new Date().toISOString());
        console.log('='.repeat(60));
        
        if (!assessmentId) {
            return res.status(400).json({ error: 'Assessment ID is required' });
        }
        
        const assessment = await getAssessmentById(assessmentId);
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        const docs = assessment.documents || {};
        const docKeys = Object.keys(docs);
        console.log(`\nTotal documents uploaded: ${docKeys.length}`);
        console.log('Document keys:', docKeys.join(', '));
        
        // Track document processing times
        const documentTimings = [];
        let apiCallCount = 0;
        
        // Check if Claude (via Amazon Bedrock) is configured.
        // Bedrock auth comes from the task/instance IAM role + AWS_REGION,
        // not an API key — ANTHROPIC_API_KEY is kept only as a legacy
        // fallback indicator for non-Bedrock deployments.
        if (!process.env.AWS_REGION && !process.env.ANTHROPIC_API_KEY) {
            return res.status(400).json({
                error: 'Claude API not configured',
                message: 'Please set AWS_REGION (Bedrock) or ANTHROPIC_API_KEY (legacy direct API) in environment variables'
            });
        }
        
        const extractedData = {
            balance_sheet: {},
            profit_and_loss: {},
            cash_flow: {},
            gst_returns: [],
            bank_statements: [],
            itr_returns: [],
            kyc: {},
            property: {},
            company_info: null
        };
        
        const missingFields = [];
        
        // ==================== FINANCIAL STATEMENTS ====================
        console.log('\n📊 EXTRACTING FINANCIAL STATEMENTS...');
        sendProgress(assessmentId, { type: 'section', section: 'Financial Statements' });
        
        // Debug: Log all available document keys
        console.log('📁 Available document keys:', Object.keys(docs));
        
        const years = ['fy25', 'fy24', 'fy23'];
        const yearLabels = {'fy25': 'FY 2024-25', 'fy24': 'FY 2023-24', 'fy23': 'FY 2022-23'};
        // Map bulk upload years to FY format
        const bulkYearMap = {'fy25': '2025', 'fy24': '2024', 'fy23': '2023'};
        
        for (const year of years) {
            // Balance Sheet - check multiple key formats including bulk upload
            const bulkYear = bulkYearMap[year];
            const bsKeys = [
                `balance-sheet_${year}`, `balance-sheet_bs_${year}`, `bs_${year}`, `financial_bs_${year}`,
                // Bulk upload formats
                `balance_sheet_${bulkYear}`, `bs_${bulkYear}`, `balancesheet${bulkYear}`
            ];
            console.log(`   Searching for BS ${year}: ${bsKeys.join(', ')}`);
            let bsDoc = null, bsFoundKey = null;
            for (const key of bsKeys) {
                if (docs[key]) { bsDoc = docs[key]; bsFoundKey = key; console.log(`   ✓ Found: ${key}`); break; }
            }
            if (!bsDoc) console.log(`   ✗ Not found for ${year}`);
            
            if (bsDoc) {
                const docStart = Date.now();
                const sizeKB = Math.round((bsDoc.buffer?.length || bsDoc.size || 0) / 1024);
                const docName = `Balance Sheet ${year.toUpperCase()}`;
                
                // Send START progress
                sendProgress(assessmentId, { 
                    type: 'doc_start', 
                    docNum: ++apiCallCount, 
                    docName: docName,
                    sizeKB: sizeKB
                });
                
                try {
                    console.log(`\n[${apiCallCount}] 📄 ${docName} (${sizeKB} KB)`);
                    
                    const buffer = bsDoc.buffer || (bsDoc.s3Key ? await s3Client.getFile(bsDoc.s3Key) : null);
                    if (!buffer) {
                        console.error(`    ❌ Could not retrieve document buffer`);
                        console.error(`       Buffer exists: ${!!bsDoc.buffer}`);
                        console.error(`       S3 Key: ${bsDoc.s3Key || 'NOT SET'}`);
                        missingFields.push({ category: 'balance_sheet', year, error: 'Document buffer not available' });
                        continue;
                    }
                    
                    if (buffer) {
                        // Check rate limit BEFORE extraction
                        const estimatedTokens = estimateTokens(sizeKB, 'financial');
                        await checkRateLimitBefore(estimatedTokens, docName, assessmentId);
                        
                        // Extract with retry logic
                        const result = await withRetry(
                            () => claudeExtractor.extractBalanceSheet(buffer, yearLabels[year]),
                            3, docName, assessmentId
                        );
                        
                        const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                        const tokensUsed = result._tokensUsed || 0;
                        
                        // Update token count AFTER successful extraction
                        const tokenUsage = updateTokenCount(tokensUsed);
                        
                        extractedData.balance_sheet[year] = result.balance_sheet;
                        documentTimings.push({ doc: `BS ${year}`, time: parseFloat(duration), success: true, tokens: tokensUsed });
                        console.log(`    ✅ Extracted in ${duration}s (${tokensUsed.toLocaleString()} tokens)`);
                        
                        // Send COMPLETE progress
                        sendProgress(assessmentId, { 
                            type: 'doc_complete', 
                            docNum: apiCallCount, 
                            docName: docName,
                            duration: parseFloat(duration),
                            tokens: tokensUsed,
                            tokenUsage: tokenUsage,
                            keyValues: {
                                total_assets: result.balance_sheet?.total_assets,
                                net_worth: result.balance_sheet?.net_worth
                            },
                            success: true
                        });
                        
                        if (!extractedData.company_info) {
                            console.log(`[${++apiCallCount}] 🏢 Company Info (from BS)`);
                            const ciStart = Date.now();
                            await checkRateLimitBefore(estimateTokens(sizeKB, 'financial'), 'Company Info', assessmentId);
                            const ciResult = await withRetry(
                                () => claudeExtractor.extractCompanyInfo(buffer),
                                3, 'Company Info', assessmentId
                            );
                            extractedData.company_info = ciResult;
                            const ciDuration = ((Date.now() - ciStart) / 1000).toFixed(1);
                            const ciTokens = ciResult._tokensUsed || 0;
                            updateTokenCount(ciTokens);
                            documentTimings.push({ doc: 'Company Info', time: parseFloat(ciDuration), success: true, tokens: ciTokens });
                            console.log(`    ✅ Extracted in ${ciDuration}s (${ciTokens.toLocaleString()} tokens)`);
                        }
                    }
                } catch (err) {
                    const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                    documentTimings.push({ doc: `BS ${year}`, time: parseFloat(duration), success: false, error: err.message });
                    console.error(`    ❌ Error in ${duration}s: ${err.message}`);
                    
                    // Send ERROR progress
                    sendProgress(assessmentId, { 
                        type: 'doc_error', 
                        docNum: apiCallCount, 
                        docName: docName,
                        error: err.message,
                        duration: parseFloat(duration)
                    });
                    
                    missingFields.push({ category: 'balance_sheet', year, error: err.message });
                }
            }
            
            // P&L - check multiple key formats including bulk upload
            const pnlKeys = [
                `pnl_${year}`, `pnl_pnl_${year}`, `profit-loss_${year}`, `financial_pnl_${year}`,
                // Bulk upload formats
                `pnl_${bulkYear}`, `pl_${bulkYear}`, `profit_loss_${bulkYear}`, `profitloss${bulkYear}`
            ];
            console.log(`   Searching for PnL ${year}: ${pnlKeys.join(', ')}`);
            let pnlDoc = null, pnlFoundKey = null;
            for (const key of pnlKeys) {
                if (docs[key]) { pnlDoc = docs[key]; pnlFoundKey = key; console.log(`   ✓ Found: ${key}`); break; }
            }
            if (!pnlDoc) console.log(`   ✗ P&L not found for ${year}`);
            
            if (pnlDoc) {
                const docStart = Date.now();
                const sizeKB = Math.round((pnlDoc.buffer?.length || pnlDoc.size || 0) / 1024);
                const docName = `P&L ${year.toUpperCase()}`;
                
                sendProgress(assessmentId, { type: 'doc_start', docNum: ++apiCallCount, docName: docName, sizeKB });
                
                try {
                    console.log(`\n[${apiCallCount}] 📄 ${docName} (${sizeKB} KB)`);
                    const buffer = pnlDoc.buffer || (pnlDoc.s3Key ? await s3Client.getFile(pnlDoc.s3Key) : null);
                    if (buffer) {
                        // Check rate limit BEFORE extraction
                        const estimatedTokens = estimateTokens(sizeKB, 'financial');
                        await checkRateLimitBefore(estimatedTokens, docName, assessmentId);
                        
                        const result = await withRetry(
                            () => claudeExtractor.extractProfitAndLoss(buffer, yearLabels[year]),
                            3, docName, assessmentId
                        );
                        const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                        const tokensUsed = result._tokensUsed || 0;
                        const tokenUsage = updateTokenCount(tokensUsed);
                        
                        extractedData.profit_and_loss[year] = result.profit_and_loss;
                        documentTimings.push({ doc: `P&L ${year}`, time: parseFloat(duration), success: true, tokens: tokensUsed });
                        console.log(`    ✅ Extracted in ${duration}s (${tokensUsed.toLocaleString()} tokens)`);
                        
                        sendProgress(assessmentId, { 
                            type: 'doc_complete', docNum: apiCallCount, docName: docName,
                            duration: parseFloat(duration), tokens: tokensUsed,
                            tokenUsage: tokenUsage,
                            keyValues: { revenue: result.profit_and_loss?.revenue, pat: result.profit_and_loss?.profit_after_tax },
                            success: true
                        });
                    }
                } catch (err) {
                    const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                    documentTimings.push({ doc: `P&L ${year}`, time: parseFloat(duration), success: false, error: err.message });
                    console.error(`    ❌ Error in ${duration}s: ${err.message}`);
                    sendProgress(assessmentId, { type: 'doc_error', docNum: apiCallCount, docName: docName, error: err.message });
                    missingFields.push({ category: 'profit_and_loss', year, error: err.message });
                }
            }
        }
        
        // Cash Flow Statement extraction
        for (const year of years) {
            const bulkYear = bulkYearMap[year];
            const cfKeys = [
                `cash-flow_${year}`, `cf_${year}`, `cashflow_${year}`,
                // Bulk upload formats
                `cashflow_${bulkYear}`, `cf_${bulkYear}`, `cash_flow_${bulkYear}`
            ];
            let cfDoc = null, cfFoundKey = null;
            for (const key of cfKeys) {
                if (docs[key]) { cfDoc = docs[key]; cfFoundKey = key; break; }
            }
            
            if (cfDoc) {
                const docStart = Date.now();
                const sizeKB = Math.round((cfDoc.buffer?.length || cfDoc.size || 0) / 1024);
                const docName = `Cash Flow ${year.toUpperCase()}`;
                
                sendProgress(assessmentId, { 
                    type: 'doc_start', docNum: ++apiCallCount, docName: docName, sizeKB: sizeKB
                });
                
                try {
                    console.log(`\n[${apiCallCount}] 📄 ${docName} (${sizeKB} KB)`);
                    
                    const buffer = cfDoc.buffer || (cfDoc.s3Key ? await s3Client.getFile(cfDoc.s3Key) : null);
                    if (buffer) {
                        const estimatedTokens = estimateTokens(sizeKB, 'financial');
                        await checkRateLimitBefore(estimatedTokens, docName, assessmentId);
                        
                        const result = await withRetry(
                            () => claudeExtractor.extractCashFlow(buffer, yearLabels[year]),
                            3, docName, assessmentId
                        );
                        const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                        const tokensUsed = result._tokensUsed || 0;
                        const tokenUsage = updateTokenCount(tokensUsed);
                        
                        extractedData.cash_flow[year] = result.cash_flow;
                        documentTimings.push({ doc: `CF ${year}`, time: parseFloat(duration), success: true, tokens: tokensUsed });
                        console.log(`    ✅ Extracted in ${duration}s (${tokensUsed.toLocaleString()} tokens)`);
                        
                        sendProgress(assessmentId, { 
                            type: 'doc_complete', docNum: apiCallCount, docName: docName,
                            duration: parseFloat(duration), tokens: tokensUsed,
                            tokenUsage: tokenUsage,
                            keyValues: { operating_cf: result.cash_flow?.operating_cash_flow, net_cf: result.cash_flow?.net_cash_flow },
                            success: true
                        });
                    }
                } catch (err) {
                    const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                    documentTimings.push({ doc: `CF ${year}`, time: parseFloat(duration), success: false, error: err.message });
                    console.error(`    ❌ Error in ${duration}s: ${err.message}`);
                    sendProgress(assessmentId, { type: 'doc_error', docNum: apiCallCount, docName: docName, error: err.message });
                    missingFields.push({ category: 'cash_flow', year, error: err.message });
                }
            }
        }
        
        // ==================== GST RETURNS ====================
        console.log('\n📋 EXTRACTING GST RETURNS...');
        sendProgress(assessmentId, { type: 'section', section: 'GST Returns' });
        
        const gstPeriods = ['nov25','oct25','sep25','aug25','jul25','jun25','may25','apr25','q2_fy26','q1_fy26','annual_fy25'];
        for (const period of gstPeriods) {
            const gstKeys = [`gst-return_${period}`, `gst-return_gst_${period}`, `gst_${period}`];
            let gstDoc = null, gstFoundKey = null;
            for (const key of gstKeys) {
                if (docs[key]) { gstDoc = docs[key]; gstFoundKey = key; break; }
            }
            
            if (gstDoc) {
                const docStart = Date.now();
                const buffer = gstDoc.buffer || (gstDoc.s3Key ? await s3Client.getFile(gstDoc.s3Key) : null);
                
                // CRITICAL FIX: Only process if buffer exists
                if (buffer) {
                    const sizeKB = Math.round(buffer.length / 1024);
                    const docName = `GST ${period.toUpperCase()}`;
                    
                    sendProgress(assessmentId, { type: 'doc_start', docNum: ++apiCallCount, docName: docName, sizeKB });
                    
                    try {
                        console.log(`\n[${apiCallCount}] 📄 ${docName} (${sizeKB} KB)`);
                        
                        // GST returns are HIGH-TOKEN docs - check rate limit BEFORE
                        const estimatedTokens = estimateTokens(sizeKB, 'gst');
                        await checkRateLimitBefore(estimatedTokens, docName, assessmentId);
                        
                        const result = await withRetry(
                            () => claudeExtractor.extractGSTReturn(buffer, period),
                            3, docName, assessmentId
                        );
                        const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                        const tokensUsed = result._tokensUsed || 0;
                        const tokenUsage = updateTokenCount(tokensUsed);
                        
                        extractedData.gst_returns.push(result);
                        documentTimings.push({ doc: `GST ${period}`, time: parseFloat(duration), success: true, tokens: tokensUsed });
                        console.log(`    ✅ Extracted in ${duration}s (${tokensUsed.toLocaleString()} tokens)`);
                        
                        sendProgress(assessmentId, { 
                            type: 'doc_complete', docNum: apiCallCount, docName: docName,
                            duration: parseFloat(duration), tokens: tokensUsed,
                            tokenUsage: tokenUsage,
                            keyValues: { total_turnover: result.gst_return?.total_turnover },
                            success: true
                        });
                    } catch (err) {
                        const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                        documentTimings.push({ doc: `GST ${period}`, time: parseFloat(duration), success: false });
                        console.error(`    ❌ Error in ${duration}s: ${err.message}`);
                        sendProgress(assessmentId, { type: 'doc_error', docNum: apiCallCount, docName: docName, error: err.message });
                    }
                }
            }
        }
        
        // ==================== BANK STATEMENTS ====================
        console.log('\n🏦 EXTRACTING BANK STATEMENTS...');
        sendProgress(assessmentId, { type: 'section', section: 'Bank Statements' });
        // Both single upload (nov25, oct25) and bulk upload (apr_2024, may_2024) formats
        const bankMonthConfigs = [
            { short: 'apr25', bulk: 'apr_2025', label: 'Apr 2025' },
            { short: 'mar25', bulk: 'mar_2025', label: 'Mar 2025' },
            { short: 'feb25', bulk: 'feb_2025', label: 'Feb 2025' },
            { short: 'jan25', bulk: 'jan_2025', label: 'Jan 2025' },
            { short: 'dec24', bulk: 'dec_2024', label: 'Dec 2024' },
            { short: 'nov24', bulk: 'nov_2024', label: 'Nov 2024' },
            { short: 'oct24', bulk: 'oct_2024', label: 'Oct 2024' },
            { short: 'sep24', bulk: 'sep_2024', label: 'Sep 2024' },
            { short: 'aug24', bulk: 'aug_2024', label: 'Aug 2024' },
            { short: 'jul24', bulk: 'jul_2024', label: 'Jul 2024' },
            { short: 'jun24', bulk: 'jun_2024', label: 'Jun 2024' },
            { short: 'may24', bulk: 'may_2024', label: 'May 2024' },
            { short: 'apr24', bulk: 'apr_2024', label: 'Apr 2024' }
        ];
        for (const monthConfig of bankMonthConfigs) {
            const month = monthConfig.short;
            const bulkMonth = monthConfig.bulk;
            const bankKeys = [
                `bank-statement_${month}`, `bank-statement_bank_${month}`, `bank_${month}`,
                // Bulk upload formats
                `bank_statement_${bulkMonth}`, `bank_${bulkMonth}`, `bs_${bulkMonth}`
            ];
            let bankDoc = null, bankFoundKey = null;
            for (const key of bankKeys) {
                if (docs[key]) { bankDoc = docs[key]; bankFoundKey = key; break; }
            }
            
            if (bankDoc) {
                const docStart = Date.now();
                // Get buffer first to know actual size (Fix 8: Bank size showing "? KB")
                let buffer = bankDoc.buffer;
                if (!buffer && bankDoc.s3Key) {
                    buffer = await s3Client.getFile(bankDoc.s3Key);
                }
                
                // CRITICAL FIX: Only process if buffer exists (don't show ghost processing)
                if (buffer) {
                    const sizeKB = Math.round(buffer.length / 1024);
                    const docName = `Bank ${month.toUpperCase()}`;
                    
                    sendProgress(assessmentId, { type: 'doc_start', docNum: ++apiCallCount, docName: docName, sizeKB });
                    
                    try {
                        console.log(`\n[${apiCallCount}] 📄 ${docName} (${sizeKB} KB)`);
                        
                        // Bank statements are HIGH-TOKEN docs - check rate limit BEFORE
                        const estimatedTokens = estimateTokens(sizeKB, 'bank');
                        await checkRateLimitBefore(estimatedTokens, docName, assessmentId);
                        
                        const result = await withRetry(
                            () => claudeExtractor.extractBankStatement(buffer, month),
                            3, docName, assessmentId
                        );
                        const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                        const tokensUsed = result._tokensUsed || 0;
                        const tokenUsage = updateTokenCount(tokensUsed);
                        
                        extractedData.bank_statements.push(result);
                        documentTimings.push({ doc: `Bank ${month}`, time: parseFloat(duration), success: true, tokens: tokensUsed });
                        console.log(`    ✅ Extracted in ${duration}s (${tokensUsed.toLocaleString()} tokens)`);
                        
                        sendProgress(assessmentId, { 
                            type: 'doc_complete', docNum: apiCallCount, docName: docName,
                            duration: parseFloat(duration), tokens: tokensUsed,
                            tokenUsage: tokenUsage,
                            keyValues: { 
                                credits: result.bank_statement?.total_credits,
                                debits: result.bank_statement?.total_debits,
                                closing: result.bank_statement?.closing_balance
                            },
                            success: true
                        });
                    } catch (err) {
                        const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                        documentTimings.push({ doc: `Bank ${month}`, time: parseFloat(duration), success: false });
                        console.error(`    ❌ Error in ${duration}s: ${err.message}`);
                        sendProgress(assessmentId, { type: 'doc_error', docNum: apiCallCount, docName: docName, error: err.message });
                    }
                }
            }
        }
        
        // ==================== ITR ====================
        console.log('\n📑 EXTRACTING ITR RETURNS...');
        sendProgress(assessmentId, { type: 'section', section: 'ITR Returns' });
        
        const itrYears = ['ay26', 'ay25', 'ay24'];
        const itrLabels = {'ay26': 'AY 2025-26', 'ay25': 'AY 2024-25', 'ay24': 'AY 2023-24'};
        // Map assessment year to calendar year for bulk upload format
        const itrBulkYears = {'ay26': '2025', 'ay25': '2024', 'ay24': '2023'};
        for (const year of itrYears) {
            const bulkYear = itrBulkYears[year];
            const itrKeys = [
                `itr_${year}`, `itr_itr_${year}`,
                // Bulk upload formats
                `itr_${bulkYear}`, `income_tax_return_${bulkYear}`, `it_return_${bulkYear}`
            ];
            let itrDoc = null;
            for (const key of itrKeys) {
                if (docs[key]) { itrDoc = docs[key]; break; }
            }
            
            if (itrDoc) {
                const docStart = Date.now();
                const sizeKB = Math.round((itrDoc.buffer?.length || itrDoc.size || 0) / 1024);
                const docName = `ITR ${year.toUpperCase()}`;
                
                sendProgress(assessmentId, { type: 'doc_start', docNum: ++apiCallCount, docName: docName, sizeKB });
                
                try {
                    console.log(`\n[${apiCallCount}] 📄 ${docName} (${sizeKB} KB)`);
                    const buffer = itrDoc.buffer || (itrDoc.s3Key ? await s3Client.getFile(itrDoc.s3Key) : null);
                    if (buffer) {
                        // Check rate limit before
                        const estimatedTokens = estimateTokens(sizeKB, 'financial');
                        await checkRateLimitBefore(estimatedTokens, docName, assessmentId);
                        
                        const result = await withRetry(
                            () => claudeExtractor.extractITR(buffer, itrLabels[year]),
                            3, docName, assessmentId
                        );
                        const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                        const tokensUsed = result._tokensUsed || 0;
                        const tokenUsage = updateTokenCount(tokensUsed);
                        
                        extractedData.itr_returns.push(result);
                        documentTimings.push({ doc: `ITR ${year}`, time: parseFloat(duration), success: true, tokens: tokensUsed });
                        console.log(`    ✅ Extracted in ${duration}s (${tokensUsed.toLocaleString()} tokens)`);
                        
                        sendProgress(assessmentId, { 
                            type: 'doc_complete', docNum: apiCallCount, docName: docName,
                            duration: parseFloat(duration), tokens: tokensUsed,
                            tokenUsage: tokenUsage,
                            success: true
                        });
                    }
                } catch (err) {
                    const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                    documentTimings.push({ doc: `ITR ${year}`, time: parseFloat(duration), success: false });
                    console.error(`    ❌ Error in ${duration}s: ${err.message}`);
                    sendProgress(assessmentId, { type: 'doc_error', docNum: apiCallCount, docName: docName, error: err.message });
                }
            }
        }
        
        // ==================== KYC ====================
        console.log('\n🪪 EXTRACTING KYC DOCUMENTS...');
        sendProgress(assessmentId, { type: 'section', section: 'KYC Documents' });
        
        // Map between single upload and bulk upload key names
        const kycConfigs = [
            { type: 'coi', aliases: ['coi', 'cin_certificate', 'incorporation_certificate'] },
            { type: 'moa', aliases: ['moa', 'memorandum_of_association', 'memorandum'] },
            { type: 'aoa', aliases: ['aoa', 'articles_of_association', 'articles'] },
            { type: 'pan_company', aliases: ['pan_company', 'company_pan', 'pan_card_company'] },
            { type: 'gst_cert', aliases: ['gst_cert', 'gst_certificate', 'gstin', 'gst_registration'] },
            { type: 'tan_cert', aliases: ['tan_certificate', 'tan'] },
            { type: 'board_resolution', aliases: ['board_resolution'] },
            { type: 'address_proof', aliases: ['address_proof', 'company_address', 'registered_address'] },
            { type: 'dir1_kyc', aliases: ['dir1_kyc', 'director1_aadhaar', 'director1_pan', 'director_aadhaar', 'director_pan'] },
            { type: 'dir2_kyc', aliases: ['dir2_kyc', 'director2_aadhaar', 'director2_pan'] },
            { type: 'dir3_kyc', aliases: ['dir3_kyc', 'director3_aadhaar', 'director3_pan'] },
            { type: 'dir1_photo', aliases: ['director1_photo', 'director_photo', 'promoter_photo'] },
            { type: 'dir2_photo', aliases: ['director2_photo'] }
        ];
        
        for (const config of kycConfigs) {
            const docType = config.type;
            // Build all possible key variations
            const kycKeys = [`kyc_${docType}`];
            config.aliases.forEach(alias => {
                kycKeys.push(alias);
                kycKeys.push(`kyc_${alias}`);
            });
            
            let kycDoc = null;
            for (const key of kycKeys) {
                if (docs[key]) { kycDoc = docs[key]; break; }
            }
            
            if (kycDoc) {
                const docStart = Date.now();
                const sizeKB = Math.round((kycDoc.buffer?.length || kycDoc.size || 0) / 1024);
                const docName = `KYC ${docType.toUpperCase()}`;
                
                sendProgress(assessmentId, { type: 'doc_start', docNum: ++apiCallCount, docName: docName, sizeKB });
                
                try {
                    console.log(`\n[${apiCallCount}] 📄 ${docName} (${sizeKB} KB)`);
                    const buffer = kycDoc.buffer || (kycDoc.s3Key ? await s3Client.getFile(kycDoc.s3Key) : null);
                    if (buffer) {
                        const estimatedTokens = estimateTokens(sizeKB, 'financial');
                        await checkRateLimitBefore(estimatedTokens, docName, assessmentId);
                        
                        const result = await withRetry(
                            () => claudeExtractor.extractKYC(buffer, docType),
                            3, docName, assessmentId
                        );
                        const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                        const tokensUsed = result._tokensUsed || 0;
                        const tokenUsage = updateTokenCount(tokensUsed);
                        
                        extractedData.kyc[docType] = result;
                        documentTimings.push({ doc: `KYC ${docType}`, time: parseFloat(duration), success: true, tokens: tokensUsed });
                        console.log(`    ✅ Extracted in ${duration}s (${tokensUsed.toLocaleString()} tokens)`);
                        
                        sendProgress(assessmentId, { 
                            type: 'doc_complete', docNum: apiCallCount, docName: docName,
                            duration: parseFloat(duration), tokens: tokensUsed,
                            tokenUsage: tokenUsage,
                            success: true
                        });
                    }
                } catch (err) {
                    const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                    documentTimings.push({ doc: `KYC ${docType}`, time: parseFloat(duration), success: false });
                    console.error(`    ❌ Error in ${duration}s: ${err.message}`);
                    sendProgress(assessmentId, { type: 'doc_error', docNum: apiCallCount, docName: docName, error: err.message });
                }
            }
        }
        
        // ==================== PROPERTY ====================
        console.log('\n🏠 EXTRACTING PROPERTY DOCUMENTS...');
        sendProgress(assessmentId, { type: 'section', section: 'Property Documents' });
        
        const propTypes = ['prop_title', 'prop_valuation', 'prop_enc', 'prop_tax', 'prop_map'];
        for (const docType of propTypes) {
            const propKeys = [`property_${docType}`, docType];
            let propDoc = null;
            for (const key of propKeys) {
                if (docs[key]) { propDoc = docs[key]; break; }
            }
            
            if (propDoc) {
                const docStart = Date.now();
                const sizeKB = Math.round((propDoc.buffer?.length || propDoc.size || 0) / 1024);
                const docName = `Property ${docType}`;
                
                sendProgress(assessmentId, { type: 'doc_start', docNum: ++apiCallCount, docName: docName, sizeKB });
                
                try {
                    console.log(`\n[${apiCallCount}] 📄 ${docName} (${sizeKB} KB)`);
                    const buffer = propDoc.buffer || (propDoc.s3Key ? await s3Client.getFile(propDoc.s3Key) : null);
                    if (buffer) {
                        const estimatedTokens = estimateTokens(sizeKB, 'financial');
                        await checkRateLimitBefore(estimatedTokens, docName, assessmentId);
                        
                        const result = await withRetry(
                            () => claudeExtractor.extractProperty(buffer, docType),
                            3, docName, assessmentId
                        );
                        const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                        const tokensUsed = result._tokensUsed || 0;
                        const tokenUsage = updateTokenCount(tokensUsed);
                        
                        extractedData.property[docType] = result;
                        documentTimings.push({ doc: `Property ${docType}`, time: parseFloat(duration), success: true, tokens: tokensUsed });
                        console.log(`    ✅ Extracted in ${duration}s (${tokensUsed.toLocaleString()} tokens)`);
                        
                        sendProgress(assessmentId, { 
                            type: 'doc_complete', docNum: apiCallCount, docName: docName,
                            duration: parseFloat(duration), tokens: tokensUsed,
                            tokenUsage: tokenUsage,
                            success: true
                        });
                    }
                } catch (err) {
                    const duration = ((Date.now() - docStart) / 1000).toFixed(1);
                    documentTimings.push({ doc: `Property ${docType}`, time: parseFloat(duration), success: false });
                    console.error(`    ❌ Error in ${duration}s: ${err.message}`);
                    sendProgress(assessmentId, { type: 'doc_error', docNum: apiCallCount, docName: docName, error: err.message });
                }
            }
        }
        
        // Aggregate data
        if (extractedData.gst_returns.length > 0) {
            extractedData.gst_aggregated = claudeExtractor.aggregateGSTData(extractedData.gst_returns);
        }
        if (extractedData.bank_statements.length > 0) {
            extractedData.bank_aggregated = claudeExtractor.aggregateBankData(extractedData.bank_statements);
        }
        
        // Store extracted data in assessment
        assessment.extracted_data = extractedData;
        assessment.status = 'extracted';
        
        // Calculate total time and summary
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const totalApiTime = documentTimings.reduce((sum, d) => sum + d.time, 0).toFixed(1);
        
        // Send completion event via SSE
        sendProgress(assessmentId, { 
            type: 'complete', 
            totalDocs: apiCallCount, 
            totalTime: totalTime,
            apiTime: totalApiTime
        });
        
        console.log('\n' + '='.repeat(60));
        console.log('=== EXTRACTION COMPLETE ===');
        console.log('='.repeat(60));
        console.log(`Total API Calls: ${apiCallCount}`);
        console.log(`Total API Time: ${totalApiTime}s`);
        console.log(`Total Elapsed: ${totalTime}s (includes ${apiCallCount}s of delays)`);
        console.log('');
        console.log('Documents Processed:');
        console.log(`  Balance Sheets: ${Object.keys(extractedData.balance_sheet).length}`);
        console.log(`  P&L Statements: ${Object.keys(extractedData.profit_and_loss).length}`);
        console.log(`  Cash Flow Statements: ${Object.keys(extractedData.cash_flow).length}`);
        console.log(`  GST Returns: ${extractedData.gst_returns.length}`);
        console.log(`  Bank Statements: ${extractedData.bank_statements.length}`);
        console.log('ITR Returns:', extractedData.itr_returns.length);
        console.log('KYC Documents:', Object.keys(extractedData.kyc).length);
        console.log('Property Documents:', Object.keys(extractedData.property).length);
        
        // Validate extraction
        const validation = claudeExtractor.validateExtractedData(
            { balance_sheet: extractedData.balance_sheet.fy25, financial_year: 'FY 2024-25' },
            { profit_and_loss: extractedData.profit_and_loss.fy25, financial_year: 'FY 2024-25' }
        );
        
        res.json({
            success: true,
            assessmentId: assessmentId,
            extractedData: extractedData,
            validation: validation,
            missingFields: validation.missingFields.concat(missingFields),
            summary: {
                balance_sheets: Object.keys(extractedData.balance_sheet).length,
                pnl_statements: Object.keys(extractedData.profit_and_loss).length,
                gst_returns: extractedData.gst_returns.length,
                bank_statements: extractedData.bank_statements.length,
                itr_returns: extractedData.itr_returns.length,
                kyc_documents: Object.keys(extractedData.kyc).length,
                property_documents: Object.keys(extractedData.property).length,
                total_api_calls: apiCallCount,
                total_time_seconds: parseFloat(totalTime),
                api_time_seconds: parseFloat(totalApiTime)
            },
            // Include API stats for frontend monitoring
            apiStats: claudeExtractor.getApiStats(),
            // Include actual rate limits
            rateLimits: claudeExtractor.getRateLimits(),
            // Include detailed API call logs
            apiCallLogs: claudeExtractor.getApiCallLogs(),
            // Include per-document timings
            documentTimings: documentTimings
        });
        
    } catch (error) {
        console.error('Extract financials error:', error);
        res.status(500).json({ error: 'Failed to extract financials: ' + error.message });
    }
});

/**
 * POST /api/extract-category
 * Extract data from a specific document category
 */
app.post('/api/extract-category', ensureAuthenticated, ensureNotReadOnly, async (req, res) => {
    try {
        const { assessmentId, categoryId } = req.body;
        
        console.log(`\n=== Extract Category: ${categoryId} ===`);
        console.log(`Assessment ID: ${assessmentId}`);
        
        if (!assessmentId || !categoryId) {
            return res.status(400).json({ error: 'Assessment ID and Category ID are required' });
        }
        
        const assessment = await getAssessmentById(assessmentId);
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        if (!process.env.AWS_REGION && !process.env.ANTHROPIC_API_KEY) {
            return res.status(400).json({
                error: 'Claude API not configured',
                message: 'Please set AWS_REGION (Bedrock) or ANTHROPIC_API_KEY (legacy direct API) in environment variables'
            });
        }
        
        let extractedData = {};
        const docs = assessment.documents || {};
        
        // Log available documents
        console.log('Available documents:', Object.keys(docs));
        
        // Extract based on category
        if (categoryId === 'financial') {
            // Extract Balance Sheet and P&L
            extractedData = { balance_sheet: {}, profit_and_loss: {}, company_info: null };
            const years = ['fy25', 'fy24', 'fy23'];
            const yearLabels = {'fy25': 'FY 2024-25', 'fy24': 'FY 2023-24', 'fy23': 'FY 2022-23'};
            
            for (const year of years) {
                // Balance Sheet - check multiple possible key formats
                const bsKeys = [`financial_bs_${year}`, `bs_${year}`, `balance-sheet_${year}`];
                let bsDoc = null;
                for (const key of bsKeys) {
                    if (docs[key]) { bsDoc = docs[key]; console.log(`Found BS doc: ${key}`); break; }
                }
                
                if (bsDoc) {
                    try {
                        console.log(`Extracting Balance Sheet ${year}...`);
                        const buffer = bsDoc.buffer || (bsDoc.s3Key ? await s3Client.getFile(bsDoc.s3Key) : null);
                        if (buffer) {
                            const result = await claudeExtractor.extractBalanceSheet(buffer, yearLabels[year]);
                            extractedData.balance_sheet[year] = result.balance_sheet;
                            console.log(`BS ${year} extracted successfully`);
                            if (!extractedData.company_info) {
                                extractedData.company_info = await claudeExtractor.extractCompanyInfo(buffer);
                            }
                        }
                    } catch (err) {
                        console.error(`Error extracting BS ${year}:`, err.message);
                        extractedData.balance_sheet[year] = { error: err.message };
                    }
                }
                
                // P&L - check multiple possible key formats
                const pnlKeys = [`financial_pnl_${year}`, `pnl_${year}`];
                let pnlDoc = null;
                for (const key of pnlKeys) {
                    if (docs[key]) { pnlDoc = docs[key]; console.log(`Found P&L doc: ${key}`); break; }
                }
                
                if (pnlDoc) {
                    try {
                        console.log(`Extracting P&L ${year}...`);
                        const buffer = pnlDoc.buffer || (pnlDoc.s3Key ? await s3Client.getFile(pnlDoc.s3Key) : null);
                        if (buffer) {
                            const result = await claudeExtractor.extractProfitAndLoss(buffer, yearLabels[year]);
                            extractedData.profit_and_loss[year] = result.profit_and_loss;
                            console.log(`P&L ${year} extracted successfully`);
                        }
                    } catch (err) {
                        console.error(`Error extracting P&L ${year}:`, err.message);
                        extractedData.profit_and_loss[year] = { error: err.message };
                    }
                }
            }
            
            console.log('Financial extraction complete:', {
                bs_years: Object.keys(extractedData.balance_sheet),
                pnl_years: Object.keys(extractedData.profit_and_loss)
            });
            
        } else if (categoryId === 'gst') {
            // Extract GST Returns
            extractedData = { gst_returns: [], aggregated: null };
            const periods = ['nov24','oct24','sep24','aug24','jul24','jun24','q2_24','q1_24','annual_24'];
            
            for (const period of periods) {
                const gstKeys = [`gst_gst_${period}`, `gst_${period}`];
                let gstDoc = null;
                for (const key of gstKeys) {
                    if (docs[key]) { gstDoc = docs[key]; console.log(`Found GST doc: ${key}`); break; }
                }
                
                if (gstDoc) {
                    try {
                        console.log(`Extracting GST ${period}...`);
                        const buffer = gstDoc.buffer || (gstDoc.s3Key ? await s3Client.getFile(gstDoc.s3Key) : null);
                        if (buffer) {
                            const result = await claudeExtractor.extractGSTReturn(buffer, period);
                            extractedData.gst_returns.push(result);
                            console.log(`GST ${period} extracted successfully`);
                        }
                    } catch (err) {
                        console.error(`Error extracting GST ${period}:`, err.message);
                    }
                }
            }
            extractedData.aggregated = claudeExtractor.aggregateGSTData(extractedData.gst_returns);
            console.log('GST extraction complete:', extractedData.gst_returns.length, 'returns processed');
            
        } else if (categoryId === 'bank') {
            // Extract Bank Statements
            extractedData = { bank_statements: [], aggregated: null };
            const months = ['dec24','nov24','oct24','sep24','aug24','jul24','jun24','may24','apr24','mar24','feb24','jan24'];
            
            for (const month of months) {
                const bankKeys = [`bank_bank_${month}`, `bank_${month}`];
                let bankDoc = null;
                for (const key of bankKeys) {
                    if (docs[key]) { bankDoc = docs[key]; console.log(`Found Bank doc: ${key}`); break; }
                }
                
                if (bankDoc) {
                    try {
                        console.log(`Extracting Bank ${month}...`);
                        const buffer = bankDoc.buffer || (bankDoc.s3Key ? await s3Client.getFile(bankDoc.s3Key) : null);
                        if (buffer) {
                            const result = await claudeExtractor.extractBankStatement(buffer, month);
                            extractedData.bank_statements.push(result);
                            console.log(`Bank ${month} extracted successfully`);
                        }
                    } catch (err) {
                        console.error(`Error extracting Bank ${month}:`, err.message);
                    }
                }
            }
            extractedData.aggregated = claudeExtractor.aggregateBankData(extractedData.bank_statements);
            console.log('Bank extraction complete:', extractedData.bank_statements.length, 'statements processed');
            
        } else if (categoryId === 'itr') {
            // Extract ITR Documents
            extractedData = { itr_returns: [] };
            const years = ['fy24', 'fy23', 'fy22'];
            const yearLabels = {'fy24': 'AY 2024-25', 'fy23': 'AY 2023-24', 'fy22': 'AY 2022-23'};
            
            for (const year of years) {
                const itrKeys = [`itr_itr_${year}`, `itr_${year}`];
                let itrDoc = null;
                for (const key of itrKeys) {
                    if (docs[key]) { itrDoc = docs[key]; console.log(`Found ITR doc: ${key}`); break; }
                }
                
                if (itrDoc) {
                    try {
                        console.log(`Extracting ITR ${year}...`);
                        const buffer = itrDoc.buffer || (itrDoc.s3Key ? await s3Client.getFile(itrDoc.s3Key) : null);
                        if (buffer) {
                            const result = await claudeExtractor.extractITR(buffer, yearLabels[year]);
                            extractedData.itr_returns.push(result);
                            console.log(`ITR ${year} extracted successfully`);
                        }
                    } catch (err) {
                        console.error(`Error extracting ITR ${year}:`, err.message);
                    }
                }
            }
            console.log('ITR extraction complete:', extractedData.itr_returns.length, 'returns processed');
            
        } else if (categoryId === 'kyc') {
            // Extract KYC Documents
            extractedData = { kyc: {} };
            const kycDocTypes = ['coi', 'moa', 'aoa', 'pan_company', 'gst_cert', 'board_resolution', 'dir1_kyc', 'dir2_kyc'];
            
            for (const docType of kycDocTypes) {
                const kycKeys = [`kyc_${docType}`, docType];
                let kycDoc = null;
                for (const key of kycKeys) {
                    if (docs[key]) { kycDoc = docs[key]; console.log(`Found KYC doc: ${key}`); break; }
                }
                
                if (kycDoc) {
                    try {
                        console.log(`Extracting KYC ${docType}...`);
                        const buffer = kycDoc.buffer || (kycDoc.s3Key ? await s3Client.getFile(kycDoc.s3Key) : null);
                        if (buffer) {
                            const result = await claudeExtractor.extractKYC(buffer, docType);
                            extractedData.kyc[docType] = result;
                            console.log(`KYC ${docType} extracted successfully`);
                        }
                    } catch (err) {
                        console.error(`Error extracting KYC ${docType}:`, err.message);
                    }
                }
            }
            console.log('KYC extraction complete:', Object.keys(extractedData.kyc).length, 'documents processed');
            
        } else if (categoryId === 'property') {
            // Extract Property Documents
            extractedData = { property: {} };
            const propDocTypes = ['prop_title', 'prop_valuation', 'prop_enc', 'prop_tax', 'prop_map'];
            
            for (const docType of propDocTypes) {
                const propKeys = [`property_${docType}`, docType];
                let propDoc = null;
                for (const key of propKeys) {
                    if (docs[key]) { propDoc = docs[key]; console.log(`Found Property doc: ${key}`); break; }
                }
                
                if (propDoc) {
                    try {
                        console.log(`Extracting Property ${docType}...`);
                        const buffer = propDoc.buffer || (propDoc.s3Key ? await s3Client.getFile(propDoc.s3Key) : null);
                        if (buffer) {
                            const result = await claudeExtractor.extractProperty(buffer, docType);
                            extractedData.property[docType] = result;
                            console.log(`Property ${docType} extracted successfully`);
                        }
                    } catch (err) {
                        console.error(`Error extracting Property ${docType}:`, err.message);
                    }
                }
            }
            console.log('Property extraction complete:', Object.keys(extractedData.property).length, 'documents processed');
        }
        
        // Store extracted data in assessment
        assessment.category_data = assessment.category_data || {};
        assessment.category_data[categoryId] = extractedData;
        
        console.log(`=== Extract Category ${categoryId} Complete ===\n`);
        
        res.json({
            success: true,
            assessmentId: assessmentId,
            categoryId: categoryId,
            data: extractedData
        });
        
    } catch (error) {
        console.error('Extract category error:', error);
        res.status(500).json({ error: 'Failed to extract category: ' + error.message });
    }
});

/**
 * POST /api/assessment/complete
 * Complete assessment with extracted data and generate results
 */
app.post('/api/assessment/complete', ensureAuthenticated, ensureNotReadOnly, async (req, res) => {
    try {
        const { assessmentId, manualData, reviewedData, apiLogs, apiStats, processingTime, documentTimings, extractionSummary } = req.body;
        
        const assessment = await getAssessmentById(assessmentId);
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        // Use reviewed data if provided, otherwise use extracted data
        let extractedData;
        if (reviewedData) {
            // Keep the reviewed financial data but preserve all other extracted categories
            extractedData = {
                balance_sheet: reviewedData.balance_sheet || assessment.extracted_data?.balance_sheet || {},
                profit_and_loss: reviewedData.profit_and_loss || assessment.extracted_data?.profit_and_loss || {},
                company_info: assessment.extracted_data?.company_info || {},
                // Preserve all other extracted data categories
                gst_returns: assessment.extracted_data?.gst_returns || [],
                bank_statements: assessment.extracted_data?.bank_statements || [],
                itr_returns: assessment.extracted_data?.itr_returns || [],
                kyc: assessment.extracted_data?.kyc || {},
                property: assessment.extracted_data?.property || {},
                gst_aggregated: assessment.extracted_data?.gst_aggregated || null,
                bank_aggregated: assessment.extracted_data?.bank_aggregated || null
            };
            console.log('Using reviewed data for assessment, preserving other categories');
        } else {
            extractedData = assessment.extracted_data || {};
        }
        
        // Merge manual data if provided
        if (manualData) {
            Object.keys(manualData).forEach(key => {
                const [category, year, field] = key.split('_');
                if (extractedData[category] && extractedData[category][year]) {
                    extractedData[category][year][field] = manualData[key];
                }
            });
        }
        
        // Save API logs and timing data
        if (apiLogs) {
            assessment.api_logs = apiLogs;
        }
        if (apiStats) {
            assessment.api_stats = apiStats;
        }
        if (processingTime) {
            assessment.processing_time = processingTime;
        }
        if (documentTimings) {
            assessment.document_timings = documentTimings;
        }
        if (extractionSummary) {
            assessment.extraction_summary = extractionSummary;
        }
        
        // Calculate using new calculation engine (with formula transparency)
        const calculations = calculationEngine.calculateAll(extractedData);
        const creditScore = calculations.credit_score;
        const policyCompliance = calculationEngine.generatePolicyCompliance(calculations);
        
        // Calculate recommended limits
        const bsLatest = extractedData.balance_sheet?.fy25 || {};
        const pnlLatest = extractedData.profit_and_loss?.fy25 || {};
        const recommendedLimits = calculationEngine.calculateLimits(bsLatest, pnlLatest, assessment.loan_amount_lakhs);
        
        // Determine status
        let status = 'Pending';
        const decision = creditScore.decision;
        if (decision.includes('APPROVE') && !decision.includes('PARTIAL') && !decision.includes('CONDITION')) {
            status = 'Approved';
        } else if (decision.includes('REJECT')) {
            status = 'Rejected';
        } else if (decision.includes('PARTIAL')) {
            status = 'Partial';
        }
        
        // Update assessment
        assessment.extracted_data = extractedData;
        assessment.calculations = calculations;
        assessment.credit_score = creditScore;
        assessment.policy_compliance = policyCompliance;
        assessment.recommended_limits = recommendedLimits;
        assessment.status = status;
        assessment.grade = creditScore.grade;
        assessment.score = creditScore.total;
        assessment.completed_at = new Date().toISOString();
        assessment.product = assessment.product || 'WC';
        assessment.branch = assessment.branch || 'Mumbai';
        assessment.priority = assessment.priority || 'High';
        assessment.tat = 0;
        assessment.sla = 2;
        
        // REMOVED: dummyGenerator.generateCompleteAssessment() - was generating fake directors, bureau, banking data
        // All real data now comes from extracted documents only
        
        // Save to S3 if configured
        if (s3Client.isConfigured()) {
            try {
                // Remove buffer data before saving
                const assessmentToSave = { ...assessment };
                if (assessmentToSave.documents) {
                    Object.keys(assessmentToSave.documents).forEach(k => {
                        if (assessmentToSave.documents[k].buffer) {
                            delete assessmentToSave.documents[k].buffer;
                        }
                    });
                }
                await s3Client.saveAssessment(assessmentId, assessmentToSave);
                console.log(`✅ Saved assessment ${assessmentId} to S3`);
            } catch (err) {
                console.error('Error saving to S3:', err.message);
            }
        }
        
        // Update assessments list
        const existingIdx = assessmentsList.findIndex(a => a.assessment_id === assessmentId);
        if (existingIdx >= 0) {
            assessmentsList[existingIdx] = assessment;
        } else {
            assessmentsList.unshift(assessment);
        }
        
        res.json({
            success: true,
            assessmentId: assessmentId,
            results: {
                decision: creditScore.decision,
                grade: creditScore.grade,
                score: creditScore.total,
                breakdown: creditScore.components
            },
            extractedData: extractedData,
            calculatedData: {
                calculations: calculations,
                creditScore: creditScore,
                policyCompliance: policyCompliance,
                recommendedLimits: recommendedLimits
            },
            policyCompliance: policyCompliance,
            // Include timing data for API Log tab
            apiLogs: assessment.api_logs || [],
            apiStats: assessment.api_stats || {},
            processingTime: assessment.processing_time || 0,
            documentTimings: assessment.document_timings || [],
            extractionSummary: assessment.extraction_summary || {}
        });
        
    } catch (error) {
        console.error('Complete assessment error:', error);
        res.status(500).json({ error: 'Failed to complete assessment: ' + error.message });
    }
});

// REMOVED DUPLICATE /api/assessment/:id/reprocess endpoint
// The primary endpoint at line 1224 now handles all reprocessing

/**
 * POST /api/assessment/:id/change-status
 * Super Admin can manually change assessment status
 */
app.post('/api/assessment/:id/change-status', ensureAuthenticated, requireRole('Super Admin', 'super_admin'), async (req, res) => {
    try {
        const assessmentId = req.params.id;
        const { new_status, reason, previous_status } = req.body;
        
        if (!new_status || !reason) {
            return res.status(400).json({ error: 'New status and reason are required' });
        }
        
        let assessment = await getAssessmentById(assessmentId);
        if (!assessment) {
            return res.status(404).json({ error: 'Assessment not found' });
        }
        
        console.log(`📝 STATUS CHANGE: ${assessmentId} | ${previous_status} → ${new_status} by ${req.user.email}`);
        
        assessment.status = new_status;
        assessment.status_override = true;
        assessment.status_changed_by = req.user.email;
        assessment.status_changed_at = new Date().toISOString();
        assessment.status_change_reason = reason;
        
        if (!assessment.audit_trail) assessment.audit_trail = [];
        assessment.audit_trail.push({
            action: 'STATUS_CHANGE', timestamp: new Date().toISOString(),
            user: req.user.email, previous_value: previous_status,
            new_value: new_status, reason: reason
        });
        
        const listIdx = assessmentsList.findIndex(a => (a.assessment_id || a.id) === assessmentId);
        if (listIdx !== -1) {
            assessmentsList[listIdx].status = new_status;
            assessmentsList[listIdx].status_override = true;
            assessmentsList[listIdx].status_changed_by = req.user.email;
        }
        
        if (s3Client.isConfigured()) {
            try {
                const toSave = { ...assessment };
                if (toSave.documents) Object.keys(toSave.documents).forEach(k => { if (toSave.documents[k].buffer) delete toSave.documents[k].buffer; });
                await s3Client.saveAssessment(assessmentId, toSave);
            } catch (err) { console.error('S3 save error:', err.message); }
        }
        
        res.json({ success: true, new_status: new_status });
    } catch (error) {
        console.error('Status change error:', error);
        res.status(500).json({ error: 'Failed to change status: ' + error.message });
    }
});

/**
 * POST /api/extracted-data/save
 * Save approved extracted data to S3
 */
app.post('/api/extracted-data/save', ensureAuthenticated, ensureNotReadOnly, async (req, res) => {
    try {
        const {
            assessment_id,
            company_name,
            loan_amount_lakhs,
            extracted_at,
            approved_at,
            balance_sheet,
            profit_and_loss,
            notes,
            field_status
        } = req.body;
        
        if (!company_name) {
            return res.status(400).json({ error: 'Company name is required' });
        }
        
        // Generate filename: CompanyName_YYYY-MM-DD.json
        const dateStr = new Date().toISOString().split('T')[0];
        const sanitizedName = company_name.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const fileName = `${sanitizedName}_${dateStr}.json`;
        
        // Prepare data object
        const dataToSave = {
            assessment_id: assessment_id,
            company_name: company_name,
            loan_amount_lakhs: loan_amount_lakhs,
            extracted_at: extracted_at,
            approved_at: approved_at || new Date().toISOString(),
            approved_by: 'User',
            balance_sheet: balance_sheet,
            profit_and_loss: profit_and_loss,
            notes: notes || {},
            field_status: field_status || {},
            metadata: {
                version: '3.0',
                source: 'AI Extraction + Manual Review',
                created_at: new Date().toISOString()
            }
        };
        
        const jsonContent = JSON.stringify(dataToSave, null, 2);
        const buffer = Buffer.from(jsonContent, 'utf-8');
        
        // Check if S3 is configured
        if (s3Client.isConfigured()) {
            // Save to S3
            const s3Key = `extracted/${dateStr}/${fileName}`;
            const result = await s3Client.uploadFile(s3Key, buffer, 'application/json');
            
            // Also store reference in assessment
            const assessment = await getAssessmentById(assessment_id);
            if (assessment) {
                assessment.extractedDataFile = {
                    s3Key: result.key,
                    fileName: fileName,
                    savedAt: new Date().toISOString()
                };
            }
            
            console.log(`✅ Extracted data saved to S3: ${s3Key}`);
            
            res.json({
                success: true,
                fileName: fileName,
                s3Key: result.key,
                message: 'Data saved to S3 successfully'
            });
        } else {
            // Store in memory if S3 not configured
            const assessment = await getAssessmentById(assessment_id);
            if (assessment) {
                assessment.extractedDataFile = {
                    data: dataToSave,
                    fileName: fileName,
                    savedAt: new Date().toISOString()
                };
            }
            
            console.log(`⚠️ S3 not configured. Data stored in memory: ${fileName}`);
            
            res.json({
                success: true,
                fileName: fileName,
                message: 'Data saved in memory (S3 not configured)'
            });
        }
    } catch (error) {
        console.error('Save extracted data error:', error);
        res.status(500).json({ error: 'Failed to save data: ' + error.message });
    }
});

/**
 * GET /api/extracted-data/:assessmentId
 * Download saved extracted data
 */
app.get('/api/extracted-data/:assessmentId', ensureAuthenticated, async (req, res) => {
    try {
        const assessment = await getAssessmentById(req.params.assessmentId);
        if (!assessment || !assessment.extractedDataFile) {
            return res.status(404).json({ error: 'Extracted data not found' });
        }
        
        const fileInfo = assessment.extractedDataFile;
        
        if (fileInfo.s3Key && s3Client.isConfigured()) {
            // Fetch from S3
            const buffer = await s3Client.getFile(fileInfo.s3Key);
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${fileInfo.fileName}"`);
            res.send(buffer);
        } else if (fileInfo.data) {
            // Return from memory
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${fileInfo.fileName}"`);
            res.json(fileInfo.data);
        } else {
            res.status(404).json({ error: 'Data file not available' });
        }
    } catch (error) {
        console.error('Download extracted data error:', error);
        res.status(500).json({ error: 'Failed to download data: ' + error.message });
    }
});

/**
 * GET /api/config/status
 * Get configuration status (which services are configured)
 */
app.get('/api/config/status', (req, res) => {
    res.json({
        claudeApi: !!process.env.AWS_REGION || !!process.env.ANTHROPIC_API_KEY,
        claudeMode: process.env.AWS_REGION ? 'bedrock' : (process.env.ANTHROPIC_API_KEY ? 'direct' : null),
        s3Configured: s3Client.isConfigured(),
        s3Bucket: process.env.S3_BUCKET_NAME || null,
        awsRegion: process.env.AWS_REGION || 'ap-south-1'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Initialize server-side processing
async function initializeServerProcessing() {
    console.log('\n🔄 Initializing server-side processing...');
    
    // 1. Initialize Socket.io
    socketManager.initialize(server);
    
    // 2. Initialize Claude Processor
    const claudeReady = claudeProcessor.initialize();
    if (claudeReady) {
        console.log(`   ✅ Claude Processor ready (mode: ${claudeProcessor.mode})`);
    } else {
        console.log('   ⚠️ Claude Processor not available (missing AWS_REGION/Bedrock and ANTHROPIC_API_KEY)');
    }
    
    // 3. Initialize BullMQ (if Redis is configured)
    const bullReady = await bullQueue.initialize({
        socketManager,
        s3Client,
        claudeProcessor,
        assessments,
        assessmentsList,
        jobQueue  // Add in-memory job queue for progress tracking
    });
    
    if (bullReady) {
        console.log('   ✅ BullMQ Queue ready (server-side processing enabled)');
    } else {
        console.log('   ⚠️ BullMQ not available (missing REDIS_URL) - using client-side processing');
    }
    
    return { socketManager, bullQueue, claudeProcessor };
}

// Start server
async function startServer() {
    await initializeData();
    await initializeServerProcessing();
    
    server.listen(PORT, () => {
        console.log(`\n🚀 Agentic Underwriting Platform`);
        console.log(`   Version: 7.1.0 (with Server-Side Processing)`);
        console.log(`   Server running on port ${PORT}`);
        console.log(`\n🔐 Authentication Status:`);
        console.log(`   ADFS SAML SSO: ${process.env.ADFS_SIGNING_CERT ? '✅ Enabled' : '❌ Not configured'}`);
        console.log(`   ADFS Callback URL: ${process.env.ADFS_CALLBACK_URL || 'Not set'}`);
        console.log(`   Session Secret: ${process.env.SESSION_SECRET ? '✅ Configured' : '❌ Not configured'}`);
        console.log(`\n📋 Configuration Status:`);
        console.log(`   Claude API: ${claudeProcessor.isReady() ? `✅ Configured (${claudeProcessor.mode})` : '❌ Not configured'}`);
        console.log(`   AWS S3: ${s3Client.isConfigured() ? '✅ Configured' : '❌ Not configured'}`);
        console.log(`   S3 Bucket: ${process.env.S3_BUCKET_NAME || 'Not set'}`);
        console.log(`   Redis/BullMQ: ${bullQueue.isReady() ? '✅ Connected' : '⚠️ Not configured (client-side mode)'}`);
        console.log(`   WebSocket: ${socketManager.isReady() ? '✅ Ready' : '❌ Not ready'}`);
        console.log(`   Assessments Loaded: ${assessments.size}`);
        console.log(`\n🔗 Endpoints:`);
        console.log(`   GET  /                          - Main application (🔒 Protected)`);
        console.log(`   GET  /login                     - Login page`);
        console.log(`   GET  /auth/saml/login           - ADFS SAML login`);
        console.log(`   POST /auth/saml/callback        - SAML assertion callback`);
        console.log(`   GET  /auth/logout               - Logout`);
        console.log(`   GET  /health                    - Health check`);
        console.log(`   GET  /api/assessments           - List all assessments (🔒 Protected)`);
        console.log(`   GET  /api/assessment/:id        - Get assessment details (🔒 Protected)`);
        console.log(`   POST /api/assessment/create     - Create new assessment`);
        console.log(`   POST /api/upload/direct         - Upload document`);
        console.log(`   POST /api/extract-financials    - Extract data with Claude`);
        console.log(`   POST /api/assessment/complete   - Complete assessment`);
        console.log(`   POST /api/extracted-data/save   - Save approved data to S3`);
        console.log(`   POST /api/assessment/:id/process-server - Server-side processing (NEW)\n`);
    });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    await bullQueue.shutdown();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

startServer();
