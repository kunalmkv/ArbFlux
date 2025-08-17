// Uniswap V2 Constants
const UNISWAP_V2_CONSTANTS = {
    FEE_DENOMINATOR: 1000,
    FEE_NUMERATOR: 997,
    MINIMUM_LIQUIDITY: 1000,
    INIT_CODE_HASH: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f'
};

// DEX Factory Addresses
const DEX_FACTORIES = {
    UNISWAP_V2: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    SUSHISWAP: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
    PANCAKESWAP: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'
};

// Token Addresses (Ethereum Mainnet)
const TOKENS = {
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F'
};

// Arbitrage Configuration
const ARBITRAGE_CONFIG = {
    MIN_PROFIT_THRESHOLD: parseFloat(process.env.MIN_PROFIT_THRESHOLD) || 0.5,
    SAFETY_MARGIN: parseFloat(process.env.SAFETY_MARGIN) || 0.15,
    MAX_GAS_PRICE: parseFloat(process.env.MAX_GAS_PRICE) || 50,
    PRICE_UPDATE_INTERVAL: parseInt(process.env.PRICE_UPDATE_INTERVAL) || 1000,
    OPPORTUNITY_EXPIRY_TIME: parseInt(process.env.OPPORTUNITY_EXPIRY_TIME) || 30000
};

// Gas Configuration
const GAS_CONFIG = {
    DEFAULT_GAS_LIMIT: 300000,
    SWAP_GAS_LIMIT: 200000,
    APPROVE_GAS_LIMIT: 50000,
    SAFETY_MARGIN: 0.15
};

// Error Messages
const ERROR_MESSAGES = {
    INSUFFICIENT_LIQUIDITY: 'Insufficient liquidity for trade',
    PRICE_IMPACT_TOO_HIGH: 'Price impact exceeds maximum threshold',
    INSUFFICIENT_PROFIT: 'Profit below minimum threshold',
    GAS_COST_TOO_HIGH: 'Gas cost exceeds maximum allowed',
    INVALID_PAIR: 'Invalid trading pair',
    NETWORK_ERROR: 'Network error occurred'
};

module.exports = {
    UNISWAP_V2_CONSTANTS,
    DEX_FACTORIES,
    TOKENS,
    ARBITRAGE_CONFIG,
    GAS_CONFIG,
    ERROR_MESSAGES
};
