const { Web3 } = require('web3');
const logger = require('../../utils/logger');

/**
 * Web3 Manager with Multi-Provider Failover
 * Handles multiple RPC providers with automatic failover and load balancing
 */
class Web3Manager {
    constructor(providers, options = {}) {
        this.providers = providers.map(provider => ({
            url: provider.url,
            name: provider.name || 'Unknown',
            weight: provider.weight || 1,
            maxRetries: provider.maxRetries || 3,
            timeout: provider.timeout || 30000
        }));
        
        this.currentProviderIndex = 0;
        this.failoverThreshold = options.failoverThreshold || 3;
        this.failureCount = 0;
        this.lastFailureTime = 0;
        this.cooldownPeriod = options.cooldownPeriod || 60000; // 1 minute
        
        this.web3Instances = this.providers.map(provider => {
            const web3 = new Web3(provider.url);
            web3.provider.name = provider.name;
            return web3;
        });
        
        this.currentWeb3 = this.web3Instances[this.currentProviderIndex];
        
        logger.info('Web3Manager initialized', {
            providerCount: this.providers.length,
            currentProvider: this.providers[this.currentProviderIndex].name
        });
    }
    
    /**
     * Execute operation with automatic failover
     * @param {Function} operation - Async function that takes web3 instance
     * @param {Object} options - Execution options
     * @returns {Promise<any>} Operation result
     */
    async executeWithFailover(operation, options = {}) {
        const maxAttempts = options.maxAttempts || this.providers.length;
        const timeout = options.timeout || 30000;
        
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const provider = this.providers[this.currentProviderIndex];
            const web3 = this.web3Instances[this.currentProviderIndex];
            
            try {
                logger.debug('Executing operation with provider', {
                    provider: provider.name,
                    attempt: attempt + 1,
                    maxAttempts
                });
                
                const result = await Promise.race([
                    operation(web3),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Timeout')), timeout)
                    )
                ]);
                
                // Reset failure count on success
                this.failureCount = 0;
                this.lastFailureTime = 0;
                
                logger.debug('Operation successful', {
                    provider: provider.name,
                    attempt: attempt + 1
                });
                
                return result;
                
            } catch (error) {
                logger.warn('Provider operation failed', {
                    provider: provider.name,
                    attempt: attempt + 1,
                    error: error.message
                });
                
                this.failureCount++;
                this.lastFailureTime = Date.now();
                
                // Check if we should rotate provider
                if (this.shouldRotateProvider()) {
                    this.rotateProvider();
                }
            }
        }
        
        throw new Error(`All providers failed after ${maxAttempts} attempts`);
    }
    
    /**
     * Check if provider should be rotated
     * @returns {boolean}
     */
    shouldRotateProvider() {
        const timeSinceLastFailure = Date.now() - this.lastFailureTime;
        
        return this.failureCount >= this.failoverThreshold && 
               timeSinceLastFailure > this.cooldownPeriod;
    }
    
    /**
     * Rotate to next provider
     */
    rotateProvider() {
        const previousProvider = this.providers[this.currentProviderIndex].name;
        
        this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
        this.currentWeb3 = this.web3Instances[this.currentProviderIndex];
        this.failureCount = 0;
        
        logger.info('Provider rotated', {
            from: previousProvider,
            to: this.providers[this.currentProviderIndex].name
        });
    }
    
    /**
     * Get current Web3 instance
     * @returns {Web3}
     */
    getCurrentWeb3() {
        return this.currentWeb3;
    }
    
    /**
     * Get current provider info
     * @returns {Object}
     */
    getCurrentProvider() {
        return this.providers[this.currentProviderIndex];
    }
    
    /**
     * Get all provider status
     * @returns {Array}
     */
    getProviderStatus() {
        return this.providers.map((provider, index) => ({
            name: provider.name,
            url: provider.url,
            isActive: index === this.currentProviderIndex,
            weight: provider.weight
        }));
    }
    
    /**
     * Health check for current provider
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        try {
            await this.executeWithFailover(async (web3) => {
                await web3.eth.getBlockNumber();
            }, { maxAttempts: 1, timeout: 5000 });
            
            return true;
        } catch (error) {
            logger.error('Health check failed', { error: error.message });
            return false;
        }
    }
    
    /**
     * Subscribe to new blocks
     * @param {Function} callback - Callback function for new blocks
     * @returns {Promise<Object>} Subscription object
     */
    async subscribeToBlocks(callback) {
        return this.executeWithFailover(async (web3) => {
            const subscription = await web3.eth.subscribe('newBlockHeaders');
            
            subscription.on('data', (blockHeader) => {
                logger.debug('New block received', {
                    blockNumber: blockHeader.number,
                    provider: web3.provider.name
                });
                
                callback(blockHeader);
            });
            
            subscription.on('error', (error) => {
                logger.error('Block subscription error', {
                    provider: web3.provider.name,
                    error: error.message
                });
                
                // Trigger provider rotation on subscription error
                this.failureCount++;
                if (this.shouldRotateProvider()) {
                    this.rotateProvider();
                }
            });
            
            return subscription;
        });
    }
    
    /**
     * Batch call multiple contract methods
     * @param {Array} calls - Array of call objects
     * @param {string} blockNumber - Block number for calls
     * @returns {Promise<Array>} Results array
     */
    async batchCall(calls, blockNumber = 'latest') {
        return this.executeWithFailover(async (web3) => {
            const batch = new web3.BatchRequest();
            const promises = [];
            
            calls.forEach((call, index) => {
                const promise = new Promise((resolve, reject) => {
                    batch.add(
                        web3.eth.call.request(
                            {
                                to: call.to,
                                data: call.data
                            },
                            blockNumber,
                            (error, result) => {
                                if (error) {
                                    reject(error);
                                } else {
                                    resolve(result);
                                }
                            }
                        )
                    );
                });
                
                promises.push(promise);
            });
            
            batch.execute();
            
            return Promise.all(promises);
        });
    }
    
    /**
     * Get gas price with fallback
     * @returns {Promise<string>} Gas price in wei
     */
    async getGasPrice() {
        return this.executeWithFailover(async (web3) => {
            return await web3.eth.getGasPrice();
        });
    }
    
    /**
     * Get block number with fallover
     * @returns {Promise<number>} Current block number
     */
    async getBlockNumber() {
        return this.executeWithFailover(async (web3) => {
            return await web3.eth.getBlockNumber();
        });
    }
}

module.exports = Web3Manager;
