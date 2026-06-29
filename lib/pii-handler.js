/**
 * PII Handler - Sensitive Data Detection and Masking
 * 
 * VERSION: 1.0.0
 * CREATED: February 5, 2025
 * 
 * Features:
 * - Detects PII patterns (PAN, Aadhaar, Phone, Email, Bank Accounts, GSTIN)
 * - Masks sensitive data for logging
 * - Provides audit trail for PII access
 * - RBI Compliance ready
 * 
 * Usage:
 *   const { maskPII, maskObject, detectPII } = require('./lib/pii-handler');
 *   const safeLog = maskObject(sensitiveData);
 */

'use strict';

// ==================== PII PATTERNS ====================
// Indian-specific patterns for financial services

const PII_PATTERNS = {
    // PAN Card: ABCDE1234F
    pan: {
        regex: /[A-Z]{5}[0-9]{4}[A-Z]{1}/g,
        name: 'PAN',
        mask: (match) => `PAN:${match.substring(0,2)}***${match.substring(8)}`
    },
    
    // Aadhaar: 1234 5678 9012 or 123456789012
    aadhaar: {
        regex: /\b[2-9]{1}[0-9]{3}\s?[0-9]{4}\s?[0-9]{4}\b/g,
        name: 'Aadhaar',
        mask: (match) => `AADHAAR:XXXX-XXXX-${match.replace(/\s/g, '').slice(-4)}`
    },
    
    // Indian Phone: +91XXXXXXXXXX or 9XXXXXXXXX
    phone: {
        regex: /(\+91[\-\s]?)?[6-9]\d{9}\b/g,
        name: 'Phone',
        mask: (match) => {
            const digits = match.replace(/\D/g, '');
            return `PHONE:******${digits.slice(-4)}`;
        }
    },
    
    // Email
    email: {
        regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        name: 'Email',
        mask: (match) => {
            const [local, domain] = match.split('@');
            const maskedLocal = local.length > 2 
                ? `${local.substring(0,2)}${'*'.repeat(Math.min(local.length - 2, 5))}`
                : local;
            return `${maskedLocal}@${domain}`;
        }
    },
    
    // Bank Account Number (9-18 digits)
    bankAccount: {
        regex: /\b[0-9]{9,18}\b/g,
        name: 'BankAccount',
        mask: (match) => `ACCT:${'*'.repeat(match.length - 4)}${match.slice(-4)}`,
        // Only mask if it looks like an account (not just any number)
        validate: (match, context) => {
            // Check if context suggests this is a bank account
            const accountKeywords = ['account', 'acct', 'bank', 'a/c', 'savings', 'current'];
            return accountKeywords.some(kw => context.toLowerCase().includes(kw));
        }
    },
    
    // IFSC Code
    ifsc: {
        regex: /[A-Z]{4}0[A-Z0-9]{6}/g,
        name: 'IFSC',
        mask: (match) => `IFSC:${match.substring(0,4)}*******`
    },
    
    // GSTIN: 22AAAAA0000A1Z5
    gstin: {
        regex: /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}Z[0-9A-Z]{1}\b/g,
        name: 'GSTIN',
        mask: (match) => `GSTIN:${match.substring(0,2)}*****${match.substring(10)}`
    },
    
    // CIN (Corporate Identification Number)
    cin: {
        regex: /[UL][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}/g,
        name: 'CIN',
        mask: (match) => `CIN:${match.substring(0,1)}*****${match.slice(-6)}`
    },
    
    // Credit Card (basic pattern)
    creditCard: {
        regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9][0-9])[0-9]{12})\b/g,
        name: 'CreditCard',
        mask: (match) => `CARD:****-****-****-${match.slice(-4)}`
    },
    
    // Date of Birth patterns
    dob: {
        regex: /\b(?:0[1-9]|[12][0-9]|3[01])[-\/](?:0[1-9]|1[0-2])[-\/](?:19|20)\d{2}\b/g,
        name: 'DOB',
        mask: () => 'DOB:**/**/****'
    },
    
    // Passport Number (Indian)
    passport: {
        regex: /[A-Z][1-9][0-9]\s?[0-9]{4}[1-9]/g,
        name: 'Passport',
        mask: (match) => `PASSPORT:${match.substring(0,1)}*******`
    },
    
    // Voter ID
    voterId: {
        regex: /[A-Z]{3}[0-9]{7}/g,
        name: 'VoterID',
        mask: (match) => `VOTERID:${match.substring(0,3)}*******`
    },
    
    // Driving License (varies by state, common pattern)
    drivingLicense: {
        regex: /[A-Z]{2}[0-9]{2}\s?[0-9]{4}\s?[0-9]{7}/g,
        name: 'DrivingLicense',
        mask: (match) => `DL:${match.substring(0,4)}*******`
    }
};

// Sensitive field names that should always be masked
const SENSITIVE_FIELD_NAMES = [
    'pan', 'panNumber', 'pan_number',
    'aadhaar', 'aadhaarNumber', 'aadhaar_number', 'aadhar',
    'password', 'pwd', 'secret', 'token', 'apiKey', 'api_key',
    'accountNumber', 'account_number', 'acctNo', 'bankAccount',
    'creditCard', 'cardNumber', 'card_number', 'cvv', 'cvc',
    'ssn', 'socialSecurity',
    'dob', 'dateOfBirth', 'date_of_birth', 'birthDate',
    'phone', 'mobile', 'mobileNumber', 'phoneNumber',
    'email', 'emailAddress', 'email_address',
    'gstin', 'gstNumber', 'gst_number',
    'ifsc', 'ifscCode', 'ifsc_code',
    'passport', 'passportNumber', 'passport_number',
    'voterId', 'voter_id', 'voterIdNumber',
    'drivingLicense', 'driving_license', 'dlNumber',
    'cin', 'cinNumber', 'cin_number',
    'upi', 'upiId', 'vpa'
];

// ==================== CORE FUNCTIONS ====================

/**
 * Detect PII in a string and return details
 * @param {string} text - Text to scan for PII
 * @returns {Array} Array of detected PII items with type and position
 */
function detectPII(text) {
    if (!text || typeof text !== 'string') return [];
    
    const detected = [];
    
    for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        let match;
        
        while ((match = regex.exec(text)) !== null) {
            // Skip if validation function exists and fails
            if (pattern.validate && !pattern.validate(match[0], text)) {
                continue;
            }
            
            detected.push({
                type: pattern.name,
                value: match[0],
                masked: pattern.mask(match[0]),
                position: match.index,
                length: match[0].length
            });
        }
    }
    
    return detected;
}

/**
 * Mask PII in a string
 * @param {string} text - Text containing potential PII
 * @param {Object} options - Options for masking
 * @returns {string} Text with PII masked
 */
function maskPII(text, options = {}) {
    if (!text || typeof text !== 'string') return text;
    
    let masked = text;
    const { skipTypes = [], contextAware = true } = options;
    
    for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
        if (skipTypes.includes(type)) continue;
        
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        
        masked = masked.replace(regex, (match) => {
            // Skip if validation function exists and fails
            if (contextAware && pattern.validate && !pattern.validate(match, text)) {
                return match;
            }
            return pattern.mask(match);
        });
    }
    
    return masked;
}

/**
 * Check if a field name is sensitive
 * @param {string} fieldName - Name of the field
 * @returns {boolean} True if field is sensitive
 */
function isSensitiveField(fieldName) {
    if (!fieldName) return false;
    const normalizedName = fieldName.toLowerCase().replace(/[-_\s]/g, '');
    return SENSITIVE_FIELD_NAMES.some(sensitive => 
        normalizedName.includes(sensitive.toLowerCase().replace(/[-_\s]/g, ''))
    );
}

/**
 * Mask an entire object recursively
 * @param {any} obj - Object to mask
 * @param {Object} options - Masking options
 * @returns {any} Masked object
 */
function maskObject(obj, options = {}) {
    if (obj === null || obj === undefined) return obj;
    
    const { depth = 0, maxDepth = 10, maskFieldNames = true } = options;
    
    // Prevent infinite recursion
    if (depth > maxDepth) return '[MAX_DEPTH_REACHED]';
    
    // Handle strings
    if (typeof obj === 'string') {
        return maskPII(obj, options);
    }
    
    // Handle arrays
    if (Array.isArray(obj)) {
        return obj.map(item => maskObject(item, { ...options, depth: depth + 1 }));
    }
    
    // Handle objects
    if (typeof obj === 'object') {
        const masked = {};
        
        for (const [key, value] of Object.entries(obj)) {
            // Check if field name itself is sensitive
            if (maskFieldNames && isSensitiveField(key)) {
                // Completely redact sensitive fields
                if (typeof value === 'string' && value.length > 0) {
                    masked[key] = '[REDACTED]';
                } else if (typeof value === 'number') {
                    masked[key] = 0;
                } else {
                    masked[key] = '[REDACTED]';
                }
            } else {
                masked[key] = maskObject(value, { ...options, depth: depth + 1 });
            }
        }
        
        return masked;
    }
    
    // Return primitives as-is
    return obj;
}

/**
 * Create a safe log entry from request object
 * @param {Object} req - Express request object
 * @returns {Object} Safe log entry
 */
function createSafeLogEntry(req) {
    return {
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        // Mask query parameters
        query: maskObject(req.query || {}),
        // Only log safe headers
        headers: {
            'user-agent': req.headers['user-agent'],
            'content-type': req.headers['content-type'],
            'accept': req.headers['accept']
        },
        // Mask body if present
        body: req.body ? maskObject(req.body) : undefined,
        // Mask IP partially
        ip: maskIP(req.ip),
        // User info (email already somewhat public)
        user: req.user ? {
            id: req.user.id,
            email: maskPII(req.user.email),
            role: req.user.role
        } : null
    };
}

/**
 * Mask IP address (keep first two octets for geo analysis)
 * @param {string} ip - IP address
 * @returns {string} Masked IP
 */
function maskIP(ip) {
    if (!ip) return 'unknown';
    
    // Handle IPv4
    if (ip.includes('.')) {
        const parts = ip.split('.');
        if (parts.length === 4) {
            return `${parts[0]}.${parts[1]}.XXX.XXX`;
        }
    }
    
    // Handle IPv6
    if (ip.includes(':')) {
        const parts = ip.split(':');
        if (parts.length > 2) {
            return `${parts[0]}:${parts[1]}:****:****`;
        }
    }
    
    return 'masked';
}

/**
 * Hash sensitive value for logging (one-way)
 * @param {string} value - Value to hash
 * @returns {string} Hashed value (first 16 chars of SHA256)
 */
function hashValue(value) {
    if (!value) return 'empty';
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(String(value)).digest('hex').substring(0, 16);
}

/**
 * Create PII access audit entry
 * @param {Object} params - Audit parameters
 * @returns {Object} Audit entry
 */
function createPIIAuditEntry(params) {
    const { userId, action, dataType, recordId, fieldAccessed, reason, req } = params;
    
    return {
        timestamp: new Date().toISOString(),
        eventId: require('crypto').randomUUID(),
        userId: userId,
        userIdHash: hashValue(userId),
        action: action, // 'view', 'extract', 'export', 'modify', 'delete'
        dataType: dataType, // 'pan', 'aadhaar', 'bank_statement', etc.
        recordId: recordId, // Assessment ID or document ID
        fieldAccessed: fieldAccessed, // Specific field if applicable
        reason: reason || 'system_process',
        ip: req ? maskIP(req.ip) : 'system',
        userAgent: req?.headers?.['user-agent'] || 'system',
        sessionId: req?.sessionID ? hashValue(req.sessionID) : 'system'
    };
}

// ==================== EXPORTS ====================

module.exports = {
    // Core masking functions
    maskPII,
    maskObject,
    maskIP,
    hashValue,
    
    // Detection
    detectPII,
    isSensitiveField,
    
    // Audit helpers
    createSafeLogEntry,
    createPIIAuditEntry,
    
    // Patterns (for testing/extension)
    PII_PATTERNS,
    SENSITIVE_FIELD_NAMES
};
