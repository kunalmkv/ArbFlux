const { Decimal } = require('decimal.js');
const { UNISWAP_V2_CONSTANTS } = require('../../utils/constants');
const logger = require('../../utils/logger');

/**
 * Uniswap V2 Mathematical Engine
 * Implements exact AMM calculations with proper rounding and fee handling
 * Based on the constant product formula: x * y = k
 */
class UniswapV2Math {
    static FEE_DENOMINATOR = UNISWAP_V2_CONSTANTS.FEE_DENOMINATOR;
    static FEE_NUMERATOR = UNISWAP_V2_CONSTANTS.FEE_NUMERATOR;
    
    /**
     * Calculate exact output amount for a given input amount
     * Formula: amountOut = floor(amountIn * γ * rOut / (rIn + amountIn * γ))
     * where γ = 0.997 (fee numerator / fee denominator)
     * 
     * @param {string|number} amountIn - Input amount (in wei)
     * @param {string|number} reserveIn - Reserve of input token
     * @param {string|number} reserveOut - Reserve of output token
     * @returns {string} Output amount in wei (as string for precision)
     */
    static getAmountOut(amountIn, reserveIn, reserveOut) {
        try {
            // Convert to Decimal for precise calculations
            const amountInDecimal = new Decimal(amountIn);
            const reserveInDecimal = new Decimal(reserveIn);
            const reserveOutDecimal = new Decimal(reserveOut);
            
            // Validate inputs with more detailed error messages
            if (amountInDecimal.lte(0)) {
                throw new Error(`Invalid amountIn: ${amountIn} (must be positive)`);
            }
            if (reserveInDecimal.lte(0)) {
                throw new Error(`Invalid reserveIn: ${reserveIn} (must be positive)`);
            }
            if (reserveOutDecimal.lte(0)) {
                throw new Error(`Invalid reserveOut: ${reserveOut} (must be positive)`);
            }
            
            // Calculate amountInWithFee = amountIn * 997
            const amountInWithFee = amountInDecimal.mul(this.FEE_NUMERATOR);
            
            // Calculate numerator = amountInWithFee * reserveOut
            const numerator = amountInWithFee.mul(reserveOutDecimal);
            
            // Calculate denominator = (reserveIn * 1000) + amountInWithFee
            const denominator = reserveInDecimal.mul(this.FEE_DENOMINATOR).add(amountInWithFee);
            
            // Calculate amountOut = floor(numerator / denominator)
            const amountOut = numerator.div(denominator).floor();
            
            logger.debug('getAmountOut calculation', {
                amountIn: amountInDecimal.toString(),
                reserveIn: reserveInDecimal.toString(),
                reserveOut: reserveOutDecimal.toString(),
                amountOut: amountOut.toString()
            });
            
            return amountOut.toString();
        } catch (error) {
            logger.error('Error in getAmountOut calculation', { 
                error: error.message,
                amountIn,
                reserveIn,
                reserveOut
            });
            throw error;
        }
    }
    
    /**
     * Calculate exact input amount for a given output amount
     * Formula: amountIn = ceil((reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997)) + 1
     * 
     * @param {string|number} amountOut - Desired output amount (in wei)
     * @param {string|number} reserveIn - Reserve of input token
     * @param {string|number} reserveOut - Reserve of output token
     * @returns {string} Input amount in wei (as string for precision)
     */
    static getAmountIn(amountOut, reserveIn, reserveOut) {
        try {
            // Convert to Decimal for precise calculations
            const amountOutDecimal = new Decimal(amountOut);
            const reserveInDecimal = new Decimal(reserveIn);
            const reserveOutDecimal = new Decimal(reserveOut);
            
            // Validate inputs
            if (amountOutDecimal.lte(0) || reserveInDecimal.lte(0) || reserveOutDecimal.lte(0)) {
                throw new Error('Invalid input: amounts and reserves must be positive');
            }
            
            if (amountOutDecimal.gte(reserveOutDecimal)) {
                throw new Error('Insufficient liquidity: amountOut >= reserveOut');
            }
            
            // Calculate numerator = reserveIn * amountOut * 1000
            const numerator = reserveInDecimal.mul(amountOutDecimal).mul(this.FEE_DENOMINATOR);
            
            // Calculate denominator = (reserveOut - amountOut) * 997
            const denominator = reserveOutDecimal.sub(amountOutDecimal).mul(this.FEE_NUMERATOR);
            
            // Calculate amountIn = ceil(numerator / denominator) + 1
            const amountIn = numerator.div(denominator).ceil().add(1);
            
            logger.debug('getAmountIn calculation', {
                amountOut: amountOutDecimal.toString(),
                reserveIn: reserveInDecimal.toString(),
                reserveOut: reserveOutDecimal.toString(),
                amountIn: amountIn.toString()
            });
            
            return amountIn.toString();
        } catch (error) {
            logger.error('Error in getAmountIn calculation', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Calculate amounts for multi-hop swaps
     * Applies the getAmountOut formula hop-by-hop
     * 
     * @param {string|number} amountIn - Initial input amount
     * @param {Array} path - Array of token addresses representing the swap path
     * @param {Array} reserves - Array of [reserveIn, reserveOut] pairs for each hop
     * @returns {Array} Array of amounts for each token in the path
     */
    static getAmountsOut(amountIn, path, reserves) {
        try {
            if (path.length < 2) {
                throw new Error('Path must contain at least 2 tokens');
            }
            
            if (reserves.length !== path.length - 1) {
                throw new Error('Reserves array length must be path length - 1');
            }
            
            const amounts = new Array(path.length);
            amounts[0] = amountIn;
            
            // Calculate amounts for each hop
            for (let i = 0; i < path.length - 1; i++) {
                const [reserveIn, reserveOut] = reserves[i];
                amounts[i + 1] = this.getAmountOut(amounts[i], reserveIn, reserveOut);
            }
            
            logger.debug('getAmountsOut calculation', {
                path,
                amounts: amounts.map(amount => amount.toString())
            });
            
            return amounts;
        } catch (error) {
            logger.error('Error in getAmountsOut calculation', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Calculate input amounts for multi-hop swaps (reverse of getAmountsOut)
     * 
     * @param {string|number} amountOut - Final output amount
     * @param {Array} path - Array of token addresses representing the swap path
     * @param {Array} reserves - Array of [reserveIn, reserveOut] pairs for each hop
     * @returns {Array} Array of amounts for each token in the path
     */
    static getAmountsIn(amountOut, path, reserves) {
        try {
            if (path.length < 2) {
                throw new Error('Path must contain at least 2 tokens');
            }
            
            if (reserves.length !== path.length - 1) {
                throw new Error('Reserves array length must be path length - 1');
            }
            
            const amounts = new Array(path.length);
            amounts[amounts.length - 1] = amountOut;
            
            // Calculate amounts backwards for each hop
            for (let i = path.length - 1; i > 0; i--) {
                const [reserveIn, reserveOut] = reserves[i - 1];
                amounts[i - 1] = this.getAmountIn(amounts[i], reserveIn, reserveOut);
            }
            
            logger.debug('getAmountsIn calculation', {
                path,
                amounts: amounts.map(amount => amount.toString())
            });
            
            return amounts;
        } catch (error) {
            logger.error('Error in getAmountsIn calculation', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Calculate price impact for a given trade
     * 
     * @param {string|number} amountIn - Input amount
     * @param {string|number} reserveIn - Reserve of input token
     * @param {string|number} reserveOut - Reserve of output token
     * @returns {number} Price impact as a decimal (0.01 = 1%)
     */
    static calculatePriceImpact(amountIn, reserveIn, reserveOut) {
        try {
            const amountInDecimal = new Decimal(amountIn);
            const reserveInDecimal = new Decimal(reserveIn);
            const reserveOutDecimal = new Decimal(reserveOut);
            
            // Calculate spot price before trade
            const spotPrice = reserveOutDecimal.div(reserveInDecimal);
            
            // Calculate execution price after trade
            const amountOut = this.getAmountOut(amountIn, reserveIn, reserveOut);
            const amountOutDecimal = new Decimal(amountOut);
            const executionPrice = amountOutDecimal.div(amountInDecimal);
            
            // Calculate price impact
            const priceImpact = spotPrice.sub(executionPrice).div(spotPrice);
            
            return priceImpact.toNumber();
        } catch (error) {
            logger.error('Error calculating price impact', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Calculate optimal trade size using binary search
     * Finds the trade size that maximizes profit
     * 
     * @param {Object} poolA - First pool data
     * @param {Object} poolB - Second pool data
     * @param {string|number} maxAmount - Maximum trade size to consider
     * @param {string|number} gasCost - Gas cost in wei
     * @returns {Object} { optimalAmount, maxProfit }
     */
    static findOptimalTradeSize(poolA, poolB, maxAmount, gasCost) {
        try {
            const maxAmountDecimal = new Decimal(maxAmount);
            const gasCostDecimal = new Decimal(gasCost);
            
            let low = new Decimal(1); // Start from 1 to avoid zero
            let high = maxAmountDecimal;
            let optimalAmount = new Decimal(0);
            let maxProfit = new Decimal(0);
            
            // Binary search for optimal trade size
            while (high.sub(low).gt(1)) {
                const mid = low.add(high).div(2).floor();
                
                // Skip if mid is zero
                if (mid.lte(0)) {
                    low = mid.add(1);
                    continue;
                }
                
                try {
                    // Calculate A→B on first pool
                    const amountOutB = this.getAmountOut(
                        mid.toString(),
                        poolA.reserveIn,
                        poolA.reserveOut
                    );
                    
                    // Calculate B→A on second pool
                    const amountOutA = this.getAmountOut(
                        amountOutB,
                        poolB.reserveIn,
                        poolB.reserveOut
                    );
                    
                    const netProfit = new Decimal(amountOutA).sub(mid).sub(gasCostDecimal);
                    
                    if (netProfit.gt(maxProfit)) {
                        maxProfit = netProfit;
                        optimalAmount = mid;
                    }
                    
                    if (netProfit.gt(0)) {
                        low = mid;
                    } else {
                        high = mid;
                    }
                } catch (error) {
                    // If calculation fails, move to higher range
                    low = mid.add(1);
                }
            }
            
            logger.debug('Optimal trade size calculation', {
                optimalAmount: optimalAmount.toString(),
                maxProfit: maxProfit.toString(),
                gasCost: gasCostDecimal.toString()
            });
            
            return {
                optimalAmount: optimalAmount.toString(),
                maxProfit: maxProfit.toString()
            };
        } catch (error) {
            logger.error('Error finding optimal trade size', { error: error.message });
            throw error;
        }
    }
}

module.exports = UniswapV2Math;
