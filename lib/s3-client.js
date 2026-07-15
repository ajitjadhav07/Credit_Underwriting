/**
 * S3 Client Module - Dual-Mode Support
 * Supports both flat structure (legacy) and partitioned structure (analytics-ready)
 * Toggle with USE_PARTITIONED_STRUCTURE environment variable
 */

const { S3Client, CreateMultipartUploadCommand, UploadPartCommand, 
        CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
        GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

// Initialize S3 Client
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'axis-underwriting-documents';
const USE_PARTITIONED = process.env.USE_PARTITIONED_STRUCTURE === 'true';

console.log(`🗂️  S3 Mode: ${USE_PARTITIONED ? 'PARTITIONED (v2)' : 'FLAT (legacy)'}`);
console.log(`📦 Bucket: ${BUCKET_NAME}`);

/**
 * Generate partitioned S3 key based on date
 */
function generatePartitionedKey(baseFolder, date, id, extension = 'json') {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    
    return `${baseFolder}/year=${year}/month=${month}/day=${day}/${id}.${extension}`;
}

/**
 * Generate flat S3 key (legacy)
 */
function generateFlatKey(baseFolder, id, extension = 'json') {
    return `${baseFolder}/${id}.${extension}`;
}

/**
 * Get appropriate folder name based on mode
 */
function getFolderName(baseName) {
    if (USE_PARTITIONED) {
        // Use v2 folders for partitioned structure
        if (baseName === 'assessments') return 'assessments-v2';
        if (baseName === 'masters') return 'masters-v2';
        return baseName;
    }
    return baseName;
}

/**
 * Stream to string helper
 */
async function streamToString(stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
}

/**
 * Upload file to S3 with automatic mode detection
 */
async function uploadFile(key, buffer, contentType = 'application/octet-stream') {
    try {
        const upload = new Upload({
            client: s3Client,
            params: {
                Bucket: BUCKET_NAME,
                Key: key,
                Body: buffer,
                ContentType: contentType
            }
        });
        
        const result = await upload.done();
        console.log(`✅ Uploaded to S3: ${key}`);
        return { key: key, ...result };  // Return key with lowercase for backward compatibility
    } catch (err) {
        console.error(`❌ S3 upload failed for ${key}:`, err.message);
        throw err;
    }
}

/**
 * Get file from S3
 */
async function getFile(key) {
    try {
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        
        const response = await s3Client.send(command);
        const chunks = [];
        
        return new Promise((resolve, reject) => {
            response.Body.on('data', (chunk) => chunks.push(chunk));
            response.Body.on('error', reject);
            response.Body.on('end', () => resolve(Buffer.concat(chunks)));
        });
    } catch (err) {
        console.error(`❌ S3 get failed for ${key}:`, err.message);
        throw err;
    }
}

/**
 * Save assessment with automatic structure selection
 */
async function saveAssessment(assessmentId, data) {
    try {
        // Add timestamps
        data.updated_at = new Date().toISOString();
        if (!data.created_at) {
            data.created_at = data.updated_at;
        }
        
        let key;
        
        if (USE_PARTITIONED) {
            // New partitioned structure
            key = generatePartitionedKey('assessments-v2', data.created_at, assessmentId);
            
            // Also update metadata index
            await updateMetadataIndex(assessmentId, data);
        } else {
            // Old flat structure
            key = generateFlatKey('assessments', assessmentId);
            
            // Update old-style index
            await updateLegacyIndex(assessmentId, data);
        }
        
        // Save assessment
        const buffer = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
        await uploadFile(key, buffer, 'application/json');
        
        return { key, bucket: BUCKET_NAME };
        
    } catch (err) {
        console.error('Error saving assessment:', err);
        throw err;
    }
}

/**
 * Get assessment by ID (auto-detects structure)
 */
async function getAssessment(assessmentId) {
    try {
        let data;
        
        if (USE_PARTITIONED) {
            // Try metadata index first
            const summary = await searchMetadataIndex(assessmentId);
            if (summary && summary.created_at) {
                const key = generatePartitionedKey('assessments-v2', summary.created_at, assessmentId);
                data = await getFile(key);
            } else {
                // Fallback: search partitions
                data = await searchPartitions(assessmentId);
            }
        } else {
            // Old flat structure
            const key = generateFlatKey('assessments', assessmentId);
            data = await getFile(key);
        }
        
        return JSON.parse(data.toString('utf-8'));
        
    } catch (err) {
        console.error(`Error getting assessment ${assessmentId}:`, err);
        throw err;
    }
}

/**
 * Delete assessment by ID (auto-detects structure)
 */
async function deleteAssessment(assessmentId) {
    try {
        let key;
        
        if (USE_PARTITIONED) {
            // Try metadata index first to find the partition
            const summary = await searchMetadataIndex(assessmentId);
            if (summary && summary.created_at) {
                key = generatePartitionedKey('assessments-v2', summary.created_at, assessmentId);
            } else {
                throw new Error('Assessment not found in metadata index');
            }
            
            // Delete from S3
            const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
            const command = new DeleteObjectCommand({
                Bucket: BUCKET_NAME,
                Key: key
            });
            await s3Client.send(command);
            
            // Remove from metadata index
            await removeFromMetadataIndex(assessmentId, summary.created_at);
            
        } else {
            // Old flat structure
            key = generateFlatKey('assessments', assessmentId);
            
            // Delete from S3
            const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
            const command = new DeleteObjectCommand({
                Bucket: BUCKET_NAME,
                Key: key
            });
            await s3Client.send(command);
            
            // Remove from legacy index
            await removeFromLegacyIndex(assessmentId);
        }
        
        console.log(`Deleted assessment ${assessmentId} from S3`);
        return { deleted: true, key };
        
    } catch (err) {
        console.error(`Error deleting assessment ${assessmentId}:`, err);
        throw err;
    }
}

/**
 * Remove assessment from metadata index
 */
async function removeFromMetadataIndex(assessmentId, createdAt) {
    try {
        const date = new Date(createdAt);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const indexKey = `metadata/assessments-v2/year=${year}/month=${month}/index.json`;
        
        let index = { assessments: [] };
        try {
            const data = await getFile(indexKey);
            index = JSON.parse(data.toString('utf-8'));
        } catch (err) {
            // Index doesn't exist, nothing to remove
            return;
        }
        
        // Remove assessment from index
        index.assessments = index.assessments.filter(a => a.id !== assessmentId);
        index.updated_at = new Date().toISOString();
        
        // Save updated index
        const buffer = Buffer.from(JSON.stringify(index, null, 2), 'utf-8');
        await uploadFile(indexKey, buffer, 'application/json');
        
    } catch (err) {
        console.error('Error removing from metadata index:', err);
        // Don't throw - deletion should succeed even if index update fails
    }
}

/**
 * Remove assessment from legacy index
 */
async function removeFromLegacyIndex(assessmentId) {
    try {
        const index = await getAssessmentsIndex();
        
        // Remove assessment from index
        if (index.assessments) {
            index.assessments = index.assessments.filter(a => a.id !== assessmentId);
        }
        index.updated_at = new Date().toISOString();
        
        // Save updated index
        await saveAssessmentsIndex(index);
        
    } catch (err) {
        console.error('Error removing from legacy index:', err);
        // Don't throw - deletion should succeed even if index update fails
    }
}

/**
 * Get all assessments (auto-detects structure)
 * WARNING: Loads FULL data for each assessment - expensive! Use getAllAssessmentSummaries() for dashboard.
 */
async function getAllAssessments() {
    try {
        let summaries = [];
        
        if (USE_PARTITIONED) {
            summaries = await getAllFromMetadataIndex();
        } else {
            const index = await getAssessmentsIndex();
            summaries = index.assessments || [];
        }
        
        // IMPORTANT: Load FULL assessment data for each, not just summaries!
        console.log(`📂 Loading full data for ${summaries.length} assessments...`);
        
        const fullAssessments = [];
        for (const summary of summaries) {
            const id = summary.assessment_id || summary.id;
            try {
                const fullData = await getAssessment(id);
                if (fullData) {
                    fullAssessments.push(fullData);
                } else {
                    // Fallback to summary if full data not found
                    console.warn(`   ⚠️ Full data not found for ${id}, using summary`);
                    fullAssessments.push(summary);
                }
            } catch (err) {
                console.warn(`   ⚠️ Error loading ${id}: ${err.message}, using summary`);
                fullAssessments.push(summary);
            }
        }
        
        console.log(`   ✅ Loaded ${fullAssessments.length} full assessments`);
        return fullAssessments;
        
    } catch (err) {
        console.error('Error getting all assessments:', err);
        return [];
    }
}

/**
 * Update metadata index (partitioned mode)
 */
async function updateMetadataIndex(assessmentId, data) {
    try {
        const date = new Date(data.created_at);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        
        const indexKey = `metadata/assessment_index/year=${year}/month=${month}/index.json`;
        
        // Get existing index
        let index = { assessments: [], updated_at: new Date().toISOString() };
        try {
            const existing = await getFile(indexKey);
            index = JSON.parse(existing.toString('utf-8'));
        } catch (err) {
            // Index doesn't exist, create new
        }
        
        // Add/update summary (must include all fields needed for dashboard)
        const summary = {
            assessment_id: assessmentId,
            id: assessmentId,
            company_name: data.company_name,
            pan: data.pan,
            status: data.status,
            risk_grade: data.risk_grade,
            loan_amount_lakhs: data.loan_amount_lakhs || data.loan_amount || 0,
            grade: data.grade,
            score: data.score,
            product: data.product,
            branch: data.branch,
            priority: data.priority,
            type: data.type || 'actual',
            created_by: data.created_by,
            created_by_name: data.created_by_name,
            created_at: data.created_at,
            updated_at: data.updated_at,
            completed_at: data.completed_at,
            document_count: data.document_count
        };
        
        const existingIdx = index.assessments.findIndex(a => a.id === assessmentId || a.assessment_id === assessmentId);
        if (existingIdx >= 0) {
            // Preserve created_by from existing entry if not present in new data
            if (!summary.created_by && index.assessments[existingIdx].created_by) {
                summary.created_by = index.assessments[existingIdx].created_by;
            }
            if (!summary.created_by_name && index.assessments[existingIdx].created_by_name) {
                summary.created_by_name = index.assessments[existingIdx].created_by_name;
            }
            index.assessments[existingIdx] = summary;
        } else {
            index.assessments.push(summary);
        }
        
        index.updated_at = new Date().toISOString();
        
        // Save updated index
        const buffer = Buffer.from(JSON.stringify(index, null, 2), 'utf-8');
        await uploadFile(indexKey, buffer, 'application/json');
        
    } catch (err) {
        console.error('Error updating metadata index:', err);
        // Don't throw - index failure shouldn't break assessment save
    }
}

/**
 * Search metadata index for assessment
 */
async function searchMetadataIndex(assessmentId) {
    try {
        const now = new Date();
        
        // Search last 12 months
        for (let monthsBack = 0; monthsBack <= 12; monthsBack++) {
            const d = new Date(now);
            d.setMonth(d.getMonth() - monthsBack);
            
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            
            const indexKey = `metadata/assessment_index/year=${year}/month=${month}/index.json`;
            
            try {
                const data = await getFile(indexKey);
                const index = JSON.parse(data.toString('utf-8'));
                
                const found = index.assessments.find(a => a.id === assessmentId);
                if (found) return found;
                
            } catch (err) {
                // Index doesn't exist for this month, continue
                continue;
            }
        }
        
        return null;
        
    } catch (err) {
        console.error('Error searching metadata index:', err);
        return null;
    }
}

/**
 * Search partitions for assessment (fallback)
 */
async function searchPartitions(assessmentId) {
    try {
        const listCommand = new ListObjectsV2Command({
            Bucket: BUCKET_NAME,
            Prefix: 'assessments-v2/',
            MaxKeys: 1000
        });
        
        const response = await s3Client.send(listCommand);
        const target = response.Contents?.find(obj => obj.Key.includes(assessmentId));
        
        if (target) {
            return await getFile(target.Key);
        }
        
        throw new Error(`Assessment ${assessmentId} not found in partitions`);
        
    } catch (err) {
        console.error('Error searching partitions:', err);
        throw err;
    }
}

/**
 * Get all from metadata index
 */
async function getAllFromMetadataIndex() {
    try {
        const allAssessments = [];
        const now = new Date();
        
        // Get last 12 months of data
        for (let monthsBack = 0; monthsBack <= 12; monthsBack++) {
            const d = new Date(now);
            d.setMonth(d.getMonth() - monthsBack);
            
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            
            const indexKey = `metadata/assessment_index/year=${year}/month=${month}/index.json`;
            
            try {
                const data = await getFile(indexKey);
                const index = JSON.parse(data.toString('utf-8'));
                allAssessments.push(...index.assessments);
            } catch (err) {
                // Index doesn't exist for this month, skip
                continue;
            }
        }
        
        return allAssessments;
        
    } catch (err) {
        console.error('Error getting all from metadata:', err);
        return [];
    }
}

/**
 * Update legacy index (flat mode)
 */
async function updateLegacyIndex(assessmentId, data) {
    try {
        const index = await getAssessmentsIndex();
        
        const summary = {
            assessment_id: assessmentId,  // Use assessment_id for consistency!
            id: assessmentId,  // Keep id for backward compatibility
            company_name: data.company_name,
            loan_amount_lakhs: data.loan_amount_lakhs || data.loan_amount || 0,
            type: data.type || 'actual',
            status: data.status,
            grade: data.grade,
            score: data.score,
            product: data.product,
            branch: data.branch,
            priority: data.priority,
            tat: data.tat,
            sla: data.sla,
            created_by: data.created_by,  // Include created_by!
            created_at: data.created_at,
            updated_at: data.updated_at,
            completed_at: data.completed_at  // Include completed_at!
        };
        
        const existing = index.assessments.findIndex(a => a.id === assessmentId);
        if (existing >= 0) {
            // Preserve created_by from existing entry if not present in new data
            if (!summary.created_by && index.assessments[existing].created_by) {
                summary.created_by = index.assessments[existing].created_by;
            }
            index.assessments[existing] = summary;
        } else {
            index.assessments.unshift(summary);
        }
        
        await saveAssessmentsIndex(index);
        
    } catch (err) {
        console.error('Error updating legacy index:', err);
    }
}

/**
 * Get assessments index (legacy)
 */
async function getAssessmentsIndex() {
    try {
        const data = await getFile('assessments/index.json');
        return JSON.parse(data.toString('utf-8'));
    } catch (err) {
        return { 
            assessments: [], 
            updated_at: new Date().toISOString() 
        };
    }
}

/**
 * Save assessments index (legacy)
 */
async function saveAssessmentsIndex(index) {
    index.updated_at = new Date().toISOString();
    const buffer = Buffer.from(JSON.stringify(index, null, 2), 'utf-8');
    await uploadFile('assessments/index.json', buffer, 'application/json');
    return index;
}

/**
 * Save masters (with mode detection)
 */
async function saveMasters(key, data) {
    if (!isConfigured()) {
        console.log('S3 not configured, skipping masters save');
        return;
    }
    
    try {
        let s3Key;
        
        if (USE_PARTITIONED) {
            // Partitioned: masters-v2/{type}/snapshot_{date}.json
            const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
            s3Key = `masters-v2/${key}/snapshot_${today}.json`;
        } else {
            // Flat: masters/{key}.json
            s3Key = `masters/${key}.json`;
        }
        
        const jsonData = JSON.stringify(data, null, 2);
        
        const upload = new Upload({
            client: s3Client,
            params: {
                Bucket: BUCKET_NAME,
                Key: s3Key,
                Body: jsonData,
                ContentType: 'application/json'
            }
        });
        
        await upload.done();
        console.log(`✅ Masters saved: ${s3Key}`);
        
    } catch (err) {
        console.error(`Error saving masters ${key}:`, err);
        throw err;
    }
}

/**
 * Get masters (with mode detection)
 */
async function getMasters(key) {
    if (!isConfigured()) {
        return null;
    }
    
    try {
        let s3Key;
        
        if (USE_PARTITIONED) {
            // Get latest snapshot
            const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
            s3Key = `masters-v2/${key}/snapshot_${today}.json`;
            
            // Try today, if not found try yesterday, etc
            for (let daysBack = 0; daysBack <= 7; daysBack++) {
                const d = new Date();
                d.setDate(d.getDate() - daysBack);
                const dateStr = d.toISOString().split('T')[0].replace(/-/g, '');
                const tryKey = `masters-v2/${key}/snapshot_${dateStr}.json`;
                
                try {
                    const command = new GetObjectCommand({
                        Bucket: BUCKET_NAME,
                        Key: tryKey
                    });
                    
                    const response = await s3Client.send(command);
                    const jsonData = await streamToString(response.Body);
                    return JSON.parse(jsonData);
                } catch (err) {
                    // Not found, try previous day
                    continue;
                }
            }
            
            throw new Error(`No recent snapshot found for ${key}`);
            
        } else {
            // Flat structure
            s3Key = `masters/${key}.json`;
            
            const command = new GetObjectCommand({
                Bucket: BUCKET_NAME,
                Key: s3Key
            });
            
            const response = await s3Client.send(command);
            const jsonData = await streamToString(response.Body);
            return JSON.parse(jsonData);
        }
        
    } catch (err) {
        console.error(`Error getting masters ${key}:`, err);
        return null;
    }
}

/**
 * Save audit entry (partitioned mode only)
 */
async function saveAuditEntry(entry) {
    if (!USE_PARTITIONED) {
        console.log('Audit entries only supported in partitioned mode');
        return;
    }
    
    try {
        const date = entry.timestamp ? new Date(entry.timestamp) : new Date();
        entry.timestamp = date.toISOString();
        
        const dateStr = date.toISOString().split('T')[0];
        const [year, month, day] = dateStr.split('-');
        
        const key = `audit/year=${year}/month=${month}/day=${day}/audit_${dateStr.replace(/-/g, '')}.json`;
        
        // Read existing entries for today
        let entries = [];
        try {
            const existing = await getFile(key);
            entries = JSON.parse(existing.toString('utf-8'));
        } catch (err) {
            // File doesn't exist, create new
        }
        
        // Add new entry
        entries.push(entry);
        
        // Save
        const buffer = Buffer.from(JSON.stringify(entries, null, 2), 'utf-8');
        await uploadFile(key, buffer, 'application/json');
        
        return { key, bucket: BUCKET_NAME };
        
    } catch (err) {
        console.error('Error saving audit entry:', err);
        throw err;
    }
}

/**
 * Generate S3 key for document uploads
 */
function generateS3Key(assessmentId, docType, year, filename) {
    const timestamp = Date.now();
    const ext = filename.split('.').pop() || 'pdf';
    return `uploads/${assessmentId}/${docType}/${year}_${timestamp}.${ext}`;
}

/**
 * Check if S3 is properly configured
 */
function isConfigured() {
    // Only the bucket name is required. Credentials come from the ECS task's
    // IAM role (the AWS SDK picks these up automatically), NOT static
    // AWS_ACCESS_KEY_ID/SECRET env vars — those are deliberately unset in
    // this deployment. Previously this also required the static keys, so it
    // always returned false and printed "S3 not configured" even though S3
    // access via the IAM role worked fine.
    return !!process.env.S3_BUCKET_NAME;
}

/**
 * Check if demo data exists
 */
async function demoDataExists() {
    try {
        await getFile('assessments/index.json');
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * Get all assessment SUMMARIES for dashboard display
 * Uses index only — single S3 call, no full data loads
 * Returns summary objects with: assessment_id, company_name, loan_amount_lakhs, 
 *   status, grade, score, product, branch, priority, created_by, created_at, completed_at, type
 */
async function getAllAssessmentSummaries() {
    try {
        let summaries = [];
        
        if (USE_PARTITIONED) {
            summaries = await getAllFromMetadataIndex();
        } else {
            const index = await getAssessmentsIndex();
            summaries = index.assessments || [];
        }
        
        // Normalize: ensure loan_amount_lakhs is set (backward compat for old records)
        summaries = summaries.map(s => ({
            ...s,
            assessment_id: s.assessment_id || s.id,
            loan_amount_lakhs: s.loan_amount_lakhs || s.loan_amount || 0
        }));
        
        console.log(`📋 Loaded ${summaries.length} assessment summaries from index`);
        return summaries;
        
    } catch (err) {
        console.error('Error getting assessment summaries:', err);
        return [];
    }
}

/**
 * Save job queue state for crash recovery
 */
async function saveQueueState(state) {
    if (!isConfigured()) return;
    
    try {
        const buffer = Buffer.from(JSON.stringify(state, null, 2), 'utf-8');
        await uploadFile('queue/state.json', buffer, 'application/json');
    } catch (err) {
        console.error('Error saving queue state:', err.message);
    }
}

/**
 * Get job queue state for recovery after restart
 */
async function getQueueState() {
    if (!isConfigured()) return null;
    
    try {
        const data = await getFile('queue/state.json');
        return JSON.parse(data.toString('utf-8'));
    } catch (err) {
        // Queue state doesn't exist yet
        return null;
    }
}

// Export all functions
module.exports = {
    // Core functions (backward compatible)
    uploadFile,
    getFile,
    saveAssessment,
    getAssessment,
    deleteAssessment,
    getAllAssessments,
    getAllAssessmentSummaries,
    saveMasters,
    getMasters,
    generateS3Key,
    isConfigured,
    demoDataExists,
    
    // Queue state functions
    saveQueueState,
    getQueueState,
    
    // Legacy functions (for compatibility)
    getAssessmentsIndex,
    saveAssessmentsIndex,
    
    // New partitioned functions
    saveAuditEntry,
    generatePartitionedKey,
    searchMetadataIndex,
    
    // Multipart upload (keep existing)
    initiateMultipartUpload: async (key, contentType) => {
        const command = new CreateMultipartUploadCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            ContentType: contentType || 'application/pdf'
        });
        const response = await s3Client.send(command);
        return { uploadId: response.UploadId, key: key };
    },
    
    uploadPart: async (key, uploadId, partNumber, body) => {
        const command = new UploadPartCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: body
        });
        const response = await s3Client.send(command);
        return { ETag: response.ETag, PartNumber: partNumber };
    },
    
    completeMultipartUpload: async (key, uploadId, parts) => {
        const sortedParts = parts.sort((a, b) => a.PartNumber - b.PartNumber);
        const command = new CompleteMultipartUploadCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: sortedParts }
        });
        const response = await s3Client.send(command);
        return { location: response.Location, key: key, bucket: BUCKET_NAME };
    },
    
    abortMultipartUpload: async (key, uploadId) => {
        const command = new AbortMultipartUploadCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            UploadId: uploadId
        });
        await s3Client.send(command);
    },
    
    // Constants
    s3Client,
    BUCKET_NAME,
    USE_PARTITIONED
};
