/**
 * SIEM Storage - S3 Partitioned Log Storage
 * 
 * VERSION: 1.0.0
 * CREATED: February 6, 2025
 * 
 * Features:
 * - Hourly partitioned storage in S3
 * - Automatic indexing for fast queries
 * - Cursor-based pagination support
 * - Log retrieval with filtering
 * 
 * Storage Structure:
 * logs/YYYY/MM/DD/HH/{type}_{timestamp}_{random}.json
 */

'use strict';

const crypto = require('crypto');

// ==================== CONFIGURATION ====================

const DEFAULT_CONFIG = {
    basePath: 'logs',
    indexPath: 'logs/index',
    flushIntervalMs: 30000,
    maxRetries: 3
};

// ==================== SIEM STORAGE CLASS ====================

class SIEMStorage {
    constructor(s3Client, config = {}) {
        this.s3 = s3Client;
        this.config = { ...DEFAULT_CONFIG, ...config };
        
        // Index cache (in-memory for current hour)
        this.currentIndex = {
            hour: null,
            entries: []
        };
    }
    
    // ==================== WRITE METHODS ====================
    
    /**
     * Write log entries to S3
     * @param {string} type - Log type (security, sessions, access, application, pii-audit)
     * @param {Array} entries - Array of log entries
     */
    async write(type, entries) {
        if (!entries || entries.length === 0) return;
        if (!this.s3?.isConfigured?.()) {
            console.warn('S3 not configured, logs not persisted');
            return;
        }
        
        const now = new Date();
        const key = this._generateKey(type, now);
        
        try {
            const content = JSON.stringify({
                log_type: type,
                count: entries.length,
                generated_at: now.toISOString(),
                entries: entries
            }, null, 2);
            
            await this.s3.uploadFile(key, Buffer.from(content, 'utf-8'), 'application/json');
            
            // Update index
            await this._updateIndex(type, key, entries.length, now);
            
            console.log(`✓ Wrote ${entries.length} ${type} logs to S3: ${key}`);
            
        } catch (err) {
            console.error(`Failed to write ${type} logs to S3:`, err.message);
            throw err;
        }
    }
    
    /**
     * Generate S3 key with partitioning
     */
    _generateKey(type, date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hour = String(date.getHours()).padStart(2, '0');
        const minute = String(date.getMinutes()).padStart(2, '0');
        const random = crypto.randomBytes(4).toString('hex');
        
        return `${this.config.basePath}/${year}/${month}/${day}/${hour}/${type}_${hour}-${minute}_${random}.json`;
    }
    
    /**
     * Update daily index
     */
    async _updateIndex(type, key, count, date) {
        const indexKey = this._getIndexKey(date);
        
        try {
            // Get existing index or create new
            let index;
            try {
                const data = await this.s3.getFile(indexKey);
                index = JSON.parse(data.toString('utf-8'));
            } catch (err) {
                // Index doesn't exist, create new
                index = {
                    date: date.toISOString().split('T')[0],
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    files: [],
                    stats: {
                        total_files: 0,
                        total_entries: 0,
                        by_type: {}
                    }
                };
            }
            
            // Add file entry
            index.files.push({
                key: key,
                type: type,
                count: count,
                timestamp: date.toISOString()
            });
            
            // Update stats
            index.stats.total_files++;
            index.stats.total_entries += count;
            index.stats.by_type[type] = (index.stats.by_type[type] || 0) + count;
            index.updated_at = new Date().toISOString();
            
            // Save index
            await this.s3.uploadFile(indexKey, Buffer.from(JSON.stringify(index, null, 2), 'utf-8'), 'application/json');
            
        } catch (err) {
            console.warn('Failed to update log index:', err.message);
            // Don't throw - indexing failure shouldn't break logging
        }
    }
    
    /**
     * Get index key for a date
     */
    _getIndexKey(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${this.config.basePath}/${year}/${month}/${day}/index.json`;
    }
    
    // ==================== READ METHODS (FOR SIEM API) ====================
    
    /**
     * Query logs with filters
     * @param {Object} options - Query options
     * @returns {Object} Query result with logs and cursor
     */
    async query(options = {}) {
        const {
            start,
            end = new Date(),
            types = ['security', 'sessions', 'access', 'application', 'pii-audit'],
            limit = 1000,
            cursor = null
        } = options;
        
        if (!this.s3?.isConfigured?.()) {
            return { logs: [], cursor: null, total: 0 };
        }
        
        // Parse cursor if provided
        let cursorData = null;
        if (cursor) {
            try {
                cursorData = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
            } catch (err) {
                console.warn('Invalid cursor:', cursor);
            }
        }
        
        const startDate = new Date(start);
        const endDate = new Date(end);
        
        // Collect all logs
        const allLogs = [];
        let filesProcessed = 0;
        let totalEntries = 0;
        
        // Iterate through dates
        const currentDate = new Date(startDate);
        while (currentDate <= endDate && allLogs.length < limit) {
            const indexKey = this._getIndexKey(currentDate);
            
            try {
                const indexData = await this.s3.getFile(indexKey);
                const index = JSON.parse(indexData.toString('utf-8'));
                
                // Filter files by type and time
                for (const file of index.files) {
                    if (!types.includes(file.type)) continue;
                    
                    const fileTime = new Date(file.timestamp);
                    if (fileTime < startDate || fileTime > endDate) continue;
                    
                    // Skip files before cursor
                    if (cursorData && fileTime <= new Date(cursorData.lastTimestamp)) {
                        continue;
                    }
                    
                    // Fetch file
                    try {
                        const fileData = await this.s3.getFile(file.key);
                        const fileContent = JSON.parse(fileData.toString('utf-8'));
                        
                        for (const entry of fileContent.entries) {
                            if (allLogs.length >= limit) break;
                            
                            // Skip entries before cursor
                            if (cursorData && entry.timestamp <= cursorData.lastTimestamp) {
                                continue;
                            }
                            
                            allLogs.push(entry);
                            totalEntries++;
                        }
                        
                        filesProcessed++;
                        
                    } catch (fileErr) {
                        console.warn(`Failed to read log file ${file.key}:`, fileErr.message);
                    }
                    
                    if (allLogs.length >= limit) break;
                }
                
            } catch (indexErr) {
                // No index for this date, skip
            }
            
            // Move to next day
            currentDate.setDate(currentDate.getDate() + 1);
        }
        
        // Sort by timestamp
        allLogs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        // Generate new cursor if there are more results
        let newCursor = null;
        if (allLogs.length >= limit) {
            const lastLog = allLogs[allLogs.length - 1];
            newCursor = Buffer.from(JSON.stringify({
                lastTimestamp: lastLog.timestamp,
                lastEventId: lastLog.event_id
            })).toString('base64');
        }
        
        return {
            logs: allLogs,
            cursor: newCursor,
            meta: {
                files_processed: filesProcessed,
                total_entries: totalEntries,
                has_more: allLogs.length >= limit
            }
        };
    }
    
    /**
     * Get logs for a specific correlation ID
     * @param {string} correlationId - Correlation ID to search for
     * @param {Date} startDate - Start date for search (to limit scope)
     */
    async queryByCorrelationId(correlationId, startDate = null) {
        if (!startDate) {
            // Default to last 24 hours
            startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
        }
        
        const result = await this.query({
            start: startDate,
            end: new Date(),
            limit: 10000 // Higher limit for correlation search
        });
        
        // Filter by correlation ID
        const correlatedLogs = result.logs.filter(
            log => log.correlation_id === correlationId
        );
        
        return {
            correlation_id: correlationId,
            logs: correlatedLogs,
            count: correlatedLogs.length
        };
    }
    
    /**
     * Get log statistics
     */
    async getStats(date = new Date()) {
        const indexKey = this._getIndexKey(date);
        
        try {
            const indexData = await this.s3.getFile(indexKey);
            const index = JSON.parse(indexData.toString('utf-8'));
            return index.stats;
        } catch (err) {
            return {
                total_files: 0,
                total_entries: 0,
                by_type: {}
            };
        }
    }
    
    /**
     * Update cursor state for incremental pulls
     */
    async saveCursorState(siemClientId, cursor) {
        const key = `${this.config.indexPath}/cursors/${siemClientId}.json`;
        
        const state = {
            client_id: siemClientId,
            cursor: cursor,
            updated_at: new Date().toISOString()
        };
        
        await this.s3.uploadFile(key, Buffer.from(JSON.stringify(state), 'utf-8'), 'application/json');
    }
    
    /**
     * Get cursor state for a SIEM client
     */
    async getCursorState(siemClientId) {
        const key = `${this.config.indexPath}/cursors/${siemClientId}.json`;
        
        try {
            const data = await this.s3.getFile(key);
            return JSON.parse(data.toString('utf-8'));
        } catch (err) {
            return null;
        }
    }
}

// ==================== EXPORTS ====================

module.exports = { SIEMStorage };
