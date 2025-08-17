const TradingStrategyEngine = require('../../src/services/trading/TradingStrategyEngine');
const { Decimal } = require('decimal.js');

// Mock dependencies
const mockWeb3Manager = {
    getGasPrice: jest.fn(),
    getCurrentWeb3: jest.fn(() => ({
        utils: {
            fromWei: jest.fn().mockReturnValue('50') // 50 gwei
        }
    }))
};

const mockDEXPriceService = {
    getPrice: jest.fn()
};

describe('TradingStrategyEngine', () => {
    let tradingStrategyEngine;

    beforeEach(() => {
        jest.clearAllMocks();
        
        tradingStrategyEngine = new TradingStrategyEngine(
            mockWeb3Manager,
            mockDEXPriceService,
            {
                minProfitUSD: 10,
                minProfitMargin: 0.005,
                maxPositionSizeUSD: 1000,
                gasBuffer: 1.2,
                maxGasPriceGwei: 100,
                opportunityTimeout: 30000,
                minLiquidityUSD: 100000
            }
        );
    });

    describe('Initialization', () => {
        test('should initialize with default options', () => {
            expect(tradingStrategyEngine.options.minProfitUSD).toBe(10);
            expect(tradingStrategyEngine.options.minProfitMargin).toBe(0.005);
            expect(tradingStrategyEngine.options.maxPositionSizeUSD).toBe(1000);
        });

        test('should initialize with custom options', () => {
            const customEngine = new TradingStrategyEngine(mockWeb3Manager, mockDEXPriceService, {
                minProfitUSD: 50,
                minProfitMargin: 0.01,
                maxPositionSizeUSD: 5000
            });

            expect(customEngine.options.minProfitUSD).toBe(50);
            expect(customEngine.options.minProfitMargin).toBe(0.01);
            expect(customEngine.options.maxPositionSizeUSD).toBe(5000);
        });

        test('should initialize state management', () => {
            expect(tradingStrategyEngine.activeOpportunities).toBeInstanceOf(Map);
            expect(tradingStrategyEngine.opportunityHistory).toEqual([]);
            expect(tradingStrategyEngine.stats.opportunitiesDetected).toBe(0);
            expect(tradingStrategyEngine.stats.opportunitiesQualified).toBe(0);
        });
    });

    describe('detectOpportunities', () => {
        test('should detect opportunities successfully', async () => {
            const tokenPairs = [
                { tokenA: '0xTOKENA', tokenB: '0xTOKENB' }
            ];
            const dexList = ['uniswap', 'sushiswap'];
            const blockNumber = 'latest';

            // Mock gas price
            mockWeb3Manager.getGasPrice.mockResolvedValue('20000000000'); // 20 gwei

            // Mock price data
            const mockPrice1 = {
                dexName: 'uniswap',
                price0: '2.0',
                price1: '0.5',
                reserve0: '1000000000000000000000',
                reserve1: '2000000000000000000000',
                pairAddress: '0xPAIR1'
            };

            const mockPrice2 = {
                dexName: 'sushiswap',
                price0: '2.1',
                price1: '0.476',
                reserve0: '1000000000000000000000',
                reserve1: '2100000000000000000000',
                pairAddress: '0xPAIR2'
            };

            mockDEXPriceService.getPrice
                .mockResolvedValueOnce(mockPrice1)
                .mockResolvedValueOnce(mockPrice2);

            const opportunities = await tradingStrategyEngine.detectOpportunities(
                tokenPairs, dexList, blockNumber
            );

            expect(opportunities).toHaveLength(1);
            expect(opportunities[0]).toHaveProperty('buyDex', 'uniswap');
            expect(opportunities[0]).toHaveProperty('sellDex', 'sushiswap');
            expect(opportunities[0]).toHaveProperty('qualified', true);
        });

        test('should handle gas price too high', async () => {
            const tokenPairs = [
                { tokenA: '0xTOKENA', tokenB: '0xTOKENB' }
            ];

            // Mock high gas price
            mockWeb3Manager.getGasPrice.mockResolvedValue('200000000000'); // 200 gwei
            mockWeb3Manager.getCurrentWeb3().utils.fromWei.mockReturnValue('200');

            const opportunities = await tradingStrategyEngine.detectOpportunities(tokenPairs);

            expect(opportunities).toHaveLength(0);
        });

        test('should handle insufficient DEXs', async () => {
            const tokenPairs = [
                { tokenA: '0xTOKENA', tokenB: '0xTOKENB' }
            ];

            mockWeb3Manager.getGasPrice.mockResolvedValue('20000000000');

            // Mock only one successful price
            mockDEXPriceService.getPrice
                .mockResolvedValueOnce({
                    dexName: 'uniswap',
                    price0: '2.0',
                    price1: '0.5',
                    reserve0: '1000000000000000000000',
                    reserve1: '2000000000000000000000',
                    pairAddress: '0xPAIR1'
                })
                .mockRejectedValueOnce(new Error('Failed to get price'));

            const opportunities = await tradingStrategyEngine.detectOpportunities(tokenPairs);

            expect(opportunities).toHaveLength(0);
        });

        test('should handle errors gracefully', async () => {
            const tokenPairs = [
                { tokenA: '0xTOKENA', tokenB: '0xTOKENB' }
            ];

            mockWeb3Manager.getGasPrice.mockRejectedValue(new Error('Network error'));

            const opportunities = await tradingStrategyEngine.detectOpportunities(tokenPairs);

            expect(opportunities).toHaveLength(0);
        });
    });

    describe('calculateArbitrageOpportunity', () => {
        test('should calculate opportunity correctly', async () => {
            const pair = { tokenA: '0xTOKENA', tokenB: '0xTOKENB' };
            const buyDex = {
                dex: 'uniswap',
                price0: new Decimal('2.0'),
                liquidityUSD: new Decimal('1000000'),
                reserves: ['1000000000000000000000', '2000000000000000000000'],
                pairAddress: '0xPAIR1'
            };
            const sellDex = {
                dex: 'sushiswap',
                price0: new Decimal('2.1'),
                liquidityUSD: new Decimal('1000000'),
                reserves: ['1000000000000000000000', '2100000000000000000000'],
                pairAddress: '0xPAIR2'
            };
            const gasPrice = '20000000000';
            const blockNumber = 'latest';

            const opportunity = await tradingStrategyEngine.calculateArbitrageOpportunity(
                pair, buyDex, sellDex, gasPrice, blockNumber
            );

            expect(opportunity).toBeDefined();
            expect(opportunity.buyDex).toBe('uniswap');
            expect(opportunity.sellDex).toBe('sushiswap');
            expect(opportunity.pair).toEqual(pair);
            expect(opportunity.blockNumber).toBe(blockNumber);
        });

        test('should return null for small price difference', async () => {
            const pair = { tokenA: '0xTOKENA', tokenB: '0xTOKENB' };
            const buyDex = {
                dex: 'uniswap',
                price0: new Decimal('2.0'),
                liquidityUSD: new Decimal('1000000'),
                reserves: ['1000000000000000000000', '2000000000000000000000'],
                pairAddress: '0xPAIR1'
            };
            const sellDex = {
                dex: 'sushiswap',
                price0: new Decimal('2.001'), // Very small difference
                liquidityUSD: new Decimal('1000000'),
                reserves: ['1000000000000000000000', '2001000000000000000000'],
                pairAddress: '0xPAIR2'
            };
            const gasPrice = '20000000000';
            const blockNumber = 'latest';

            const opportunity = await tradingStrategyEngine.calculateArbitrageOpportunity(
                pair, buyDex, sellDex, gasPrice, blockNumber
            );

            expect(opportunity).toBeNull();
        });
    });

    describe('calculateOptimalTradeSize', () => {
        test('should calculate optimal trade size', () => {
            const buyDex = {
                reserves: ['1000000000000000000000', '2000000000000000000000']
            };
            const sellDex = {
                reserves: ['1000000000000000000000', '2100000000000000000000']
            };

            const optimalSize = tradingStrategyEngine.calculateOptimalTradeSize(buyDex, sellDex);

            expect(optimalSize).toBeInstanceOf(Decimal);
            expect(optimalSize.greaterThan(0)).toBe(true);
        });

        test('should handle calculation errors', () => {
            const buyDex = {
                reserves: ['0', '0'] // Invalid reserves
            };
            const sellDex = {
                reserves: ['0', '0']
            };

            const optimalSize = tradingStrategyEngine.calculateOptimalTradeSize(buyDex, sellDex);

            expect(optimalSize).toBeInstanceOf(Decimal);
            expect(optimalSize.equals(0)).toBe(true);
        });
    });

    describe('calculateGrossProfit', () => {
        test('should calculate gross profit correctly', () => {
            const amount = new Decimal('1000');
            const buyPrice = new Decimal('2.0');
            const sellPrice = new Decimal('2.1');

            const grossProfit = tradingStrategyEngine.calculateGrossProfit(amount, buyPrice, sellPrice);

            expect(grossProfit).toBeInstanceOf(Decimal);
            expect(grossProfit.greaterThan(0)).toBe(true);
        });

        test('should handle zero profit scenario', () => {
            const amount = new Decimal('1000');
            const buyPrice = new Decimal('2.0');
            const sellPrice = new Decimal('2.0'); // Same price

            const grossProfit = tradingStrategyEngine.calculateGrossProfit(amount, buyPrice, sellPrice);

            expect(grossProfit).toBeInstanceOf(Decimal);
            expect(grossProfit.equals(0)).toBe(true);
        });
    });

    describe('calculateGasCost', () => {
        test('should calculate gas cost correctly', async () => {
            const gasPrice = '20000000000'; // 20 gwei

            const gasCost = await tradingStrategyEngine.calculateGasCost(gasPrice);

            expect(gasCost).toBeInstanceOf(Decimal);
            expect(gasCost.greaterThan(0)).toBe(true);
        });

        test('should handle gas calculation errors', async () => {
            const gasPrice = 'invalid';

            const gasCost = await tradingStrategyEngine.calculateGasCost(gasPrice);

            expect(gasCost).toBeInstanceOf(Decimal);
            expect(gasCost.equals(0)).toBe(true);
        });
    });

    describe('calculateLiquidityUSD', () => {
        test('should calculate liquidity in USD', () => {
            const priceData = {
                reserve0: '1000000000000000000000',
                reserve1: '2000000000000000000000',
                price0: '2.0'
            };

            const liquidityUSD = tradingStrategyEngine.calculateLiquidityUSD(priceData);

            expect(liquidityUSD).toBeInstanceOf(Decimal);
            expect(liquidityUSD.greaterThan(0)).toBe(true);
        });

        test('should handle calculation errors', () => {
            const priceData = {
                reserve0: 'invalid',
                reserve1: 'invalid',
                price0: 'invalid'
            };

            const liquidityUSD = tradingStrategyEngine.calculateLiquidityUSD(priceData);

            expect(liquidityUSD).toBeInstanceOf(Decimal);
            expect(liquidityUSD.equals(0)).toBe(true);
        });
    });

    describe('qualifyOpportunity', () => {
        test('should qualify profitable opportunity', () => {
            const opportunity = {
                netProfitUSD: '50',
                profitMargin: '0.1',
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() + 60000
            };

            const qualified = tradingStrategyEngine.qualifyOpportunity(opportunity);

            expect(qualified).toBe(true);
            expect(opportunity.qualified).toBe(true);
        });

        test('should reject opportunity with insufficient profit', () => {
            const opportunity = {
                netProfitUSD: '5', // Below minimum
                profitMargin: '0.1',
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() + 60000
            };

            const qualified = tradingStrategyEngine.qualifyOpportunity(opportunity);

            expect(qualified).toBe(false);
        });

        test('should reject opportunity with low profit margin', () => {
            const opportunity = {
                netProfitUSD: '50',
                profitMargin: '0.001', // Below minimum
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() + 60000
            };

            const qualified = tradingStrategyEngine.qualifyOpportunity(opportunity);

            expect(qualified).toBe(false);
        });

        test('should reject opportunity with insufficient liquidity', () => {
            const opportunity = {
                netProfitUSD: '50',
                profitMargin: '0.1',
                buyLiquidityUSD: '50000', // Below minimum
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() + 60000
            };

            const qualified = tradingStrategyEngine.qualifyOpportunity(opportunity);

            expect(qualified).toBe(false);
        });

        test('should reject expired opportunity', () => {
            const opportunity = {
                netProfitUSD: '50',
                profitMargin: '0.1',
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() - 60000 // Expired
            };

            const qualified = tradingStrategyEngine.qualifyOpportunity(opportunity);

            expect(qualified).toBe(false);
        });
    });

    describe('generateOpportunityId', () => {
        test('should generate unique opportunity ID', () => {
            const pair = { tokenA: '0xTOKENA', tokenB: '0xTOKENB' };
            const buyDex = 'uniswap';
            const sellDex = 'sushiswap';
            const blockNumber = '12345';

            const id1 = tradingStrategyEngine.generateOpportunityId(pair, buyDex, sellDex, blockNumber);
            const id2 = tradingStrategyEngine.generateOpportunityId(pair, buyDex, sellDex, blockNumber);

            expect(id1).toContain('0xTOKENA-0xTOKENB-uniswap-sushiswap-12345');
            expect(id1).not.toBe(id2); // Should be different due to timestamp
        });
    });

    describe('getStats', () => {
        test('should return comprehensive statistics', () => {
            // Simulate some activity
            tradingStrategyEngine.stats.opportunitiesDetected = 100;
            tradingStrategyEngine.stats.opportunitiesQualified = 50;
            tradingStrategyEngine.stats.successfulRequests = 80;
            tradingStrategyEngine.stats.failedRequests = 20;

            const stats = tradingStrategyEngine.getStats();

            expect(stats).toHaveProperty('opportunitiesDetected', 100);
            expect(stats).toHaveProperty('opportunitiesQualified', 50);
            expect(stats).toHaveProperty('successRate', 0.5);
            expect(stats).toHaveProperty('averageDetectionLatency');
        });
    });

    describe('updateOpportunityStatus', () => {
        test('should update opportunity status', () => {
            const opportunityId = 'test-opportunity';
            const status = 'executed';
            const additionalData = { txHash: '0x123' };

            // Add opportunity to active opportunities
            tradingStrategyEngine.activeOpportunities.set(opportunityId, {
                id: opportunityId,
                netProfitUSD: '50',
                gasCostUSD: '10'
            });

            tradingStrategyEngine.updateOpportunityStatus(opportunityId, status, additionalData);

            const opportunity = tradingStrategyEngine.activeOpportunities.get(opportunityId);
            expect(opportunity.status).toBe(status);
            expect(opportunity.txHash).toBe('0x123');
        });

        test('should handle executed status correctly', () => {
            const opportunityId = 'test-opportunity';

            // Add opportunity to active opportunities
            tradingStrategyEngine.activeOpportunities.set(opportunityId, {
                id: opportunityId,
                netProfitUSD: '50',
                gasCostUSD: '10'
            });

            tradingStrategyEngine.updateOpportunityStatus(opportunityId, 'executed');

            // Should be moved to history
            expect(tradingStrategyEngine.activeOpportunities.has(opportunityId)).toBe(false);
            expect(tradingStrategyEngine.opportunityHistory).toHaveLength(1);
            expect(tradingStrategyEngine.stats.opportunitiesExecuted).toBe(1);
        });
    });

    describe('clearExpiredOpportunities', () => {
        test('should clear expired opportunities', () => {
            const now = Date.now();
            
            // Add expired and valid opportunities
            tradingStrategyEngine.activeOpportunities.set('expired1', {
                expiresAt: now - 1000
            });
            tradingStrategyEngine.activeOpportunities.set('valid1', {
                expiresAt: now + 1000
            });

            tradingStrategyEngine.clearExpiredOpportunities();

            expect(tradingStrategyEngine.activeOpportunities.has('expired1')).toBe(false);
            expect(tradingStrategyEngine.activeOpportunities.has('valid1')).toBe(true);
            expect(tradingStrategyEngine.performanceMetrics.missedOpportunities).toBe(1);
        });
    });

    describe('Performance Metrics', () => {
        test('should track detection latency', async () => {
            const tokenPairs = [
                { tokenA: '0xTOKENA', tokenB: '0xTOKENB' }
            ];

            mockWeb3Manager.getGasPrice.mockResolvedValue('20000000000');
            mockDEXPriceService.getPrice.mockResolvedValue({
                dexName: 'uniswap',
                price0: '2.0',
                price1: '0.5',
                reserve0: '1000000000000000000000',
                reserve1: '2000000000000000000000',
                pairAddress: '0xPAIR1'
            });

            await tradingStrategyEngine.detectOpportunities(tokenPairs);

            expect(tradingStrategyEngine.performanceMetrics.detectionLatency).toHaveLength(1);
            expect(tradingStrategyEngine.performanceMetrics.detectionLatency[0]).toBeGreaterThan(0);
        });
    });
});
