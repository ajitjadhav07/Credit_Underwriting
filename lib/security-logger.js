/**
 * Security Logger - PII-Safe Audit Logging System
 * 
 * VERSION: 1.0.0
 * CREATED: February 5, 2025
 * 
 * Features:
 * - Automatic PII masking in all logs
 * - Separate streams for security events and PII access
 * - S3 persistence with encryption support
 * - RBI compliance (7-year retention support)
 * - Configurable log levels and destinations
 * 
 * Log Types:
 * - Security Events: Login, logout, access denied, etc. (masked, 90 days)
 * - Application Logs: Errors, warnings, info (masked, 90 days)
 * - PII Access Audit: Who accessed what PII when (encrypted, 7 years)
 * - Access Logs: HTTP requests (minimal PII, 1 year)
 */

'use strict';

const crypto = require('crypto');
const { maskObject, maskIP, hashValue, createPIIAuditEntry, maskPII } = require('./pii-handler');

// ==================== CONFIGURATION ====================

const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

const DEFAULT_CONFIG = {
    // Buffer settings
    bufferSize: 50,
    flushIntervalMs: 60000, // 1 minute
    
    // Log level
    logLevel: LOG_LEVELS.INFO,
    
    // Console output
    consoleEnabled: true,
    consoleLevel: LOG_LEVELS.INFO,
    
    // S3 settings
    s3Enabled: true,
    s3Bucket: process.env.S3_BUCKET_NAME,
    
    // Paths
    securityLogPath: 'logs/security',
    applicationLogPath: 'logs/application',
    piiAuditPath: 'logs/pii-audit',
    accessLogPath: 'logs/access',
    
    // Retention (for reference, actual deletion handled separately)
    retentionDays: {
        security: 90,
        application: 90,
        piiAudit: 2555, // 7 years
        access: 365
    }
};

// ==================== SECURITY LOGGER CLASS ====================

class SecurityLogger {
    constructor(s3Client, config = {}) {
        this.s3 = s3Client;
        this.config = { ...DEFAULT_CONFIG, ...config };
        
        // Separate buffers for different log types
        this.buffers = {
            security: [],
            application: [],
            piiAudit: [],
            access: []
        };
        
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
    }
    
    // ==================== SECURITY EVENTS ====================
    
    /**
     * Log a security event (login, logout, access denied, etc.)
     * PII is automatically masked
     */
    logSecurityEvent(eventType, details, req) {
        const event = {
            timestamp: new Date().toISOString(),
            eventId: crypto.randomUUID(),
            eventType: eventType,
            // Mask all details
            details: maskObject(details),
            // Request info (masked)
            request: req ? {
                method: req.method,
                path: req.path,
                ip: maskIP(req.ip),
                userAgent: req.headers?.['user-agent'] || 'unknown',
                sessionId: req.sessionID ? hashValue(req.sessionID) : null
            } : null,
            // User info
            user: req?.user ? {
                id: req.user.id,
                emailHash: hashValue(req.user.email),
                role: req.user.role
            } : null
        };
        
        // Console output
        if (this.config.consoleEnabled) {
            const emoji = this._getSecurityEmoji(eventType);
            console.log(`${emoji} [SECURITY] ${eventType}: ${JSON.stringify(event.details)}`);
        }
        
        this.buffers.security.push(event);
        this._checkFlush('security');
        
        return event;
    }
    
    // ==================== APPLICATION LOGS ====================
    
    /**
     * Log an error (PII masked)
     */
    error(message, context = {}, req = null) {
        return this._logApplication('ERROR', message, context, req);
    }
    
    /**
     * Log a warning (PII masked)
     */
    warn(message, context = {}, req = null) {
        return this._logApplication('WARN', message, context, req);
    }
    
    /**
     * Log info (PII masked)
     */
    info(message, context = {}, req = null) {
        return this._logApplication('INFO', message, context, req);
    }
    
    /**
     * Log debug (PII masked)
     */
    debug(message, context = {}, req = null) {
        return this._logApplication('DEBUG', message, context, req);
    }
    
    _logApplication(level, message, context, req) {
        if (LOG_LEVELS[level] > this.config.logLevel) return null;
        
        const entry = {
            timestamp: new Date().toISOString(),
            level: level,
            message: maskPII(message),
            context: maskObject(context),
            request: req ? {
                method: req.method,
                path: req.path,
                ip: maskIP(req.ip)
            } : null
        };
        
        // Console output
        if (this.config.consoleEnabled && LOG_LEVELS[level] <= this.config.consoleLevel) {
            const emoji = this._getLevelEmoji(level);
            console.log(`${emoji} [${level}] ${entry.message}`);
            if (Object.keys(entry.context).length > 0) {
                console.log(`   Context: ${JSON.stringify(entry.context)}`);
            }
        }
        
        this.buffers.application.push(entry);
        this._checkFlush('application');
        
        return entry;
    }
    
    // ==================== PII ACCESS AUDIT ====================
    
    /**
     * Log PII access (encrypted, 7-year retention)
     * This is for compliance - tracking who accessed what sensitive data
     */
    logPIIAccess(params) {
        const { userId, action, dataType, recordId, fieldAccessed, reason, req } = params;
        
        const entry = createPIIAuditEntry({
            userId,
            action,
            dataType,
            recordId,
            fieldAccessed,
            reason,
            req
        });
        
        // Console output (limited info)
        if (this.config.consoleEnabled) {
            console.log(`🔐 [PII-AUDIT] ${action} ${dataType} by ${hashValue(userId).substring(0, 8)}... on record ${recordId}`);
        }
        
        this.buffers.piiAudit.push(entry);
        this._checkFlush('piiAudit');
        
        return entry;
    }
    
    // ==================== ACCESS LOGS ====================
    
    /**
     * Log HTTP request (minimal PII)
     */
    logAccess(req, res, responseTime) {
        const entry = {
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            responseTimeMs: responseTime,
            ip: maskIP(req.ip),
            userAgent: req.headers?.['user-agent'] || 'unknown',
            userId: req.user?.id || null,
            contentLength: res.get('Content-Length') || 0
        };
        
        this.buffers.access.push(entry);
        this._checkFlush('access');
        
        return entry;
    }
    
    // ==================== FLUSH METHODS ====================
    
    async flushAll() {
        const promises = [
            this._flush('security'),
            this._flush('application'),
            this._flush('piiAudit'),
            this._flush('access')
        ];
        
        await Promise.allSettled(promises);
    }
    
    async _flush(bufferName) {
        const buffer = this.buffers[bufferName];
        if (buffer.length === 0) return;
        
        const eventsToFlush = [...buffer];
        buffer.length = 0; // Clear buffer
        
        try {
            if (this.config.s3Enabled && this.s3?.isConfigured?.()) {
                const date = new Date();
                const datePath = `${date.getFullYear()}/${String(date.getMonth()+1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')}`;
                const fileName = `${date.toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(4).toString('hex')}.json`;
                
                let basePath;
                let putOptions = {};
                
                switch(bufferName) {
                    case 'security':
                        basePath = this.config.securityLogPath;
                        break;
                    case 'application':
                        basePath = this.config.applicationLogPath;
                        break;
                    case 'piiAudit':
                        basePath = this.config.piiAuditPath;
                        // PII audit logs should be encrypted
                        putOptions = {
                            ServerSideEncryption: 'aws:kms',
                            // KMS key ID from environment if available
                            ...(process.env.KMS_KEY_ID && { SSEKMSKeyId: process.env.KMS_KEY_ID })
                        };
                        break;
                    case 'access':
                        basePath = this.config.accessLogPath;
                        break;
                }
                
                const key = `${basePath}/${datePath}/${fileName}`;
                await this.s3.putObject(key, JSON.stringify(eventsToFlush, null, 2), putOptions);
                
                if (this.config.consoleEnabled) {
                    console.log(`✓ Flushed ${eventsToFlush.length} ${bufferName} events to S3`);
                }
            }
        } catch (err) {
            console.error(`Failed to flush ${bufferName} log:`, err.message);
            // Re-add events to buffer on failure
            this.buffers[bufferName].push(...eventsToFlush);
        }
    }
    
    _checkFlush(bufferName) {
        if (this.buffers[bufferName].length >= this.config.bufferSize) {
            this._flush(bufferName);
        }
    }
    
    // ==================== HELPERS ====================
    
    _getSecurityEmoji(eventType) {
        const emojis = {
            'LOGIN_SUCCESS': '✅',
            'LOGIN_FAILED': '❌',
            'LOGOUT': '👋',
            'ACCESS_DENIED': '🚫',
            'PERMISSION_DENIED': '⛔',
            'RATE_LIMITED': '🚦',
            'SUSPICIOUS_ACTIVITY': '⚠️',
            'PASSWORD_CHANGED': '🔑',
            'SESSION_EXPIRED': '⏰',
            'DATA_EXPORT': '📤',
            'DATA_MODIFIED': '✏️',
            'DATA_DELETED': '🗑️'
        };
        return emojis[eventType] || '🔒';
    }
    
    _getLevelEmoji(level) {
        const emojis = {
            'ERROR': '❌',
            'WARN': '⚠️',
            'INFO': 'ℹ️',
            'DEBUG': '🔍'
        };
        return emojis[level] || '📝';
    }
    
    // ==================== CLEANUP ====================
    
    destroy() {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
        }
    }
}

// ==================== EXPRESS MIDDLEWARE ====================

/**
 * Create access logging middleware
 */
function createAccessLogMiddleware(logger) {
    return (req, res, next) => {
        const startTime = Date.now();
        
        // Log on response finish
        res.on('finish', () => {
            const responseTime = Date.now() - startTime;
            logger.logAccess(req, res, responseTime);
        });
        
        next();
    };
}

/**
 * Create PII access tracking middleware for specific routes
 */
function createPIIAccessMiddleware(logger, dataType) {
    return (req, res, next) => {
        // Log PII access
        logger.logPIIAccess({
            userId: req.user?.email || 'anonymous',
            action: req.method === 'GET' ? 'view' : 'modify',
            dataType: dataType,
            recordId: req.params.id || req.params.assessmentId || 'unknown',
            fieldAccessed: req.query.field || null,
            reason: req.body?.reason || 'user_request',
            req: req
        });
        
        next();
    };
}

/**
 * Create error logging middleware
 */
function createErrorLogMiddleware(logger) {
    return (err, req, res, next) => {
        logger.error(err.message, {
            stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
            code: err.code,
            statusCode: err.status || err.statusCode || 500
        }, req);
        
        next(err);
    };
}

// ==================== EXPORTS ====================

module.exports = {
    SecurityLogger,
    createAccessLogMiddleware,
    createPIIAccessMiddleware,
    createErrorLogMiddleware,
    LOG_LEVELS
};
