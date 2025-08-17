const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const logger = require('../../utils/logger');

/**
 * Database Service
 * Handles storage and retrieval of arbitrage opportunities
 */
class DatabaseService {
    constructor(databaseUrl) {
        this.databaseUrl = databaseUrl;
        this.db = null;
        this.isInitialized = false;
        
        logger.info('DatabaseService initialized', {
            databaseUrl: this.databaseUrl,
            service: 'database-service'
        });
    }
    
    /**
     * Initialize database connection and create tables
     */
    async initialize() {
        try {
            logger.info('Initializing database connection', {
                service: 'database-service'
            });
            
            // Open database connection
            this.db = await open({
                filename: this.databaseUrl.replace('sqlite:', ''),
                driver: sqlite3.Database
            });
            
            // Create tables
            await this.createTables();
            
            this.isInitialized = true;
            
            logger.info('Database initialized successfully', {
                service: 'database-service'
            });
            
        } catch (error) {
            logger.error('Failed to initialize database', {
                error: error.message,
                service: 'database-service'
            });
            throw error;
        }
    }
    
    /**
     * Create database tables
     */
    async createTables() {
        try {
            // Opportunities table
            await this.db.exec(`
                CREATE TABLE IF NOT EXISTS opportunities (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    pair TEXT NOT NULL,
                    buyDex TEXT,
                    sellDex TEXT,
                    buyPrice TEXT,
                    sellPrice TEXT,
                    priceDifference TEXT,
                    priceDifferencePercent TEXT,
                    tradeAmount TEXT,
                    grossProfitUSD TEXT,
                    gasCostUSD TEXT,
                    swapFeesUSD TEXT,
                    netProfitUSD TEXT,
                    profitWithSafetyMargin TEXT,
                    path TEXT,
                    dex1 TEXT,
                    dex2 TEXT,
                    buyPairAddress TEXT,
                    sellPairAddress TEXT,
                    blockNumber TEXT,
                    timestamp INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Statistics table
            await this.db.exec(`
                CREATE TABLE IF NOT EXISTS statistics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    totalOpportunities INTEGER DEFAULT 0,
                    directOpportunities INTEGER DEFAULT 0,
                    triangularOpportunities INTEGER DEFAULT 0,
                    totalProfitUSD TEXT DEFAULT '0',
                    scansCompleted INTEGER DEFAULT 0,
                    uptimeSeconds INTEGER DEFAULT 0,
                    timestamp INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Price history table
            await this.db.exec(`
                CREATE TABLE IF NOT EXISTS price_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pair TEXT NOT NULL,
                    dex TEXT NOT NULL,
                    price0 TEXT NOT NULL,
                    price1 TEXT NOT NULL,
                    reserve0 TEXT NOT NULL,
                    reserve1 TEXT NOT NULL,
                    blockNumber TEXT,
                    timestamp INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            logger.info('Database tables created successfully', {
                service: 'database-service'
            });
            
        } catch (error) {
            logger.error('Failed to create database tables', {
                error: error.message,
                service: 'database-service'
            });
            throw error;
        }
    }
    
    /**
     * Store arbitrage opportunity
     * @param {Object} opportunity - Opportunity object
     */
    async storeOpportunity(opportunity) {
        try {
            if (!this.isInitialized) {
                throw new Error('Database not initialized');
            }
            
            const query = `
                INSERT OR REPLACE INTO opportunities (
                    id, type, pair, buyDex, sellDex, buyPrice, sellPrice,
                    priceDifference, priceDifferencePercent, tradeAmount,
                    grossProfitUSD, gasCostUSD, swapFeesUSD, netProfitUSD,
                    profitWithSafetyMargin, path, dex1, dex2, buyPairAddress,
                    sellPairAddress, blockNumber, timestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            const params = [
                opportunity.id,
                opportunity.type || 'direct',
                opportunity.pair,
                opportunity.buyDex || null,
                opportunity.sellDex || null,
                opportunity.buyPrice || null,
                opportunity.sellPrice || null,
                opportunity.priceDifference || null,
                opportunity.priceDifferencePercent || null,
                opportunity.tradeAmount,
                opportunity.grossProfitUSD,
                opportunity.gasCostUSD,
                opportunity.swapFeesUSD || '0',
                opportunity.netProfitUSD,
                opportunity.profitWithSafetyMargin,
                opportunity.path || null,
                opportunity.dex1 || null,
                opportunity.dex2 || null,
                opportunity.buyPairAddress || null,
                opportunity.sellPairAddress || null,
                opportunity.blockNumber || null,
                opportunity.timestamp
            ];
            
            await this.db.run(query, params);
            
            logger.debug('Opportunity stored in database', {
                opportunityId: opportunity.id,
                service: 'database-service'
            });
            
        } catch (error) {
            logger.error('Failed to store opportunity', {
                error: error.message,
                opportunityId: opportunity.id,
                service: 'database-service'
            });
        }
    }
    
    /**
     * Get recent opportunities
     * @param {number} limit - Number of opportunities to retrieve
     * @param {string} type - Filter by type (direct, triangular, or all)
     * @returns {Array} Array of opportunities
     */
    async getRecentOpportunities(limit = 50, type = 'all') {
        try {
            if (!this.isInitialized) {
                throw new Error('Database not initialized');
            }
            
            let query = `
                SELECT * FROM opportunities 
                ORDER BY timestamp DESC 
                LIMIT ?
            `;
            
            let params = [limit];
            
            if (type !== 'all') {
                query = `
                    SELECT * FROM opportunities 
                    WHERE type = ? 
                    ORDER BY timestamp DESC 
                    LIMIT ?
                `;
                params = [type, limit];
            }
            
            const opportunities = await this.db.all(query, params);
            
            logger.debug('Retrieved recent opportunities', {
                count: opportunities.length,
                type: type,
                service: 'database-service'
            });
            
            return opportunities;
            
        } catch (error) {
            logger.error('Failed to get recent opportunities', {
                error: error.message,
                service: 'database-service'
            });
            return [];
        }
    }
    
    /**
     * Get opportunities by time range
     * @param {number} startTime - Start timestamp
     * @param {number} endTime - End timestamp
     * @param {string} type - Filter by type
     * @returns {Array} Array of opportunities
     */
    async getOpportunitiesByTimeRange(startTime, endTime, type = 'all') {
        try {
            if (!this.isInitialized) {
                throw new Error('Database not initialized');
            }
            
            let query = `
                SELECT * FROM opportunities 
                WHERE timestamp BETWEEN ? AND ?
                ORDER BY timestamp DESC
            `;
            
            let params = [startTime, endTime];
            
            if (type !== 'all') {
                query = `
                    SELECT * FROM opportunities 
                    WHERE type = ? AND timestamp BETWEEN ? AND ?
                    ORDER BY timestamp DESC
                `;
                params = [type, startTime, endTime];
            }
            
            const opportunities = await this.db.all(query, params);
            
            logger.debug('Retrieved opportunities by time range', {
                count: opportunities.length,
                startTime: startTime,
                endTime: endTime,
                type: type,
                service: 'database-service'
            });
            
            return opportunities;
            
        } catch (error) {
            logger.error('Failed to get opportunities by time range', {
                error: error.message,
                service: 'database-service'
            });
            return [];
        }
    }
    
    /**
     * Get opportunity by ID
     * @param {string} id - Opportunity ID
     * @returns {Object|null} Opportunity object or null
     */
    async getOpportunityById(id) {
        try {
            if (!this.isInitialized) {
                throw new Error('Database not initialized');
            }
            
            const query = `
                SELECT * FROM opportunities 
                WHERE id = ?
                LIMIT 1
            `;
            
            const opportunity = await this.db.get(query, [id]);
            
            logger.debug('Retrieved opportunity by ID', {
                id: id,
                found: !!opportunity,
                service: 'database-service'
            });
            
            return opportunity || null;
            
        } catch (error) {
            logger.error('Failed to get opportunity by ID', {
                id: id,
                error: error.message,
                service: 'database-service'
            });
            return null;
        }
    }
    
    /**
     * Get statistics
     * @returns {Object} Statistics object
     */
    async getStatistics() {
        try {
            if (!this.isInitialized) {
                throw new Error('Database not initialized');
            }
            
            // Get total opportunities
            const totalResult = await this.db.get('SELECT COUNT(*) as count FROM opportunities');
            const totalOpportunities = totalResult.count;
            
            // Get direct opportunities
            const directResult = await this.db.get('SELECT COUNT(*) as count FROM opportunities WHERE type = "direct"');
            const directOpportunities = directResult.count;
            
            // Get triangular opportunities
            const triangularResult = await this.db.get('SELECT COUNT(*) as count FROM opportunities WHERE type = "triangular"');
            const triangularOpportunities = triangularResult.count;
            
            // Get total profit
            const profitResult = await this.db.get(`
                SELECT SUM(CAST(netProfitUSD AS REAL)) as totalProfit 
                FROM opportunities 
                WHERE netProfitUSD IS NOT NULL
            `);
            const totalProfit = profitResult.totalProfit || 0;
            
            // Get recent opportunities (last 24 hours)
            const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
            const recentResult = await this.db.get(`
                SELECT COUNT(*) as count 
                FROM opportunities 
                WHERE timestamp > ?
            `, [oneDayAgo]);
            const recentOpportunities = recentResult.count;
            
            const statistics = {
                totalOpportunities,
                directOpportunities,
                triangularOpportunities,
                totalProfit: totalProfit.toString(),
                recentOpportunities,
                lastUpdated: Date.now()
            };
            
            logger.debug('Retrieved statistics', {
                statistics: statistics,
                service: 'database-service'
            });
            
            return statistics;
            
        } catch (error) {
            logger.error('Failed to get statistics', {
                error: error.message,
                service: 'database-service'
            });
            return {
                totalOpportunities: 0,
                directOpportunities: 0,
                triangularOpportunities: 0,
                totalProfit: '0',
                recentOpportunities: 0,
                lastUpdated: Date.now()
            };
        }
    }
    
    /**
     * Store price history
     * @param {Object} priceData - Price data object
     */
    async storePriceHistory(priceData) {
        try {
            if (!this.isInitialized) {
                throw new Error('Database not initialized');
            }
            
            const query = `
                INSERT INTO price_history (
                    pair, dex, price0, price1, reserve0, reserve1, 
                    blockNumber, timestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            const params = [
                priceData.pair,
                priceData.dex,
                priceData.price0,
                priceData.price1,
                priceData.reserve0,
                priceData.reserve1,
                priceData.blockNumber || null,
                priceData.timestamp
            ];
            
            await this.db.run(query, params);
            
        } catch (error) {
            logger.error('Failed to store price history', {
                error: error.message,
                service: 'database-service'
            });
        }
    }
    
    /**
     * Get price history
     * @param {string} pair - Token pair
     * @param {string} dex - DEX name
     * @param {number} limit - Number of records to retrieve
     * @returns {Array} Array of price history records
     */
    async getPriceHistory(pair, dex, limit = 100) {
        try {
            if (!this.isInitialized) {
                throw new Error('Database not initialized');
            }
            
            const query = `
                SELECT * FROM price_history 
                WHERE pair = ? AND dex = ?
                ORDER BY timestamp DESC 
                LIMIT ?
            `;
            
            const params = [pair, dex, limit];
            const history = await this.db.all(query, params);
            
            return history;
            
        } catch (error) {
            logger.error('Failed to get price history', {
                error: error.message,
                service: 'database-service'
            });
            return [];
        }
    }
    
    /**
     * Clean old data
     * @param {number} daysToKeep - Number of days to keep data
     */
    async cleanOldData(daysToKeep = 30) {
        try {
            if (!this.isInitialized) {
                throw new Error('Database not initialized');
            }
            
            const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
            
            // Clean old opportunities
            await this.db.run('DELETE FROM opportunities WHERE timestamp < ?', [cutoffTime]);
            
            // Clean old price history
            await this.db.run('DELETE FROM price_history WHERE timestamp < ?', [cutoffTime]);
            
            // Clean old statistics
            await this.db.run('DELETE FROM statistics WHERE timestamp < ?', [cutoffTime]);
            
            logger.info('Cleaned old data', {
                cutoffTime: cutoffTime,
                daysToKeep: daysToKeep,
                service: 'database-service'
            });
            
        } catch (error) {
            logger.error('Failed to clean old data', {
                error: error.message,
                service: 'database-service'
            });
        }
    }
    
    /**
     * Close database connection
     */
    async close() {
        try {
            if (this.db) {
                await this.db.close();
                this.isInitialized = false;
                
                logger.info('Database connection closed', {
                    service: 'database-service'
                });
            }
        } catch (error) {
            logger.error('Failed to close database connection', {
                error: error.message,
                service: 'database-service'
            });
        }
    }
}

module.exports = DatabaseService;
