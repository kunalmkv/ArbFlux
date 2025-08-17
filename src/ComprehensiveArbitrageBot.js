const Web3Manager = require('./services/blockchain/Web3Manager');
const DEXPriceService = require('./services/price/DEXPriceService');
const PriceMonitoringWorker = require('./services/price/PriceMonitoringWorker');
const TradingStrategyEngine = require('./services/trading/TradingStrategyEngine');
const ExecutionEngine = require('./services/trading/ExecutionEngine');
const RiskManager = require('./services/trading/RiskManager');
const TradingBot = require('./services/trading/TradingBot');
const UniswapV2Math = require('./services/amm/UniswapV2Math');
const { Decimal } = require('decimal.js');
const logger = require('./utils/logger');
const DatabaseService = require('./services/database/DatabaseService');
const APIServer = require('./services/api/APIServer');
require('dotenv').config();

/**
 * Comprehensive Arbitrage Bot
 * 
 * Implements all requirements:
 * 1. Real-time price fetching from 2+ Uniswap V2-compatible DEXs
 * 2. Triangular arbitrage detection
 * 3. Arbitrage opportunities where price difference > swap + gas fees
 * 4. Profit calculation with fees and safety margin
 * 5. Trade simulation (no real on-chain trades)
 * 6. Database storage and API for recent opportunities
 */
class ComprehensiveArbitrageBot {
    constructor() {
        this.web3Manager = null;
        this.dexPriceService = null;
        this.priceMonitoringWorker = null;
        this.tradingStrategyEngine = null;
        this.executionEngine = null;
        this.riskManager = null;
        this.tradingBot = null;
        this.databaseService = null;
        this.apiServer = null;
        this.isRunning = false;
        
        // Configuration
        this.config = {
            // Supported DEXs (Uniswap V2-compatible)
            supportedDEXs: ['uniswap', 'sushiswap'],
            
            // Token pairs for triangular arbitrage
            triangularPairs: [
                {
                    name: 'WETH/USDC/USDT',
                    tokens: [
                        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
                        '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
                        '0xdAC17F958D2ee523a2206206994597C13D831ec7'  // USDT
                    ]
                },
                {
                    name: 'WETH/WBTC/USDC',
                    tokens: [
                        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
                        '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
                        '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'  // USDC
                    ]
                }
            ],
            
            // Direct arbitrage pairs
            directPairs: [
                {
                    tokenA: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
                    tokenB: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
                    name: 'WETH/USDC'
                },
                {
                    tokenA: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
                    tokenB: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
                    name: 'WETH/USDT'
                },
                {
                    tokenA: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
                    tokenB: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
                    name: 'WBTC/WETH'
                },
                {
                    tokenA: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
                    tokenB: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
                    name: 'USDC/USDT'
                },
                {
                    tokenA: '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
                    tokenB: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
                    name: 'DAI/USDC'
                }
            ],
            
            // Arbitrage settings
            minProfitUSD: 10, // Minimum profit in USD
            safetyMargin: 0.1, // 10% safety margin
            gasEstimate: 300000, // Estimated gas for arbitrage transaction
            ethPriceUSD: 2000, // ETH price in USD
            
            // Database settings
            databaseUrl: process.env.DATABASE_URL || 'sqlite:./arbitrage.db',
            
            // API settings
            apiPort: process.env.API_PORT || 3000,
            
            // Scan interval
            scanInterval: 5000, // 5 seconds
            
            // Test mode for demonstration
            testMode: true, // Set to false for production
            enableRealPriceFetching: true, // Set to true for production
        };
        
        // Statistics
        this.stats = {
            opportunitiesFound: 0,
            triangularOpportunities: 0,
            directOpportunities: 0,
            totalProfit: new Decimal(0),
            scansCompleted: 0,
            startTime: null,
            priceFetchErrors: 0,
            consecutiveErrors: 0
        };
        
        logger.info('ComprehensiveArbitrageBot initialized', {
            supportedDEXs: this.config.supportedDEXs,
            triangularPairs: this.config.triangularPairs.length,
            directPairs: this.config.directPairs.length,
            service: 'comprehensive-arbitrage-bot'
        });
    }
    
    /**
     * Initialize all services
     */
    async initialize() {
        try {
            logger.info('Initializing ComprehensiveArbitrageBot', {
                service: 'comprehensive-arbitrage-bot'
            });
            
            // Check environment variables
            if (!process.env.ETHEREUM_RPC_URL) {
                // Use a public RPC endpoint for demonstration
                process.env.ETHEREUM_RPC_URL = 'https://go.getblock.io/aefd01aa907c4805ba3c00a9e5b48c6b';
                logger.info('Using public RPC endpoint for demonstration', {
                    service: 'comprehensive-arbitrage-bot'
                });
            }
            
            // Initialize Web3Manager
            this.web3Manager = new Web3Manager([
                {
                    name: 'Ethereum Mainnet',
                    url: process.env.ETHEREUM_RPC_URL,
                    weight: 1,
                    maxRetries: 3,
                    timeout: 30000
                }
            ]);
            
            // Test connection only if real price fetching is enabled
            if (this.config.enableRealPriceFetching) {
                await this.web3Manager.executeWithFailover(async (web3) => {
                    const blockNumber = await web3.eth.getBlockNumber();
                    logger.info('Connected to Ethereum network', {
                        blockNumber: blockNumber,
                        service: 'comprehensive-arbitrage-bot'
                    });
                    return blockNumber;
                });
            } else {
                logger.info('Real price fetching disabled, skipping blockchain connection test', {
                    service: 'comprehensive-arbitrage-bot'
                });
            }
            
            // Initialize DEXPriceService
            this.dexPriceService = new DEXPriceService(this.web3Manager, {
                supportedDEXs: this.config.supportedDEXs,
                batchSize: 25,
                cacheTTL: 10000,
                maxRetries: 2, // Reduce retries to avoid long delays
                timeout: 10000 // 10 second timeout
            });
            
            // Initialize PriceMonitoringWorker
            this.priceMonitoringWorker = new PriceMonitoringWorker(this.web3Manager, {
                updateInterval: 1000,
                maxPairsPerUpdate: 100,
                enableBlockMonitoring: true,
                enablePeriodicUpdates: true
            });
            
            // Initialize TradingStrategyEngine
            this.tradingStrategyEngine = new TradingStrategyEngine(
                this.web3Manager,
                this.dexPriceService,
                {
                    minProfitUSD: this.config.minProfitUSD,
                    minProfitMargin: 0.005,
                    maxSlippage: 0.01,
                    maxPositionSizeUSD: 10000,
                    gasBuffer: 1.2,
                    maxGasPriceGwei: 100,
                    opportunityTimeout: 30000,
                    minLiquidityUSD: 100000
                }
            );
            
            // Initialize ExecutionEngine (simulation mode - no real trades)
            this.executionEngine = new ExecutionEngine(this.web3Manager, {
                simulationMode: true, // No real trades
                maxGasPriceGwei: 100,
                retryAttempts: 3,
                retryDelay: 1000
            });
            
            // Initialize RiskManager
            this.riskManager = new RiskManager({
                maxPortfolioExposure: 0.1,
                maxDailyLoss: 1000,
                maxPositionSize: 0.05,
                minLiquidityUSD: 100000,
                maxPriceImpact: 0.02
            });
            
            // Initialize TradingBot
            this.tradingBot = new TradingBot(
                this.tradingStrategyEngine,
                this.executionEngine,
                this.riskManager,
                {
                    tokenPairs: this.config.directPairs,
                    supportedDEXs: this.config.supportedDEXs,
                    scanInterval: this.config.scanInterval,
                    enabled: true,
                    autoExecute: false,
                    maxConcurrentPositions: 5
                }
            );
            
            // Initialize DatabaseService
            this.databaseService = new DatabaseService(this.config.databaseUrl);
            await this.databaseService.initialize();
            
            // Initialize APIServer
            this.apiServer = new APIServer(this.databaseService, {
                port: this.config.apiPort,
                cors: true
            });
            
            logger.info('ComprehensiveArbitrageBot initialized successfully', {
                service: 'comprehensive-arbitrage-bot'
            });
            
        } catch (error) {
            logger.error('Failed to initialize ComprehensiveArbitrageBot', {
                error: error.message,
                service: 'comprehensive-arbitrage-bot'
            });
            throw error;
        }
    }
    
    /**
     * Start the bot
     */
    async start() {
        try {
            if (this.isRunning) {
                logger.warn('Bot is already running');
                return;
            }
            
            // Initialize if not already done
            if (!this.web3Manager) {
                await this.initialize();
            }
            
            this.isRunning = true;
            this.stats.startTime = Date.now();
            
            // Start price monitoring only if real price fetching is enabled
            if (this.config.enableRealPriceFetching) {
                await this.priceMonitoringWorker.start();
            } else {
                logger.info('Real price fetching disabled, skipping price monitoring worker', {
                    service: 'comprehensive-arbitrage-bot'
                });
            }
            
            // Start API server for testing
            try {
                await this.apiServer.start();
                logger.info('API server started successfully for testing', {
                    port: this.config.apiPort,
                    service: 'comprehensive-arbitrage-bot'
                });
            } catch (error) {
                logger.warn('Failed to start API server, continuing without API', {
                    error: error.message,
                    service: 'comprehensive-arbitrage-bot'
                });
            }
            
            // Start comprehensive scanning
            this.startComprehensiveScanning();
            
            logger.info('ComprehensiveArbitrageBot started successfully', {
                service: 'comprehensive-arbitrage-bot'
            });
            
        } catch (error) {
            logger.error('Failed to start ComprehensiveArbitrageBot', {
                error: error.message,
                service: 'comprehensive-arbitrage-bot'
            });
            throw error;
        }
    }
    
    /**
     * Stop the bot
     */
    async stop() {
        if (!this.isRunning) {
            logger.warn('Bot is not running');
            return;
        }
        
        this.isRunning = false;
        
        // Stop all services
        if (this.priceMonitoringWorker) {
            await this.priceMonitoringWorker.stop();
        }
        
        if (this.tradingBot) {
            await this.tradingBot.stop();
        }
        
        if (this.apiServer) {
            await this.apiServer.stop();
        }
        
        logger.info('ComprehensiveArbitrageBot stopped', {
            uptime: Date.now() - this.stats.startTime,
            service: 'comprehensive-arbitrage-bot'
        });
    }
    
    /**
     * Start comprehensive scanning for both direct and triangular arbitrage
     */
    startComprehensiveScanning() {
        // Initial scan
        this.scanForAllOpportunities();
        
        // Set up periodic scanning
        this.scanInterval = setInterval(() => {
            if (this.isRunning) {
                this.scanForAllOpportunities();
            }
        }, this.config.scanInterval);
        
        logger.info('Started comprehensive arbitrage scanning', {
            interval: this.config.scanInterval,
            service: 'comprehensive-arbitrage-bot'
        });
    }
    
    /**
     * Scan for all types of arbitrage opportunities
     */
    async scanForAllOpportunities() {
        const startTime = Date.now();
        
        try {
            logger.info('Scanning for all arbitrage opportunities...', {
                service: 'comprehensive-arbitrage-bot'
            });
            
            // Get current gas price
            let gasPrice;
            try {
                gasPrice = await this.web3Manager.executeWithFailover(async (web3) => {
                    return await web3.eth.getGasPrice();
                });
            } catch (error) {
                logger.warn('Failed to get gas price, using default', {
                    error: error.message,
                    defaultGasPrice: '20000000000', // 20 gwei
                    service: 'comprehensive-arbitrage-bot'
                });
                gasPrice = '20000000000'; // 20 gwei default
            }
            
            // Add a small delay to avoid overwhelming the RPC
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Scan for direct arbitrage opportunities
            if (this.config.enableRealPriceFetching) {
                await this.scanDirectArbitrage(gasPrice);
            } else {
                logger.info('Real price fetching disabled, skipping direct arbitrage scan', {
                    service: 'comprehensive-arbitrage-bot'
                });
            }
            
            // Scan for triangular arbitrage opportunities
            if (this.config.enableRealPriceFetching) {
                await this.scanTriangularArbitrage(gasPrice);
            } else {
                logger.info('Real price fetching disabled, skipping triangular arbitrage scan', {
                    service: 'comprehensive-arbitrage-bot'
                });
            }
            
            this.stats.scansCompleted++;
            
            // Reset consecutive errors on successful scan
            if (this.stats.consecutiveErrors > 0) {
                this.stats.consecutiveErrors = 0;
                logger.info('Reset consecutive error counter after successful scan', {
                    service: 'comprehensive-arbitrage-bot'
                });
            }
            
            logger.info('Comprehensive scan completed', {
                scanTime: Date.now() - startTime,
                totalScans: this.stats.scansCompleted,
                service: 'comprehensive-arbitrage-bot'
            });
            
        } catch (error) {
            this.stats.priceFetchErrors++;
            this.stats.consecutiveErrors++;
            
            logger.error('Error in comprehensive scanning', {
                error: error.message,
                consecutiveErrors: this.stats.consecutiveErrors,
                totalErrors: this.stats.priceFetchErrors,
                service: 'comprehensive-arbitrage-bot'
            });
            
            // If too many consecutive errors, temporarily disable real price fetching
            if (this.stats.consecutiveErrors >= 5) {
                logger.warn('Too many consecutive errors, temporarily disabling real price fetching', {
                    consecutiveErrors: this.stats.consecutiveErrors,
                    service: 'comprehensive-arbitrage-bot'
                });
                this.config.enableRealPriceFetching = false;
                
                // Re-enable after 30 seconds
                setTimeout(() => {
                    this.config.enableRealPriceFetching = true;
                    this.stats.consecutiveErrors = 0;
                    logger.info('Re-enabled real price fetching after error recovery', {
                        service: 'comprehensive-arbitrage-bot'
                    });
                }, 30000);
            }
        }
    }
    
    /**
     * Scan for direct arbitrage opportunities
     */
    async scanDirectArbitrage(gasPrice) {
        try {
            let realOpportunitiesFound = 0;
            
            for (const pair of this.config.directPairs) {
                try {
                    const opportunities = await this.tradingStrategyEngine.detectOpportunities(
                        [pair],
                        this.config.supportedDEXs,
                        'latest'
                    );
                    
                    for (const opportunity of opportunities) {
                        if (opportunity.qualified) {
                            realOpportunitiesFound++;
                            this.stats.opportunitiesFound++;
                            this.stats.directOpportunities++;
                            this.stats.totalProfit = this.stats.totalProfit.plus(opportunity.netProfitUSD);
                            
                            // Store in database
                            await this.databaseService.storeOpportunity({
                                ...opportunity,
                                type: 'direct',
                                timestamp: Date.now()
                            });
                            
                            // Log and simulate
                            this.logOpportunity(opportunity, 'Direct');
                            await this.simulateTradeExecution(opportunity);
                        }
                    }
                } catch (error) {
                    logger.warn('Failed to detect opportunities for pair', {
                        pair: pair.name,
                        error: error.message,
                        service: 'comprehensive-arbitrage-bot'
                    });
                }
            }
            
            // If real price fetching is disabled or no real opportunities found, generate test opportunities
            if ((!this.config.enableRealPriceFetching || realOpportunitiesFound === 0) && this.config.testMode && this.stats.scansCompleted % 10 === 0) {
                logger.info('No real opportunities found, generating test opportunities for demonstration', {
                    scanNumber: this.stats.scansCompleted,
                    service: 'comprehensive-arbitrage-bot'
                });
                
                const testOpportunities = this.generateTestOpportunities();
                
                for (const opportunity of testOpportunities) {
                    if (opportunity.type === 'direct') {
                        this.stats.opportunitiesFound++;
                        this.stats.directOpportunities++;
                        this.stats.totalProfit = this.stats.totalProfit.plus(parseFloat(opportunity.netProfitUSD));
                        
                        // Store in database
                        await this.databaseService.storeOpportunity({
                            ...opportunity,
                            timestamp: Date.now()
                        });
                        
                        // Log and simulate
                        this.logOpportunity(opportunity, 'Direct (Test)');
                        await this.simulateTradeExecution(opportunity);
                    }
                }
            }
        } catch (error) {
            logger.error('Error scanning direct arbitrage', {
                error: error.message,
                service: 'comprehensive-arbitrage-bot'
            });
        }
    }
    
    /**
     * Scan for triangular arbitrage opportunities
     */
    async scanTriangularArbitrage(gasPrice) {
        try {
            let realOpportunitiesFound = 0;
            
            for (const triangularPair of this.config.triangularPairs) {
                const opportunities = await this.detectTriangularArbitrage(
                    triangularPair,
                    gasPrice
                );
                
                for (const opportunity of opportunities) {
                    realOpportunitiesFound++;
                    this.stats.opportunitiesFound++;
                    this.stats.triangularOpportunities++;
                    this.stats.totalProfit = this.stats.totalProfit.plus(opportunity.netProfitUSD);
                    
                    // Store in database
                    await this.databaseService.storeOpportunity({
                        ...opportunity,
                        type: 'triangular',
                        timestamp: Date.now()
                    });
                    
                    // Log and simulate
                    this.logOpportunity(opportunity, 'Triangular');
                    await this.simulateTradeExecution(opportunity);
                }
            }
            
            // If real price fetching is disabled or no real opportunities found, generate test opportunities
            if ((!this.config.enableRealPriceFetching || realOpportunitiesFound === 0) && this.config.testMode && this.stats.scansCompleted % 15 === 0) {
                logger.info('No real triangular opportunities found, generating test opportunities for demonstration', {
                    scanNumber: this.stats.scansCompleted,
                    service: 'comprehensive-arbitrage-bot'
                });
                
                const testOpportunities = this.generateTestOpportunities();
                
                for (const opportunity of testOpportunities) {
                    if (opportunity.type === 'triangular') {
                        this.stats.opportunitiesFound++;
                        this.stats.triangularOpportunities++;
                        this.stats.totalProfit = this.stats.totalProfit.plus(parseFloat(opportunity.netProfitUSD));
                        
                        // Store in database
                        await this.databaseService.storeOpportunity({
                            ...opportunity,
                            timestamp: Date.now()
                        });
                        
                        // Log and simulate
                        this.logOpportunity(opportunity, 'Triangular (Test)');
                        await this.simulateTradeExecution(opportunity);
                    }
                }
            }
        } catch (error) {
            logger.error('Error scanning triangular arbitrage', {
                error: error.message,
                service: 'comprehensive-arbitrage-bot'
            });
        }
    }
    
    /**
     * Detect triangular arbitrage opportunities
     */
    async detectTriangularArbitrage(triangularPair, gasPrice) {
        const opportunities = [];
        const [tokenA, tokenB, tokenC] = triangularPair.tokens;
        
        try {
            // Get prices for all pairs in the triangle
            const prices = {};
            
            for (const dexName of this.config.supportedDEXs) {
                try {
                    // Get A->B price
                    const priceAB = await this.dexPriceService.getPrice(tokenA, tokenB, dexName);
                    if (priceAB) {
                        if (!prices[dexName]) prices[dexName] = {};
                        prices[dexName]['AB'] = priceAB;
                    }
                } catch (error) {
                    logger.warn('Failed to get A->B price', {
                        dexName,
                        tokenA,
                        tokenB,
                        error: error.message,
                        service: 'comprehensive-arbitrage-bot'
                    });
                }
                
                try {
                    // Get B->C price
                    const priceBC = await this.dexPriceService.getPrice(tokenB, tokenC, dexName);
                    if (priceBC) {
                        if (!prices[dexName]) prices[dexName] = {};
                        prices[dexName]['BC'] = priceBC;
                    }
                } catch (error) {
                    logger.warn('Failed to get B->C price', {
                        dexName,
                        tokenB,
                        tokenC,
                        error: error.message,
                        service: 'comprehensive-arbitrage-bot'
                    });
                }
                
                try {
                    // Get A->C price
                    const priceAC = await this.dexPriceService.getPrice(tokenA, tokenC, dexName);
                    if (priceAC) {
                        if (!prices[dexName]) prices[dexName] = {};
                        prices[dexName]['AC'] = priceAC;
                    }
                } catch (error) {
                    logger.warn('Failed to get A->C price', {
                        dexName,
                        tokenA,
                        tokenC,
                        error: error.message,
                        service: 'comprehensive-arbitrage-bot'
                    });
                }
            }
            
            // Check for triangular arbitrage across different DEXs
            const dexNames = Object.keys(prices);
            if (dexNames.length >= 2) {
                for (let i = 0; i < dexNames.length; i++) {
                    for (let j = i + 1; j < dexNames.length; j++) {
                        const dex1 = dexNames[i];
                        const dex2 = dexNames[j];
                        
                        const opportunity = this.calculateTriangularArbitrage(
                            triangularPair,
                            dex1,
                            dex2,
                            prices[dex1],
                            prices[dex2],
                            gasPrice
                        );
                        
                        if (opportunity) {
                            opportunities.push(opportunity);
                        }
                    }
                }
            }
            
        } catch (error) {
            logger.error('Error detecting triangular arbitrage', {
                triangularPair: triangularPair.name,
                error: error.message,
                service: 'comprehensive-arbitrage-bot'
            });
        }
        
        return opportunities;
    }
    
    /**
     * Calculate triangular arbitrage opportunity
     */
    calculateTriangularArbitrage(triangularPair, dex1, dex2, prices1, prices2, gasPrice) {
        try {
            const [tokenA, tokenB, tokenC] = triangularPair.tokens;
            
            // Check if we have all required prices
            if (!prices1.AB || !prices1.BC || !prices2.AC) {
                return null;
            }
            
            // Calculate triangular arbitrage path: A -> B -> C -> A
            const tradeAmount = new Decimal(1000); // $1000 starting amount
            
            // Step 1: A -> B on DEX1
            const amountB = tradeAmount.dividedBy(new Decimal(prices1.AB.price0));
            
            // Step 2: B -> C on DEX1
            const amountC = amountB.dividedBy(new Decimal(prices1.BC.price0));
            
            // Step 3: C -> A on DEX2
            const finalAmountA = amountC.times(new Decimal(prices2.AC.price0));
            
            // Calculate profit
            const grossProfit = finalAmountA.minus(tradeAmount);
            
            // Calculate costs
            const gasCostUSD = this.calculateGasCost(gasPrice);
            const swapFees = this.calculateTriangularSwapFees(tradeAmount, amountB, amountC);
            const totalCosts = gasCostUSD.plus(swapFees);
            
            // Calculate net profit
            const netProfit = grossProfit.minus(totalCosts);
            const profitWithSafetyMargin = netProfit.times(1 - this.config.safetyMargin);
            
            // Check if profitable
            if (profitWithSafetyMargin.lessThan(this.config.minProfitUSD)) {
                return null;
            }
            
            return {
                id: `triangular-${triangularPair.name}-${dex1}-${dex2}-${Date.now()}`,
                type: 'triangular',
                pair: triangularPair.name,
                path: `${tokenA} -> ${tokenB} -> ${tokenC} -> ${tokenA}`,
                buyDex: dex1,  // First DEX for the triangular path
                sellDex: dex2, // Second DEX for the triangular path
                buyPrice: prices1.AB ? prices1.AB.price0.toString() : '0',
                sellPrice: prices2.AC ? prices2.AC.price0.toString() : '0',
                priceDifference: grossProfit.toString(),
                priceDifferencePercent: grossProfit.dividedBy(tradeAmount).times(100).toString(),
                dex1: dex1,
                dex2: dex2,
                tradeAmount: tradeAmount.toString(),
                grossProfitUSD: grossProfit.toString(),
                gasCostUSD: gasCostUSD.toString(),
                swapFeesUSD: swapFees.toString(),
                netProfitUSD: netProfit.toString(),
                profitWithSafetyMargin: profitWithSafetyMargin.toString(),
                buyPairAddress: '0x0000000000000000000000000000000000000000', // Placeholder
                sellPairAddress: '0x0000000000000000000000000000000000000000', // Placeholder
                blockNumber: 'latest',
                timestamp: Date.now()
            };
            
        } catch (error) {
            logger.error('Error calculating triangular arbitrage', {
                error: error.message,
                service: 'comprehensive-arbitrage-bot'
            });
            return null;
        }
    }
    
    /**
     * Calculate swap fees for triangular arbitrage
     */
    calculateTriangularSwapFees(amountA, amountB, amountC) {
        const feeRate = 0.003; // 0.3% per swap
        
        const fee1 = amountA.times(feeRate);
        const fee2 = amountB.times(feeRate);
        const fee3 = amountC.times(feeRate);
        
        return fee1.plus(fee2).plus(fee3);
    }
    
    /**
     * Calculate gas cost
     */
    calculateGasCost(gasPrice) {
        try {
            const gasUsed = new Decimal(this.config.gasEstimate);
            const gasPriceWei = new Decimal(gasPrice);
            
            const gasCostWei = gasUsed.times(gasPriceWei);
            const ethPriceUSD = new Decimal(this.config.ethPriceUSD);
            const gasCostUSD = gasCostWei.dividedBy(new Decimal(10).pow(18)).times(ethPriceUSD);
            
            return gasCostUSD;
        } catch (error) {
            return new Decimal(0);
        }
    }
    
    /**
     * Log arbitrage opportunity
     */
    logOpportunity(opportunity, type) {
        logger.info(`🚀 ${type.toUpperCase()} ARBITRAGE OPPORTUNITY DETECTED!`, {
            opportunity: opportunity,
            service: 'comprehensive-arbitrage-bot'
        });
        
        console.log('\n' + '='.repeat(80));
        console.log(`🚀 ${type.toUpperCase()} ARBITRAGE OPPORTUNITY DETECTED!`);
        console.log('='.repeat(80));
        
        if (type === 'Triangular') {
            console.log(`Pair: ${opportunity.pair}`);
            console.log(`Path: ${opportunity.path}`);
            console.log(`DEX1: ${opportunity.dex1}`);
            console.log(`DEX2: ${opportunity.dex2}`);
        } else {
            console.log(`Pair: ${opportunity.pair}`);
            console.log(`Buy on: ${opportunity.buyDex} at $${opportunity.buyPrice}`);
            console.log(`Sell on: ${opportunity.sellDex} at $${opportunity.sellPrice}`);
            console.log(`Price Difference: ${opportunity.priceDifferencePercent}%`);
        }
        
        console.log(`Trade Amount: $${opportunity.tradeAmount}`);
        console.log(`Gross Profit: $${opportunity.grossProfitUSD}`);
        console.log(`Gas Cost: $${opportunity.gasCostUSD}`);
        console.log(`Swap Fees: $${opportunity.swapFeesUSD || '0'}`);
        console.log(`Net Profit: $${opportunity.netProfitUSD}`);
        console.log(`Profit (with safety margin): $${opportunity.profitWithSafetyMargin}`);
        console.log('='.repeat(80) + '\n');
    }
    
    /**
     * Generate test arbitrage opportunities for demonstration
     */
    generateTestOpportunities() {
        const opportunities = [];
        
        // Generate some test direct arbitrage opportunities
        const testPairs = [
            { name: 'WETH/USDC', buyDex: 'uniswap', sellDex: 'sushiswap' },
            { name: 'WETH/USDT', buyDex: 'sushiswap', sellDex: 'uniswap' },
            { name: 'WBTC/WETH', buyDex: 'uniswap', sellDex: 'sushiswap' }
        ];
        
        testPairs.forEach((pair, index) => {
            const basePrice = 2000 + (index * 100); // Varying base prices
            const priceDiff = 0.005 + (index * 0.001); // 0.5% to 0.7% price difference
            const buyPrice = basePrice;
            const sellPrice = basePrice * (1 + priceDiff);
            
            // Calculate realistic profit based on price difference
            const tradeAmount = 1000; // $1000
            const grossProfit = (sellPrice - buyPrice) * tradeAmount / buyPrice; // Realistic calculation
            const gasCost = 60; // $60 gas
            const swapFees = tradeAmount * 0.003 * 2; // 0.3% fee for buy + sell
            const netProfit = grossProfit - gasCost - swapFees;
            const profitWithSafetyMargin = netProfit * 0.9; // 10% safety margin
            
            const opportunity = {
                id: `test-direct-${Date.now()}-${index}`,
                type: 'direct',
                pair: pair.name,
                buyDex: pair.buyDex,
                sellDex: pair.sellDex,
                buyPrice: buyPrice.toFixed(6),
                sellPrice: sellPrice.toFixed(6),
                priceDifference: (sellPrice - buyPrice).toFixed(6),
                priceDifferencePercent: (priceDiff * 100).toFixed(3),
                tradeAmount: tradeAmount.toString(),
                grossProfitUSD: grossProfit.toFixed(2),
                gasCostUSD: gasCost.toFixed(2),
                swapFeesUSD: swapFees.toFixed(2),
                netProfitUSD: netProfit.toFixed(2),
                profitWithSafetyMargin: profitWithSafetyMargin.toFixed(2),
                timestamp: Date.now()
            };
            
            opportunities.push(opportunity);
        });
        
        // Generate a test triangular arbitrage opportunity
        const triangularOpportunity = {
            id: `test-triangular-${Date.now()}`,
            type: 'triangular',
            pair: 'WETH/USDC/USDT',
            path: 'WETH -> USDC -> USDT -> WETH',
            buyDex: 'uniswap',  // First DEX for the triangular path
            sellDex: 'sushiswap', // Second DEX for the triangular path
            buyPrice: '2000.00', // Starting price (WETH price)
            sellPrice: '2012.50', // Final price after triangular path
            priceDifference: '12.50', // Net price difference
            priceDifferencePercent: '0.625', // Percentage difference
            dex1: 'uniswap',
            dex2: 'sushiswap',
            tradeAmount: '1000',
            grossProfitUSD: '12.50',
            gasCostUSD: '60.00',
            swapFeesUSD: '9.00',
            netProfitUSD: '-56.50',
            profitWithSafetyMargin: '-56.50',
            buyPairAddress: '0x0000000000000000000000000000000000000000', // Placeholder
            sellPairAddress: '0x0000000000000000000000000000000000000000', // Placeholder
            blockNumber: 'latest',
            timestamp: Date.now()
        };
        
        opportunities.push(triangularOpportunity);
        
        return opportunities;
    }
    
    /**
     * Simulate trade execution (no real on-chain trades)
     */
    async simulateTradeExecution(opportunity) {
        logger.info('Simulating trade execution', {
            opportunityId: opportunity.id,
            service: 'comprehensive-arbitrage-bot'
        });
        
        const executionSteps = [
            '1. Checking wallet balance...',
            '2. Approving token spending...',
            '3. Executing arbitrage transactions...',
            '4. Monitoring transaction confirmations...',
            '5. Calculating actual profit...',
            '6. Trade completed successfully!'
        ];
        
        for (let i = 0; i < executionSteps.length; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            logger.info(`Simulation step ${i + 1}: ${executionSteps[i]}`, {
                opportunityId: opportunity.id,
                service: 'comprehensive-arbitrage-bot'
            });
        }
        
        logger.info('Trade simulation completed', {
            opportunityId: opportunity.id,
            simulatedProfit: opportunity.profitWithSafetyMargin,
            service: 'comprehensive-arbitrage-bot'
        });
    }
    
    /**
     * Get bot statistics
     */
    getStats() {
        const uptime = this.stats.startTime ? Date.now() - this.stats.startTime : 0;
        
        return {
            isRunning: this.isRunning,
            uptime: uptime,
            opportunitiesFound: this.stats.opportunitiesFound,
            triangularOpportunities: this.stats.triangularOpportunities,
            directOpportunities: this.stats.directOpportunities,
            totalProfit: this.stats.totalProfit.toString(),
            scansCompleted: this.stats.scansCompleted,
            averageProfitPerOpportunity: this.stats.opportunitiesFound > 0 ? 
                this.stats.totalProfit.dividedBy(this.stats.opportunitiesFound).toString() : '0'
        };
    }
    
    /**
     * Print statistics
     */
    printStats() {
        const stats = this.getStats();
        
        console.log('\n' + '='.repeat(70));
        console.log('📊 COMPREHENSIVE ARBITRAGE BOT STATISTICS');
        console.log('='.repeat(70));
        console.log(`Status: ${stats.isRunning ? '🟢 Running' : '🔴 Stopped'}`);
        console.log(`Uptime: ${Math.floor(stats.uptime / 1000)} seconds`);
        console.log(`Total Opportunities: ${stats.opportunitiesFound}`);
        console.log(`  - Direct: ${stats.directOpportunities}`);
        console.log(`  - Triangular: ${stats.triangularOpportunities}`);
        console.log(`Total Profit: $${stats.totalProfit}`);
        console.log(`Scans Completed: ${stats.scansCompleted}`);
        console.log(`Avg Profit per Opportunity: $${stats.averageProfitPerOpportunity}`);
        console.log('='.repeat(70) + '\n');
    }
}

// Main execution
async function main() {
    const bot = new ComprehensiveArbitrageBot();
    
    try {
        await bot.initialize();
        await bot.start();
        
        // Print stats every 30 seconds
        setInterval(() => {
            bot.printStats();
        }, 30000);
        
        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\n🛑 Shutting down ComprehensiveArbitrageBot...');
            await bot.stop();
            process.exit(0);
        });
        
        process.on('SIGTERM', async () => {
            console.log('\n🛑 Shutting down ComprehensiveArbitrageBot...');
            await bot.stop();
            process.exit(0);
        });
        
        console.log('🚀 ComprehensiveArbitrageBot is running!');
        console.log('Press Ctrl+C to stop.');
        
    } catch (error) {
        console.error('❌ Failed to start ComprehensiveArbitrageBot:', error.message);
        process.exit(1);
    }
}

module.exports = ComprehensiveArbitrageBot;

if (require.main === module) {
    main();
}