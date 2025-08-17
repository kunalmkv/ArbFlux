const Web3Manager = require('../../src/services/blockchain/Web3Manager');

// Mock Web3
jest.mock('web3', () => {
    return jest.fn().mockImplementation((url) => {
        const mockWeb3 = {
            eth: {
                getBlockNumber: jest.fn().mockResolvedValue(12345),
                getGasPrice: jest.fn().mockResolvedValue('20000000000'),
                subscribe: jest.fn().mockResolvedValue({
                    on: jest.fn(),
                    unsubscribe: jest.fn()
                }),
                call: jest.fn().mockResolvedValue('0x'),
                abi: {
                    encodeFunctionCall: jest.fn().mockReturnValue('0x'),
                    decodeParameters: jest.fn().mockReturnValue(['1000', '2000', '1234567890'])
                }
            },
            BatchRequest: jest.fn().mockImplementation(() => ({
                add: jest.fn(),
                execute: jest.fn()
            })),
            provider: { name: 'MockProvider' }
        };

        // Add the request method to eth.call for batch operations
        mockWeb3.eth.call.request = jest.fn().mockImplementation((callData, blockNumber, callback) => {
            if (callback) {
                callback(null, '0x');
            }
            return Promise.resolve('0x');
        });

        return mockWeb3;
    });
});

describe('Web3Manager', () => {
    let web3Manager;
    let mockProviders;

    beforeEach(() => {
        mockProviders = [
            {
                url: 'https://mainnet.infura.io/v3/test1',
                name: 'Infura',
                weight: 1,
                maxRetries: 3,
                timeout: 30000
            },
            {
                url: 'https://mainnet.alchemyapi.io/v2/test2',
                name: 'Alchemy',
                weight: 1,
                maxRetries: 3,
                timeout: 30000
            },
            {
                url: 'https://eth-mainnet.public.blastapi.io',
                name: 'BlastAPI',
                weight: 1,
                maxRetries: 3,
                timeout: 30000
            }
        ];

        web3Manager = new Web3Manager(mockProviders, {
            failoverThreshold: 3,
            cooldownPeriod: 60000
        });
    });

    describe('Initialization', () => {
        test('should initialize with multiple providers', () => {
            expect(web3Manager.providers).toHaveLength(3);
            expect(web3Manager.currentProviderIndex).toBe(0);
            expect(web3Manager.web3Instances).toHaveLength(3);
        });

        test('should set default options', () => {
            expect(web3Manager.failoverThreshold).toBe(3);
            expect(web3Manager.cooldownPeriod).toBe(60000);
        });

        test('should handle providers without optional fields', () => {
            const simpleProviders = [
                { url: 'https://test1.com' },
                { url: 'https://test2.com' }
            ];

            const manager = new Web3Manager(simpleProviders);
            expect(manager.providers[0].name).toBe('Unknown');
            expect(manager.providers[0].weight).toBe(1);
            expect(manager.providers[0].maxRetries).toBe(3);
            expect(manager.providers[0].timeout).toBe(30000);
        });
    });

    describe('Provider Management', () => {
        test('should get current provider info', () => {
            const currentProvider = web3Manager.getCurrentProvider();
            expect(currentProvider.name).toBe('Infura');
            expect(currentProvider.url).toBe('https://mainnet.infura.io/v3/test1');
        });

        test('should get all provider status', () => {
            const status = web3Manager.getProviderStatus();
            expect(status).toHaveLength(3);
            expect(status[0].isActive).toBe(true);
            expect(status[1].isActive).toBe(false);
            expect(status[2].isActive).toBe(false);
        });

        test('should rotate provider', () => {
            const initialProvider = web3Manager.getCurrentProvider().name;
            web3Manager.rotateProvider();
            const newProvider = web3Manager.getCurrentProvider().name;
            
            expect(newProvider).not.toBe(initialProvider);
            expect(newProvider).toBe('Alchemy');
        });

        test('should handle provider rotation cycle', () => {
            // Rotate through all providers
            web3Manager.rotateProvider(); // Infura -> Alchemy
            expect(web3Manager.getCurrentProvider().name).toBe('Alchemy');
            
            web3Manager.rotateProvider(); // Alchemy -> BlastAPI
            expect(web3Manager.getCurrentProvider().name).toBe('BlastAPI');
            
            web3Manager.rotateProvider(); // BlastAPI -> Infura (cycle)
            expect(web3Manager.getCurrentProvider().name).toBe('Infura');
        });
    });

    describe('Failover Logic', () => {
        test('should not rotate provider before threshold', () => {
            web3Manager.failureCount = 2;
            expect(web3Manager.shouldRotateProvider()).toBe(false);
        });

        test('should rotate provider after threshold', () => {
            web3Manager.failureCount = 3;
            web3Manager.lastFailureTime = Date.now() - 70000; // 70 seconds ago
            expect(web3Manager.shouldRotateProvider()).toBe(true);
        });

        test('should not rotate during cooldown period', () => {
            web3Manager.failureCount = 3;
            web3Manager.lastFailureTime = Date.now() - 30000; // 30 seconds ago
            expect(web3Manager.shouldRotateProvider()).toBe(false);
        });
    });

    describe('executeWithFailover', () => {
        test('should execute operation successfully', async () => {
            const operation = jest.fn().mockResolvedValue('success');
            
            const result = await web3Manager.executeWithFailover(operation);
            
            expect(result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(1);
            expect(web3Manager.failureCount).toBe(0);
        });

        test('should handle operation failure and retry', async () => {
            const operation = jest.fn()
                .mockRejectedValueOnce(new Error('Provider failed'))
                .mockResolvedValueOnce('success');
            
            const result = await web3Manager.executeWithFailover(operation);
            
            expect(result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(2);
            // Note: failureCount is reset to 0 on success, so we check it was incremented during the process
            expect(web3Manager.failureCount).toBe(0);
        });

        test('should fail after all providers exhausted', async () => {
            const operation = jest.fn().mockRejectedValue(new Error('All providers failed'));
            
            await expect(web3Manager.executeWithFailover(operation)).rejects.toThrow('All providers failed after 3 attempts');
            expect(operation).toHaveBeenCalledTimes(3);
        });

        test('should handle timeout', async () => {
            const operation = jest.fn().mockImplementation(() => 
                new Promise(resolve => setTimeout(resolve, 100))
            );
            
            await expect(web3Manager.executeWithFailover(operation, { timeout: 50 }))
                .rejects.toThrow('All providers failed after 3 attempts');
        });
    });

    describe('Health Check', () => {
        test('should return true for healthy provider', async () => {
            const health = await web3Manager.healthCheck();
            expect(health).toBe(true);
        });

        test('should return false for unhealthy provider', async () => {
            // Mock a failed health check
            const originalExecuteWithFailover = web3Manager.executeWithFailover.bind(web3Manager);
            web3Manager.executeWithFailover = jest.fn().mockRejectedValue(new Error('Health check failed'));
            
            const health = await web3Manager.healthCheck();
            expect(health).toBe(false);
            
            // Restore original method
            web3Manager.executeWithFailover = originalExecuteWithFailover;
        });
    });

    describe('Block Subscription', () => {
        test('should subscribe to new blocks', async () => {
            const callback = jest.fn();
            const subscription = await web3Manager.subscribeToBlocks(callback);
            
            expect(subscription).toBeDefined();
            expect(web3Manager.getCurrentWeb3().eth.subscribe).toHaveBeenCalledWith('newBlockHeaders');
        });

        test('should handle subscription errors', async () => {
            const callback = jest.fn();
            
            // Mock subscription with error
            const mockSubscription = {
                on: jest.fn((event, handler) => {
                    if (event === 'error') {
                        // Simulate error
                        handler(new Error('Subscription error'));
                    }
                })
            };
            
            web3Manager.getCurrentWeb3().eth.subscribe = jest.fn().mockResolvedValue(mockSubscription);
            
            await web3Manager.subscribeToBlocks(callback);
            
            expect(mockSubscription.on).toHaveBeenCalledWith('data', expect.any(Function));
            expect(mockSubscription.on).toHaveBeenCalledWith('error', expect.any(Function));
        });
    });

    describe('Batch Operations', () => {
        test('should execute batch calls', async () => {
            const calls = [
                { to: '0x123', data: '0xabc' },
                { to: '0x456', data: '0xdef' }
            ];
            
            const results = await web3Manager.batchCall(calls, 'latest');
            
            expect(results).toBeDefined();
            expect(web3Manager.getCurrentWeb3().BatchRequest).toHaveBeenCalled();
        });
    });

    describe('Utility Methods', () => {
        test('should get gas price', async () => {
            const gasPrice = await web3Manager.getGasPrice();
            expect(gasPrice).toBe('20000000000');
        });

        test('should get block number', async () => {
            const blockNumber = await web3Manager.getBlockNumber();
            expect(blockNumber).toBe(12345);
        });

        test('should get current Web3 instance', () => {
            const web3 = web3Manager.getCurrentWeb3();
            expect(web3).toBeDefined();
            expect(web3.provider.name).toBe('Infura');
        });
    });

    describe('Error Handling', () => {
        test('should handle provider rotation on subscription error', async () => {
            const callback = jest.fn();
            
            // Mock subscription with error that triggers rotation
            const mockSubscription = {
                on: jest.fn((event, handler) => {
                    if (event === 'error') {
                        // Simulate multiple errors to trigger rotation
                        for (let i = 0; i < 3; i++) {
                            handler(new Error('Subscription error'));
                        }
                    }
                })
            };
            
            web3Manager.getCurrentWeb3().eth.subscribe = jest.fn().mockResolvedValue(mockSubscription);
            
            await web3Manager.subscribeToBlocks(callback);
            
            // The subscription error handler should be set up
            expect(mockSubscription.on).toHaveBeenCalledWith('data', expect.any(Function));
            expect(mockSubscription.on).toHaveBeenCalledWith('error', expect.any(Function));
        });

        test('should handle network timeouts gracefully', async () => {
            const operation = jest.fn().mockImplementation(() => 
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Network timeout')), 10)
                )
            );
            
            await expect(web3Manager.executeWithFailover(operation, { timeout: 5 }))
                .rejects.toThrow('All providers failed after 3 attempts');
        });
    });
});
