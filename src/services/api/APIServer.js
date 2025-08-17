const express = require('express');
const cors = require('cors');
const logger = require('../../utils/logger');

/**
 * API Server
 * Provides REST API access to arbitrage opportunities and statistics
 */
class APIServer {
    constructor(databaseService, options = {}) {
        this.databaseService = databaseService;
        this.options = {
            port: options.port || 3000,
            cors: options.cors !== false,
            ...options
        };
        
        this.app = null;
        this.server = null;
        this.isRunning = false;
        
        logger.info('APIServer initialized', {
            port: this.options.port,
            cors: this.options.cors,
            service: 'api-server'
        });
    }
    
    /**
     * Initialize and start the API server
     */
    async start() {
        try {
            if (this.isRunning) {
                logger.warn('API server is already running');
                return;
            }
            
            // Create Express app
            this.app = express();
            
            // Configure middleware
            if (this.options.cors) {
                this.app.use(cors());
            }
            
            this.app.use(express.json());
            this.app.use(express.urlencoded({ extended: true }));
            
            // Add request logging
            this.app.use((req, res, next) => {
                logger.info(`${req.method} ${req.path}`, {
                    ip: req.ip,
                    userAgent: req.get('User-Agent'),
                    service: 'api-server'
                });
                next();
            });
            
            // Setup routes
            this.setupRoutes();
            
            // Error handling middleware
            this.app.use((error, req, res, next) => {
                logger.error('API Error', {
                    error: error.message,
                    path: req.path,
                    method: req.method,
                    service: 'api-server'
                });
                
                res.status(500).json({
                    error: 'Internal Server Error',
                    message: error.message
                });
            });
            
            // Start server
            this.server = this.app.listen(this.options.port, () => {
                this.isRunning = true;
                logger.info('API server started successfully', {
                    port: this.options.port,
                    service: 'api-server'
                });
            });
            
        } catch (error) {
            logger.error('Failed to start API server', {
                error: error.message,
                service: 'api-server'
            });
            throw error;
        }
    }
    
    /**
     * Setup API routes
     */
    setupRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                timestamp: Date.now(),
                service: 'arbitrage-bot-api'
            });
        });
        
        // Get recent opportunities
        this.app.get('/api/opportunities', async (req, res) => {
            try {
                const limit = parseInt(req.query.limit) || 50;
                const type = req.query.type || 'all';
                
                const opportunities = await this.databaseService.getRecentOpportunities(limit, type);
                
                res.json({
                    success: true,
                    data: opportunities,
                    count: opportunities.length,
                    type: type,
                    limit: limit
                });
                
            } catch (error) {
                logger.error('Error getting opportunities', {
                    error: error.message,
                    service: 'api-server'
                });
                
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // Get direct arbitrage opportunities
        this.app.get('/api/opportunities/direct', async (req, res) => {
            try {
                const limit = parseInt(req.query.limit) || 50;
                
                const opportunities = await this.databaseService.getRecentOpportunities(limit, 'direct');
                
                res.json({
                    success: true,
                    data: opportunities,
                    count: opportunities.length,
                    type: 'direct',
                    limit: limit
                });
                
            } catch (error) {
                logger.error('Error getting direct opportunities', {
                    error: error.message,
                    service: 'api-server'
                });
                
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // Get triangular arbitrage opportunities
        this.app.get('/api/opportunities/triangular', async (req, res) => {
            try {
                const limit = parseInt(req.query.limit) || 50;
                
                const opportunities = await this.databaseService.getRecentOpportunities(limit, 'triangular');
                
                res.json({
                    success: true,
                    data: opportunities,
                    count: opportunities.length,
                    type: 'triangular',
                    limit: limit
                });
                
            } catch (error) {
                logger.error('Error getting triangular opportunities', {
                    error: error.message,
                    service: 'api-server'
                });
                
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // Get profitable opportunities (above threshold)
        this.app.get('/api/opportunities/profitable', async (req, res) => {
            try {
                const minProfit = parseFloat(req.query.minProfit) || 10;
                const limit = parseInt(req.query.limit) || 50;
                
                const allOpportunities = await this.databaseService.getRecentOpportunities(1000, 'all');
                
                const profitableOpportunities = allOpportunities
                    .filter(opp => parseFloat(opp.netProfitUSD) >= minProfit)
                    .slice(0, limit);
                
                res.json({
                    success: true,
                    data: profitableOpportunities,
                    count: profitableOpportunities.length,
                    minProfit: minProfit,
                    limit: limit
                });
                
            } catch (error) {
                logger.error('Error getting profitable opportunities', {
                    error: error.message,
                    service: 'api-server'
                });
                
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // Get opportunities by time range
        this.app.get('/api/opportunities/range', async (req, res) => {
            try {
                const startTime = parseInt(req.query.startTime);
                const endTime = parseInt(req.query.endTime);
                const type = req.query.type || 'all';
                
                if (!startTime || !endTime) {
                    return res.status(400).json({
                        success: false,
                        error: 'startTime and endTime parameters are required'
                    });
                }
                
                const opportunities = await this.databaseService.getOpportunitiesByTimeRange(
                    startTime, endTime, type
                );
                
                res.json({
                    success: true,
                    data: opportunities,
                    count: opportunities.length,
                    startTime: startTime,
                    endTime: endTime,
                    type: type
                });
                
            } catch (error) {
                logger.error('Error getting opportunities by range', {
                    error: error.message,
                    service: 'api-server'
                });
                
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // Get specific opportunity by ID
        this.app.get('/api/opportunities/:id', async (req, res) => {
            try {
                const opportunityId = req.params.id;
                
                res.json({
                    success: true,
                    message: 'Opportunity details endpoint - implementation needed',
                    id: opportunityId
                });
                
            } catch (error) {
                logger.error('Error getting opportunity by ID', {
                    error: error.message,
                    service: 'api-server'
                });
                
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // Get statistics
        this.app.get('/api/statistics', async (req, res) => {
            try {
                const statistics = await this.databaseService.getStatistics();
                
                res.json({
                    success: true,
                    data: statistics
                });
                
            } catch (error) {
                logger.error('Error getting statistics', {
                    error: error.message,
                    service: 'api-server'
                });
                
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // Get price history
        this.app.get('/api/prices', async (req, res) => {
            try {
                const pair = req.query.pair;
                const dex = req.query.dex;
                const limit = parseInt(req.query.limit) || 100;
                
                if (!pair || !dex) {
                    return res.status(400).json({
                        success: false,
                        error: 'pair and dex query parameters are required'
                    });
                }
                
                const priceHistory = await this.databaseService.getPriceHistory(pair, dex, limit);
                
                res.json({
                    success: true,
                    data: priceHistory,
                    count: priceHistory.length,
                    pair: pair,
                    dex: dex,
                    limit: limit
                });
                
            } catch (error) {
                logger.error('Error getting price history', {
                    error: error.message,
                    service: 'api-server'
                });
                
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // API documentation endpoint
        this.app.get('/api/docs', (req, res) => {
            res.json({
                success: true,
                message: 'Arbitrage Bot API Documentation',
                version: '1.0.0',
                endpoints: {
                    'GET /health': 'Health check endpoint',
                    'GET /api/opportunities': 'Get recent opportunities (query params: limit, type)',
                    'GET /api/opportunities/direct': 'Get direct arbitrage opportunities',
                    'GET /api/opportunities/triangular': 'Get triangular arbitrage opportunities',
                    'GET /api/opportunities/profitable': 'Get profitable opportunities (query params: minProfit, limit)',
                    'GET /api/opportunities/range': 'Get opportunities by time range (query params: startTime, endTime, type)',
                    'GET /api/opportunities/:id': 'Get specific opportunity by ID',
                    'GET /api/statistics': 'Get bot statistics',
                    'GET /api/prices': 'Get price history (query params: pair, dex, limit)'
                },
                examples: {
                    'Get recent opportunities': 'GET /api/opportunities?limit=20&type=direct',
                    'Get opportunities in time range': 'GET /api/opportunities/range?startTime=1640995200000&endTime=1641081600000&type=triangular',
                    'Get profitable opportunities': 'GET /api/opportunities/profitable?minProfit=50&limit=10',
                    'Get price history': 'GET /api/prices?pair=WETH/USDC&dex=uniswap&limit=100'
                }
            });
        });
        
        // Default route
        this.app.get('/', (req, res) => {
            res.json({
                success: true,
                message: 'Arbitrage Bot API Server',
                version: '1.0.0',
                endpoints: {
                    health: '/health',
                    opportunities: '/api/opportunities',
                    statistics: '/api/statistics',
                    documentation: '/api/docs'
                }
            });
        });
        
        // 404 handler
        this.app.use('*', (req, res) => {
            res.status(404).json({
                success: false,
                error: 'Endpoint not found',
                path: req.originalUrl,
                availableEndpoints: [
                    '/health',
                    '/api/opportunities',
                    '/api/statistics',
                    '/api/docs'
                ]
            });
        });
    }
    
    /**
     * Stop the API server
     */
    async stop() {
        try {
            if (this.server) {
                this.server.close();
                this.isRunning = false;
                
                logger.info('API server stopped', {
                    service: 'api-server'
                });
            }
        } catch (error) {
            logger.error('Failed to stop API server', {
                error: error.message,
                service: 'api-server'
            });
        }
    }
    
    /**
     * Get server status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            port: this.options.port,
            cors: this.options.cors
        };
    }
}

module.exports = APIServer;
