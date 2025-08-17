// Test setup file
require('dotenv').config({ path: '.env.test' });

// Set test environment
process.env.NODE_ENV = 'test';

// Configure Decimal.js for consistent precision in tests
const { Decimal } = require('decimal.js');
Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

// Suppress console logs during tests unless explicitly needed
if (process.env.NODE_ENV === 'test') {
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();
}
