const logger = require('../../utils/logger');
const { DEX_FACTORIES, TOKENS } = require('../../utils/constants');

/**
 * DEX Price Service
 * Handles multiple DEX integrations with intelligent batching and caching
 * Supports Uniswap V2, SushiSwap, PancakeSwap, and other V2-compatible DEXs
 */
class DEXPriceService {
    constructor(web3Manager, options = {}) {
        this.web3Manager = web3Manager;
        this.options = {
            supportedDEXs: options.supportedDEXs || ['uniswap', 'sushiswap'],
            batchSize: options.batchSize || 25,
            cacheTTL: options.cacheTTL || 30000,
            maxRetries: options.maxRetries || 3,
            ...options
        };
        
        // DEX configurations
        this.dexConfigs = {
            uniswap: {
                name: 'Uniswap V2',
                factory: DEX_FACTORIES.UNISWAP_V2,
                fee: 0.003, // 0.3%
                chainId: 1
            },
            sushiswap: {
                name: 'SushiSwap',
                factory: DEX_FACTORIES.SUSHISWAP,
                fee: 0.003, // 0.3%
                chainId: 1
            },
            pancakeswap: {
                name: 'PancakeSwap',
                factory: DEX_FACTORIES.PANCAKESWAP,
                fee: 0.0025, // 0.25%
                chainId: 56
            }
        };
        
        // Price cache per DEX
        this.priceCaches = new Map();
        this.pairCaches = new Map();
        this.tokenCaches = new Map();
        
        // Statistics
        this.stats = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            cacheHits: 0,
            cacheMisses: 0,
            averageResponseTime: 0
        };
        
        logger.info('DEXPriceService initialized', {
            supportedDEXs: this.options.supportedDEXs,
            batchSize: this.options.batchSize
        });
    }
    
    /**
     * Get pair address for two tokens on a specific DEX
     * @param {string} tokenA - Token A address
     * @param {string} tokenB - Token B address
     * @param {string} dexName - DEX name
     * @returns {Promise<string>} Pair address
     */
    async getPairAddress(tokenA, tokenB, dexName) {
        const cacheKey = `${dexName}:${tokenA}:${tokenB}`;
        
        // Check cache first
        if (this.pairCaches.has(cacheKey)) {
            const cached = this.pairCaches.get(cacheKey);
            if (Date.now() < cached.expiresAt) {
                this.stats.cacheHits++;
                return cached.pairAddress;
            }
            this.pairCaches.delete(cacheKey);
        }
        
        this.stats.cacheMisses++;
        this.stats.totalRequests++;
        
        try {
            const dexConfig = this.dexConfigs[dexName];
            if (!dexConfig) {
                throw new Error(`Unsupported DEX: ${dexName}`);
            }
            
            // Sort tokens for consistent pair address
            const [token0, token1] = tokenA < tokenB ? [tokenA, tokenB] : [tokenB, tokenA];
            
            const pairAddress = await this.web3Manager.executeWithFailover(async (web3) => {
                const factoryContract = new web3.eth.Contract([
                    {
                        "constant": true,
                        "inputs": [
                            {"name": "tokenA", "type": "address"},
                            {"name": "tokenB", "type": "address"}
                        ],
                        "name": "getPair",
                        "outputs": [{"name": "pair", "type": "address"}],
                        "payable": false,
                        "stateMutability": "view",
                        "type": "function"
                    }
                ], dexConfig.factory);
                
                return await factoryContract.methods.getPair(token0, token1).call();
            });
            
            // Cache the result
            this.pairCaches.set(cacheKey, {
                pairAddress,
                expiresAt: Date.now() + this.options.cacheTTL
            });
            
            return pairAddress;
            
        } catch (error) {
            logger.error('Failed to get pair address', {
                tokenA,
                tokenB,
                dexName,
                error: error.message
            });
            throw error;
        }
    }
    
    /**
     * Get reserves for a pair
     * @param {string} pairAddress - Pair address
     * @param {string} blockNumber - Block number (optional)
     * @returns {Promise<Object>} Reserves data
     */
    async getReserves(pairAddress, blockNumber = 'latest') {
        const cacheKey = `${pairAddress}:${blockNumber}`;
        
        // Check cache first
        if (this.priceCaches.has(cacheKey)) {
            const cached = this.priceCaches.get(cacheKey);
            if (Date.now() < cached.expiresAt) {
                this.stats.cacheHits++;
                return cached.reserves;
            }
            this.priceCaches.delete(cacheKey);
        }
        
        this.stats.cacheMisses++;
        this.stats.totalRequests++;
        const startTime = Date.now();
        
        try {
            const reserves = await this.web3Manager.executeWithFailover(async (web3) => {
                const pairContract = new web3.eth.Contract([
                    {
                        "constant": true,
                        "inputs": [],
                        "name": "getReserves",
                        "outputs": [
                            {"name": "_reserve0", "type": "uint112"},
                            {"name": "_reserve1", "type": "uint112"},
                            {"name": "_blockTimestampLast", "type": "uint32"}
                        ],
                        "payable": false,
                        "stateMutability": "view",
                        "type": "function"
                    }
                ], pairAddress);
                
                return await pairContract.methods.getReserves().call({}, blockNumber);
            });
            
            const responseTime = Date.now() - startTime;
            this.stats.successfulRequests++;
            if (this.stats.successfulRequests === 1) {
                this.stats.averageResponseTime = responseTime;
            } else {
                this.stats.averageResponseTime = 
                    (this.stats.averageResponseTime * (this.stats.successfulRequests - 1) + responseTime) / 
                    this.stats.successfulRequests;
            }
            
            // Cache the result
            this.priceCaches.set(cacheKey, {
                reserves,
                expiresAt: Date.now() + this.options.cacheTTL
            });
            
            return reserves;
            
        } catch (error) {
            this.stats.failedRequests++;
            logger.error('Failed to get reserves', {
                pairAddress,
                blockNumber,
                error: error.message
            });
            throw error;
        }
    }
    
    /**
     * Get price for a token pair on a specific DEX
     * @param {string} tokenA - Token A address
     * @param {string} tokenB - Token B address
     * @param {string} dexName - DEX name
     * @param {string} blockNumber - Block number (optional)
     * @returns {Promise<Object>} Price data
     */
    async getPrice(tokenA, tokenB, dexName, blockNumber = 'latest') {
        try {
            const pairAddress = await this.getPairAddress(tokenA, tokenB, dexName);
            
            if (pairAddress === '0x0000000000000000000000000000000000000000') {
                throw new Error(`No pair found for ${tokenA}/${tokenB} on ${dexName}`);
            }
            
            const reserves = await this.getReserves(pairAddress, blockNumber);
            const dexConfig = this.dexConfigs[dexName];
            
            // Check if reserves are valid
            if (!reserves || (typeof reserves === 'object' && Object.keys(reserves).length === 0)) {
                throw new Error(`Invalid reserves data for pair ${pairAddress}`);
            }
            
            // Calculate prices
            const reserve0 = reserves._reserve0 || reserves[0];
            const reserve1 = reserves._reserve1 || reserves[1];
            const blockTimestampLast = reserves._blockTimestampLast || reserves[2];
            
            if (!reserve0 || !reserve1 || reserve0 === '0' || reserve1 === '0') {
                throw new Error(`Invalid reserve values: reserve0=${reserve0}, reserve1=${reserve1}`);
            }
            
            const price0 = reserve1 / reserve0;
            const price1 = reserve0 / reserve1;
            
            return {
                pairAddress,
                tokenA,
                tokenB,
                dexName,
                reserve0: reserve0.toString(),
                reserve1: reserve1.toString(),
                price0: price0.toString(),
                price1: price1.toString(),
                fee: dexConfig.fee,
                blockNumber,
                blockTimestampLast: blockTimestampLast.toString(),
                timestamp: Date.now()
            };
            
        } catch (error) {
            logger.error('Failed to get price', {
                tokenA,
                tokenB,
                dexName,
                error: error.message
            });
            throw error;
        }
    }
    
    /**
     * Get prices for multiple pairs in batch
     * @param {Array} pairs - Array of {tokenA, tokenB, dexName} objects
     * @param {string} blockNumber - Block number (optional)
     * @returns {Promise<Array>} Array of price data
     */
    async getPricesBatch(pairs, blockNumber = 'latest') {
        const results = [];
        const batchSize = this.options.batchSize;
        
        for (let i = 0; i < pairs.length; i += batchSize) {
            const batch = pairs.slice(i, i + batchSize);
            
            try {
                const batchResults = await Promise.allSettled(
                    batch.map(pair => this.getPrice(pair.tokenA, pair.tokenB, pair.dexName, blockNumber))
                );
                
                batchResults.forEach((result, index) => {
                    if (result.status === 'fulfilled') {
                        results.push(result.value);
                    } else {
                        logger.error('Batch price request failed', {
                            pair: batch[index],
                            error: result.reason.message
                        });
                    }
                });
                
                // Add delay between batches to avoid rate limiting
                if (i + batchSize < pairs.length) {
                    await this.delay(100);
                }
                
            } catch (error) {
                logger.error('Batch price request failed', {
                    batchIndex: i,
                    error: error.message
                });
            }
        }
        
        return results;
    }
    
    /**
     * Get arbitrage opportunities between two DEXs
     * @param {string} tokenA - Token A address
     * @param {string} tokenB - Token B address
     * @param {string} dex1 - First DEX name
     * @param {string} dex2 - Second DEX name
     * @param {string} blockNumber - Block number (optional)
     * @returns {Promise<Object|null>} Arbitrage opportunity or null
     */
    async getArbitrageOpportunity(tokenA, tokenB, dex1, dex2, blockNumber = 'latest') {
        try {
            const [price1, price2] = await Promise.all([
                this.getPrice(tokenA, tokenB, dex1, blockNumber),
                this.getPrice(tokenA, tokenB, dex2, blockNumber)
            ]);
            
            // Calculate price difference
            const price1Value = parseFloat(price1.price0);
            const price2Value = parseFloat(price2.price0);
            const priceDiff = Math.abs(price1Value - price2Value);
            const minPrice = Math.min(price1Value, price2Value);
            const priceDiffPercent = minPrice > 0 ? (priceDiff / minPrice) * 100 : 0;
            
            // Determine buy/sell direction
            const buyDex = price1Value < price2Value ? dex1 : dex2;
            const sellDex = price1Value < price2Value ? dex2 : dex1;
            const buyPrice = Math.min(price1Value, price2Value);
            const sellPrice = Math.max(price1Value, price2Value);
            
            return {
                tokenA,
                tokenB,
                buyDex,
                sellDex,
                buyPrice: buyPrice.toString(),
                sellPrice: sellPrice.toString(),
                priceDifference: priceDiff.toString(),
                priceDifferencePercent: priceDiffPercent.toString(),
                blockNumber,
                timestamp: Date.now()
            };
            
        } catch (error) {
            logger.error('Failed to get arbitrage opportunity', {
                tokenA,
                tokenB,
                dex1,
                dex2,
                error: error.message
            });
            return null;
        }
    }
    
    /**
     * Get all supported DEXs
     * @returns {Array} Array of supported DEX names
     */
    getSupportedDEXs() {
        return this.options.supportedDEXs;
    }
    
    /**
     * Get DEX configuration
     * @param {string} dexName - DEX name
     * @returns {Object|null} DEX configuration
     */
    getDEXConfig(dexName) {
        return this.dexConfigs[dexName] || null;
    }
    
    /**
     * Get statistics
     * @returns {Object} Statistics object
     */
    getStats() {
        return {
            ...this.stats,
            cacheHitRate: this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses),
            successRate: this.stats.successfulRequests / this.stats.totalRequests,
            priceCacheSize: this.priceCaches.size,
            pairCacheSize: this.pairCaches.size
        };
    }
    
    /**
     * Clear expired cache entries
     */
    clearExpiredCache() {
        const currentTime = Date.now();
        let clearedCount = 0;
        
        // Clear price cache
        for (const [key, value] of this.priceCaches) {
            if (currentTime > value.expiresAt) {
                this.priceCaches.delete(key);
                clearedCount++;
            }
        }
        
        // Clear pair cache
        for (const [key, value] of this.pairCaches) {
            if (currentTime > value.expiresAt) {
                this.pairCaches.delete(key);
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

module.exports = DEXPriceService;
