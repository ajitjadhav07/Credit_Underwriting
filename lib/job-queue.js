/**
 * Job Queue Manager for Background Assessment Processing
 * Handles concurrent processing, queue positions, and recovery
 */

class JobQueue {
    constructor(options = {}) {
        this.maxConcurrent = options.maxConcurrent || 3;
        this.queue = [];                    // Waiting jobs
        this.processing = new Map();        // Currently processing jobs
        this.s3Client = options.s3Client;
        this.onJobComplete = options.onJobComplete || (() => {});
        this.onJobError = options.onJobError || (() => {});
    }

    /**
     * Add job to queue
     */
    enqueue(assessmentId, jobData) {
        // Check if already in queue or processing
        if (this.processing.has(assessmentId)) {
            return this.processing.get(assessmentId);
        }
        
        const existingIdx = this.queue.findIndex(j => j.id === assessmentId);
        if (existingIdx >= 0) {
            return this.queue[existingIdx];
        }

        const job = {
            id: assessmentId,
            status: 'queued',
            position: this.queue.length + 1,
            queuedAt: new Date().toISOString(),
            estimatedWait: this.estimateWaitTime(),
            companyName: jobData.companyName,
            loanAmount: jobData.loanAmount,
            documents: jobData.documents,
            userId: jobData.userId,
            
            // Progress tracking
            progress: 0,
            currentPhase: 0,
            totalPhases: 11,
            currentDocument: null,
            currentStep: null,
            
            // Pipeline state for UI
            pipeline: [
                { name: 'Document Upload', status: 'complete' },
                { name: 'Document Processing', status: 'pending' },
                { name: 'Bank Statement', status: 'pending' },
                { name: 'GST Return', status: 'pending' },
                { name: 'ITR Document', status: 'pending' },
                { name: 'KYC Document', status: 'pending' },
                { name: 'Property Document', status: 'pending' },
                { name: 'Credit Bureau', status: 'pending' },
                { name: 'Calculations', status: 'pending' },
                { name: 'Policy Check', status: 'pending' },
                { name: 'Final Decision', status: 'pending' }
            ],
            
            // Metrics
            metrics: {
                documents: jobData.documentCount || 0,
                apiCalls: 0,
                validations: 0,
                dataPoints: 0
            },
            
            // Live commentary
            commentary: 'Waiting in queue...',
            
            // Error tracking
            error: null,
            retryCount: 0,
            maxRetries: 3
        };

        this.queue.push(job);
        this.updateQueuePositions();
        this.persistQueue();
        
        console.log(`📋 Job ${assessmentId} added to queue at position ${job.position}`);
        
        return job;
    }

    /**
     * Get job status by assessment ID
     */
    getStatus(assessmentId) {
        // Check if processing
        if (this.processing.has(assessmentId)) {
            const job = this.processing.get(assessmentId);
            
            // Check if job is stale (no update in 5 minutes)
            const lastUpdate = job.lastUpdatedAt || job.startedAt;
            const staleThreshold = 5 * 60 * 1000; // 5 minutes
            const isStale = lastUpdate && (Date.now() - new Date(lastUpdate).getTime() > staleThreshold);
            
            return {
                ...job,
                status: isStale ? 'stalled' : 'processing',
                isStale: isStale,
                lastUpdatedAt: lastUpdate,
                staleDuration: isStale ? Math.round((Date.now() - new Date(lastUpdate).getTime()) / 60000) : 0,
                inQueue: false
            };
        }

        // Check if queued
        const queueIdx = this.queue.findIndex(j => j.id === assessmentId);
        if (queueIdx >= 0) {
            const job = this.queue[queueIdx];
            return {
                ...job,
                status: 'queued',
                position: queueIdx + 1,
                totalInQueue: this.queue.length,
                estimatedWait: this.estimateWaitTime(queueIdx),
                ahead: queueIdx,
                inQueue: true
            };
        }

        return { status: 'not_found', inQueue: false };
    }

    /**
     * Update job progress (called during processing)
     */
    updateProgress(assessmentId, progressData) {
        let job = this.processing.get(assessmentId);
        
        // If job not in processing map, DON'T create a new entry
        // This prevents completed jobs from being recreated
        if (!job) {
            // Check if in queue
            const queueIdx = this.queue.findIndex(j => j.id === assessmentId);
            if (queueIdx >= 0) {
                job = this.queue[queueIdx];
            } else {
                // Job not found - it may have completed, don't recreate
                console.log(`⚠️ updateProgress called for unknown job ${assessmentId} - ignoring (may be completed)`);
                return false;
            }
        }

        // Update timestamp for stale detection
        job.lastUpdatedAt = new Date().toISOString();

        // Update the job with new progress data
        if (progressData.progress !== undefined) job.progress = progressData.progress;
        if (progressData.currentPhase !== undefined) job.currentPhase = progressData.currentPhase;
        if (progressData.currentDocument !== undefined) job.currentDocument = progressData.currentDocument;
        if (progressData.commentary) job.commentary = progressData.commentary;
        if (progressData.message) job.message = progressData.message;
        if (progressData.phase) job.phase = progressData.phase;
        if (progressData.docsCompleted !== undefined) job.docsCompleted = progressData.docsCompleted;
        if (progressData.metrics) {
            job.metrics = { ...job.metrics, ...progressData.metrics };
        }

        // Update pipeline status
        if (progressData.pipelineUpdate) {
            const idx = job.pipeline.findIndex(p => p.name === progressData.pipelineUpdate.name);
            if (idx >= 0) {
                job.pipeline[idx].status = progressData.pipelineUpdate.status;
            }
        }
        
        return true;
    }

    /**
     * Start processing a job (move from queue to processing)
     */
    startProcessing(assessmentId) {
        const queueIdx = this.queue.findIndex(j => j.id === assessmentId);
        if (queueIdx < 0) return null;

        const job = this.queue.splice(queueIdx, 1)[0];
        job.status = 'processing';
        job.startedAt = new Date().toISOString();
        job.commentary = 'Starting document extraction...';
        
        this.processing.set(assessmentId, job);
        this.updateQueuePositions();
        this.persistQueue();
        
        console.log(`🚀 Job ${assessmentId} started processing`);
        
        return job;
    }

    /**
     * Mark job as complete
     */
    completeJob(assessmentId, result) {
        const job = this.processing.get(assessmentId);
        if (!job) return;

        job.status = 'complete';
        job.completedAt = new Date().toISOString();
        job.progress = 100;
        job.result = result;
        
        this.processing.delete(assessmentId);
        this.persistQueue();
        
        console.log(`✅ Job ${assessmentId} completed`);
        
        this.onJobComplete(assessmentId, job);
        this.processNext();
    }

    /**
     * Mark job as failed
     */
    failJob(assessmentId, error, partialData = null) {
        const job = this.processing.get(assessmentId);
        if (!job) return;

        job.error = {
            message: error.message || error,
            failedAt: job.currentDocument,
            timestamp: new Date().toISOString()
        };
        
        // Check if we should retry
        if (job.retryCount < job.maxRetries && this.isRetryableError(error)) {
            job.retryCount++;
            job.status = 'retrying';
            job.commentary = `Retrying (attempt ${job.retryCount}/${job.maxRetries})...`;
            console.log(`🔄 Job ${assessmentId} retrying (${job.retryCount}/${job.maxRetries})`);
            return { shouldRetry: true, job };
        }

        job.status = partialData ? 'partial' : 'failed';
        job.partialData = partialData;
        job.failedAt = new Date().toISOString();
        
        this.processing.delete(assessmentId);
        this.persistQueue();
        
        console.log(`❌ Job ${assessmentId} failed: ${error.message || error}`);
        
        this.onJobError(assessmentId, job);
        this.processNext();
        
        return { shouldRetry: false, job };
    }

    /**
     * Check if error is retryable
     */
    isRetryableError(error) {
        const message = error.message || error;
        return message.includes('timeout') ||
               message.includes('rate limit') ||
               message.includes('529') ||
               message.includes('503') ||
               message.includes('ECONNRESET') ||
               message.includes('overloaded');
    }

    /**
     * Process next job in queue if slots available
     */
    processNext() {
        if (this.processing.size >= this.maxConcurrent || this.queue.length === 0) {
            return null;
        }
        
        const nextJob = this.queue[0];
        return nextJob ? nextJob.id : null;
    }

    /**
     * Check if can start new job
     */
    canStartNew() {
        return this.processing.size < this.maxConcurrent;
    }

    /**
     * Get next job to process
     */
    getNextJob() {
        if (!this.canStartNew() || this.queue.length === 0) {
            return null;
        }
        return this.queue[0];
    }

    /**
     * Estimate wait time based on position
     */
    estimateWaitTime(position = this.queue.length) {
        const avgProcessingTime = 8 * 60 * 1000; // 8 minutes average
        const batches = Math.ceil(position / this.maxConcurrent);
        const waitMs = batches * avgProcessingTime;
        
        if (waitMs < 60000) return 'Less than 1 minute';
        if (waitMs < 3600000) return `~${Math.ceil(waitMs / 60000)} minutes`;
        return `~${Math.ceil(waitMs / 3600000)} hours`;
    }

    /**
     * Update queue positions after changes
     */
    updateQueuePositions() {
        this.queue.forEach((job, idx) => {
            job.position = idx + 1;
            job.estimatedWait = this.estimateWaitTime(idx);
        });
    }

    /**
     * Get queue statistics
     */
    getStats() {
        return {
            processing: this.processing.size,
            queued: this.queue.length,
            maxConcurrent: this.maxConcurrent,
            processingIds: Array.from(this.processing.keys()),
            queuedIds: this.queue.map(j => j.id)
        };
    }

    /**
     * Persist queue state to S3 for crash recovery
     */
    async persistQueue() {
        if (!this.s3Client || !this.s3Client.isConfigured()) return;
        
        try {
            const state = {
                queue: this.queue,
                processing: Array.from(this.processing.entries()).map(([id, job]) => ({
                    id,
                    ...job
                })),
                updatedAt: new Date().toISOString()
            };
            
            await this.s3Client.saveQueueState(state);
        } catch (err) {
            console.error('Error persisting queue:', err.message);
        }
    }

    /**
     * Restore queue from S3 on server restart
     */
    async restore() {
        if (!this.s3Client || !this.s3Client.isConfigured()) return;
        
        try {
            const state = await this.s3Client.getQueueState();
            if (!state) return;
            
            // Re-queue any jobs that were processing (server crashed mid-process)
            const interruptedJobs = state.processing || [];
            const queuedJobs = state.queue || [];
            
            // Mark interrupted jobs for retry
            interruptedJobs.forEach(job => {
                job.status = 'queued';
                job.commentary = 'Resuming after server restart...';
                job.retryCount = (job.retryCount || 0);
            });
            
            this.queue = [...interruptedJobs, ...queuedJobs];
            this.updateQueuePositions();
            
            if (this.queue.length > 0) {
                console.log(`📋 Restored ${this.queue.length} jobs from queue`);
            }
        } catch (err) {
            console.log('No queue state to restore');
        }
    }

    /**
     * Remove job from queue (user cancelled)
     */
    cancelJob(assessmentId) {
        // Remove from queue
        const queueIdx = this.queue.findIndex(j => j.id === assessmentId);
        if (queueIdx >= 0) {
            this.queue.splice(queueIdx, 1);
            this.updateQueuePositions();
            this.persistQueue();
            console.log(`🚫 Job ${assessmentId} cancelled from queue`);
            return true;
        }
        
        // Can't cancel processing job easily
        if (this.processing.has(assessmentId)) {
            console.log(`⚠️ Cannot cancel ${assessmentId} - already processing`);
            return false;
        }
        
        return false;
    }
}

module.exports = JobQueue;
