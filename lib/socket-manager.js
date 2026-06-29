/**
 * Socket.io Manager
 * Handles real-time WebSocket communication for progress updates
 */

const { Server } = require('socket.io');

class SocketManager {
    constructor() {
        this.io = null;
        this.initialized = false;
        this.connectedClients = new Map(); // assessmentId -> Set of socket IDs
    }

    /**
     * Initialize Socket.io with HTTP server
     */
    initialize(httpServer) {
        if (this.initialized) return;

        this.io = new Server(httpServer, {
            cors: {
                origin: '*',
                methods: ['GET', 'POST']
            },
            pingTimeout: 60000,
            pingInterval: 25000
        });

        this.setupEventHandlers();
        this.initialized = true;
        
        console.log('✅ Socket.io initialized');
    }

    /**
     * Set up connection handlers
     */
    setupEventHandlers() {
        this.io.on('connection', (socket) => {
            console.log(`🔌 Client connected: ${socket.id}`);

            // Subscribe to assessment updates
            socket.on('subscribe', (assessmentId) => {
                if (!assessmentId) return;
                
                socket.join(assessmentId);
                
                // Track subscription
                if (!this.connectedClients.has(assessmentId)) {
                    this.connectedClients.set(assessmentId, new Set());
                }
                this.connectedClients.get(assessmentId).add(socket.id);
                
                console.log(`📡 ${socket.id} subscribed to ${assessmentId}`);
                
                // Send acknowledgment
                socket.emit('subscribed', { assessmentId, success: true });
            });

            // Unsubscribe from assessment updates
            socket.on('unsubscribe', (assessmentId) => {
                if (!assessmentId) return;
                
                socket.leave(assessmentId);
                
                // Remove from tracking
                if (this.connectedClients.has(assessmentId)) {
                    this.connectedClients.get(assessmentId).delete(socket.id);
                    if (this.connectedClients.get(assessmentId).size === 0) {
                        this.connectedClients.delete(assessmentId);
                    }
                }
                
                console.log(`📡 ${socket.id} unsubscribed from ${assessmentId}`);
            });

            // Handle disconnection
            socket.on('disconnect', (reason) => {
                console.log(`🔌 Client disconnected: ${socket.id} (${reason})`);
                
                // Clean up all subscriptions for this socket
                for (const [assessmentId, sockets] of this.connectedClients.entries()) {
                    sockets.delete(socket.id);
                    if (sockets.size === 0) {
                        this.connectedClients.delete(assessmentId);
                    }
                }
            });

            // Ping/pong for connection health
            socket.on('ping', () => {
                socket.emit('pong', { timestamp: Date.now() });
            });
        });
    }

    /**
     * Emit event to all clients subscribed to an assessment
     */
    emitToAssessment(assessmentId, event, data) {
        if (!this.io || !assessmentId) return;
        
        this.io.to(assessmentId).emit(event, {
            assessmentId,
            timestamp: new Date().toISOString(),
            ...data
        });
    }

    /**
     * Emit progress update
     */
    emitProgress(assessmentId, progressData) {
        this.emitToAssessment(assessmentId, 'progress', progressData);
    }

    /**
     * Emit completion event
     */
    emitComplete(assessmentId, result) {
        this.emitToAssessment(assessmentId, 'complete', result);
    }

    /**
     * Emit error event
     */
    emitError(assessmentId, error) {
        this.emitToAssessment(assessmentId, 'error', {
            message: error.message || error,
            code: error.code
        });
    }

    /**
     * Get number of clients watching an assessment
     */
    getSubscriberCount(assessmentId) {
        return this.connectedClients.get(assessmentId)?.size || 0;
    }

    /**
     * Get all active assessment subscriptions
     */
    getActiveSubscriptions() {
        const subscriptions = {};
        for (const [assessmentId, sockets] of this.connectedClients.entries()) {
            subscriptions[assessmentId] = sockets.size;
        }
        return subscriptions;
    }

    /**
     * Broadcast to all connected clients
     */
    broadcast(event, data) {
        if (!this.io) return;
        this.io.emit(event, data);
    }

    /**
     * Check if Socket.io is initialized
     */
    isReady() {
        return this.initialized && this.io !== null;
    }

    /**
     * Comprehensive health check for WebSocket
     * @returns {{working: boolean, configured: boolean, details: string, connectedClients?: number}}
     */
    checkHealth() {
        if (!this.initialized || !this.io) {
            return {
                working: false,
                configured: false,
                details: 'Socket.io not initialized'
            };
        }
        
        try {
            // Get connected clients count from socket.io engine
            const connectedClients = this.io.engine?.clientsCount || 0;
            // Get active rooms (assessments being tracked)
            const activeRooms = this.connectedClients?.size || 0;
            
            return {
                working: true,
                configured: true,
                details: `WebSocket server running (${connectedClients} clients, ${activeRooms} rooms)`,
                connectedClients,
                activeRooms
            };
        } catch (error) {
            return {
                working: false,
                configured: true,
                details: `WebSocket error: ${error.message}`,
                error: error.message
            };
        }
    }
}

module.exports = new SocketManager();
