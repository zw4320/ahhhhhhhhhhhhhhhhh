/**
 * Vercel Serverless Function - Economic Indicators API
 *
 * Fetches key economic indicators and market indices
 * from Finnhub Stock API (free tier available).
 *
 * Environment Variables Required:
 * - API_KEY: Finnhub API token (get free at https://finnhub.io/)
 */

// Market indices and major economic indicators (available on free tier)
const INDICATORS = {
  // Major US Market Indices
  '^GSPC': { name: 'S&P 500', type: 'Index', description: 'US Large Cap Index' },
  '^DJI': { name: 'Dow Jones Industrial Average', type: 'Index', description: 'US Blue Chip Index' },
  '^IXIC': { name: 'NASDAQ Composite', type: 'Index', description: 'US Tech-Heavy Index' },
  '^RUT': { name: 'Russell 2000', type: 'Index', description: 'US Small Cap Index' },

  // Volatility
  '^VIX': { name: 'CBOE Volatility Index', type: 'Volatility', description: 'Market Fear Gauge' },

  // Treasury & Rates
  '^TNX': { name: 'US 10-Year Treasury Yield', type: 'Bonds', description: '10-Year Bond Yield' },

  // Commodities
  'GC=F': { name: 'Gold Futures', type: 'Commodities', description: 'Gold Price' },
  'CL=F': { name: 'Crude Oil WTI', type: 'Commodities', description: 'Oil Price' }
};

/**
 * Fetches indicator data with retry logic
 * @param {string} symbol - Indicator symbol
 * @param {string} apiKey - Finnhub API token
 * @param {number} retries - Number of retry attempts
 * @returns {Promise<Object>} Indicator data object
 */
async function fetchIndicator(symbol, apiKey, retries = 2) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${apiKey}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });

      if (!response.ok) {
        if (response.status === 429 && attempt < retries) {
          // Rate limit hit, wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`API request failed for ${symbol}: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      // Check if we got valid data
      if (data.c === 0 && data.t === 0) {
        throw new Error(`No data available for ${symbol}`);
      }

      const indicatorInfo = INDICATORS[symbol];
      return {
        symbol: symbol,
        name: indicatorInfo.name,
        type: indicatorInfo.type,
        description: indicatorInfo.description,
        value: data.c, // Current value
        previousClose: data.pc,
        change: data.c - data.pc,
        changePercent: ((data.c - data.pc) / data.pc) * 100,
        high: data.h,
        low: data.l,
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
 * Fetches economic indicators and market indices
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

    // Fetch indicator data for all tracked indicators in parallel
    const symbols = Object.keys(INDICATORS);
    const timestamp = new Date().toISOString();

    console.log(`Fetching ${symbols.length} economic indicators...`);

    const indicatorPromises = symbols.map(symbol =>
      fetchIndicator(symbol, apiKey)
        .catch(error => {
          console.error(`Error fetching ${symbol}:`, error.message);
          // Return error object for this indicator instead of failing completely
          const indicatorInfo = INDICATORS[symbol];
          return {
            symbol: symbol,
            name: indicatorInfo.name,
            type: indicatorInfo.type,
            description: indicatorInfo.description,
            value: null,
            error: error.message,
            timestamp: timestamp
          };
        })
    );

    // Wait for all indicator requests to complete
    const indicatorData = await Promise.all(indicatorPromises);

    // Check if all requests failed
    const allFailed = indicatorData.every(indicator => indicator.error);

    if (allFailed) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'Unable to fetch economic indicator data from API',
        data: indicatorData
      });
    }

    // Group indicators by type for easier frontend display
    const groupedData = indicatorData.reduce((acc, indicator) => {
      if (!indicator.error) {
        if (!acc[indicator.type]) {
          acc[indicator.type] = [];
        }
        acc[indicator.type].push(indicator);
      }
      return acc;
    }, {});

    // Return successful response
    console.log(`Successfully fetched data for ${indicatorData.filter(i => !i.error).length} indicators`);

    return res.status(200).json({
      success: true,
      timestamp: timestamp,
      data: indicatorData,
      grouped: groupedData
    });

  } catch (error) {
    console.error('Unexpected error in economic API:', error);

    return res.status(500).json({
      error: 'Internal server error',
      message: 'An unexpected error occurred while fetching economic data',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}
