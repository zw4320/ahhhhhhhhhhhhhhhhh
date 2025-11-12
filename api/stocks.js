/**
 * Vercel Serverless Function - Stock Price API
 *
 * Fetches real-time stock prices for major technology competitors
 * from Finnhub Stock API (free tier available).
 *
 * Environment Variables Required:
 * - API_KEY: Finnhub API token (get free at https://finnhub.io/)
 */

// Company ticker to full name mapping organized by sector
const COMPANIES = {
  // Technology
  'AAPL': { name: 'Apple Inc.', sector: 'Technology' },
  'MSFT': { name: 'Microsoft Corporation', sector: 'Technology' },
  'GOOGL': { name: 'Alphabet Inc.', sector: 'Technology' },
  'META': { name: 'Meta Platforms Inc.', sector: 'Technology' },
  'NVDA': { name: 'NVIDIA Corporation', sector: 'Technology' },

  // Healthcare
  'JNJ': { name: 'Johnson & Johnson', sector: 'Healthcare' },
  'UNH': { name: 'UnitedHealth Group', sector: 'Healthcare' },
  'PFE': { name: 'Pfizer Inc.', sector: 'Healthcare' },

  // Finance
  'JPM': { name: 'JPMorgan Chase & Co.', sector: 'Finance' },
  'BAC': { name: 'Bank of America Corp.', sector: 'Finance' },
  'GS': { name: 'Goldman Sachs Group', sector: 'Finance' },

  // Energy
  'XOM': { name: 'Exxon Mobil Corporation', sector: 'Energy' },
  'CVX': { name: 'Chevron Corporation', sector: 'Energy' },

  // Consumer/Retail
  'AMZN': { name: 'Amazon.com Inc.', sector: 'Consumer' },
  'WMT': { name: 'Walmart Inc.', sector: 'Consumer' },
  'COST': { name: 'Costco Wholesale', sector: 'Consumer' },

  // Industrial
  'BA': { name: 'Boeing Company', sector: 'Industrial' },
  'CAT': { name: 'Caterpillar Inc.', sector: 'Industrial' }
};

/**
 * Fetches stock price data for a specific ticker using Finnhub API with retry logic
 * @param {string} ticker - Stock ticker symbol
 * @param {string} apiKey - Finnhub API token
 * @param {number} retries - Number of retry attempts (default: 2)
 * @returns {Promise<Object>} Stock data object
 */
async function fetchStockPrice(ticker, apiKey, retries = 2) {
  // Finnhub API endpoint for real-time quote
  const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });

      if (!response.ok) {
        if (response.status === 429) {
          // Rate limit hit, wait before retry
          if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            continue;
          }
        }
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`API request failed for ${ticker}: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      // Finnhub returns: { c: currentPrice, h: high, l: low, o: open, pc: previousClose, t: timestamp }
      // Check if we got valid data
      if (data.c === 0 && data.t === 0) {
        throw new Error(`No data available for ${ticker} (market may be closed or invalid ticker)`);
      }

      const companyInfo = COMPANIES[ticker];
      return {
        ticker: ticker,
        companyName: companyInfo.name,
        sector: companyInfo.sector,
        price: data.c, // 'c' is the current price
        previousClose: data.pc, // Previous close price
        change: data.c - data.pc, // Price change
        changePercent: ((data.c - data.pc) / data.pc) * 100, // Percentage change
        high: data.h, // Day high
        low: data.l, // Day low
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }
  }
}

/**
 * Main serverless function handler
 * Fetches stock data for all tracked companies
 */
export default async function handler(req, res) {
  // Enable CORS for frontend access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed',
      message: 'Only GET requests are supported'
    });
  }

  try {
    // Verify API key is configured
    const apiKey = process.env.API_KEY;

    if (!apiKey) {
      console.error('API_KEY environment variable is not configured');
      return res.status(500).json({
        error: 'Configuration error',
        message: 'API key not configured. Please set API_KEY environment variable.'
      });
    }

    // Fetch stock data for all companies in parallel
    const tickers = Object.keys(COMPANIES);
    const timestamp = new Date().toISOString();

    console.log(`Fetching stock data for ${tickers.length} companies...`);

    const stockPromises = tickers.map(ticker =>
      fetchStockPrice(ticker, apiKey)
        .catch(error => {
          console.error(`Error fetching ${ticker}:`, error.message);
          // Return error object for this ticker instead of failing completely
          const companyInfo = COMPANIES[ticker];
          return {
            ticker: ticker,
            companyName: companyInfo.name,
            sector: companyInfo.sector,
            price: null,
            error: error.message,
            timestamp: timestamp
          };
        })
    );

    // Wait for all stock data requests to complete
    const stockData = await Promise.all(stockPromises);

    // Check if all requests failed
    const allFailed = stockData.every(stock => stock.error);

    if (allFailed) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'Unable to fetch stock data from API',
        data: stockData
      });
    }

    // Return successful response
    console.log(`Successfully fetched data for ${stockData.filter(s => !s.error).length} companies`);

    return res.status(200).json({
      success: true,
      timestamp: timestamp,
      data: stockData
    });

  } catch (error) {
    console.error('Unexpected error in stock API:', error);

    return res.status(500).json({
      error: 'Internal server error',
      message: 'An unexpected error occurred while fetching stock data',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}
