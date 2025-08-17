const logger = require('../../utils/logger');
const { Decimal } = require('decimal.js');

/**
 * Risk Manager
 * 
 * Responsible for:
 * - Position sizing and risk assessment
 * - Safety checks and validation
 * - Exposure limits and portfolio management
 * - Slippage protection and price impact analysis
 * - Risk metrics and monitoring
 */
class RiskManager {
    constructor(options = {}) {
        // Configuration
        this.options = {
            maxPositionSizeUSD: options.maxPositionSizeUSD || 10000, // Maximum position size
            maxPortfolioExposure: options.maxPortfolioExposure || 0.1, // 10% max exposure
            maxSlippage: options.maxSlippage || 0.01, // 1% maximum slippage
            maxPriceImpact: options.maxPriceImpact || 0.005, // 0.5% maximum price impact
            minLiquidityRatio: options.minLiquidityRatio || 0.1, // 10% of position size
            maxConcurrentPositions: options.maxConcurrentPositions || 5,
            maxDailyLoss: options.maxDailyLoss || 1000, // $1000 max daily loss
            maxDrawdown: options.maxDrawdown || 0.2, // 20% maximum drawdown
            ...options
        };
        
        // State management
        this.activePositions = new Map();
        this.positionHistory = [];
        this.dailyStats = {
            totalProfit: new Decimal(0),
            totalLoss: new Decimal(0),
            netProfit: new Decimal(0),
            tradesCount: 0,
            startTime: Date.now()
        };
        
        // Risk metrics
        this.riskMetrics = {
            currentExposure: new Decimal(0),
            maxExposure: new Decimal(this.options.maxPositionSizeUSD).times(this.options.maxPortfolioExposure),
            currentDrawdown: new Decimal(0),
            peakValue: new Decimal(0),
            sharpeRatio: new Decimal(0),
            maxDrawdown: new Decimal(0),
            volatility: new Decimal(0)
        };
        
        // Performance tracking
        this.performanceHistory = [];
        
        logger.info('RiskManager initialized', {
            options: this.options,
            service: 'defi-arbitrage-bot'
        });
    }
    
    /**
     * Assess risk for an arbitrage opportunity
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {Object} portfolioState - Current portfolio state
     * @returns {Promise<Object>} Risk assessment result
     */
    async assessRisk(opportunity, portfolioState = {}) {
        const startTime = Date.now();
        
        try {
            const assessment = {
                approved: false,
                riskScore: 0,
                maxPositionSize: new Decimal(0),
                warnings: [],
                recommendations: []
            };
            
            // Check basic risk criteria
            const basicChecks = this.performBasicRiskChecks(opportunity);
            if (!basicChecks.approved) {
                assessment.warnings.push(...basicChecks.warnings);
                return assessment;
            }
            
            // Calculate optimal position size
            const positionSizing = this.calculatePositionSize(opportunity, portfolioState);
            assessment.maxPositionSize = positionSizing.size;
            
            // Check liquidity requirements
            const liquidityCheck = this.checkLiquidityRequirements(opportunity, positionSizing.size);
            if (!liquidityCheck.approved) {
                assessment.warnings.push(...liquidityCheck.warnings);
                return assessment;
            }
            
            // Check price impact
            const priceImpactCheck = this.checkPriceImpact(opportunity, positionSizing.size);
            if (!priceImpactCheck.approved) {
                assessment.warnings.push(...priceImpactCheck.warnings);
                return assessment;
            }
            
            // Check portfolio exposure
            const exposureCheck = this.checkPortfolioExposure(opportunity, positionSizing.size, portfolioState);
            if (!exposureCheck.approved) {
                assessment.warnings.push(...exposureCheck.warnings);
                return assessment;
            }
            
            // Check daily loss limits
            const dailyLossCheck = this.checkDailyLossLimits(opportunity, positionSizing.size);
            if (!dailyLossCheck.approved) {
                assessment.warnings.push(...dailyLossCheck.warnings);
                return assessment;
            }
            
            // Calculate risk score
            assessment.riskScore = this.calculateRiskScore(opportunity, positionSizing.size);
            
            // Final approval
            assessment.approved = assessment.riskScore <= 0.7; // 70% risk threshold
            
            if (assessment.approved) {
                assessment.recommendations.push('Opportunity approved for execution');
            } else {
                assessment.recommendations.push('Risk score too high, consider reducing position size');
            }
            
            logger.info('Risk assessment completed', {
                opportunityId: opportunity.id,
                approved: assessment.approved,
                riskScore: assessment.riskScore,
                maxPositionSize: assessment.maxPositionSize.toString(),
                warnings: assessment.warnings.length,
                assessmentTime: Date.now() - startTime,
                service: 'defi-arbitrage-bot'
            });
            
            return assessment;
            
        } catch (error) {
            logger.error('Error assessing risk', {
                opportunityId: opportunity.id,
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            
            return {
                approved: false,
                riskScore: 1.0,
                maxPositionSize: new Decimal(0),
                warnings: ['Risk assessment failed: ' + error.message],
                recommendations: ['Do not execute this opportunity']
            };
        }
    }
    
    /**
     * Perform basic risk checks
     * @param {Object} opportunity - Arbitrage opportunity
     * @returns {Object} Basic checks result
     */
    performBasicRiskChecks(opportunity) {
        const result = {
            approved: true,
            warnings: []
        };
        
        try {
            // Check minimum profit
            const netProfit = new Decimal(opportunity.netProfitUSD);
            if (netProfit.lessThan(this.options.maxDailyLoss * 0.1)) { // 10% of daily loss limit
                result.approved = false;
                result.warnings.push('Profit too small relative to risk');
            }
            
            // Check profit margin
            const profitMargin = new Decimal(opportunity.profitMargin);
            if (profitMargin.lessThan(0.01)) { // 1% minimum margin
                result.approved = false;
                result.warnings.push('Profit margin too low');
            }
            
            // Check if opportunity has expired
            if (Date.now() > opportunity.expiresAt) {
                result.approved = false;
                result.warnings.push('Opportunity has expired');
            }
            
            // Check concurrent positions limit
            if (this.activePositions.size >= this.options.maxConcurrentPositions) {
                result.approved = false;
                result.warnings.push('Maximum concurrent positions reached');
            }
            
        } catch (error) {
            result.approved = false;
            result.warnings.push('Error in basic risk checks: ' + error.message);
        }
        
        return result;
    }
    
    /**
     * Calculate optimal position size
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {Object} portfolioState - Portfolio state
     * @returns {Object} Position sizing result
     */
    calculatePositionSize(opportunity, portfolioState) {
        try {
            const netProfit = new Decimal(opportunity.netProfitUSD);
            const profitMargin = new Decimal(opportunity.profitMargin);
            
            // Kelly Criterion for position sizing
            const kellyFraction = profitMargin.minus(1).dividedBy(profitMargin);
            
            // Apply Kelly Criterion with conservative adjustment
            const conservativeKelly = kellyFraction.times(0.25); // 25% of Kelly
            
            // Calculate position size based on available capital
            const availableCapital = new Decimal(portfolioState.availableCapital || this.options.maxPositionSizeUSD);
            const kellyPositionSize = availableCapital.times(conservativeKelly);
            
            // Apply maximum position size limit
            const maxPositionSize = new Decimal(this.options.maxPositionSizeUSD);
            const positionSize = Decimal.min(kellyPositionSize, maxPositionSize);
            
            // Ensure minimum position size
            const minPositionSize = new Decimal(100); // $100 minimum
            const finalPositionSize = Decimal.max(positionSize, minPositionSize);
            
            return {
                size: finalPositionSize,
                kellyFraction: kellyFraction.toString(),
                conservativeKelly: conservativeKelly.toString(),
                availableCapital: availableCapital.toString()
            };
            
        } catch (error) {
            logger.error('Error calculating position size', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            
            return {
                size: new Decimal(0),
                kellyFraction: '0',
                conservativeKelly: '0',
                availableCapital: '0'
            };
        }
    }
    
    /**
     * Check liquidity requirements
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {Decimal} positionSize - Position size
     * @returns {Object} Liquidity check result
     */
    checkLiquidityRequirements(opportunity, positionSize) {
        const result = {
            approved: true,
            warnings: []
        };
        
        try {
            const buyLiquidity = new Decimal(opportunity.buyLiquidityUSD);
            const sellLiquidity = new Decimal(opportunity.sellLiquidityUSD);
            
            // Check if position size is within liquidity limits
            const minLiquidity = positionSize.dividedBy(this.options.minLiquidityRatio);
            
            if (buyLiquidity.lessThan(minLiquidity)) {
                result.approved = false;
                result.warnings.push(`Buy liquidity insufficient: ${buyLiquidity.toString()} < ${minLiquidity.toString()}`);
            }
            
            if (sellLiquidity.lessThan(minLiquidity)) {
                result.approved = false;
                result.warnings.push(`Sell liquidity insufficient: ${sellLiquidity.toString()} < ${minLiquidity.toString()}`);
            }
            
        } catch (error) {
            result.approved = false;
            result.warnings.push('Error checking liquidity: ' + error.message);
        }
        
        return result;
    }
    
    /**
     * Check price impact
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {Decimal} positionSize - Position size
     * @returns {Object} Price impact check result
     */
    checkPriceImpact(opportunity, positionSize) {
        const result = {
            approved: true,
            warnings: []
        };
        
        try {
            // Calculate estimated price impact
            const buyLiquidity = new Decimal(opportunity.buyLiquidityUSD);
            const sellLiquidity = new Decimal(opportunity.sellLiquidityUSD);
            
            // Simple price impact calculation
            const buyImpact = positionSize.dividedBy(buyLiquidity);
            const sellImpact = positionSize.dividedBy(sellLiquidity);
            
            const maxImpact = new Decimal(this.options.maxPriceImpact);
            
            if (buyImpact.greaterThan(maxImpact)) {
                result.approved = false;
                result.warnings.push(`Buy price impact too high: ${buyImpact.times(100).toString()}% > ${maxImpact.times(100).toString()}%`);
            }
            
            if (sellImpact.greaterThan(maxImpact)) {
                result.approved = false;
                result.warnings.push(`Sell price impact too high: ${sellImpact.times(100).toString()}% > ${maxImpact.times(100).toString()}%`);
            }
            
        } catch (error) {
            result.approved = false;
            result.warnings.push('Error checking price impact: ' + error.message);
        }
        
        return result;
    }
    
    /**
     * Check portfolio exposure
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {Decimal} positionSize - Position size
     * @param {Object} portfolioState - Portfolio state
     * @returns {Object} Exposure check result
     */
    checkPortfolioExposure(opportunity, positionSize, portfolioState) {
        const result = {
            approved: true,
            warnings: []
        };
        
        try {
            const totalPortfolioValue = new Decimal(portfolioState.totalValue || this.options.maxPositionSizeUSD);
            const currentExposure = this.riskMetrics.currentExposure;
            const newExposure = currentExposure.plus(positionSize);
            
            // Check if new exposure exceeds limits
            const maxExposure = totalPortfolioValue.times(this.options.maxPortfolioExposure);
            
            if (newExposure.greaterThan(maxExposure)) {
                result.approved = false;
                result.warnings.push(`Portfolio exposure too high: ${newExposure.toString()} > ${maxExposure.toString()}`);
            }
            
            // Check if position size exceeds maximum
            const maxPositionSize = new Decimal(this.options.maxPositionSizeUSD);
            if (positionSize.greaterThan(maxPositionSize)) {
                result.approved = false;
                result.warnings.push(`Position size too large: ${positionSize.toString()} > ${maxPositionSize.toString()}`);
            }
            
        } catch (error) {
            result.approved = false;
            result.warnings.push('Error checking portfolio exposure: ' + error.message);
        }
        
        return result;
    }
    
    /**
     * Check daily loss limits
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {Decimal} positionSize - Position size
     * @returns {Object} Daily loss check result
     */
    checkDailyLossLimits(opportunity, positionSize) {
        const result = {
            approved: true,
            warnings: []
        };
        
        try {
            // Check if we've exceeded daily loss limit
            const dailyLoss = this.dailyStats.totalLoss;
            const maxDailyLoss = new Decimal(this.options.maxDailyLoss);
            
            if (dailyLoss.greaterThanOrEqualTo(maxDailyLoss)) {
                result.approved = false;
                result.warnings.push('Daily loss limit exceeded');
            }
            
            // Check if potential loss would exceed remaining daily limit
            const remainingDailyLoss = maxDailyLoss.minus(dailyLoss);
            const potentialLoss = positionSize.times(0.1); // Assume 10% potential loss
            
            if (potentialLoss.greaterThan(remainingDailyLoss)) {
                result.approved = false;
                result.warnings.push('Position size could exceed remaining daily loss limit');
            }
            
        } catch (error) {
            result.approved = false;
            result.warnings.push('Error checking daily loss limits: ' + error.message);
        }
        
        return result;
    }
    
    /**
     * Calculate risk score for opportunity
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {Decimal} positionSize - Position size
     * @returns {number} Risk score (0-1, lower is better)
     */
    calculateRiskScore(opportunity, positionSize) {
        try {
            let riskScore = 0;
            
            // Profit margin risk (lower margin = higher risk)
            const profitMargin = new Decimal(opportunity.profitMargin);
            const marginRisk = Math.max(0, 1 - profitMargin.times(100).toNumber());
            riskScore += marginRisk * 0.3; // 30% weight
            
            // Liquidity risk
            const buyLiquidity = new Decimal(opportunity.buyLiquidityUSD);
            const sellLiquidity = new Decimal(opportunity.sellLiquidityUSD);
            const liquidityRisk = Math.min(
                positionSize.dividedBy(buyLiquidity).toNumber(),
                positionSize.dividedBy(sellLiquidity).toNumber()
            );
            riskScore += Math.min(liquidityRisk * 10, 1) * 0.25; // 25% weight
            
            // Portfolio exposure risk
            const currentExposure = this.riskMetrics.currentExposure;
            const newExposure = currentExposure.plus(positionSize);
            const maxExposure = new Decimal(this.options.maxPositionSizeUSD).times(this.options.maxPortfolioExposure);
            const exposureRisk = newExposure.dividedBy(maxExposure).toNumber();
            riskScore += Math.min(exposureRisk, 1) * 0.2; // 20% weight
            
            // Market volatility risk (simplified)
            const volatilityRisk = 0.1; // Placeholder - would use actual volatility data
            riskScore += volatilityRisk * 0.15; // 15% weight
            
            // Gas price risk
            const gasCost = new Decimal(opportunity.gasCostUSD);
            const netProfit = new Decimal(opportunity.netProfitUSD);
            const gasRisk = gasCost.dividedBy(netProfit.plus(gasCost)).toNumber();
            riskScore += Math.min(gasRisk, 1) * 0.1; // 10% weight
            
            return Math.min(riskScore, 1);
            
        } catch (error) {
            logger.error('Error calculating risk score', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return 1.0; // Maximum risk if calculation fails
        }
    }
    
    /**
     * Record position opening
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {Decimal} positionSize - Actual position size
     * @param {string} transactionId - Transaction ID
     */
    recordPositionOpen(opportunity, positionSize, transactionId) {
        try {
            const position = {
                id: transactionId,
                opportunityId: opportunity.id,
                pair: opportunity.pair,
                buyDex: opportunity.buyDex,
                sellDex: opportunity.sellDex,
                positionSize: positionSize.toString(),
                expectedProfit: opportunity.netProfitUSD,
                openTime: Date.now(),
                status: 'open'
            };
            
            this.activePositions.set(transactionId, position);
            this.riskMetrics.currentExposure = this.riskMetrics.currentExposure.plus(positionSize);
            
            logger.info('Position opened', {
                transactionId,
                positionSize: positionSize.toString(),
                currentExposure: this.riskMetrics.currentExposure.toString(),
                service: 'defi-arbitrage-bot'
            });
            
        } catch (error) {
            logger.error('Error recording position open', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
        }
    }
    
    /**
     * Record position closing
     * @param {string} transactionId - Transaction ID
     * @param {Object} result - Transaction result
     */
    recordPositionClose(transactionId, result) {
        try {
            const position = this.activePositions.get(transactionId);
            if (!position) {
                logger.warn('Position not found for closing', {
                    transactionId,
                    service: 'defi-arbitrage-bot'
                });
                return;
            }
            
            // Update position
            position.closeTime = Date.now();
            position.status = 'closed';
            position.actualProfit = result.actualProfit || position.expectedProfit;
            position.gasCost = result.gasCost;
            
            // Calculate profit/loss
            const actualProfit = new Decimal(position.actualProfit || '0');
            const gasCost = new Decimal(position.gasCost || '0');
            const netProfit = actualProfit.minus(gasCost);
            
            // Update daily stats
            this.dailyStats.tradesCount++;
            if (netProfit.greaterThan(0)) {
                this.dailyStats.totalProfit = this.dailyStats.totalProfit.plus(netProfit);
            } else {
                this.dailyStats.totalLoss = this.dailyStats.totalLoss.plus(netProfit.abs());
            }
            this.dailyStats.netProfit = this.dailyStats.netProfit.plus(netProfit);
            
            // Update risk metrics
            const positionSize = new Decimal(position.positionSize);
            this.riskMetrics.currentExposure = this.riskMetrics.currentExposure.minus(positionSize);
            
            // Update peak value and drawdown
            if (this.dailyStats.netProfit.greaterThan(this.riskMetrics.peakValue)) {
                this.riskMetrics.peakValue = this.dailyStats.netProfit;
            }
            
            const currentDrawdown = this.riskMetrics.peakValue.minus(this.dailyStats.netProfit);
            if (currentDrawdown.greaterThan(this.riskMetrics.maxDrawdown)) {
                this.riskMetrics.maxDrawdown = currentDrawdown;
            }
            
            // Move to history
            this.positionHistory.push(position);
            this.activePositions.delete(transactionId);
            
            logger.info('Position closed', {
                transactionId,
                netProfit: netProfit.toString(),
                currentExposure: this.riskMetrics.currentExposure.toString(),
                service: 'defi-arbitrage-bot'
            });
            
        } catch (error) {
            logger.error('Error recording position close', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
        }
    }
    
    /**
     * Get current risk metrics
     * @returns {Object} Risk metrics
     */
    getRiskMetrics() {
        return {
            ...this.riskMetrics,
            activePositions: this.activePositions.size,
            dailyStats: this.dailyStats,
            positionHistory: this.positionHistory.length
        };
    }
    
    /**
     * Get daily statistics
     * @returns {Object} Daily statistics
     */
    getDailyStats() {
        return this.dailyStats;
    }
    
    /**
     * Reset daily statistics
     */
    resetDailyStats() {
        this.dailyStats = {
            totalProfit: new Decimal(0),
            totalLoss: new Decimal(0),
            netProfit: new Decimal(0),
            tradesCount: 0,
            startTime: Date.now()
        };
        
        logger.info('Daily statistics reset', {
            service: 'defi-arbitrage-bot'
        });
    }
    
    /**
     * Check if trading should be paused
     * @returns {Object} Pause status
     */
    checkTradingPause() {
        const pauseStatus = {
            paused: false,
            reason: null
        };
        
        try {
            // Check daily loss limit
            if (this.dailyStats.totalLoss.greaterThanOrEqualTo(this.options.maxDailyLoss)) {
                pauseStatus.paused = true;
                pauseStatus.reason = 'Daily loss limit exceeded';
            }
            
            // Check drawdown limit
            if (this.riskMetrics.maxDrawdown.dividedBy(this.riskMetrics.peakValue).greaterThan(this.options.maxDrawdown)) {
                pauseStatus.paused = true;
                pauseStatus.reason = 'Maximum drawdown exceeded';
            }
            
            // Check exposure limit
            if (this.riskMetrics.currentExposure.greaterThan(this.riskMetrics.maxExposure)) {
                pauseStatus.paused = true;
                pauseStatus.reason = 'Portfolio exposure limit exceeded';
            }
            
        } catch (error) {
            logger.error('Error checking trading pause', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
        }
        
        return pauseStatus;
    }
    
    /**
     * Get position information
     * @param {string} transactionId - Transaction ID
     * @returns {Object|null} Position information
     */
    getPosition(transactionId) {
        return this.activePositions.get(transactionId) || null;
    }
    
    /**
     * Get all active positions
     * @returns {Array} Array of active positions
     */
    getActivePositions() {
        return Array.from(this.activePositions.values());
    }
}

module.exports = RiskManager;
