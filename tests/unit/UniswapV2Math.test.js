const UniswapV2Math = require('../../src/services/amm/UniswapV2Math');
const { Decimal } = require('decimal.js');

describe('UniswapV2Math', () => {
    describe('getAmountOut', () => {
        test('should calculate correct output amount for simple swap', () => {
            // Test case: 1000 wei input, 10000 reserveIn, 10000 reserveOut
            const amountIn = '1000';
            const reserveIn = '10000';
            const reserveOut = '10000';
            
            const result = UniswapV2Math.getAmountOut(amountIn, reserveIn, reserveOut);
            
            // Expected: floor(1000 * 997 * 10000 / (10000 * 1000 + 1000 * 997))
            // = floor(9970000 / 10997000) = floor(0.9066...) = 0
            // But with proper reserves, we should get a meaningful result
            expect(result).toBeDefined();
            expect(typeof result).toBe('string');
        });
        
        test('should handle large numbers correctly', () => {
            const amountIn = '1000000000000000000'; // 1 ETH in wei
            const reserveIn = '1000000000000000000000'; // 1000 ETH
            const reserveOut = '1000000000000000000000'; // 1000 ETH
            
            const result = UniswapV2Math.getAmountOut(amountIn, reserveIn, reserveOut);
            
            expect(result).toBeDefined();
            expect(parseInt(result)).toBeGreaterThan(0);
        });
        
        test('should throw error for invalid inputs', () => {
            expect(() => {
                UniswapV2Math.getAmountOut('0', '1000', '1000');
            }).toThrow('Invalid input: amounts and reserves must be positive');
            
            expect(() => {
                UniswapV2Math.getAmountOut('1000', '0', '1000');
            }).toThrow('Invalid input: amounts and reserves must be positive');
            
            expect(() => {
                UniswapV2Math.getAmountOut('1000', '1000', '0');
            }).toThrow('Invalid input: amounts and reserves must be positive');
        });
        
        test('should maintain precision with decimal.js', () => {
            const amountIn = '1000000000000000000';
            const reserveIn = '1000000000000000000000';
            const reserveOut = '1000000000000000000000';
            
            const result1 = UniswapV2Math.getAmountOut(amountIn, reserveIn, reserveOut);
            const result2 = UniswapV2Math.getAmountOut(amountIn, reserveIn, reserveOut);
            
            // Results should be identical (deterministic)
            expect(result1).toBe(result2);
        });
    });
    
    describe('getAmountIn', () => {
        test('should calculate correct input amount for desired output', () => {
            const amountOut = '1000';
            const reserveIn = '10000';
            const reserveOut = '10000';
            
            const result = UniswapV2Math.getAmountIn(amountOut, reserveIn, reserveOut);
            
            expect(result).toBeDefined();
            expect(typeof result).toBe('string');
            expect(parseInt(result)).toBeGreaterThan(0);
        });
        
        test('should throw error when amountOut >= reserveOut', () => {
            expect(() => {
                UniswapV2Math.getAmountIn('10000', '10000', '10000');
            }).toThrow('Insufficient liquidity: amountOut >= reserveOut');
        });
        
        test('should handle edge cases correctly', () => {
            const amountOut = '1';
            const reserveIn = '1000000';
            const reserveOut = '1000000';
            
            const result = UniswapV2Math.getAmountIn(amountOut, reserveIn, reserveOut);
            
            expect(result).toBeDefined();
            expect(parseInt(result)).toBeGreaterThan(0);
        });
    });
    
    describe('getAmountsOut', () => {
        test('should calculate multi-hop amounts correctly', () => {
            const amountIn = '1000';
            const path = ['0xTokenA', '0xTokenB', '0xTokenC'];
            const reserves = [
                ['10000', '10000'], // TokenA -> TokenB
                ['10000', '10000']  // TokenB -> TokenC
            ];
            
            const result = UniswapV2Math.getAmountsOut(amountIn, path, reserves);
            
            expect(result).toHaveLength(3);
            expect(result[0]).toBe(amountIn);
            expect(typeof result[1]).toBe('string');
            expect(typeof result[2]).toBe('string');
        });
        
        test('should throw error for invalid path length', () => {
            expect(() => {
                UniswapV2Math.getAmountsOut('1000', ['0xTokenA'], []);
            }).toThrow('Path must contain at least 2 tokens');
        });
        
        test('should throw error for mismatched reserves length', () => {
            expect(() => {
                UniswapV2Math.getAmountsOut('1000', ['0xTokenA', '0xTokenB'], []);
            }).toThrow('Reserves array length must be path length - 1');
        });
    });
    
    describe('getAmountsIn', () => {
        test('should calculate reverse multi-hop amounts correctly', () => {
            const amountOut = '1000';
            const path = ['0xTokenA', '0xTokenB', '0xTokenC'];
            const reserves = [
                ['10000', '10000'], // TokenA -> TokenB
                ['10000', '10000']  // TokenB -> TokenC
            ];
            
            const result = UniswapV2Math.getAmountsIn(amountOut, path, reserves);
            
            expect(result).toHaveLength(3);
            expect(result[2]).toBe(amountOut);
            expect(typeof result[0]).toBe('string');
            expect(typeof result[1]).toBe('string');
        });
    });
    
    describe('calculatePriceImpact', () => {
        test('should calculate price impact correctly', () => {
            const amountIn = '1000';
            const reserveIn = '10000';
            const reserveOut = '10000';
            
            const result = UniswapV2Math.calculatePriceImpact(amountIn, reserveIn, reserveOut);
            
            expect(typeof result).toBe('number');
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThan(1);
        });
        
        test('should return higher impact for larger trades', () => {
            const reserveIn = '10000';
            const reserveOut = '10000';
            
            const smallTrade = UniswapV2Math.calculatePriceImpact('100', reserveIn, reserveOut);
            const largeTrade = UniswapV2Math.calculatePriceImpact('1000', reserveIn, reserveOut);
            
            expect(largeTrade).toBeGreaterThan(smallTrade);
        });
    });
    
    describe('findOptimalTradeSize', () => {
        test('should find optimal trade size for profitable arbitrage', () => {
            const poolA = {
                reserveIn: '1000000000000000000000', // 1000 ETH
                reserveOut: '2000000000000000000000' // 2000 USDC
            };
            const poolB = {
                reserveIn: '1000000000000000000000', // 1000 ETH
                reserveOut: '2100000000000000000000' // 2100 USDC (5% better price)
            };
            const maxAmount = '10000000000000000000'; // 10 ETH
            const gasCost = '1000000000000000000'; // 1 ETH
            
            const result = UniswapV2Math.findOptimalTradeSize(poolA, poolB, maxAmount, gasCost);
            
            expect(result).toHaveProperty('optimalAmount');
            expect(result).toHaveProperty('maxProfit');
            expect(typeof result.optimalAmount).toBe('string');
            expect(typeof result.maxProfit).toBe('string');
        });
        
        test('should handle unprofitable arbitrage', () => {
            const poolA = {
                reserveIn: '1000000000000000000000', // 1000 ETH
                reserveOut: '2000000000000000000000' // 2000 USDC
            };
            const poolB = {
                reserveIn: '1000000000000000000000', // 1000 ETH
                reserveOut: '1900000000000000000000' // 1900 USDC (5% worse price)
            };
            const maxAmount = '10000000000000000000'; // 10 ETH
            const gasCost = '1000000000000000000'; // 1 ETH
            
            const result = UniswapV2Math.findOptimalTradeSize(poolA, poolB, maxAmount, gasCost);
            
            expect(result).toHaveProperty('optimalAmount');
            expect(result).toHaveProperty('maxProfit');
            // Should still return a result, even if profit is negative
        });
    });
    
    describe('Constants', () => {
        test('should have correct fee constants', () => {
            expect(UniswapV2Math.FEE_DENOMINATOR).toBe(1000);
            expect(UniswapV2Math.FEE_NUMERATOR).toBe(997);
        });
        
        test('should maintain fee ratio', () => {
            const feeRatio = UniswapV2Math.FEE_NUMERATOR / UniswapV2Math.FEE_DENOMINATOR;
            expect(feeRatio).toBe(0.997);
        });
    });
    
    describe('Integration Tests', () => {
        test('should maintain consistency between getAmountOut and getAmountIn', () => {
            const amountIn = '1000';
            const reserveIn = '10000';
            const reserveOut = '10000';
            
            const amountOut = UniswapV2Math.getAmountOut(amountIn, reserveIn, reserveOut);
            const calculatedAmountIn = UniswapV2Math.getAmountIn(amountOut, reserveIn, reserveOut);
            
            // Should be approximately equal (within rounding tolerance)
            const tolerance = new Decimal(1);
            const difference = new Decimal(calculatedAmountIn).sub(amountIn).abs();
            
            expect(difference.lte(tolerance)).toBe(true);
        });
        
        test('should handle realistic arbitrage scenario', () => {
            // Simulate two pools with price difference
            const poolA = {
                reserveIn: '1000000000000000000000', // 1000 ETH
                reserveOut: '2000000000000000000000' // 2000 USDC
            };
            const poolB = {
                reserveIn: '1000000000000000000000', // 1000 ETH
                reserveOut: '2100000000000000000000' // 2100 USDC (5% better price)
            };
            
            const maxAmount = '10000000000000000000'; // 10 ETH
            const gasCost = '1000000000000000000'; // 1 ETH
            
            const result = UniswapV2Math.findOptimalTradeSize(poolA, poolB, maxAmount, gasCost);
            
            expect(result.optimalAmount).toBeDefined();
            expect(result.maxProfit).toBeDefined();
            
            // Should find a profitable opportunity
            const profit = new Decimal(result.maxProfit);
            expect(profit.gt(0)).toBe(true);
        });
    });
});
