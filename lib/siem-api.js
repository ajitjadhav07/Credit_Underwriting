/**
 * SIEM API - REST API for Log Access
 * 
 * VERSION: 1.0.0
 * CREATED: February 6, 2025
 * 
 * Features:
 * - API Key + Timestamp + HMAC authentication
 * - IP whitelist validation
 * - Rate limiting
 * - Cursor-based pagination
 * - Full audit logging of API access
 * 
 * Environment Variables:
 * - SIEM_API_KEY: API key for authentication
 * - SIEM_API_SECRET: Secret for HMAC signature
 * - SIEM_ALLOWED_IPS: Comma-separated list of allowed IPs
 */

'use strict';

const crypto = require('crypto');
const express = require('express');

// ==================== CONFIGURATION ====================

const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100;
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

// ==================== AUTHENTICATION MIDDLEWARE ====================

/**
 * Validate SIEM API request
 * - Checks API key
 * - Validates timestamp (within 5 minutes)
 * - Verifies HMAC signature
 * - Validates IP whitelist
 */
function siemAuthMiddleware(logger) {
    // Rate limiting state
    const requestCounts = new Map();
    
    return (req, res, next) => {
        const apiKey = req.headers['x-api-key'];
        const timestamp = req.headers['x-timestamp'];
        const signature = req.headers['x-signature'];
        const clientIP = req.ip || req.connection?.remoteAddress;
        
        // Get configuration from environment
        const configuredApiKey = process.env.SIEM_API_KEY;
        const configuredSecret = process.env.SIEM_API_SECRET;
        const allowedIPs = (process.env.SIEM_ALLOWED_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean);
        
        // Log the attempt
        const logAttempt = (success, reason) => {
            if (logger) {
                logger.security(success ? 'SIEM_API_ACCESS' : 'SIEM_API_DENIED', {
                    success: success,
                    reason: reason,
                    client_ip: clientIP,
                    api_key_provided: !!apiKey,
                    timestamp_provided: !!timestamp,
                    signature_provided: !!signature
                }, req);
            }
        };
        
        // Check if SIEM API is configured
        if (!configuredApiKey || !configuredSecret) {
            logAttempt(false, 'SIEM API not configured');
            return res.status(503).json({
                success: false,
                error: 'siem_not_configured',
                message: 'SIEM API is not configured on this server'
            });
        }
        
        // Check API key
        if (!apiKey) {
            logAttempt(false, 'Missing API key');
            return res.status(401).json({
                success: false,
                error: 'missing_api_key',
                message: 'X-API-Key header is required'
            });
        }
        
        if (apiKey !== configuredApiKey) {
            logAttempt(false, 'Invalid API key');
            return res.status(401).json({
                success: false,
                error: 'invalid_api_key',
                message: 'Invalid API key'
            });
        }
        
        // Check timestamp
        if (!timestamp) {
            logAttempt(false, 'Missing timestamp');
            return res.status(401).json({
                success: false,
                error: 'missing_timestamp',
                message: 'X-Timestamp header is required'
            });
        }
        
        const requestTime = new Date(timestamp).getTime();
        const now = Date.now();
        
        if (isNaN(requestTime)) {
            logAttempt(false, 'Invalid timestamp format');
            return res.status(401).json({
                success: false,
                error: 'invalid_timestamp',
                message: 'X-Timestamp must be in ISO 8601 format'
            });
        }
        
        if (Math.abs(now - requestTime) > TIMESTAMP_TOLERANCE_MS) {
            logAttempt(false, 'Timestamp expired');
            return res.status(401).json({
                success: false,
                error: 'timestamp_expired',
                message: 'Request timestamp is outside the 5-minute tolerance window'
            });
        }
        
        // Check HMAC signature
        if (!signature) {
            logAttempt(false, 'Missing signature');
            return res.status(401).json({
                success: false,
                error: 'missing_signature',
                message: 'X-Signature header is required'
            });
        }
        
        // Generate expected signature
        // Signature = HMAC-SHA256(timestamp + method + path + query, secret)
        const queryString = Object.keys(req.query).length > 0 
            ? '?' + new URLSearchParams(req.query).toString() 
            : '';
        const signaturePayload = `${timestamp}${req.method}${req.path}${queryString}`;
        const expectedSignature = crypto
            .createHmac('sha256', configuredSecret)
            .update(signaturePayload)
            .digest('hex');
        
        if (signature !== expectedSignature) {
            logAttempt(false, 'Invalid signature');
            return res.status(401).json({
                success: false,
                error: 'invalid_signature',
                message: 'HMAC signature validation failed'
            });
        }
        
        // Check IP whitelist (if configured)
        if (allowedIPs.length > 0) {
            // Normalize IP (handle IPv6 localhost)
            const normalizedIP = clientIP === '::1' ? '127.0.0.1' : clientIP?.replace('::ffff:', '');
            
            if (!allowedIPs.includes(normalizedIP) && !allowedIPs.includes(clientIP)) {
                logAttempt(false, 'IP not whitelisted');
                return res.status(403).json({
                    success: false,
                    error: 'ip_not_allowed',
                    message: 'Client IP is not in the allowed list'
                });
            }
        }
        
        // Rate limiting
        const rateLimitKey = `${apiKey}_${Math.floor(now / RATE_LIMIT_WINDOW_MS)}`;
        const currentCount = requestCounts.get(rateLimitKey) || 0;
        
        if (currentCount >= RATE_LIMIT_MAX_REQUESTS) {
            logAttempt(false, 'Rate limited');
            return res.status(429).json({
                success: false,
                error: 'rate_limited',
                message: 'Rate limit exceeded. Maximum 100 requests per minute.',
                retry_after: Math.ceil((RATE_LIMIT_WINDOW_MS - (now % RATE_LIMIT_WINDOW_MS)) / 1000)
            });
        }
        
        requestCounts.set(rateLimitKey, currentCount + 1);
        
        // Clean old rate limit entries
        for (const [key, _] of requestCounts) {
            if (!key.endsWith(`_${Math.floor(now / RATE_LIMIT_WINDOW_MS)}`)) {
                requestCounts.delete(key);
            }
        }
        
        // All checks passed
        logAttempt(true, 'Authentication successful');
        next();
    };
}

// ==================== CREATE SIEM ROUTER ====================

/**
 * Create Express router for SIEM API
 * @param {SIEMStorage} storage - SIEM storage instance
 * @param {CentralizedLogger} logger - Logger instance
 */
function createSIEMRouter(storage, logger) {
    const router = express.Router();
    
    // Health check (no auth required) - Use this to verify SIEM is working
    router.get('/health', async (req, res) => {
        try {
            const stats = await storage.getStats();
            
            // Check configuration
            const apiKeyConfigured = !!process.env.SIEM_API_KEY;
            const secretConfigured = !!process.env.SIEM_API_SECRET;
            const allowedIPs = (process.env.SIEM_ALLOWED_IPS || '').split(',').filter(Boolean);
            
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                version: '7.4.2',
                siem_configured: apiKeyConfigured && secretConfigured,
                configuration: {
                    api_key: apiKeyConfigured ? 'configured' : 'missing',
                    api_secret: secretConfigured ? 'configured' : 'missing',
                    ip_whitelist: allowedIPs.length > 0 ? `${allowedIPs.length} IPs` : 'not configured (all IPs allowed)'
                },
                storage: {
                    type: 's3',
                    path: 'logs/',
                    logs_today: stats.total_entries || 0,
                    files_today: stats.total_files || 0,
                    by_type: stats.by_type || {}
                },
                endpoints: {
                    health: 'GET /api/siem/health (no auth)',
                    logs: 'GET /api/siem/logs?start=ISO_DATE (auth required)',
                    correlation: 'GET /api/siem/logs/correlation/:id (auth required)',
                    stats: 'GET /api/siem/stats (auth required)',
                    schema: 'GET /api/siem/schema (auth required)'
                }
            });
        } catch (err) {
            res.status(500).json({
                status: 'unhealthy',
                error: err.message
            });
        }
    });
    
    // Test endpoint to generate sample logs (no auth, for verification)
    router.post('/test-log', (req, res) => {
        if (process.env.NODE_ENV === 'production') {
            return res.status(403).json({
                success: false,
                error: 'Test endpoint disabled in production'
            });
        }
        
        // Generate test logs
        if (logger) {
            logger.info('SIEM test log - INFO level', { test: true, source: 'api' });
            logger.warn('SIEM test log - WARN level', { test: true, source: 'api' });
            logger.security('TEST_EVENT', { test: true, outcome: 'success' });
        }
        
        res.json({
            success: true,
            message: 'Test logs generated. Check /api/siem/health for stats.',
            note: 'Logs are buffered - may take 30 seconds to appear in S3'
        });
    });
    
    // Apply auth middleware to all other routes
    router.use(siemAuthMiddleware(logger));
    
    // ==================== GET /logs ====================
    /**
     * Query logs with filters
     * 
     * Query Parameters:
     * - start (required): ISO timestamp - start of range
     * - end (optional): ISO timestamp - end of range (default: now)
     * - type (optional): comma-separated log types (default: all)
     * - limit (optional): max events (default: 1000, max: 10000)
     * - cursor (optional): pagination cursor
     */
    router.get('/logs', async (req, res) => {
        try {
            const { start, end, type, limit, cursor } = req.query;
            
            // Validate start
            if (!start) {
                return res.status(400).json({
                    success: false,
                    error: 'missing_start',
                    message: 'start parameter is required (ISO 8601 timestamp)'
                });
            }
            
            const startDate = new Date(start);
            if (isNaN(startDate.getTime())) {
                return res.status(400).json({
                    success: false,
                    error: 'invalid_start',
                    message: 'start must be a valid ISO 8601 timestamp'
                });
            }
            
            // Parse options
            const options = {
                start: startDate,
                end: end ? new Date(end) : new Date(),
                types: type ? type.split(',').map(t => t.trim()) : undefined,
                limit: Math.min(parseInt(limit) || 1000, 10000),
                cursor: cursor || null
            };
            
            // Query logs
            const result = await storage.query(options);
            
            res.json({
                success: true,
                meta: {
                    request_id: req.correlationId,
                    timestamp: new Date().toISOString(),
                    query: {
                        start: options.start.toISOString(),
                        end: options.end.toISOString(),
                        types: options.types || 'all',
                        limit: options.limit
                    },
                    returned_count: result.logs.length,
                    has_more: result.meta.has_more
                },
                logs: result.logs,
                cursor: result.cursor
            });
            
        } catch (err) {
            console.error('SIEM API error:', err);
            res.status(500).json({
                success: false,
                error: 'query_failed',
                message: err.message
            });
        }
    });
    
    // ==================== GET /logs/:correlationId ====================
    /**
     * Get all logs for a specific correlation ID
     */
    router.get('/logs/correlation/:correlationId', async (req, res) => {
        try {
            const { correlationId } = req.params;
            const { start } = req.query;
            
            const startDate = start ? new Date(start) : null;
            const result = await storage.queryByCorrelationId(correlationId, startDate);
            
            res.json({
                success: true,
                correlation_id: correlationId,
                count: result.count,
                logs: result.logs
            });
            
        } catch (err) {
            console.error('SIEM API error:', err);
            res.status(500).json({
                success: false,
                error: 'query_failed',
                message: err.message
            });
        }
    });
    
    // ==================== GET /stats ====================
    /**
     * Get log statistics
     */
    router.get('/stats', async (req, res) => {
        try {
            const { date } = req.query;
            const queryDate = date ? new Date(date) : new Date();
            
            const stats = await storage.getStats(queryDate);
            
            res.json({
                success: true,
                date: queryDate.toISOString().split('T')[0],
                stats: stats
            });
            
        } catch (err) {
            console.error('SIEM API error:', err);
            res.status(500).json({
                success: false,
                error: 'stats_failed',
                message: err.message
            });
        }
    });
    
    // ==================== GET /schema ====================
    /**
     * Get log event schema
     */
    router.get('/schema', (req, res) => {
        res.json({
            success: true,
            version: '1.0.0',
            log_types: ['security', 'sessions', 'access', 'application', 'pii-audit'],
            schema: {
                event_id: { type: 'string', description: 'Unique event identifier' },
                timestamp: { type: 'datetime', description: 'ISO 8601 timestamp' },
                timestamp_unix: { type: 'integer', description: 'Unix timestamp in milliseconds' },
                correlation_id: { type: 'string', description: 'Request correlation ID' },
                log_type: { type: 'enum', values: ['security', 'sessions', 'access', 'application', 'pii-audit'] },
                action: { type: 'string', description: 'Event action/level' },
                message: { type: 'string', description: 'Log message (PII masked)' },
                severity: { type: 'integer', range: [1, 10], description: 'Event severity' },
                context: { type: 'object', description: 'Event context (PII masked)' },
                source: {
                    type: 'object',
                    properties: {
                        ip: { type: 'string', description: 'Masked source IP' },
                        user_agent: { type: 'string', description: 'User agent string' },
                        user_id: { type: 'string', description: 'User ID' },
                        user_email_hash: { type: 'string', description: 'SHA256 hash of email' },
                        user_role: { type: 'string', description: 'User role' },
                        session_id: { type: 'string', description: 'Hashed session ID' }
                    }
                },
                platform: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Platform name' },
                        version: { type: 'string', description: 'Platform version' },
                        environment: { type: 'string', description: 'Environment (production/development)' },
                        instance_id: { type: 'string', description: 'Server instance ID' }
                    }
                },
                cef: { type: 'string', description: 'CEF formatted event string' }
            },
            security_events: [
                'LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT', 'ACCESS_DENIED', 
                'PERMISSION_DENIED', 'RATE_LIMITED', 'FORENSIC_EXPORT', 
                'DATA_EXPORT', 'DATA_MODIFIED', 'DATA_DELETED', 'ROLE_CHANGED'
            ],
            session_events: [
                'SESSION_START', 'PAGE_VIEW', 'USER_ACTION', 'SESSION_END'
            ]
        });
    });
    
    return router;
}

// ==================== SIGNATURE GENERATOR (FOR DOCUMENTATION) ====================

/**
 * Generate HMAC signature for a request
 * This is provided for documentation/testing purposes
 */
function generateSignature(apiSecret, timestamp, method, path, query = '') {
    const payload = `${timestamp}${method}${path}${query}`;
    return crypto
        .createHmac('sha256', apiSecret)
        .update(payload)
        .digest('hex');
}

// ==================== EXPORTS ====================

module.exports = {
    createSIEMRouter,
    siemAuthMiddleware,
    generateSignature
};
