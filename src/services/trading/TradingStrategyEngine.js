const logger = require('../../utils/logger');
const { Decimal } = require('decimal.js');
const UniswapV2Math = require('../amm/UniswapV2Math');

/**
 * Trading Strategy Engine
 * 
 * Core component responsible for:
 * - Arbitrage opportunity detection
 * - Opportunity qualification and filtering
 * - Risk assessment and position sizing
 * - Profit calculation with gas costs
 * - Multi-hop arbitrage detection
 */
class TradingStrategyEngine {
    constructor(web3Manager, dexPriceService, options = {}) {
        this.web3Manager = web3Manager;
        this.dexPriceService = dexPriceService;
        
        // Configuration
        this.options = {
            minProfitUSD: options.minProfitUSD || 10, // Minimum profit in USD
            minProfitMargin: options.minProfitMargin || 0.005, // 0.5% minimum margin
            maxSlippage: options.maxSlippage || 0.01, // 1% maximum slippage
            maxPositionSizeUSD: options.maxPositionSizeUSD || 10000, // Maximum position size
            gasBuffer: options.gasBuffer || 1.2, // 20% gas buffer
            maxGasPriceGwei: options.maxGasPriceGwei || 100, // Maximum gas price
            opportunityTimeout: options.opportunityTimeout || 30000, // 30 seconds
            minLiquidityUSD: options.minLiquidityUSD || 100000, // Minimum liquidity
            ...options
        };
        
        // State management
        this.activeOpportunities = new Map();
        this.opportunityHistory = [];
        this.stats = {
            opportunitiesDetected: 0,
            opportunitiesQualified: 0,
            opportunitiesExecuted: 0,
            totalProfitUSD: new Decimal(0),
            totalGasCostUSD: new Decimal(0),
            averageProfitUSD: new Decimal(0),
            successRate: 0
        };
        
        // Performance tracking
        this.performanceMetrics = {
            detectionLatency: [],
            qualificationLatency: [],
            executionLatency: [],
            falsePositives: 0,
            missedOpportunities: 0
        };
        
        logger.info('TradingStrategyEngine initialized', {
            options: this.options,
            service: 'defi-arbitrage-bot'
        });
    }
    
    /**
     * Detect arbitrage opportunities between DEXs
     * @param {Array} tokenPairs - Array of {tokenA, tokenB} objects
     * @param {Array} dexList - Array of DEX names to check
     * @param {string} blockNumber - Block number for consistency
     * @returns {Promise<Array>} Array of qualified opportunities
     */
    async detectOpportunities(tokenPairs, dexList = ['uniswap', 'sushiswap'], blockNumber = 'latest') {
        const startTime = Date.now();
        const opportunities = [];
        
        try {
            // Get current gas price for cost calculation
            const gasPrice = await this.web3Manager.executeWithFailover(async (web3) => {
                return await web3.eth.getGasPrice();
            });
            const gasPriceGwei = this.web3Manager.getCurrentWeb3().utils.fromWei(gasPrice, 'gwei');
            
            // Check if gas price is acceptable
            if (parseFloat(gasPriceGwei) > this.options.maxGasPriceGwei) {
                logger.warn('Gas price too high, skipping opportunity detection', {
                    gasPriceGwei: parseFloat(gasPriceGwei),
                    maxGasPriceGwei: this.options.maxGasPriceGwei,
                    service: 'defi-arbitrage-bot'
                });
                return [];
            }
            
            // Process each token pair
            for (const pair of tokenPairs) {
                const pairOpportunities = await this.analyzeTokenPair(pair, dexList, blockNumber, gasPrice);
                opportunities.push(...pairOpportunities);
            }
            
            // Sort opportunities by profit margin (descending)
            opportunities.sort((a, b) => b.profitMargin - a.profitMargin);
            
            // Update statistics
            this.stats.opportunitiesDetected += opportunities.length;
            this.performanceMetrics.detectionLatency.push(Date.now() - startTime);
            
            logger.info('Opportunity detection completed', {
                opportunitiesFound: opportunities.length,
                tokenPairs: tokenPairs.length,
                dexList,
                blockNumber,
                detectionTime: Date.now() - startTime,
                service: 'defi-arbitrage-bot'
            });
            
            return opportunities;
            
        } catch (error) {
            logger.error('Error detecting opportunities', {
                error: error.message,
                tokenPairs: tokenPairs.length,
                service: 'defi-arbitrage-bot'
            });
            return [];
        }
    }
    
    /**
     * Analyze a single token pair for arbitrage opportunities
     * @param {Object} pair - {tokenA, tokenB} object
     * @param {Array} dexList - Array of DEX names
     * @param {string} blockNumber - Block number
     * @param {string} gasPrice - Current gas price
     * @returns {Promise<Array>} Array of opportunities for this pair
     */
    async analyzeTokenPair(pair, dexList, blockNumber, gasPrice) {
        const opportunities = [];
        
        try {
            // Get prices from all DEXs
            const pricePromises = dexList.map(dex => 
                this.dexPriceService.getPrice(pair.tokenA, pair.tokenB, dex, blockNumber)
                    .catch(error => {
                        logger.warn('Failed to get price', {
                            dex,
                            tokenA: pair.tokenA,
                            tokenB: pair.tokenB,
                            error: error.message,
                            service: 'defi-arbitrage-bot'
                        });
                        return null;
                    })
            );
            
            const prices = await Promise.all(pricePromises);
            const validPrices = prices.filter(price => price !== null);
            
            if (validPrices.length < 2) {
                return opportunities; // Need at least 2 DEXs for arbitrage
            }
            
            // Find best buy and sell opportunities
            const buyOpportunities = [];
            const sellOpportunities = [];
            
            for (const price of validPrices) {
                const priceData = {
                    dex: price.dexName,
                    price0: new Decimal(price.price0),
                    price1: new Decimal(price.price1),
                    liquidityUSD: this.calculateLiquidityUSD(price),
                    reserves: [price.reserve0, price.reserve1],
                    pairAddress: price.pairAddress
                };
                
                buyOpportunities.push(priceData);
                sellOpportunities.push(priceData);
            }
            
            // Sort by price (buy = lowest, sell = highest)
            buyOpportunities.sort((a, b) => a.price0.minus(b.price0).toNumber());
            sellOpportunities.sort((a, b) => b.price0.minus(a.price0).toNumber());
            
            // Check for arbitrage opportunities
            for (let i = 0; i < buyOpportunities.length; i++) {
                for (let j = 0; j < sellOpportunities.length; j++) {
                    const buyDex = buyOpportunities[i];
                    const sellDex = sellOpportunities[j];
                    
                    if (buyDex.dex === sellDex.dex) continue; // Same DEX
                    
                    const opportunity = await this.calculateArbitrageOpportunity(
                        pair, buyDex, sellDex, gasPrice, blockNumber
                    );
                    
                    if (opportunity && this.qualifyOpportunity(opportunity)) {
                        opportunities.push(opportunity);
                    }
                }
            }
            
        } catch (error) {
            logger.error('Error analyzing token pair', {
                pair,
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
        }
        
        return opportunities;
    }
    
    /**
     * Calculate arbitrage opportunity details
     * @param {Object} pair - Token pair
     * @param {Object} buyDex - Buy DEX data
     * @param {Object} sellDex - Sell DEX data
     * @param {string} gasPrice - Gas price
     * @param {string} blockNumber - Block number
     * @returns {Promise<Object|null>} Opportunity object or null
     */
    async calculateArbitrageOpportunity(pair, buyDex, sellDex, gasPrice, blockNumber) {
        try {
            const buyPrice = buyDex.price0;
            const sellPrice = sellDex.price0;
            
            // Calculate price difference
            const priceDiff = sellPrice.minus(buyPrice);
            const priceDiffPercent = priceDiff.dividedBy(buyPrice).times(100);
            
            // Skip if price difference is too small
            if (priceDiffPercent.lessThan(this.options.minProfitMargin * 100)) {
                return null;
            }
            
            // Calculate optimal trade size
            const optimalAmount = this.calculateOptimalTradeSize(buyDex, sellDex);
            
            if (optimalAmount.lessThanOrEqualTo(0)) {
                return null;
            }
            
            // Calculate gross profit
            const grossProfit = this.calculateGrossProfit(optimalAmount, buyPrice, sellPrice);
            
            // Calculate gas costs
            const gasCost = await this.calculateGasCost(gasPrice);
            
            // Calculate net profit
            const netProfit = grossProfit.minus(gasCost);
            
            // Calculate profit margin
            const profitMargin = netProfit.dividedBy(gasCost);
            
            // Create opportunity object
            const opportunity = {
                id: this.generateOpportunityId(pair, buyDex.dex, sellDex.dex, blockNumber),
                pair,
                buyDex: buyDex.dex,
                sellDex: sellDex.dex,
                buyPrice: buyPrice.toString(),
                sellPrice: sellPrice.toString(),
                priceDifference: priceDiff.toString(),
                priceDifferencePercent: priceDiffPercent.toString(),
                optimalAmount: optimalAmount.toString(),
                grossProfitUSD: grossProfit.toString(),
                gasCostUSD: gasCost.toString(),
                netProfitUSD: netProfit.toString(),
                profitMargin: profitMargin.toString(),
                buyLiquidityUSD: buyDex.liquidityUSD.toString(),
                sellLiquidityUSD: sellDex.liquidityUSD.toString(),
                buyPairAddress: buyDex.pairAddress,
                sellPairAddress: sellDex.pairAddress,
                blockNumber,
                timestamp: Date.now(),
                expiresAt: Date.now() + this.options.opportunityTimeout,
                qualified: false,
                executed: false
            };
            
            return opportunity;
            
        } catch (error) {
            logger.error('Error calculating arbitrage opportunity', {
                pair,
                buyDex: buyDex.dex,
                sellDex: sellDex.dex,
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return null;
        }
    }
    
    /**
     * Calculate optimal trade size using UniswapV2Math
     * @param {Object} buyDex - Buy DEX data
     * @param {Object} sellDex - Sell DEX data
     * @returns {Decimal} Optimal trade amount
     */
    calculateOptimalTradeSize(buyDex, sellDex) {
        try {
            // Validate that reserves exist
            if (!buyDex.reserves || !sellDex.reserves || 
                !Array.isArray(buyDex.reserves) || !Array.isArray(sellDex.reserves) ||
                buyDex.reserves.length < 2 || sellDex.reserves.length < 2) {
                logger.warn('Invalid reserves data for optimal trade size calculation', {
                    buyDex: buyDex.dex,
                    sellDex: sellDex.dex,
                    buyReserves: buyDex.reserves,
                    sellReserves: sellDex.reserves,
                    service: 'defi-arbitrage-bot'
                });
                return new Decimal(0);
            }
            
            const buyReserves = buyDex.reserves.map(r => new Decimal(r));
            const sellReserves = sellDex.reserves.map(r => new Decimal(r));
            
            // Validate that reserves are positive
            if (buyReserves[0].lte(0) || buyReserves[1].lte(0) || 
                sellReserves[0].lte(0) || sellReserves[1].lte(0)) {
                logger.warn('Zero or negative reserves for optimal trade size calculation', {
                    buyDex: buyDex.dex,
                    sellDex: sellDex.dex,
                    buyReserves: buyReserves.map(r => r.toString()),
                    sellReserves: sellReserves.map(r => r.toString()),
                    service: 'defi-arbitrage-bot'
                });
                return new Decimal(0);
            }
            
            // Use UniswapV2Math to find optimal trade size
            const poolA = {
                reserveIn: buyReserves[0].toString(),
                reserveOut: buyReserves[1].toString()
            };
            
            const poolB = {
                reserveIn: sellReserves[1].toString(),
                reserveOut: sellReserves[0].toString()
            };
            
            const gasCost = new Decimal(60); // Estimated gas cost in USD
            
            const result = UniswapV2Math.findOptimalTradeSize(
                poolA, poolB,
                this.options.maxPositionSizeUSD,
                gasCost.toString()
            );
            
            const optimalAmount = new Decimal(result.optimalAmount);
            
            // Validate the result
            if (optimalAmount.lte(0) || optimalAmount.isNaN()) {
                logger.warn('Invalid optimal trade size calculated', {
                    optimalAmount: optimalAmount.toString(),
                    buyDex: buyDex.dex,
                    sellDex: sellDex.dex,
                    service: 'defi-arbitrage-bot'
                });
                return new Decimal(0);
            }
            
            return optimalAmount;
            
        } catch (error) {
            logger.error('Error calculating optimal trade size', {
                buyDex: buyDex.dex,
                sellDex: sellDex.dex,
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            
            // Fallback: use a simple fixed amount
            try {
                return new Decimal(this.options.maxPositionSizeUSD).times(0.1); // 10% of max position size
            } catch (fallbackError) {
                logger.error('Fallback optimal trade size calculation also failed', {
                    error: fallbackError.message,
                    service: 'defi-arbitrage-bot'
                });
                return new Decimal(0);
            }
        }
    }
    
    /**
     * Calculate gross profit from arbitrage
     * @param {Decimal} amount - Trade amount
     * @param {Decimal} buyPrice - Buy price
     * @param {Decimal} sellPrice - Sell price
     * @returns {Decimal} Gross profit in USD
     */
    calculateGrossProfit(amount, buyPrice, sellPrice) {
        try {
            // Calculate tokens received from buy
            const tokensReceived = amount.dividedBy(buyPrice);
            
            // Calculate USD received from sell
            const usdReceived = tokensReceived.times(sellPrice);
            
            // Calculate gross profit
            const grossProfit = usdReceived.minus(amount);
            
            return grossProfit;
            
        } catch (error) {
            logger.error('Error calculating gross profit', {
                amount: amount.toString(),
                buyPrice: buyPrice.toString(),
                sellPrice: sellPrice.toString(),
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return new Decimal(0);
        }
    }
    
    /**
     * Calculate gas cost for the arbitrage transaction
     * @param {string} gasPrice - Gas price in wei
     * @returns {Promise<Decimal>} Gas cost in USD
     */
    async calculateGasCost(gasPrice) {
        try {
            // Estimate gas usage for arbitrage transaction
            const estimatedGas = 300000; // Conservative estimate for complex arbitrage
            
            // Apply gas buffer
            const gasWithBuffer = new Decimal(estimatedGas).times(this.options.gasBuffer);
            
            // Calculate gas cost in wei
            const gasCostWei = gasWithBuffer.times(gasPrice);
            
            // Convert to USD (simplified - in production, use price oracle)
            const ethPriceUSD = new Decimal(2000); // Placeholder - should use price oracle
            const gasCostUSD = gasCostWei.dividedBy(new Decimal(10).pow(18)).times(ethPriceUSD);
            
            return gasCostUSD;
            
        } catch (error) {
            logger.error('Error calculating gas cost', {
                gasPrice,
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return new Decimal(0);
        }
    }
    
    /**
     * Calculate liquidity in USD
     * @param {Object} priceData - Price data from DEX
     * @returns {Decimal} Liquidity in USD
     */
    calculateLiquidityUSD(priceData) {
        try {
            const reserve0 = new Decimal(priceData.reserve0);
            const reserve1 = new Decimal(priceData.reserve1);
            const price0 = new Decimal(priceData.price0);
            
            // Calculate liquidity in USD (simplified)
            const liquidityUSD = reserve0.times(price0).plus(reserve1);
            
            return liquidityUSD;
            
        } catch (error) {
            logger.error('Error calculating liquidity USD', {
                priceData,
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return new Decimal(0);
        }
    }
    
    /**
     * Qualify an opportunity based on criteria
     * @param {Object} opportunity - Opportunity object
     * @returns {boolean} Whether opportunity is qualified
     */
    qualifyOpportunity(opportunity) {
        try {
            const netProfit = new Decimal(opportunity.netProfitUSD);
            const profitMargin = new Decimal(opportunity.profitMargin);
            const buyLiquidity = new Decimal(opportunity.buyLiquidityUSD);
            const sellLiquidity = new Decimal(opportunity.sellLiquidityUSD);
            
            // Check minimum profit
            if (netProfit.lessThan(this.options.minProfitUSD)) {
                return false;
            }
            
            // Check minimum profit margin
            if (profitMargin.lessThan(this.options.minProfitMargin)) {
                return false;
            }
            
            // Check minimum liquidity
            if (buyLiquidity.lessThan(this.options.minLiquidityUSD) || 
                sellLiquidity.lessThan(this.options.minLiquidityUSD)) {
                return false;
            }
            
            // Check if opportunity has expired
            if (Date.now() > opportunity.expiresAt) {
                return false;
            }
            
            // Mark as qualified
            opportunity.qualified = true;
            
            // Update statistics
            this.stats.opportunitiesQualified++;
            
            logger.info('Opportunity qualified', {
                opportunityId: opportunity.id,
                netProfitUSD: opportunity.netProfitUSD,
                profitMargin: opportunity.profitMargin,
                buyDex: opportunity.buyDex,
                sellDex: opportunity.sellDex,
                service: 'defi-arbitrage-bot'
            });
            
            return true;
            
        } catch (error) {
            logger.error('Error qualifying opportunity', {
                opportunity,
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return false;
        }
    }
    
    /**
     * Generate unique opportunity ID
     * @param {Object} pair - Token pair
     * @param {string} buyDex - Buy DEX name
     * @param {string} sellDex - Sell DEX name
     * @param {string} blockNumber - Block number
     * @returns {string} Unique opportunity ID
     */
    generateOpportunityId(pair, buyDex, sellDex, blockNumber) {
        return `${pair.tokenA}-${pair.tokenB}-${buyDex}-${sellDex}-${blockNumber}-${Date.now()}`;
    }
    
    /**
     * Get current statistics
     * @returns {Object} Statistics object
     */
    getStats() {
        return {
            ...this.stats,
            successRate: this.stats.opportunitiesDetected > 0 ? 
                this.stats.opportunitiesQualified / this.stats.opportunitiesDetected : 0,
            averageDetectionLatency: this.performanceMetrics.detectionLatency.length > 0 ?
                this.performanceMetrics.detectionLatency.reduce((a, b) => a + b, 0) / this.performanceMetrics.detectionLatency.length : 0,
            activeOpportunities: this.activeOpportunities.size
        };
    }
    
    /**
     * Get performance metrics
     * @returns {Object} Performance metrics
     */
    getPerformanceMetrics() {
        return this.performanceMetrics;
    }
    
    /**
     * Update opportunity status
     * @param {string} opportunityId - Opportunity ID
     * @param {string} status - New status
     * @param {Object} additionalData - Additional data
     */
    updateOpportunityStatus(opportunityId, status, additionalData = {}) {
        const opportunity = this.activeOpportunities.get(opportunityId);
        
        if (opportunity) {
            opportunity.status = status;
            opportunity.updatedAt = Date.now();
            Object.assign(opportunity, additionalData);
            
            if (status === 'executed') {
                this.stats.opportunitiesExecuted++;
                this.stats.totalProfitUSD = this.stats.totalProfitUSD.plus(opportunity.netProfitUSD);
                this.stats.totalGasCostUSD = this.stats.totalGasCostUSD.plus(opportunity.gasCostUSD);
                this.stats.averageProfitUSD = this.stats.totalProfitUSD.dividedBy(this.stats.opportunitiesExecuted);
                
                // Move to history
                this.opportunityHistory.push(opportunity);
                this.activeOpportunities.delete(opportunityId);
            }
            
            logger.info('Opportunity status updated', {
                opportunityId,
                status,
                additionalData,
                service: 'defi-arbitrage-bot'
            });
        }
    }
    
    /**
     * Clear expired opportunities
     */
    clearExpiredOpportunities() {
        const now = Date.now();
        let clearedCount = 0;
        
        for (const [id, opportunity] of this.activeOpportunities) {
            if (now > opportunity.expiresAt) {
                this.activeOpportunities.delete(id);
                this.performanceMetrics.missedOpportunities++;
                clearedCount++;
            }
        }
        
        if (clearedCount > 0) {
            logger.info('Cleared expired opportunities', {
                clearedCount,
                remainingActive: this.activeOpportunities.size,
                service: 'defi-arbitrage-bot'
            });
        }
    }
}

module.exports = TradingStrategyEngine;
