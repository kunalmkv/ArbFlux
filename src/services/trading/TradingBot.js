const logger = require('../../utils/logger');
const TradingStrategyEngine = require('./TradingStrategyEngine');
const ExecutionEngine = require('./ExecutionEngine');
const RiskManager = require('./RiskManager');
const { Decimal } = require('decimal.js');

/**
 * Trading Bot
 * 
 * Main orchestrator that coordinates:
 * - Opportunity detection and qualification
 * - Risk assessment and position sizing
 * - Trade execution and monitoring
 * - Performance tracking and reporting
 */
class TradingBot {
    constructor(web3Manager, dexPriceService, options = {}) {
        this.web3Manager = web3Manager;
        this.dexPriceService = dexPriceService;
        
        // Configuration
        this.options = {
            enabled: options.enabled || false,
            autoExecute: options.autoExecute || false,
            maxOpportunitiesPerBlock: options.maxOpportunitiesPerBlock || 3,
            opportunityScanInterval: options.opportunityScanInterval || 1000, // 1 second
            tokenPairs: options.tokenPairs || [],
            supportedDEXs: options.supportedDEXs || ['uniswap', 'sushiswap'],
            walletConfig: options.walletConfig || {},
            portfolioState: options.portfolioState || {},
            ...options
        };
        
        // Initialize components
        this.strategyEngine = new TradingStrategyEngine(web3Manager, dexPriceService, options.strategy || {});
        this.executionEngine = new ExecutionEngine(web3Manager, options.execution || {});
        this.riskManager = new RiskManager(options.risk || {});
        
        // State management
        this.isRunning = false;
        this.scanInterval = null;
        this.blockSubscription = null;
        this.lastProcessedBlock = 0;
        
        // Performance tracking
        this.performanceMetrics = {
            totalOpportunities: 0,
            executedOpportunities: 0,
            totalProfit: new Decimal(0),
            totalGasCost: new Decimal(0),
            averageExecutionTime: 0,
            successRate: 0,
            uptime: 0,
            startTime: null
        };
        
        // Event handlers
        this.eventHandlers = {
            opportunityDetected: [],
            opportunityExecuted: [],
            opportunityFailed: [],
            riskAlert: [],
            performanceUpdate: []
        };
        
        logger.info('TradingBot initialized', {
            enabled: this.options.enabled,
            autoExecute: this.options.autoExecute,
            tokenPairs: this.options.tokenPairs.length,
            supportedDEXs: this.options.supportedDEXs,
            service: 'defi-arbitrage-bot'
        });
    }
    
    /**
     * Start the trading bot
     * @returns {Promise<boolean>} Success status
     */
    async start() {
        try {
            if (this.isRunning) {
                logger.warn('TradingBot is already running', {
                    service: 'defi-arbitrage-bot'
                });
                return true;
            }
            
            logger.info('Starting TradingBot', {
                service: 'defi-arbitrage-bot'
            });
            
            // Validate configuration
            if (!this.validateConfiguration()) {
                throw new Error('Invalid configuration');
            }
            
            // Initialize components
            await this.initializeComponents();
            
            // Start block monitoring
            await this.startBlockMonitoring();
            
            // Start opportunity scanning
            this.startOpportunityScanning();
            
            // Update state
            this.isRunning = true;
            this.performanceMetrics.startTime = Date.now();
            
            logger.info('TradingBot started successfully', {
                service: 'defi-arbitrage-bot'
            });
            
            return true;
            
        } catch (error) {
            logger.error('Failed to start TradingBot', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return false;
        }
    }
    
    /**
     * Stop the trading bot
     * @returns {Promise<boolean>} Success status
     */
    async stop() {
        try {
            if (!this.isRunning) {
                logger.warn('TradingBot is not running', {
                    service: 'defi-arbitrage-bot'
                });
                return true;
            }
            
            logger.info('Stopping TradingBot', {
                service: 'defi-arbitrage-bot'
            });
            
            // Stop opportunity scanning
            this.stopOpportunityScanning();
            
            // Stop block monitoring
            await this.stopBlockMonitoring();
            
            // Update state
            this.isRunning = false;
            this.performanceMetrics.uptime = Date.now() - this.performanceMetrics.startTime;
            
            logger.info('TradingBot stopped successfully', {
                uptime: this.performanceMetrics.uptime,
                service: 'defi-arbitrage-bot'
            });
            
            return true;
            
        } catch (error) {
            logger.error('Failed to stop TradingBot', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return false;
        }
    }
    
    /**
     * Validate configuration
     * @returns {boolean} Configuration validity
     */
    validateConfiguration() {
        try {
            // Check if trading is enabled
            if (!this.options.enabled) {
                logger.warn('Trading is disabled', {
                    service: 'defi-arbitrage-bot'
                });
                return false;
            }
            
            // Check wallet configuration
            if (!this.options.walletConfig.address || !this.options.walletConfig.privateKey) {
                logger.error('Invalid wallet configuration', {
                    service: 'defi-arbitrage-bot'
                });
                return false;
            }
            
            // Check token pairs
            if (this.options.tokenPairs.length === 0) {
                logger.error('No token pairs configured', {
                    service: 'defi-arbitrage-bot'
                });
                return false;
            }
            
            // Check supported DEXs
            if (this.options.supportedDEXs.length < 2) {
                logger.error('Need at least 2 DEXs for arbitrage', {
                    service: 'defi-arbitrage-bot'
                });
                return false;
            }
            
            return true;
            
        } catch (error) {
            logger.error('Error validating configuration', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return false;
        }
    }
    
    /**
     * Initialize components
     * @returns {Promise<void>}
     */
    async initializeComponents() {
        try {
            // Test blockchain connectivity
            const blockNumber = await this.web3Manager.getBlockNumber();
            logger.info('Blockchain connectivity confirmed', {
                blockNumber,
                service: 'defi-arbitrage-bot'
            });
            
            // Test DEX price service
            const testPair = this.options.tokenPairs[0];
            if (testPair) {
                const testPrice = await this.dexPriceService.getPrice(
                    testPair.tokenA,
                    testPair.tokenB,
                    this.options.supportedDEXs[0]
                );
                logger.info('DEX price service confirmed', {
                    testPair: `${testPair.tokenA}-${testPair.tokenB}`,
                    service: 'defi-arbitrage-bot'
                });
            }
            
        } catch (error) {
            logger.error('Error initializing components', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            throw error;
        }
    }
    
    /**
     * Start block monitoring
     * @returns {Promise<void>}
     */
    async startBlockMonitoring() {
        try {
            const callback = (blockHeader) => {
                this.onNewBlock(blockHeader);
            };
            
            this.blockSubscription = await this.web3Manager.subscribeToBlocks(callback);
            
            logger.info('Block monitoring started', {
                service: 'defi-arbitrage-bot'
            });
            
        } catch (error) {
            logger.error('Error starting block monitoring', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            throw error;
        }
    }
    
    /**
     * Stop block monitoring
     * @returns {Promise<void>}
     */
    async stopBlockMonitoring() {
        try {
            if (this.blockSubscription) {
                // In production, you'd properly unsubscribe
                this.blockSubscription = null;
            }
            
            logger.info('Block monitoring stopped', {
                service: 'defi-arbitrage-bot'
            });
            
        } catch (error) {
            logger.error('Error stopping block monitoring', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
        }
    }
    
    /**
     * Start opportunity scanning
     */
    startOpportunityScanning() {
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
        }
        
        this.scanInterval = setInterval(async () => {
            await this.scanForOpportunities();
        }, this.options.opportunityScanInterval);
        
        logger.info('Opportunity scanning started', {
            interval: this.options.opportunityScanInterval,
            service: 'defi-arbitrage-bot'
        });
    }
    
    /**
     * Stop opportunity scanning
     */
    stopOpportunityScanning() {
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
            this.scanInterval = null;
        }
        
        logger.info('Opportunity scanning stopped', {
            service: 'defi-arbitrage-bot'
        });
    }
    
    /**
     * Handle new block
     * @param {Object} blockHeader - Block header
     */
    async onNewBlock(blockHeader) {
        try {
            const blockNumber = blockHeader.number;
            
            // Skip if we've already processed this block
            if (blockNumber <= this.lastProcessedBlock) {
                return;
            }
            
            this.lastProcessedBlock = blockNumber;
            
            logger.info('New block received', {
                blockNumber,
                timestamp: blockHeader.timestamp,
                service: 'defi-arbitrage-bot'
            });
            
            // Scan for opportunities on new block
            await this.scanForOpportunities(blockNumber);
            
        } catch (error) {
            logger.error('Error handling new block', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
        }
    }
    
    /**
     * Scan for arbitrage opportunities
     * @param {string} blockNumber - Block number (optional)
     * @returns {Promise<Array>} Array of opportunities
     */
    async scanForOpportunities(blockNumber = 'latest') {
        const startTime = Date.now();
        
        try {
            // Check if trading is paused
            const pauseStatus = this.riskManager.checkTradingPause();
            if (pauseStatus.paused) {
                logger.warn('Trading paused', {
                    reason: pauseStatus.reason,
                    service: 'defi-arbitrage-bot'
                });
                return [];
            }
            
            // Detect opportunities
            const opportunities = await this.strategyEngine.detectOpportunities(
                this.options.tokenPairs,
                this.options.supportedDEXs,
                blockNumber
            );
            
            // Update performance metrics
            this.performanceMetrics.totalOpportunities += opportunities.length;
            
            // Process each opportunity
            const processedOpportunities = [];
            for (const opportunity of opportunities.slice(0, this.options.maxOpportunitiesPerBlock)) {
                const processed = await this.processOpportunity(opportunity);
                if (processed) {
                    processedOpportunities.push(processed);
                }
            }
            
            // Update performance metrics
            this.performanceMetrics.averageExecutionTime = 
                (this.performanceMetrics.averageExecutionTime + (Date.now() - startTime)) / 2;
            
            logger.info('Opportunity scan completed', {
                opportunitiesFound: opportunities.length,
                opportunitiesProcessed: processedOpportunities.length,
                scanTime: Date.now() - startTime,
                service: 'defi-arbitrage-bot'
            });
            
            return processedOpportunities;
            
        } catch (error) {
            logger.error('Error scanning for opportunities', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return [];
        }
    }
    
    /**
     * Process a single opportunity
     * @param {Object} opportunity - Arbitrage opportunity
     * @returns {Promise<Object|null>} Processed opportunity or null
     */
    async processOpportunity(opportunity) {
        try {
            // Emit opportunity detected event
            this.emitEvent('opportunityDetected', opportunity);
            
            // Assess risk
            const riskAssessment = await this.riskManager.assessRisk(opportunity, this.options.portfolioState);
            
            if (!riskAssessment.approved) {
                logger.info('Opportunity rejected by risk manager', {
                    opportunityId: opportunity.id,
                    warnings: riskAssessment.warnings,
                    service: 'defi-arbitrage-bot'
                });
                return null;
            }
            
            // Update opportunity with risk assessment
            opportunity.riskAssessment = riskAssessment;
            opportunity.approvedPositionSize = riskAssessment.maxPositionSize.toString();
            
            // Execute if auto-execute is enabled
            if (this.options.autoExecute) {
                const executionResult = await this.executeOpportunity(opportunity);
                return executionResult;
            } else {
                // Return opportunity for manual review
                return opportunity;
            }
            
        } catch (error) {
            logger.error('Error processing opportunity', {
                opportunityId: opportunity.id,
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return null;
        }
    }
    
    /**
     * Execute an arbitrage opportunity
     * @param {Object} opportunity - Arbitrage opportunity
     * @returns {Promise<Object|null>} Execution result or null
     */
    async executeOpportunity(opportunity) {
        const startTime = Date.now();
        
        try {
            logger.info('Executing arbitrage opportunity', {
                opportunityId: opportunity.id,
                expectedProfit: opportunity.netProfitUSD,
                positionSize: opportunity.approvedPositionSize,
                service: 'defi-arbitrage-bot'
            });
            
            // Record position opening
            const positionSize = new Decimal(opportunity.approvedPositionSize);
            this.riskManager.recordPositionOpen(opportunity, positionSize, opportunity.id);
            
            // Execute the trade
            const executionResult = await this.executionEngine.executeArbitrage(
                opportunity,
                this.options.walletConfig
            );
            
            // Record position closing
            this.riskManager.recordPositionClose(opportunity.id, executionResult);
            
            // Update performance metrics
            this.performanceMetrics.executedOpportunities++;
            this.performanceMetrics.totalProfit = this.performanceMetrics.totalProfit.plus(opportunity.netProfitUSD);
            this.performanceMetrics.totalGasCost = this.performanceMetrics.totalGasCost.plus(opportunity.gasCostUSD);
            this.performanceMetrics.successRate = this.performanceMetrics.executedOpportunities / this.performanceMetrics.totalOpportunities;
            
            // Emit execution event
            this.emitEvent('opportunityExecuted', {
                opportunity,
                executionResult,
                executionTime: Date.now() - startTime
            });
            
            logger.info('Arbitrage opportunity executed successfully', {
                opportunityId: opportunity.id,
                txHash: executionResult.txHash,
                executionTime: Date.now() - startTime,
                service: 'defi-arbitrage-bot'
            });
            
            return {
                opportunity,
                executionResult,
                executionTime: Date.now() - startTime
            };
            
        } catch (error) {
            // Record failed execution
            this.riskManager.recordPositionClose(opportunity.id, { error: error.message });
            
            // Emit failure event
            this.emitEvent('opportunityFailed', {
                opportunity,
                error: error.message,
                executionTime: Date.now() - startTime
            });
            
            logger.error('Failed to execute arbitrage opportunity', {
                opportunityId: opportunity.id,
                error: error.message,
                executionTime: Date.now() - startTime,
                service: 'defi-arbitrage-bot'
            });
            
            return null;
        }
    }
    
    /**
     * Manually execute an opportunity
     * @param {string} opportunityId - Opportunity ID
     * @returns {Promise<Object|null>} Execution result
     */
    async executeOpportunityById(opportunityId) {
        try {
            // Find opportunity in active opportunities
            const opportunity = this.strategyEngine.activeOpportunities.get(opportunityId);
            
            if (!opportunity) {
                throw new Error('Opportunity not found');
            }
            
            return await this.executeOpportunity(opportunity);
            
        } catch (error) {
            logger.error('Error executing opportunity by ID', {
                opportunityId,
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return null;
        }
    }
    
    /**
     * Get current status
     * @returns {Object} Bot status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            enabled: this.options.enabled,
            autoExecute: this.options.autoExecute,
            lastProcessedBlock: this.lastProcessedBlock,
            uptime: this.isRunning ? Date.now() - this.performanceMetrics.startTime : this.performanceMetrics.uptime,
            performanceMetrics: this.performanceMetrics,
            riskMetrics: this.riskManager.getRiskMetrics(),
            strategyStats: this.strategyEngine.getStats(),
            executionStats: this.executionEngine.getStats()
        };
    }
    
    /**
     * Get performance metrics
     * @returns {Object} Performance metrics
     */
    getPerformanceMetrics() {
        return {
            ...this.performanceMetrics,
            uptime: this.isRunning ? Date.now() - this.performanceMetrics.startTime : this.performanceMetrics.uptime,
            roi: this.performanceMetrics.totalProfit.dividedBy(this.performanceMetrics.totalGasCost).toString(),
            profitPerTrade: this.performanceMetrics.executedOpportunities > 0 ? 
                this.performanceMetrics.totalProfit.dividedBy(this.performanceMetrics.executedOpportunities).toString() : '0'
        };
    }
    
    /**
     * Get risk metrics
     * @returns {Object} Risk metrics
     */
    getRiskMetrics() {
        return this.riskManager.getRiskMetrics();
    }
    
    /**
     * Get active opportunities
     * @returns {Array} Active opportunities
     */
    getActiveOpportunities() {
        return Array.from(this.strategyEngine.activeOpportunities.values());
    }
    
    /**
     * Get active positions
     * @returns {Array} Active positions
     */
    getActivePositions() {
        return this.riskManager.getActivePositions();
    }
    
    /**
     * Add event handler
     * @param {string} event - Event name
     * @param {Function} handler - Event handler
     */
    on(event, handler) {
        if (this.eventHandlers[event]) {
            this.eventHandlers[event].push(handler);
        }
    }
    
    /**
     * Remove event handler
     * @param {string} event - Event name
     * @param {Function} handler - Event handler
     */
    off(event, handler) {
        if (this.eventHandlers[event]) {
            const index = this.eventHandlers[event].indexOf(handler);
            if (index > -1) {
                this.eventHandlers[event].splice(index, 1);
            }
        }
    }
    
    /**
     * Emit event
     * @param {string} event - Event name
     * @param {*} data - Event data
     */
    emitEvent(event, data) {
        if (this.eventHandlers[event]) {
            this.eventHandlers[event].forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    logger.error('Error in event handler', {
                        event,
                        error: error.message,
                        service: 'defi-arbitrage-bot'
                    });
                }
            });
        }
    }
    
    /**
     * Update configuration
     * @param {Object} newOptions - New options
     */
    updateConfiguration(newOptions) {
        try {
            // Update options
            Object.assign(this.options, newOptions);
            
            // Update component configurations
            if (newOptions.strategy) {
                Object.assign(this.strategyEngine.options, newOptions.strategy);
            }
            
            if (newOptions.execution) {
                Object.assign(this.executionEngine.options, newOptions.execution);
            }
            
            if (newOptions.risk) {
                Object.assign(this.riskManager.options, newOptions.risk);
            }
            
            logger.info('Configuration updated', {
                newOptions,
                service: 'defi-arbitrage-bot'
            });
            
        } catch (error) {
            logger.error('Error updating configuration', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
        }
    }
    
    /**
     * Reset daily statistics
     */
    resetDailyStats() {
        this.riskManager.resetDailyStats();
        logger.info('Daily statistics reset', {
            service: 'defi-arbitrage-bot'
        });
    }
    
    /**
     * Clear old data
     */
    clearOldData() {
        this.strategyEngine.clearExpiredOpportunities();
        this.executionEngine.clearOldTransactions();
        logger.info('Old data cleared', {
            service: 'defi-arbitrage-bot'
        });
    }
}

module.exports = TradingBot;
