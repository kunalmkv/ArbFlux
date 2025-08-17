const logger = require('../../utils/logger');
const BlockLevelPriceManager = require('./BlockLevelPriceManager');
const DEXPriceService = require('./DEXPriceService');

/**
 * Price Monitoring Worker
 * Orchestrates block-level price updates and manages real-time monitoring
 * Implements your strategy: block-by-block updates with intelligent pair tracking
 */
class PriceMonitoringWorker {
    constructor(web3Manager, options = {}) {
        this.web3Manager = web3Manager;
        this.options = {
            updateInterval: options.updateInterval || 1000, // 1 second
            maxPairsPerUpdate: options.maxPairsPerUpdate || 100,
            enableBlockMonitoring: options.enableBlockMonitoring !== false,
            enablePeriodicUpdates: options.enablePeriodicUpdates !== false,
            ...options
        };
        
        // Initialize services
        this.blockLevelManager = null;
        this.dexPriceService = new DEXPriceService(web3Manager, options);
        
        // Monitoring state
        this.isRunning = false;
        this.isBlockMonitoringActive = false;
        this.lastUpdateTime = 0;
        this.updateCount = 0;
        this.errorCount = 0;
        
        // Pair tracking
        this.monitoredPairs = new Set();
        this.pairUpdateQueue = [];
        this.pairUpdateStats = new Map();
        
        // Performance tracking
        this.performanceStats = {
            totalUpdates: 0,
            successfulUpdates: 0,
            failedUpdates: 0,
            averageUpdateTime: 0,
            lastUpdateTime: 0,
            blockCount: 0,
            pairUpdates: 0
        };
        
        logger.info('PriceMonitoringWorker initialized', {
            updateInterval: this.options.updateInterval,
            maxPairsPerUpdate: this.options.maxPairsPerUpdate,
            enableBlockMonitoring: this.options.enableBlockMonitoring,
            enablePeriodicUpdates: this.options.enablePeriodicUpdates
        });
    }
    
    /**
     * Start price monitoring
     * @param {Array} pairs - Array of pair addresses to monitor
     */
    async start(pairs = []) {
        if (this.isRunning) {
            logger.warn('Price monitoring is already running');
            return;
        }
        
        try {
            logger.info('Starting price monitoring worker');
            
            this.isRunning = true;
            this.monitoredPairs = new Set(pairs);
            
            // Initialize block-level manager if pairs provided
            if (pairs.length > 0) {
                this.blockLevelManager = new BlockLevelPriceManager(
                    this.web3Manager,
                    pairs,
                    this.options
                );
            }
            
            // Start block monitoring if enabled
            if (this.options.enableBlockMonitoring && this.blockLevelManager) {
                await this.startBlockMonitoring();
            }
            
            // Start periodic updates if enabled
            if (this.options.enablePeriodicUpdates) {
                this.startPeriodicUpdates();
            }
            
            logger.info('Price monitoring worker started successfully', {
                monitoredPairs: this.monitoredPairs.size,
                blockMonitoring: this.isBlockMonitoringActive,
                periodicUpdates: this.options.enablePeriodicUpdates
            });
            
        } catch (error) {
            this.isRunning = false;
            logger.error('Failed to start price monitoring worker', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Stop price monitoring
     */
    async stop() {
        if (!this.isRunning) {
            logger.warn('Price monitoring is not running');
            return;
        }
        
        try {
            logger.info('Stopping price monitoring worker');
            
            this.isRunning = false;
            this.isBlockMonitoringActive = false;
            
            // Stop block monitoring
            if (this.blockLevelManager) {
                // Note: In a real implementation, we would properly unsubscribe from events
                this.blockLevelManager = null;
            }
            
            logger.info('Price monitoring worker stopped successfully');
            
        } catch (error) {
            logger.error('Error stopping price monitoring worker', { error: error.message });
        }
    }
    
    /**
     * Start block-level monitoring
     */
    async startBlockMonitoring() {
        if (!this.blockLevelManager) {
            throw new Error('Block level manager not initialized');
        }
        
        try {
            await this.blockLevelManager.start();
            this.isBlockMonitoringActive = true;
            
            logger.info('Block-level monitoring started successfully');
            
        } catch (error) {
            logger.error('Failed to start block-level monitoring', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Start periodic updates
     */
    startPeriodicUpdates() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        
        this.updateInterval = setInterval(async () => {
            if (this.isRunning) {
                await this.performPeriodicUpdate();
            }
        }, this.options.updateInterval);
        
        logger.info('Periodic updates started', {
            interval: this.options.updateInterval
        });
    }
    
    /**
     * Perform periodic price update
     */
    async performPeriodicUpdate() {
        if (!this.isRunning || this.monitoredPairs.size === 0) {
            return;
        }
        
        const startTime = Date.now();
        
        try {
            // Get pairs to update (limit batch size)
            const pairsToUpdate = Array.from(this.monitoredPairs)
                .slice(0, this.options.maxPairsPerUpdate);
            
            if (pairsToUpdate.length === 0) {
                return;
            }
            
            logger.debug('Performing periodic price update', {
                pairCount: pairsToUpdate.length
            });
            
            // Update prices for pairs
            const updatePromises = pairsToUpdate.map(pairAddress => 
                this.updatePairPrice(pairAddress)
            );
            
            const results = await Promise.allSettled(updatePromises);
            
            // Process results
            let successCount = 0;
            let failureCount = 0;
            
            results.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    successCount++;
                    this.updatePairStats(pairsToUpdate[index], true);
                } else {
                    failureCount++;
                    this.updatePairStats(pairsToUpdate[index], false);
                    logger.error('Periodic update failed for pair', {
                        pairAddress: pairsToUpdate[index],
                        error: result.reason.message
                    });
                }
            });
            
            // Update performance stats
            const updateTime = Date.now() - startTime;
            this.performanceStats.totalUpdates++;
            this.performanceStats.successfulUpdates += successCount;
            this.performanceStats.failedUpdates += failureCount;
            this.performanceStats.lastUpdateTime = updateTime;
            this.performanceStats.averageUpdateTime = 
                (this.performanceStats.averageUpdateTime * (this.performanceStats.totalUpdates - 1) + updateTime) / 
                this.performanceStats.totalUpdates;
            
            logger.debug('Periodic update completed', {
                successCount,
                failureCount,
                updateTime: `${updateTime}ms`
            });
            
        } catch (error) {
            this.errorCount++;
            logger.error('Periodic update failed', { error: error.message });
        }
    }
    
    /**
     * Update price for a specific pair
     * @param {string} pairAddress - Pair address
     * @returns {Promise<Object|null>} Updated price data or null
     */
    async updatePairPrice(pairAddress) {
        try {
            // For now, we'll simulate getting reserves
            // In a real implementation, this would call the DEX service
            const reserves = await this.dexPriceService.getReserves(pairAddress);
            
            // Update pair statistics
            this.updatePairStats(pairAddress, true);
            
            return {
                pairAddress,
                reserves,
                timestamp: Date.now()
            };
            
        } catch (error) {
            this.updatePairStats(pairAddress, false);
            throw error;
        }
    }
    
    /**
     * Add pair to monitoring
     * @param {string} pairAddress - Pair address
     */
    addPair(pairAddress) {
        if (!this.monitoredPairs.has(pairAddress)) {
            this.monitoredPairs.add(pairAddress);
            
            // Add to block-level manager if available
            if (this.blockLevelManager) {
                this.blockLevelManager.markPairImpacted(pairAddress);
            }
            
            logger.debug('Pair added to monitoring', { pairAddress });
        }
    }
    
    /**
     * Remove pair from monitoring
     * @param {string} pairAddress - Pair address
     */
    removePair(pairAddress) {
        if (this.monitoredPairs.has(pairAddress)) {
            this.monitoredPairs.delete(pairAddress);
            this.pairUpdateStats.delete(pairAddress);
            
            logger.debug('Pair removed from monitoring', { pairAddress });
        }
    }
    
    /**
     * Update statistics for a pair
     * @param {string} pairAddress - Pair address
     * @param {boolean} success - Whether update was successful
     */
    updatePairStats(pairAddress, success) {
        if (!this.pairUpdateStats.has(pairAddress)) {
            this.pairUpdateStats.set(pairAddress, {
                totalUpdates: 0,
                successfulUpdates: 0,
                failedUpdates: 0,
                lastUpdateTime: 0,
                averageUpdateTime: 0
            });
        }
        
        const stats = this.pairUpdateStats.get(pairAddress);
        stats.totalUpdates++;
        stats.lastUpdateTime = Date.now();
        
        if (success) {
            stats.successfulUpdates++;
        } else {
            stats.failedUpdates++;
        }
    }
    
    /**
     * Get price data for a pair
     * @param {string} pairAddress - Pair address
     * @returns {Object|null} Price data or null
     */
    getPairPrice(pairAddress) {
        // Try block-level manager first
        if (this.blockLevelManager) {
            const blockData = this.blockLevelManager.getPriceData(pairAddress);
            if (blockData) {
                return blockData;
            }
        }
        
        // Fallback to DEX service
        // In a real implementation, this would return cached data
        return null;
    }
    
    /**
     * Get all monitored pairs
     * @returns {Array} Array of pair addresses
     */
    getMonitoredPairs() {
        return Array.from(this.monitoredPairs);
    }
    
    /**
     * Get comprehensive statistics
     * @returns {Object} Statistics object
     */
    getStats() {
        const blockStats = this.blockLevelManager ? this.blockLevelManager.getStats() : {};
        const dexStats = this.dexPriceService.getStats();
        
        return {
            isRunning: this.isRunning,
            isBlockMonitoringActive: this.isBlockMonitoringActive,
            monitoredPairsCount: this.monitoredPairs.size,
            performance: this.performanceStats,
            blockLevel: blockStats,
            dexService: dexStats,
            pairStats: Object.fromEntries(this.pairUpdateStats),
            errorCount: this.errorCount,
            lastUpdateTime: this.lastUpdateTime
        };
    }
    
    /**
     * Get health status
     * @returns {Object} Health status object
     */
    async getHealthStatus() {
        const web3Health = await this.web3Manager.healthCheck();
        const blockMonitoringHealth = this.isBlockMonitoringActive;
        const periodicUpdatesHealth = this.options.enablePeriodicUpdates;
        
        const overallHealth = web3Health && blockMonitoringHealth && periodicUpdatesHealth;
        
        return {
            healthy: overallHealth,
            web3Manager: web3Health,
            blockMonitoring: blockMonitoringHealth,
            periodicUpdates: periodicUpdatesHealth,
            lastUpdate: this.lastUpdateTime,
            errorCount: this.errorCount
        };
    }
    
    /**
     * Force update for all monitored pairs
     */
    async forceUpdate() {
        if (!this.isRunning) {
            throw new Error('Price monitoring is not running');
        }
        
        logger.info('Forcing update for all monitored pairs');
        
        const pairs = Array.from(this.monitoredPairs);
        const updatePromises = pairs.map(pairAddress => 
            this.updatePairPrice(pairAddress)
        );
        
        const results = await Promise.allSettled(updatePromises);
        
        const successCount = results.filter(r => r.status === 'fulfilled').length;
        const failureCount = results.filter(r => r.status === 'rejected').length;
        
        logger.info('Force update completed', {
            totalPairs: pairs.length,
            successCount,
            failureCount
        });
        
        return { successCount, failureCount, totalPairs: pairs.length };
    }
}

module.exports = PriceMonitoringWorker;
