const RiskManager = require('../../src/services/trading/RiskManager');
const { Decimal } = require('decimal.js');

describe('RiskManager', () => {
    let riskManager;

    beforeEach(() => {
        riskManager = new RiskManager({
            maxPositionSizeUSD: 1000,
            maxPortfolioExposure: 0.1,
            maxSlippage: 0.01,
            maxPriceImpact: 0.005,
            minLiquidityRatio: 0.1,
            maxConcurrentPositions: 3,
            maxDailyLoss: 100,
            maxDrawdown: 0.2
        });
    });

    describe('Initialization', () => {
        test('should initialize with default options', () => {
            expect(riskManager.options.maxPositionSizeUSD).toBe(1000);
            expect(riskManager.options.maxPortfolioExposure).toBe(0.1);
            expect(riskManager.options.maxDailyLoss).toBe(100);
        });

        test('should initialize with custom options', () => {
            const customRiskManager = new RiskManager({
                maxPositionSizeUSD: 5000,
                maxPortfolioExposure: 0.2,
                maxDailyLoss: 500
            });

            expect(customRiskManager.options.maxPositionSizeUSD).toBe(5000);
            expect(customRiskManager.options.maxPortfolioExposure).toBe(0.2);
            expect(customRiskManager.options.maxDailyLoss).toBe(500);
        });

        test('should initialize state management', () => {
            expect(riskManager.activePositions).toBeInstanceOf(Map);
            expect(riskManager.positionHistory).toEqual([]);
            expect(riskManager.dailyStats.totalProfit).toBeInstanceOf(Decimal);
            expect(riskManager.dailyStats.totalLoss).toBeInstanceOf(Decimal);
            expect(riskManager.dailyStats.netProfit).toBeInstanceOf(Decimal);
        });
    });

    describe('assessRisk', () => {
        test('should approve profitable opportunity', async () => {
            const opportunity = {
                id: 'test-opportunity',
                netProfitUSD: '50',
                profitMargin: '0.1',
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() + 60000
            };

            const portfolioState = {
                totalValue: 10000,
                availableCapital: 5000
            };

            const assessment = await riskManager.assessRisk(opportunity, portfolioState);

            expect(assessment.approved).toBe(true);
            expect(assessment.riskScore).toBeLessThan(0.7);
            expect(assessment.maxPositionSize.greaterThan(0)).toBe(true);
            expect(assessment.warnings).toHaveLength(0);
        });

        test('should reject opportunity with insufficient profit', async () => {
            const opportunity = {
                id: 'test-opportunity',
                netProfitUSD: '5', // Below minimum
                profitMargin: '0.1',
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() + 60000
            };

            const portfolioState = {
                totalValue: 10000,
                availableCapital: 5000
            };

            const assessment = await riskManager.assessRisk(opportunity, portfolioState);

            expect(assessment.approved).toBe(false);
            expect(assessment.warnings).toContain('Profit too small relative to risk');
        });

        test('should reject opportunity with low profit margin', async () => {
            const opportunity = {
                id: 'test-opportunity',
                netProfitUSD: '50',
                profitMargin: '0.001', // Below minimum
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() + 60000
            };

            const portfolioState = {
                totalValue: 10000,
                availableCapital: 5000
            };

            const assessment = await riskManager.assessRisk(opportunity, portfolioState);

            expect(assessment.approved).toBe(false);
            expect(assessment.warnings).toContain('Profit margin too low');
        });

        test('should reject expired opportunity', async () => {
            const opportunity = {
                id: 'test-opportunity',
                netProfitUSD: '50',
                profitMargin: '0.1',
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() - 60000 // Expired
            };

            const portfolioState = {
                totalValue: 10000,
                availableCapital: 5000
            };

            const assessment = await riskManager.assessRisk(opportunity, portfolioState);

            expect(assessment.approved).toBe(false);
            expect(assessment.warnings).toContain('Opportunity has expired');
        });

        test('should reject when max concurrent positions reached', async () => {
            // Add max concurrent positions
            for (let i = 0; i < 3; i++) {
                riskManager.activePositions.set(`position-${i}`, {});
            }

            const opportunity = {
                id: 'test-opportunity',
                netProfitUSD: '50',
                profitMargin: '0.1',
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() + 60000
            };

            const portfolioState = {
                totalValue: 10000,
                availableCapital: 5000
            };

            const assessment = await riskManager.assessRisk(opportunity, portfolioState);

            expect(assessment.approved).toBe(false);
            expect(assessment.warnings).toContain('Maximum concurrent positions reached');
        });

        test('should reject opportunity with insufficient liquidity', async () => {
            const opportunity = {
                id: 'test-opportunity',
                netProfitUSD: '50',
                profitMargin: '0.1',
                buyLiquidityUSD: '50000', // Below minimum
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() + 60000
            };

            const portfolioState = {
                totalValue: 10000,
                availableCapital: 5000
            };

            const assessment = await riskManager.assessRisk(opportunity, portfolioState);

            expect(assessment.approved).toBe(false);
            expect(assessment.warnings.some(w => w.includes('Buy liquidity insufficient'))).toBe(true);
        });

        test('should reject opportunity with high price impact', async () => {
            const opportunity = {
                id: 'test-opportunity',
                netProfitUSD: '50',
                profitMargin: '0.1',
                buyLiquidityUSD: '100000', // Low liquidity for high impact
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() + 60000
            };

            const portfolioState = {
                totalValue: 10000,
                availableCapital: 5000
            };

            const assessment = await riskManager.assessRisk(opportunity, portfolioState);

            expect(assessment.approved).toBe(false);
            expect(assessment.warnings.some(w => w.includes('Buy price impact too high'))).toBe(true);
        });

        test('should reject when daily loss limit exceeded', async () => {
            // Set daily loss to exceed limit
            riskManager.dailyStats.totalLoss = new Decimal(100);

            const opportunity = {
                id: 'test-opportunity',
                netProfitUSD: '50',
                profitMargin: '0.1',
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000',
                expiresAt: Date.now() + 60000
            };

            const portfolioState = {
                totalValue: 10000,
                availableCapital: 5000
            };

            const assessment = await riskManager.assessRisk(opportunity, portfolioState);

            expect(assessment.approved).toBe(false);
            expect(assessment.warnings).toContain('Daily loss limit exceeded');
        });
    });

    describe('calculatePositionSize', () => {
        test('should calculate position size using Kelly Criterion', () => {
            const opportunity = {
                netProfitUSD: '50',
                profitMargin: '0.1'
            };

            const portfolioState = {
                availableCapital: 5000
            };

            const result = riskManager.calculatePositionSize(opportunity, portfolioState);

            expect(result.size).toBeInstanceOf(Decimal);
            expect(result.size.greaterThan(0)).toBe(true);
            expect(result.size.lessThanOrEqualTo(1000)).toBe(true); // Max position size
            expect(result.kellyFraction).toBeDefined();
            expect(result.conservativeKelly).toBeDefined();
        });

        test('should respect maximum position size limit', () => {
            const opportunity = {
                netProfitUSD: '1000',
                profitMargin: '0.5' // High margin
            };

            const portfolioState = {
                availableCapital: 10000
            };

            const result = riskManager.calculatePositionSize(opportunity, portfolioState);

            expect(result.size.lessThanOrEqualTo(1000)).toBe(true); // Max position size
        });

        test('should ensure minimum position size', () => {
            const opportunity = {
                netProfitUSD: '1',
                profitMargin: '0.001' // Very low margin
            };

            const portfolioState = {
                availableCapital: 100
            };

            const result = riskManager.calculatePositionSize(opportunity, portfolioState);

            expect(result.size.greaterThanOrEqualTo(100)).toBe(true); // Minimum position size
        });
    });

    describe('checkLiquidityRequirements', () => {
        test('should approve when liquidity is sufficient', () => {
            const opportunity = {
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000'
            };

            const positionSize = new Decimal(500);

            const result = riskManager.checkLiquidityRequirements(opportunity, positionSize);

            expect(result.approved).toBe(true);
            expect(result.warnings).toHaveLength(0);
        });

        test('should reject when buy liquidity insufficient', () => {
            const opportunity = {
                buyLiquidityUSD: '1000', // Very low liquidity
                sellLiquidityUSD: '1000000'
            };

            const positionSize = new Decimal(500);

            const result = riskManager.checkLiquidityRequirements(opportunity, positionSize);

            expect(result.approved).toBe(false);
            expect(result.warnings.some(w => w.includes('Buy liquidity insufficient'))).toBe(true);
        });

        test('should reject when sell liquidity insufficient', () => {
            const opportunity = {
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000' // Very low liquidity
            };

            const positionSize = new Decimal(500);

            const result = riskManager.checkLiquidityRequirements(opportunity, positionSize);

            expect(result.approved).toBe(false);
            expect(result.warnings.some(w => w.includes('Sell liquidity insufficient'))).toBe(true);
        });
    });

    describe('checkPriceImpact', () => {
        test('should approve when price impact is acceptable', () => {
            const opportunity = {
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000'
            };

            const positionSize = new Decimal(100);

            const result = riskManager.checkPriceImpact(opportunity, positionSize);

            expect(result.approved).toBe(true);
            expect(result.warnings).toHaveLength(0);
        });

        test('should reject when buy price impact too high', () => {
            const opportunity = {
                buyLiquidityUSD: '1000', // Low liquidity
                sellLiquidityUSD: '1000000'
            };

            const positionSize = new Decimal(100);

            const result = riskManager.checkPriceImpact(opportunity, positionSize);

            expect(result.approved).toBe(false);
            expect(result.warnings.some(w => w.includes('Buy price impact too high'))).toBe(true);
        });

        test('should reject when sell price impact too high', () => {
            const opportunity = {
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000' // Low liquidity
            };

            const positionSize = new Decimal(100);

            const result = riskManager.checkPriceImpact(opportunity, positionSize);

            expect(result.approved).toBe(false);
            expect(result.warnings.some(w => w.includes('Sell price impact too high'))).toBe(true);
        });
    });

    describe('checkPortfolioExposure', () => {
        test('should approve when exposure is within limits', () => {
            const opportunity = {
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000'
            };

            const positionSize = new Decimal(500);

            const portfolioState = {
                totalValue: 10000
            };

            const result = riskManager.checkPortfolioExposure(opportunity, positionSize, portfolioState);

            expect(result.approved).toBe(true);
            expect(result.warnings).toHaveLength(0);
        });

        test('should reject when portfolio exposure too high', () => {
            // Set high current exposure
            riskManager.riskMetrics.currentExposure = new Decimal(800);

            const opportunity = {
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000'
            };

            const positionSize = new Decimal(500);

            const portfolioState = {
                totalValue: 10000
            };

            const result = riskManager.checkPortfolioExposure(opportunity, positionSize, portfolioState);

            expect(result.approved).toBe(false);
            expect(result.warnings.some(w => w.includes('Portfolio exposure too high'))).toBe(true);
        });

        test('should reject when position size exceeds maximum', () => {
            const opportunity = {
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000'
            };

            const positionSize = new Decimal(2000); // Exceeds max

            const portfolioState = {
                totalValue: 10000
            };

            const result = riskManager.checkPortfolioExposure(opportunity, positionSize, portfolioState);

            expect(result.approved).toBe(false);
            expect(result.warnings.some(w => w.includes('Position size too large'))).toBe(true);
        });
    });

    describe('checkDailyLossLimits', () => {
        test('should approve when within daily loss limits', () => {
            const opportunity = {
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000'
            };

            const positionSize = new Decimal(500);

            const result = riskManager.checkDailyLossLimits(opportunity, positionSize);

            expect(result.approved).toBe(true);
            expect(result.warnings).toHaveLength(0);
        });

        test('should reject when daily loss limit exceeded', () => {
            // Set daily loss to exceed limit
            riskManager.dailyStats.totalLoss = new Decimal(100);

            const opportunity = {
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000'
            };

            const positionSize = new Decimal(500);

            const result = riskManager.checkDailyLossLimits(opportunity, positionSize);

            expect(result.approved).toBe(false);
            expect(result.warnings).toContain('Daily loss limit exceeded');
        });

        test('should reject when potential loss exceeds remaining limit', () => {
            // Set daily loss close to limit
            riskManager.dailyStats.totalLoss = new Decimal(90);

            const opportunity = {
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000'
            };

            const positionSize = new Decimal(200); // Large position

            const result = riskManager.checkDailyLossLimits(opportunity, positionSize);

            expect(result.approved).toBe(false);
            expect(result.warnings.some(w => w.includes('Position size could exceed remaining daily loss limit'))).toBe(true);
        });
    });

    describe('calculateRiskScore', () => {
        test('should calculate risk score correctly', () => {
            const opportunity = {
                profitMargin: '0.1',
                buyLiquidityUSD: '1000000',
                sellLiquidityUSD: '1000000',
                gasCostUSD: '10',
                netProfitUSD: '50'
            };

            const positionSize = new Decimal(500);

            const riskScore = riskManager.calculateRiskScore(opportunity, positionSize);

            expect(riskScore).toBeGreaterThanOrEqual(0);
            expect(riskScore).toBeLessThanOrEqual(1);
        });

        test('should return maximum risk for calculation errors', () => {
            const opportunity = {
                profitMargin: 'invalid',
                buyLiquidityUSD: 'invalid',
                sellLiquidityUSD: 'invalid',
                gasCostUSD: 'invalid',
                netProfitUSD: 'invalid'
            };

            const positionSize = new Decimal(500);

            const riskScore = riskManager.calculateRiskScore(opportunity, positionSize);

            expect(riskScore).toBe(1.0);
        });
    });

    describe('recordPositionOpen', () => {
        test('should record position opening correctly', () => {
            const opportunity = {
                id: 'test-opportunity',
                pair: { tokenA: '0xTOKENA', tokenB: '0xTOKENB' },
                buyDex: 'uniswap',
                sellDex: 'sushiswap',
                netProfitUSD: '50'
            };

            const positionSize = new Decimal(500);
            const transactionId = 'tx-123';

            riskManager.recordPositionOpen(opportunity, positionSize, transactionId);

            const position = riskManager.activePositions.get(transactionId);
            expect(position).toBeDefined();
            expect(position.opportunityId).toBe('test-opportunity');
            expect(position.positionSize).toBe('500');
            expect(position.status).toBe('open');
            expect(riskManager.riskMetrics.currentExposure.equals(positionSize)).toBe(true);
        });
    });

    describe('recordPositionClose', () => {
        test('should record position closing correctly', () => {
            const transactionId = 'tx-123';
            const result = {
                actualProfit: '45',
                gasCost: '5'
            };

            // Add position first
            riskManager.activePositions.set(transactionId, {
                id: transactionId,
                positionSize: '500',
                expectedProfit: '50'
            });

            // Set initial exposure
            riskManager.riskMetrics.currentExposure = new Decimal(500);

            riskManager.recordPositionClose(transactionId, result);

            // Should be moved to history
            expect(riskManager.activePositions.has(transactionId)).toBe(false);
            expect(riskManager.positionHistory).toHaveLength(1);
            expect(riskManager.dailyStats.tradesCount).toBe(1);
            expect(riskManager.riskMetrics.currentExposure.equals(0)).toBe(true);
        });

        test('should handle profit correctly', () => {
            const transactionId = 'tx-123';
            const result = {
                actualProfit: '60',
                gasCost: '5'
            };

            // Add position first
            riskManager.activePositions.set(transactionId, {
                id: transactionId,
                positionSize: '500',
                expectedProfit: '50'
            });

            riskManager.recordPositionClose(transactionId, result);

            expect(riskManager.dailyStats.totalProfit.greaterThan(0)).toBe(true);
            expect(riskManager.dailyStats.netProfit.greaterThan(0)).toBe(true);
        });

        test('should handle loss correctly', () => {
            const transactionId = 'tx-123';
            const result = {
                actualProfit: '40',
                gasCost: '15'
            };

            // Add position first
            riskManager.activePositions.set(transactionId, {
                id: transactionId,
                positionSize: '500',
                expectedProfit: '50'
            });

            riskManager.recordPositionClose(transactionId, result);

            expect(riskManager.dailyStats.totalLoss.greaterThan(0)).toBe(true);
            expect(riskManager.dailyStats.netProfit.lessThan(0)).toBe(true);
        });
    });

    describe('getRiskMetrics', () => {
        test('should return comprehensive risk metrics', () => {
            const metrics = riskManager.getRiskMetrics();

            expect(metrics).toHaveProperty('currentExposure');
            expect(metrics).toHaveProperty('maxExposure');
            expect(metrics).toHaveProperty('currentDrawdown');
            expect(metrics).toHaveProperty('peakValue');
            expect(metrics).toHaveProperty('maxDrawdown');
            expect(metrics).toHaveProperty('activePositions');
            expect(metrics).toHaveProperty('dailyStats');
            expect(metrics).toHaveProperty('positionHistory');
        });
    });

    describe('getDailyStats', () => {
        test('should return daily statistics', () => {
            const stats = riskManager.getDailyStats();

            expect(stats).toHaveProperty('totalProfit');
            expect(stats).toHaveProperty('totalLoss');
            expect(stats).toHaveProperty('netProfit');
            expect(stats).toHaveProperty('tradesCount');
            expect(stats).toHaveProperty('startTime');
        });
    });

    describe('resetDailyStats', () => {
        test('should reset daily statistics', () => {
            // Set some initial stats
            riskManager.dailyStats.totalProfit = new Decimal(100);
            riskManager.dailyStats.totalLoss = new Decimal(20);
            riskManager.dailyStats.netProfit = new Decimal(80);
            riskManager.dailyStats.tradesCount = 5;

            riskManager.resetDailyStats();

            expect(riskManager.dailyStats.totalProfit.equals(0)).toBe(true);
            expect(riskManager.dailyStats.totalLoss.equals(0)).toBe(true);
            expect(riskManager.dailyStats.netProfit.equals(0)).toBe(true);
            expect(riskManager.dailyStats.tradesCount).toBe(0);
        });
    });

    describe('checkTradingPause', () => {
        test('should not pause when within limits', () => {
            const pauseStatus = riskManager.checkTradingPause();

            expect(pauseStatus.paused).toBe(false);
            expect(pauseStatus.reason).toBeNull();
        });

        test('should pause when daily loss limit exceeded', () => {
            riskManager.dailyStats.totalLoss = new Decimal(100);

            const pauseStatus = riskManager.checkTradingPause();

            expect(pauseStatus.paused).toBe(true);
            expect(pauseStatus.reason).toBe('Daily loss limit exceeded');
        });

        test('should pause when drawdown limit exceeded', () => {
            riskManager.riskMetrics.peakValue = new Decimal(1000);
            riskManager.dailyStats.netProfit = new Decimal(700); // 30% drawdown

            const pauseStatus = riskManager.checkTradingPause();

            expect(pauseStatus.paused).toBe(true);
            expect(pauseStatus.reason).toBe('Maximum drawdown exceeded');
        });

        test('should pause when exposure limit exceeded', () => {
            riskManager.riskMetrics.currentExposure = new Decimal(2000); // Exceeds max

            const pauseStatus = riskManager.checkTradingPause();

            expect(pauseStatus.paused).toBe(true);
            expect(pauseStatus.reason).toBe('Portfolio exposure limit exceeded');
        });
    });

    describe('getPosition', () => {
        test('should return position when exists', () => {
            const transactionId = 'tx-123';
            const position = { id: transactionId, status: 'open' };

            riskManager.activePositions.set(transactionId, position);

            const result = riskManager.getPosition(transactionId);

            expect(result).toEqual(position);
        });

        test('should return null when position does not exist', () => {
            const result = riskManager.getPosition('nonexistent');

            expect(result).toBeNull();
        });
    });

    describe('getActivePositions', () => {
        test('should return all active positions', () => {
            const position1 = { id: 'tx-1', status: 'open' };
            const position2 = { id: 'tx-2', status: 'open' };

            riskManager.activePositions.set('tx-1', position1);
            riskManager.activePositions.set('tx-2', position2);

            const positions = riskManager.getActivePositions();

            expect(positions).toHaveLength(2);
            expect(positions).toContain(position1);
            expect(positions).toContain(position2);
        });

        test('should return empty array when no active positions', () => {
            const positions = riskManager.getActivePositions();

            expect(positions).toEqual([]);
        });
    });
});
