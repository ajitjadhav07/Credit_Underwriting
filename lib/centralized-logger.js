/**
 * Centralized Logger - All Application Logs
 * 
 * VERSION: 1.0.0
 * CREATED: February 6, 2025
 * 
 * Features:
 * - All log streams (security, sessions, access, application, pii-audit)
 * - Automatic PII masking
 * - Correlation ID tracking
 * - Buffered writes to S3
 * - CEF format support for SIEM
 * 
 * Log Levels:
 * - DEBUG (0): Detailed debugging info
 * - INFO (1): General information
 * - WARN (2): Warning conditions
 * - ERROR (3): Error conditions
 * - FATAL (4): Critical failures
 */

'use strict';

const crypto = require('crypto');
const { maskPII, maskObject, maskIP, hashValue } = require('./pii-handler');

// ==================== CONFIGURATION ====================

const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    FATAL: 4
};

const LOG_LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

const SEVERITY_MAP = {
    DEBUG: 1,
    INFO: 3,
    WARN: 5,
    ERROR: 7,
    FATAL: 10
};

const DEFAULT_CONFIG = {
    // Minimum log level to record
    minLevel: LOG_LEVELS.DEBUG,
    
    // Buffer settings
    bufferSize: 50,
    flushIntervalMs: 30000, // 30 seconds
    
    // Console output
    consoleEnabled: true,
    consoleLevel: LOG_LEVELS.INFO,
    
    // Platform info
    platform: {
        name: 'AFL-Underwriting',
        version: '7.4.1',
        environment: process.env.NODE_ENV || 'development'
    }
};

// ==================== CENTRALIZED LOGGER CLASS ====================

class CentralizedLogger {
    constructor(siemStorage, config = {}) {
        this.storage = siemStorage;
        this.config = { ...DEFAULT_CONFIG, ...config };
        
        // Separate buffers for each log type
        this.buffers = {
            security: [],
            sessions: [],
            access: [],
            application: [],
            'pii-audit': []
        };
        
        // Active sessions tracking (in-memory for quick lookup)
        this.activeSessions = new Map();
        
        // Instance ID for this server
        this.instanceId = `render-${crypto.randomBytes(4).toString('hex')}`;
        
        // Start flush interval
        this.flushInterval = setInterval(() => {
            this.flushAll();
        }, this.config.flushIntervalMs);
        
        // Ensure flush on exit
        process.on('beforeExit', () => this.flushAll());
        process.on('SIGINT', async () => {
            await this.flushAll();
            process.exit(0);
        });
        process.on('SIGTERM', async () => {
            await this.flushAll();
            process.exit(0);
        });
        
        this.info('CentralizedLogger initialized', { instanceId: this.instanceId });
    }
    
    // ==================== CORE LOGGING METHODS ====================
    
    /**
     * Log a debug message
     */
    debug(message, context = {}, req = null) {
        return this._log(LOG_LEVELS.DEBUG, message, context, req);
    }
    
    /**
     * Log an info message
     */
    info(message, context = {}, req = null) {
        return this._log(LOG_LEVELS.INFO, message, context, req);
    }
    
    /**
     * Log a warning
     */
    warn(message, context = {}, req = null) {
        return this._log(LOG_LEVELS.WARN, message, context, req);
    }
    
    /**
     * Log an error
     */
    error(message, context = {}, req = null) {
        return this._log(LOG_LEVELS.ERROR, message, context, req);
    }
    
    /**
     * Log a fatal error
     */
    fatal(message, context = {}, req = null) {
        return this._log(LOG_LEVELS.FATAL, message, context, req);
    }
    
    /**
     * Internal log method
     */
    _log(level, message, context, req) {
        if (level < this.config.minLevel) return null;
        
        const entry = this._createLogEntry('application', LOG_LEVEL_NAMES[level], message, context, req);
        
        // Console output
        if (this.config.consoleEnabled && level >= this.config.consoleLevel) {
            this._consoleLog(level, message, context);
        }
        
        this.buffers.application.push(entry);
        this._checkFlush('application');
        
        return entry;
    }
    
    // ==================== SECURITY EVENTS ====================
    
    /**
     * Log a security event
     */
    security(action, details = {}, req = null) {
        const entry = this._createLogEntry('security', action, null, details, req);
        
        // Add security-specific fields
        entry.security = {
            action: action,
            outcome: details.outcome || (details.success ? 'success' : 'failure'),
            risk_level: details.risk_level || this._calculateRiskLevel(action, details)
        };
        
        // Console output
        if (this.config.consoleEnabled) {
            const emoji = this._getSecurityEmoji(action);
            console.log(`${emoji} [SECURITY] ${action}: ${JSON.stringify(maskObject(details))}`);
        }
        
        this.buffers.security.push(entry);
        this._checkFlush('security');
        
        // Immediate flush for high-risk events
        if (entry.security.risk_level === 'critical') {
            this.flush('security');
        }
        
        return entry;
    }
    
    // ==================== SESSION EVENTS ====================
    
    /**
     * Log session start (user login)
     */
    sessionStart(sessionId, user, req) {
        const session = {
            id: sessionId,
            user_id: user.id || hashValue(user.email),
            user_email_hash: hashValue(user.email),
            user_role: user.role,
            started_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
            ip: maskIP(req?.ip),
            user_agent: req?.headers?.['user-agent'] || 'unknown',
            auth_method: user.auth_method || 'office365_sso',
            pages_viewed: [],
            actions_performed: [],
            assessments_accessed: []
        };
        
        this.activeSessions.set(sessionId, session);
        
        const entry = this._createLogEntry('sessions', 'SESSION_START', null, {
            session_id: sessionId,
            user_role: user.role
        }, req);
        
        entry.session = {
            id: sessionId,
            user_id_hash: session.user_id,
            user_role: session.user_role,
            auth_method: session.auth_method
        };
        
        if (this.config.consoleEnabled) {
            console.log(`🔐 [SESSION] START: ${hashValue(user.email).substring(0, 8)}... Role: ${user.role}`);
        }
        
        this.buffers.sessions.push(entry);
        this._checkFlush('sessions');
        
        return entry;
    }
    
    /**
     * Log page view
     */
    sessionPageView(sessionId, page, req) {
        const session = this.activeSessions.get(sessionId);
        if (session) {
            session.last_activity_at = new Date().toISOString();
            session.pages_viewed.push({
                page: page,
                timestamp: new Date().toISOString()
            });
        }
        
        const entry = this._createLogEntry('sessions', 'PAGE_VIEW', null, {
            session_id: sessionId,
            page: page
        }, req);
        
        if (this.config.consoleEnabled && this.config.minLevel === LOG_LEVELS.DEBUG) {
            console.log(`📄 [SESSION] Page: ${page}`);
        }
        
        this.buffers.sessions.push(entry);
        this._checkFlush('sessions');
        
        return entry;
    }
    
    /**
     * Log user action
     */
    sessionAction(sessionId, action, details = {}, req = null) {
        const session = this.activeSessions.get(sessionId);
        if (session) {
            session.last_activity_at = new Date().toISOString();
            session.actions_performed.push({
                action: action,
                timestamp: new Date().toISOString(),
                details: details
            });
            
            // Track assessment access
            if (details.assessmentId) {
                if (!session.assessments_accessed.includes(details.assessmentId)) {
                    session.assessments_accessed.push(details.assessmentId);
                }
            }
        }
        
        const entry = this._createLogEntry('sessions', 'USER_ACTION', null, {
            session_id: sessionId,
            action: action,
            ...maskObject(details)
        }, req);
        
        if (this.config.consoleEnabled) {
            console.log(`⚡ [SESSION] Action: ${action}`);
        }
        
        this.buffers.sessions.push(entry);
        this._checkFlush('sessions');
        
        return entry;
    }
    
    /**
     * Log session end (logout)
     */
    sessionEnd(sessionId, reason = 'logout', req = null) {
        const session = this.activeSessions.get(sessionId);
        
        const entry = this._createLogEntry('sessions', 'SESSION_END', null, {
            session_id: sessionId,
            reason: reason,
            duration_seconds: session ? 
                Math.round((Date.now() - new Date(session.started_at).getTime()) / 1000) : null,
            pages_viewed_count: session?.pages_viewed?.length || 0,
            actions_count: session?.actions_performed?.length || 0,
            assessments_accessed_count: session?.assessments_accessed?.length || 0
        }, req);
        
        if (this.config.consoleEnabled) {
            console.log(`👋 [SESSION] END: Reason=${reason}`);
        }
        
        this.activeSessions.delete(sessionId);
        
        this.buffers.sessions.push(entry);
        this._checkFlush('sessions');
        
        return entry;
    }
    
    // ==================== ACCESS LOGS ====================
    
    /**
     * Log HTTP request/response
     */
    access(req, res, responseTimeMs) {
        const entry = this._createLogEntry('access', 'HTTP_REQUEST', null, {}, req);
        
        entry.http = {
            method: req.method,
            path: req.path,
            query: maskObject(req.query || {}),
            status_code: res.statusCode,
            response_time_ms: responseTimeMs,
            content_length: res.get('Content-Length') || 0,
            referrer: req.headers?.referer || null
        };
        
        // Flag slow requests
        if (responseTimeMs > 5000) {
            entry.http.slow_request = true;
        }
        
        this.buffers.access.push(entry);
        this._checkFlush('access');
        
        return entry;
    }
    
    // ==================== PII AUDIT ====================
    
    /**
     * Log PII access (for compliance)
     */
    piiAccess(userId, action, dataType, recordId, req = null, reason = 'user_request') {
        const entry = this._createLogEntry('pii-audit', action, null, {
            data_type: dataType,
            record_id: recordId,
            reason: reason
        }, req);
        
        entry.pii = {
            user_id_hash: hashValue(userId),
            action: action, // view, export, modify, delete
            data_type: dataType, // assessment, pan, aadhaar, bank_statement, etc.
            record_id: recordId,
            reason: reason,
            timestamp: new Date().toISOString()
        };
        
        if (this.config.consoleEnabled) {
            console.log(`🔐 [PII-AUDIT] ${action} ${dataType} by ${hashValue(userId).substring(0, 8)}...`);
        }
        
        this.buffers['pii-audit'].push(entry);
        this._checkFlush('pii-audit');
        
        return entry;
    }
    
    // ==================== HELPER METHODS ====================
    
    /**
     * Create a standardized log entry
     */
    _createLogEntry(type, action, message, context, req) {
        const now = new Date();
        const correlationId = req?.correlationId || `req_${crypto.randomBytes(8).toString('hex')}`;
        
        return {
            // Event identification
            event_id: `evt_${crypto.randomBytes(12).toString('hex')}`,
            timestamp: now.toISOString(),
            timestamp_unix: now.getTime(),
            correlation_id: correlationId,
            
            // Log classification
            log_type: type,
            action: action,
            message: message ? maskPII(message) : null,
            level: type === 'application' ? action : 'INFO',
            severity: SEVERITY_MAP[action] || SEVERITY_MAP.INFO,
            
            // Context (PII masked)
            context: maskObject(context),
            
            // Source information
            source: {
                ip: req ? maskIP(req.ip) : null,
                user_agent: req?.headers?.['user-agent'] || null,
                user_id: req?.user?.id || null,
                user_email_hash: req?.user?.email ? hashValue(req.user.email) : null,
                user_role: req?.user?.role || null,
                session_id: req?.sessionID ? hashValue(req.sessionID) : null
            },
            
            // Platform information
            platform: {
                name: this.config.platform.name,
                version: this.config.platform.version,
                environment: this.config.platform.environment,
                instance_id: this.instanceId
            },
            
            // CEF format for SIEM compatibility
            cef: this._generateCEF(type, action, context, req)
        };
    }
    
    /**
     * Generate CEF (Common Event Format) string
     */
    _generateCEF(type, action, context, req) {
        const severity = SEVERITY_MAP[action] || SEVERITY_MAP.INFO;
        const timestamp = new Date().toISOString();
        
        // CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
        let cef = `CEF:0|ACC|${this.config.platform.name}|${this.config.platform.version}|`;
        cef += `${type.toUpperCase()}_${action}|${action}|${severity}|`;
        
        // Extension fields
        const ext = [];
        if (req?.ip) ext.push(`src=${maskIP(req.ip)}`);
        if (req?.user?.email) ext.push(`suser=${hashValue(req.user.email).substring(0, 16)}`);
        if (req?.user?.role) ext.push(`spriv=${req.user.role}`);
        if (context.assessmentId) ext.push(`cs1Label=AssessmentID cs1=${context.assessmentId}`);
        if (context.reason) ext.push(`reason=${context.reason}`);
        ext.push(`rt=${timestamp}`);
        
        return cef + ext.join(' ');
    }
    
    /**
     * Calculate risk level for security events
     */
    _calculateRiskLevel(action, details) {
        const highRiskActions = ['LOGIN_FAILED', 'ACCESS_DENIED', 'PERMISSION_DENIED', 'FORENSIC_EXPORT', 'DATA_DELETED'];
        const criticalActions = ['MULTIPLE_LOGIN_FAILURES', 'SUSPICIOUS_ACTIVITY', 'BREACH_DETECTED'];
        
        if (criticalActions.includes(action)) return 'critical';
        if (highRiskActions.includes(action)) return 'high';
        if (details.failed_attempts > 3) return 'high';
        return 'normal';
    }
    
    /**
     * Console log with formatting
     */
    _consoleLog(level, message, context) {
        const emoji = ['🔍', 'ℹ️', '⚠️', '❌', '💀'][level];
        const levelName = LOG_LEVEL_NAMES[level];
        console.log(`${emoji} [${levelName}] ${message}`);
        if (Object.keys(context).length > 0 && level >= LOG_LEVELS.WARN) {
            console.log(`   Context: ${JSON.stringify(maskObject(context))}`);
        }
    }
    
    /**
     * Get emoji for security event
     */
    _getSecurityEmoji(action) {
        const emojis = {
            'LOGIN_SUCCESS': '✅',
            'LOGIN_FAILED': '❌',
            'LOGOUT': '👋',
            'ACCESS_DENIED': '🚫',
            'PERMISSION_DENIED': '⛔',
            'RATE_LIMITED': '🚦',
            'SUSPICIOUS_ACTIVITY': '⚠️',
            'FORENSIC_EXPORT': '📦',
            'DATA_EXPORT': '📤',
            'DATA_MODIFIED': '✏️',
            'DATA_DELETED': '🗑️',
            'ROLE_CHANGED': '👤'
        };
        return emojis[action] || '🔒';
    }
    
    // ==================== FLUSH METHODS ====================
    
    /**
     * Check if buffer should be flushed
     */
    _checkFlush(type) {
        if (this.buffers[type].length >= this.config.bufferSize) {
            this.flush(type);
        }
    }
    
    /**
     * Flush a specific buffer
     */
    async flush(type) {
        const buffer = this.buffers[type];
        if (!buffer || buffer.length === 0) return;
        
        const entries = [...buffer];
        buffer.length = 0;
        
        try {
            if (this.storage) {
                await this.storage.write(type, entries);
            }
        } catch (err) {
            console.error(`Failed to flush ${type} logs:`, err.message);
            // Re-add entries on failure
            this.buffers[type].push(...entries);
        }
    }
    
    /**
     * Flush all buffers
     */
    async flushAll() {
        const types = Object.keys(this.buffers);
        await Promise.allSettled(types.map(type => this.flush(type)));
    }
    
    // ==================== CLEANUP ====================
    
    /**
     * Destroy logger (cleanup)
     */
    destroy() {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
        }
        this.flushAll();
    }
}

// ==================== EXPRESS MIDDLEWARE ====================

/**
 * Create correlation ID middleware
 */
function correlationMiddleware() {
    return (req, res, next) => {
        req.correlationId = req.headers['x-correlation-id'] || 
                           `req_${crypto.randomBytes(8).toString('hex')}`;
        res.setHeader('X-Correlation-ID', req.correlationId);
        next();
    };
}

/**
 * Create access logging middleware
 */
function accessLogMiddleware(logger) {
    return (req, res, next) => {
        const startTime = Date.now();
        
        res.on('finish', () => {
            const responseTime = Date.now() - startTime;
            logger.access(req, res, responseTime);
        });
        
        next();
    };
}

/**
 * Create session tracking middleware
 */
function sessionTrackingMiddleware(logger) {
    return (req, res, next) => {
        // Track page views for authenticated users
        if (req.isAuthenticated && req.isAuthenticated() && req.sessionID) {
            // Only track actual page requests, not API calls
            if (!req.path.startsWith('/api/') && req.method === 'GET') {
                logger.sessionPageView(req.sessionID, req.path, req);
            }
        }
        next();
    };
}

// ==================== EXPORTS ====================

module.exports = {
    CentralizedLogger,
    correlationMiddleware,
    accessLogMiddleware,
    sessionTrackingMiddleware,
    LOG_LEVELS,
    LOG_LEVEL_NAMES
};
