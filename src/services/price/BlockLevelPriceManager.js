const { Decimal } = require('decimal.js');
const logger = require('../../utils/logger');

/**
 * Block-Level Price Manager
 * Implements block-by-block updates with intelligent pair tracking
 * Based on your strategy: subscribe to new blocks, refresh only impacted pairs
 */
class BlockLevelPriceManager {
    constructor(web3Manager, pairs, options = {}) {
        this.web3Manager = web3Manager;
        this.pairs = pairs;
        this.options = {
            batchSize: options.batchSize || 25, // Respect provider limits
            staggerDelay: options.staggerDelay || 100, // ms between batches
            maxRetries: options.maxRetries || 3,
            cacheTTL: options.cacheTTL || 30000, // 30 seconds
            ...options
        };
        
        // Price cache with block-level consistency
        this.priceCache = new Map();
        this.impactedPairs = new Set();
        this.lastBlockNumber = 0;
        this.lastBlockHash = '';
        this.isUpdating = false;
        this.updateQueue = [];
        
        // Statistics
        this.stats = {
            totalUpdates: 0,
            successfulUpdates: 0,
            failedUpdates: 0,
            averageUpdateTime: 0,
            lastUpdateTime: 0
        };
        
        logger.info('BlockLevelPriceManager initialized', {
            pairCount: this.pairs.length,
            batchSize: this.options.batchSize,
            cacheTTL: this.options.cacheTTL
        });
    }
    
    /**
     * Start block-level monitoring
     */
    async start() {
        try {
            logger.info('Starting block-level price monitoring');
            
            // Get initial block number
            this.lastBlockNumber = await this.web3Manager.getBlockNumber();
            
            // Subscribe to new blocks
            await this.web3Manager.subscribeToBlocks((blockHeader) => {
                this.onNewBlock(blockHeader);
            });
            
            // Initial price update
            await this.updateAllPairs();
            
            logger.info('Block-level monitoring started successfully', {
                currentBlock: this.lastBlockNumber
            });
            
        } catch (error) {
            logger.error('Failed to start block-level monitoring', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Handle new block events
     * @param {Object} blockHeader - Block header data
     */
    async onNewBlock(blockHeader) {
        const blockNumber = blockHeader.number;
        const blockHash = blockHeader.hash;
        
        logger.debug('New block received', {
            blockNumber,
            blockHash,
            impactedPairsCount: this.impactedPairs.size
        });
        
        // Update block info
        this.lastBlockNumber = blockNumber;
        this.lastBlockHash = blockHash;
        
        // Only update pairs that were impacted
        if (this.impactedPairs.size > 0) {
            await this.updateImpactedPairs(blockNumber, blockHash);
            this.impactedPairs.clear();
        }
        
        // Process any queued updates
        await this.processUpdateQueue();
    }
    
    /**
     * Update only impacted pairs for efficiency
     * @param {number} blockNumber - Current block number
     * @param {string} blockHash - Current block hash
     */
    async updateImpactedPairs(blockNumber, blockHash) {
        if (this.isUpdating) {
            // Queue the update if already processing
            this.updateQueue.push({ blockNumber, blockHash });
            return;
        }
        
        this.isUpdating = true;
        const startTime = Date.now();
        
        try {
            const pairs = Array.from(this.impactedPairs);
            logger.info('Updating impacted pairs', {
                blockNumber,
                blockHash,
                pairCount: pairs.length
            });
            
            // Process in batches
            for (let i = 0; i < pairs.length; i += this.options.batchSize) {
                const batch = pairs.slice(i, i + this.options.batchSize);
                await this.batchUpdateReserves(batch, blockNumber, blockHash);
                
                // Stagger requests to avoid rate limiting
                if (i + this.options.batchSize < pairs.length) {
                    await this.delay(this.options.staggerDelay);
                }
            }
            
            const updateTime = Date.now() - startTime;
            this.stats.successfulUpdates++;
            this.stats.averageUpdateTime = 
                (this.stats.averageUpdateTime * (this.stats.successfulUpdates - 1) + updateTime) / 
                this.stats.successfulUpdates;
            this.stats.lastUpdateTime = updateTime;
            
            logger.info('Impacted pairs updated successfully', {
                blockNumber,
                pairCount: pairs.length,
                updateTime: `${updateTime}ms`
            });
            
        } catch (error) {
            this.stats.failedUpdates++;
            logger.error('Failed to update impacted pairs', {
                blockNumber,
                error: error.message
            });
        } finally {
            this.isUpdating = false;
        }
    }
    
    /**
     * Process queued updates
     */
    async processUpdateQueue() {
        while (this.updateQueue.length > 0) {
            const update = this.updateQueue.shift();
            await this.updateImpactedPairs(update.blockNumber, update.blockHash);
        }
    }
    
    /**
     * Batch update reserves for multiple pairs
     * @param {Array} pairs - Array of pair addresses
     * @param {number} blockNumber - Block number for consistency
     * @param {string} blockHash - Block hash for consistency
     */
    async batchUpdateReserves(pairs, blockNumber, blockHash) {
        const calls = pairs.map(pairAddress => ({
            to: pairAddress,
            data: this.web3Manager.getCurrentWeb3().eth.abi.encodeFunctionCall({
                name: 'getReserves',
                type: 'function',
                inputs: []
            }, [])
        }));
        
        try {
            const results = await this.web3Manager.batchCall(calls, blockNumber);
            this.updatePriceCache(pairs, results, blockNumber, blockHash);
            
        } catch (error) {
            logger.error('Batch update failed, falling back to individual calls', {
                error: error.message,
                pairCount: pairs.length
            });
            
            // Fallback to individual calls
            await this.fallbackUpdate(pairs, blockNumber, blockHash);
        }
    }
    
    /**
     * Fallback to individual pair updates
     * @param {Array} pairs - Array of pair addresses
     * @param {number} blockNumber - Block number
     * @param {string} blockHash - Block hash
     */
    async fallbackUpdate(pairs, blockNumber, blockHash) {
        for (const pairAddress of pairs) {
            try {
                const result = await this.web3Manager.executeWithFailover(async (web3) => {
                    return await web3.eth.call({
                        to: pairAddress,
                        data: web3.eth.abi.encodeFunctionCall({
                            name: 'getReserves',
                            type: 'function',
                            inputs: []
                        }, [])
                    }, blockNumber);
                });
                
                this.updatePriceCache([pairAddress], [result], blockNumber, blockHash);
                
            } catch (error) {
                logger.error('Individual pair update failed', {
                    pairAddress,
                    error: error.message
                });
            }
        }
    }
    
    /**
     * Update price cache with new data
     * @param {Array} pairs - Array of pair addresses
     * @param {Array} results - Array of reserve results
     * @param {number} blockNumber - Block number
     * @param {string} blockHash - Block hash
     */
    updatePriceCache(pairs, results, blockNumber, blockHash) {
        const timestamp = Date.now();
        
        pairs.forEach((pairAddress, index) => {
            try {
                const result = results[index];
                if (!result || result === '0x') return;
                
                // Decode reserves
                const web3 = this.web3Manager.getCurrentWeb3();
                const decoded = web3.eth.abi.decodeParameters(
                    ['uint112', 'uint112', 'uint32'],
                    result
                );
                
                const [reserve0, reserve1, blockTimestampLast] = decoded;
                
                // Calculate prices
                const price0 = new Decimal(reserve1).div(reserve0);
                const price1 = new Decimal(reserve0).div(reserve1);
                
                // Calculate liquidity (simplified)
                const liquidityUSD = this.calculateLiquidityUSD(reserve0, reserve1);
                
                const priceData = {
                    pairAddress,
                    reserve0: reserve0.toString(),
                    reserve1: reserve1.toString(),
                    price0: price0.toString(),
                    price1: price1.toString(),
                    liquidityUSD,
                    blockNumber,
                    blockHash,
                    blockTimestampLast: blockTimestampLast.toString(),
                    timestamp,
                    expiresAt: timestamp + this.options.cacheTTL
                };
                
                this.priceCache.set(pairAddress, priceData);
                
                logger.debug('Price cache updated', {
                    pairAddress,
                    price0: price0.toString(),
                    price1: price1.toString(),
                    liquidityUSD,
                    blockNumber
                });
                
            } catch (error) {
                logger.error('Failed to update price cache', {
                    pairAddress,
                    error: error.message
                });
            }
        });
    }
    
    /**
     * Calculate USD liquidity (simplified)
     * @param {string} reserve0 - Reserve 0
     * @param {string} reserve1 - Reserve 1
     * @returns {number} Liquidity in USD
     */
    calculateLiquidityUSD(reserve0, reserve1) {
        // Simplified calculation - in real implementation, would use price feeds
        const reserve0Decimal = new Decimal(reserve0);
        const reserve1Decimal = new Decimal(reserve1);
        
        // Assume equal weight for now
        return reserve0Decimal.add(reserve1Decimal).toNumber();
    }
    
    /**
     * Mark pair as impacted for next block update
     * @param {string} pairAddress - Pair address
     */
    markPairImpacted(pairAddress) {
        this.impactedPairs.add(pairAddress);
    }
    
    /**
     * Get price data for a pair
     * @param {string} pairAddress - Pair address
     * @returns {Object|null} Price data or null if not found/expired
     */
    getPriceData(pairAddress) {
        const priceData = this.priceCache.get(pairAddress);
        
        if (!priceData) {
            return null;
        }
        
        // Check if data is expired
        if (Date.now() > priceData.expiresAt) {
            this.priceCache.delete(pairAddress);
            return null;
        }
        
        return priceData;
    }
    
    /**
     * Get all current price data
     * @returns {Array} Array of price data objects
     */
    getAllPriceData() {
        const currentTime = Date.now();
        const validData = [];
        
        for (const [pairAddress, priceData] of this.priceCache) {
            if (currentTime <= priceData.expiresAt) {
                validData.push(priceData);
            } else {
                this.priceCache.delete(pairAddress);
            }
        }
        
        return validData;
    }
    
    /**
     * Update all pairs (for initial load)
     */
    async updateAllPairs() {
        logger.info('Updating all pairs for initial load', {
            pairCount: this.pairs.length
        });
        
        // Mark all pairs as impacted
        this.pairs.forEach(pair => this.impactedPairs.add(pair));
        
        // Update with current block
        const blockNumber = await this.web3Manager.getBlockNumber();
        const blockHash = await this.web3Manager.executeWithFailover(async (web3) => {
            const block = await web3.eth.getBlock(blockNumber);
            return block.hash;
        });
        
        await this.updateImpactedPairs(blockNumber, blockHash);
    }
    
    /**
     * Get statistics
     * @returns {Object} Statistics object
     */
    getStats() {
        return {
            ...this.stats,
            currentBlock: this.lastBlockNumber,
            cacheSize: this.priceCache.size,
            impactedPairsCount: this.impactedPairs.size,
            queueSize: this.updateQueue.length,
            isUpdating: this.isUpdating
        };
    }
    
    /**
     * Clear expired cache entries
     */
    clearExpiredCache() {
        const currentTime = Date.now();
        let clearedCount = 0;
        
        for (const [pairAddress, priceData] of this.priceCache) {
            if (currentTime > priceData.expiresAt) {
                this.priceCache.delete(pairAddress);
                clearedCount++;
            }
        }
        
        if (clearedCount > 0) {
            logger.debug('Cleared expired cache entries', { clearedCount });
        }
    }
    
    /**
     * Utility function for delays
     * @param {number} ms - Milliseconds to delay
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = BlockLevelPriceManager;
