const logger = require('../../utils/logger');
const { Decimal } = require('decimal.js');

/**
 * Execution Engine
 * 
 * Responsible for:
 * - Smart contract interaction for trades
 * - Transaction management and confirmation
 * - MEV protection and gas optimization
 * - Flash loan integration
 * - Transaction monitoring and retry logic
 */
class ExecutionEngine {
    constructor(web3Manager, options = {}) {
        this.web3Manager = web3Manager;
        
        // Configuration
        this.options = {
            maxRetries: options.maxRetries || 3,
            retryDelay: options.retryDelay || 1000, // 1 second
            transactionTimeout: options.transactionTimeout || 60000, // 60 seconds
            gasLimitBuffer: options.gasLimitBuffer || 1.2, // 20% buffer
            maxSlippage: options.maxSlippage || 0.01, // 1% slippage
            flashLoanEnabled: options.flashLoanEnabled || false,
            mevProtection: options.mevProtection || true,
            privateTxEnabled: options.privateTxEnabled || false,
            ...options
        };
        
        // State management
        this.pendingTransactions = new Map();
        this.completedTransactions = new Map();
        this.failedTransactions = new Map();
        
        // Statistics
        this.stats = {
            transactionsSubmitted: 0,
            transactionsConfirmed: 0,
            transactionsFailed: 0,
            totalGasUsed: new Decimal(0),
            totalGasCost: new Decimal(0),
            averageGasUsed: new Decimal(0),
            successRate: 0
        };
        
        // Performance tracking
        this.performanceMetrics = {
            transactionLatency: [],
            confirmationLatency: [],
            gasEstimationLatency: [],
            failedReasonCounts: {}
        };
        
        logger.info('ExecutionEngine initialized', {
            options: this.options,
            service: 'defi-arbitrage-bot'
        });
    }
    
    /**
     * Execute an arbitrage opportunity
     * @param {Object} opportunity - Qualified arbitrage opportunity
     * @param {Object} walletConfig - Wallet configuration
     * @returns {Promise<Object>} Transaction result
     */
    async executeArbitrage(opportunity, walletConfig) {
        const startTime = Date.now();
        const transactionId = this.generateTransactionId(opportunity.id);
        
        try {
            logger.info('Starting arbitrage execution', {
                transactionId,
                opportunityId: opportunity.id,
                buyDex: opportunity.buyDex,
                sellDex: opportunity.sellDex,
                expectedProfit: opportunity.netProfitUSD,
                service: 'defi-arbitrage-bot'
            });
            
            // Validate opportunity
            if (!this.validateOpportunity(opportunity)) {
                throw new Error('Invalid opportunity');
            }
            
            // Check if opportunity is still valid
            if (Date.now() > opportunity.expiresAt) {
                throw new Error('Opportunity expired');
            }
            
            // Prepare transaction
            const transaction = await this.prepareArbitrageTransaction(opportunity, walletConfig);
            
            // Estimate gas
            const gasEstimate = await this.estimateGas(transaction);
            
            // Check if gas cost is still profitable
            const updatedGasCost = await this.calculateUpdatedGasCost(gasEstimate);
            const updatedNetProfit = new Decimal(opportunity.grossProfitUSD).minus(updatedGasCost);
            
            if (updatedNetProfit.lessThan(opportunity.minProfitUSD || 0)) {
                throw new Error('Gas cost too high, no longer profitable');
            }
            
            // Execute transaction
            const result = await this.executeTransaction(transaction, gasEstimate, walletConfig);
            
            // Update statistics
            this.stats.transactionsSubmitted++;
            this.stats.transactionsConfirmed++;
            this.stats.totalGasUsed = this.stats.totalGasUsed.plus(result.gasUsed);
            this.stats.totalGasCost = this.stats.totalGasCost.plus(result.gasCost);
            this.stats.averageGasUsed = this.stats.totalGasUsed.dividedBy(this.stats.transactionsConfirmed);
            this.stats.successRate = this.stats.transactionsConfirmed / this.stats.transactionsSubmitted;
            
            // Record performance
            this.performanceMetrics.transactionLatency.push(Date.now() - startTime);
            
            // Store completed transaction
            this.completedTransactions.set(transactionId, {
                ...result,
                opportunity,
                executionTime: Date.now() - startTime,
                timestamp: Date.now()
            });
            
            logger.info('Arbitrage execution completed successfully', {
                transactionId,
                opportunityId: opportunity.id,
                gasUsed: result.gasUsed.toString(),
                gasCost: result.gasCost.toString(),
                actualProfit: result.actualProfit?.toString() || 'N/A',
                executionTime: Date.now() - startTime,
                service: 'defi-arbitrage-bot'
            });
            
            return result;
            
        } catch (error) {
            // Update statistics
            this.stats.transactionsSubmitted++;
            this.stats.transactionsFailed++;
            this.stats.successRate = this.stats.transactionsConfirmed / this.stats.transactionsSubmitted;
            
            // Record failure reason
            const reason = error.message;
            this.performanceMetrics.failedReasonCounts[reason] = 
                (this.performanceMetrics.failedReasonCounts[reason] || 0) + 1;
            
            // Store failed transaction
            this.failedTransactions.set(transactionId, {
                opportunity,
                error: error.message,
                executionTime: Date.now() - startTime,
                timestamp: Date.now()
            });
            
            logger.error('Arbitrage execution failed', {
                transactionId,
                opportunityId: opportunity.id,
                error: error.message,
                executionTime: Date.now() - startTime,
                service: 'defi-arbitrage-bot'
            });
            
            throw error;
        }
    }
    
    /**
     * Prepare arbitrage transaction
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {Object} walletConfig - Wallet configuration
     * @returns {Promise<Object>} Transaction object
     */
    async prepareArbitrageTransaction(opportunity, walletConfig) {
        try {
            const web3 = this.web3Manager.getCurrentWeb3();
            
            // Create arbitrage contract call
            const arbitrageData = await this.buildArbitrageCall(opportunity);
            
            // Get current gas price
            const gasPrice = await this.web3Manager.getGasPrice();
            
            // Calculate priority fee for MEV protection
            const priorityFee = this.options.mevProtection ? 
                await this.calculatePriorityFee() : '0';
            
            // Build transaction
            const transaction = {
                from: walletConfig.address,
                to: this.getArbitrageContractAddress(opportunity),
                data: arbitrageData,
                gas: '0', // Will be estimated
                gasPrice: gasPrice,
                maxPriorityFeePerGas: priorityFee,
                maxFeePerGas: this.calculateMaxFeePerGas(gasPrice, priorityFee),
                value: '0', // No ETH sent
                nonce: await web3.eth.getTransactionCount(walletConfig.address, 'pending')
            };
            
            return transaction;
            
        } catch (error) {
            logger.error('Error preparing arbitrage transaction', {
                opportunityId: opportunity.id,
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            throw error;
        }
    }
    
    /**
     * Build arbitrage contract call data
     * @param {Object} opportunity - Arbitrage opportunity
     * @returns {Promise<string>} Contract call data
     */
    async buildArbitrageCall(opportunity) {
        try {
            // This is a simplified version - in production, you'd have a custom arbitrage contract
            const web3 = this.web3Manager.getCurrentWeb3();
            
            // Arbitrage contract ABI (simplified)
            const arbitrageABI = [
                {
                    "inputs": [
                        {"name": "buyDex", "type": "address"},
                        {"name": "sellDex", "type": "address"},
                        {"name": "tokenA", "type": "address"},
                        {"name": "tokenB", "type": "address"},
                        {"name": "amount", "type": "uint256"},
                        {"name": "minProfit", "type": "uint256"}
                    ],
                    "name": "executeArbitrage",
                    "outputs": [{"name": "profit", "type": "uint256"}],
                    "stateMutability": "nonpayable",
                    "type": "function"
                }
            ];
            
            // Create contract instance
            const arbitrageContract = new web3.eth.Contract(arbitrageABI);
            
            // Encode function call
            const encodedData = arbitrageContract.methods.executeArbitrage(
                opportunity.buyPairAddress,
                opportunity.sellPairAddress,
                opportunity.pair.tokenA,
                opportunity.pair.tokenB,
                opportunity.optimalAmount,
                opportunity.minProfitUSD || '0'
            ).encodeABI();
            
            return encodedData;
            
        } catch (error) {
            logger.error('Error building arbitrage call', {
                opportunityId: opportunity.id,
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            throw error;
        }
    }
    
    /**
     * Get arbitrage contract address
     * @param {Object} opportunity - Arbitrage opportunity
     * @returns {string} Contract address
     */
    getArbitrageContractAddress(opportunity) {
        // In production, this would be your deployed arbitrage contract
        // For now, return a placeholder
        return '0x1234567890123456789012345678901234567890';
    }
    
    /**
     * Estimate gas for transaction
     * @param {Object} transaction - Transaction object
     * @returns {Promise<number>} Gas estimate
     */
    async estimateGas(transaction) {
        const startTime = Date.now();
        
        try {
            const web3 = this.web3Manager.getCurrentWeb3();
            
            // Remove gas field for estimation
            const { gas, ...txForEstimate } = transaction;
            
            const gasEstimate = await web3.eth.estimateGas(txForEstimate);
            
            // Apply buffer
            const gasWithBuffer = Math.ceil(gasEstimate * this.options.gasLimitBuffer);
            
            this.performanceMetrics.gasEstimationLatency.push(Date.now() - startTime);
            
            logger.info('Gas estimation completed', {
                originalEstimate: gasEstimate,
                withBuffer: gasWithBuffer,
                estimationTime: Date.now() - startTime,
                service: 'defi-arbitrage-bot'
            });
            
            return gasWithBuffer;
            
        } catch (error) {
            logger.error('Error estimating gas', {
                error: error.message,
                transaction: transaction.to,
                service: 'defi-arbitrage-bot'
            });
            throw error;
        }
    }
    
    /**
     * Execute transaction with retry logic
     * @param {Object} transaction - Transaction object
     * @param {number} gasEstimate - Gas estimate
     * @param {Object} walletConfig - Wallet configuration
     * @returns {Promise<Object>} Transaction result
     */
    async executeTransaction(transaction, gasEstimate, walletConfig) {
        const startTime = Date.now();
        let lastError = null;
        
        // Set gas limit
        transaction.gas = gasEstimate.toString();
        
        for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
            try {
                logger.info('Executing transaction', {
                    attempt,
                    maxRetries: this.options.maxRetries,
                    gasLimit: gasEstimate,
                    service: 'defi-arbitrage-bot'
                });
                
                // Sign transaction
                const signedTx = await this.signTransaction(transaction, walletConfig);
                
                // Send transaction
                const txHash = await this.sendTransaction(signedTx);
                
                // Wait for confirmation
                const receipt = await this.waitForConfirmation(txHash);
                
                // Calculate actual gas cost
                const gasCost = await this.calculateActualGasCost(receipt);
                
                // Calculate actual profit (if possible)
                const actualProfit = await this.calculateActualProfit(receipt, transaction);
                
                const result = {
                    txHash,
                    gasUsed: receipt.gasUsed,
                    gasCost: gasCost.toString(),
                    blockNumber: receipt.blockNumber,
                    status: receipt.status,
                    actualProfit: actualProfit?.toString(),
                    confirmationTime: Date.now() - startTime
                };
                
                this.performanceMetrics.confirmationLatency.push(Date.now() - startTime);
                
                return result;
                
            } catch (error) {
                lastError = error;
                
                logger.warn('Transaction attempt failed', {
                    attempt,
                    maxRetries: this.options.maxRetries,
                    error: error.message,
                    service: 'defi-arbitrage-bot'
                });
                
                if (attempt < this.options.maxRetries) {
                    await this.delay(this.options.retryDelay * attempt);
                }
            }
        }
        
        throw lastError || new Error('All transaction attempts failed');
    }
    
    /**
     * Sign transaction
     * @param {Object} transaction - Transaction object
     * @param {Object} walletConfig - Wallet configuration
     * @returns {Promise<string>} Signed transaction
     */
    async signTransaction(transaction, walletConfig) {
        try {
            const web3 = this.web3Manager.getCurrentWeb3();
            
            // In production, you'd use proper private key management
            // For now, this is a placeholder
            const signedTx = await web3.eth.accounts.signTransaction(transaction, walletConfig.privateKey);
            
            return signedTx.rawTransaction;
            
        } catch (error) {
            logger.error('Error signing transaction', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            throw error;
        }
    }
    
    /**
     * Send transaction
     * @param {string} signedTx - Signed transaction
     * @returns {Promise<string>} Transaction hash
     */
    async sendTransaction(signedTx) {
        try {
            const web3 = this.web3Manager.getCurrentWeb3();
            
            const txHash = await web3.eth.sendSignedTransaction(signedTx);
            
            logger.info('Transaction sent', {
                txHash,
                service: 'defi-arbitrage-bot'
            });
            
            return txHash;
            
        } catch (error) {
            logger.error('Error sending transaction', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            throw error;
        }
    }
    
    /**
     * Wait for transaction confirmation
     * @param {string} txHash - Transaction hash
     * @returns {Promise<Object>} Transaction receipt
     */
    async waitForConfirmation(txHash) {
        try {
            const web3 = this.web3Manager.getCurrentWeb3();
            
            const receipt = await web3.eth.waitForTransactionReceipt(txHash, {
                timeout: this.options.transactionTimeout
            });
            
            if (!receipt.status) {
                throw new Error('Transaction failed');
            }
            
            logger.info('Transaction confirmed', {
                txHash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed,
                service: 'defi-arbitrage-bot'
            });
            
            return receipt;
            
        } catch (error) {
            logger.error('Error waiting for transaction confirmation', {
                txHash,
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            throw error;
        }
    }
    
    /**
     * Calculate actual gas cost
     * @param {Object} receipt - Transaction receipt
     * @returns {Promise<Decimal>} Gas cost in USD
     */
    async calculateActualGasCost(receipt) {
        try {
            const gasUsed = new Decimal(receipt.gasUsed);
            const gasPrice = new Decimal(receipt.effectiveGasPrice || '0');
            
            const gasCostWei = gasUsed.times(gasPrice);
            
            // Convert to USD (simplified)
            const ethPriceUSD = new Decimal(2000); // Placeholder
            const gasCostUSD = gasCostWei.dividedBy(new Decimal(10).pow(18)).times(ethPriceUSD);
            
            return gasCostUSD;
            
        } catch (error) {
            logger.error('Error calculating actual gas cost', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return new Decimal(0);
        }
    }
    
    /**
     * Calculate actual profit from transaction
     * @param {Object} receipt - Transaction receipt
     * @param {Object} transaction - Original transaction
     * @returns {Promise<Decimal|null>} Actual profit or null
     */
    async calculateActualProfit(receipt, transaction) {
        try {
            // In production, you'd parse the transaction logs to get actual profit
            // For now, return null as this requires contract-specific parsing
            return null;
            
        } catch (error) {
            logger.error('Error calculating actual profit', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return null;
        }
    }
    
    /**
     * Calculate priority fee for MEV protection
     * @returns {Promise<string>} Priority fee in wei
     */
    async calculatePriorityFee() {
        try {
            // In production, you'd use a more sophisticated MEV protection strategy
            // For now, return a conservative priority fee
            return '2000000000'; // 2 gwei
            
        } catch (error) {
            logger.error('Error calculating priority fee', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return '0';
        }
    }
    
    /**
     * Calculate max fee per gas
     * @param {string} gasPrice - Base gas price
     * @param {string} priorityFee - Priority fee
     * @returns {string} Max fee per gas
     */
    calculateMaxFeePerGas(gasPrice, priorityFee) {
        try {
            const baseFee = new Decimal(gasPrice);
            const priority = new Decimal(priorityFee);
            
            // Max fee = base fee + priority fee + buffer
            const maxFee = baseFee.plus(priority).times(1.1); // 10% buffer
            
            return maxFee.toString();
            
        } catch (error) {
            logger.error('Error calculating max fee per gas', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return gasPrice;
        }
    }
    
    /**
     * Calculate updated gas cost
     * @param {number} gasEstimate - Gas estimate
     * @returns {Promise<Decimal>} Updated gas cost
     */
    async calculateUpdatedGasCost(gasEstimate) {
        try {
            const gasPrice = await this.web3Manager.getGasPrice();
            const gasUsed = new Decimal(gasEstimate);
            const price = new Decimal(gasPrice);
            
            const gasCostWei = gasUsed.times(price);
            
            // Convert to USD
            const ethPriceUSD = new Decimal(2000); // Placeholder
            const gasCostUSD = gasCostWei.dividedBy(new Decimal(10).pow(18)).times(ethPriceUSD);
            
            return gasCostUSD;
            
        } catch (error) {
            logger.error('Error calculating updated gas cost', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return new Decimal(0);
        }
    }
    
    /**
     * Validate opportunity before execution
     * @param {Object} opportunity - Arbitrage opportunity
     * @returns {boolean} Whether opportunity is valid
     */
    validateOpportunity(opportunity) {
        try {
            // Check required fields
            if (!opportunity.id || !opportunity.pair || !opportunity.buyDex || !opportunity.sellDex) {
                return false;
            }
            
            // Check profit is positive
            const netProfit = new Decimal(opportunity.netProfitUSD);
            if (netProfit.lessThanOrEqualTo(0)) {
                return false;
            }
            
            // Check profit margin
            const profitMargin = new Decimal(opportunity.profitMargin);
            if (profitMargin.lessThan(this.options.minProfitMargin || 0)) {
                return false;
            }
            
            return true;
            
        } catch (error) {
            logger.error('Error validating opportunity', {
                error: error.message,
                service: 'defi-arbitrage-bot'
            });
            return false;
        }
    }
    
    /**
     * Generate unique transaction ID
     * @param {string} opportunityId - Opportunity ID
     * @returns {string} Transaction ID
     */
    generateTransactionId(opportunityId) {
        return `tx_${opportunityId}_${Date.now()}`;
    }
    
    /**
     * Get transaction status
     * @param {string} transactionId - Transaction ID
     * @returns {Object|null} Transaction status
     */
    getTransactionStatus(transactionId) {
        if (this.completedTransactions.has(transactionId)) {
            return {
                status: 'completed',
                data: this.completedTransactions.get(transactionId)
            };
        }
        
        if (this.failedTransactions.has(transactionId)) {
            return {
                status: 'failed',
                data: this.failedTransactions.get(transactionId)
            };
        }
        
        if (this.pendingTransactions.has(transactionId)) {
            return {
                status: 'pending',
                data: this.pendingTransactions.get(transactionId)
            };
        }
        
        return null;
    }
    
    /**
     * Get current statistics
     * @returns {Object} Statistics object
     */
    getStats() {
        return {
            ...this.stats,
            pendingTransactions: this.pendingTransactions.size,
            completedTransactions: this.completedTransactions.size,
            failedTransactions: this.failedTransactions.size,
            averageTransactionLatency: this.performanceMetrics.transactionLatency.length > 0 ?
                this.performanceMetrics.transactionLatency.reduce((a, b) => a + b, 0) / this.performanceMetrics.transactionLatency.length : 0
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
     * Clear old transaction history
     * @param {number} maxAge - Maximum age in milliseconds
     */
    clearOldTransactions(maxAge = 24 * 60 * 60 * 1000) { // 24 hours
        const now = Date.now();
        let clearedCount = 0;
        
        // Clear old completed transactions
        for (const [id, tx] of this.completedTransactions) {
            if (now - tx.timestamp > maxAge) {
                this.completedTransactions.delete(id);
                clearedCount++;
            }
        }
        
        // Clear old failed transactions
        for (const [id, tx] of this.failedTransactions) {
            if (now - tx.timestamp > maxAge) {
                this.failedTransactions.delete(id);
                clearedCount++;
            }
        }
        
        if (clearedCount > 0) {
            logger.info('Cleared old transactions', {
                clearedCount,
                service: 'defi-arbitrage-bot'
            });
        }
    }
    
    /**
     * Utility function for delays
     * @param {number} ms - Milliseconds to delay
     * @returns {Promise} Promise that resolves after delay
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = ExecutionEngine;
