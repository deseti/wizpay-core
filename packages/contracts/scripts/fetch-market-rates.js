import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

async function fetchMarketRates() {
  console.log('🔍 Fetching Real-Time Market Rates...\n');
  
  try {
    // CoinGecko API (free, no API key needed)
    console.log('📊 Source: CoinGecko API (Public)');
    console.log('🔗 Fetching EUR/USD exchange rate...\n');
    
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=euro-coin&vs_currencies=usd', {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    
    console.log('✅ Raw API Response:');
    console.log(JSON.stringify(data, null, 2));
    console.log('');
    
    if (data['euro-coin'] && data['euro-coin'].usd) {
      const rate = data['euro-coin'].usd;
      const rateForContract = Math.floor(rate * 1e6); // Convert to 6 decimals
      
      console.log('💱 Exchange Rate:');
      console.log(`   1 EURC = ${rate} USD`);
      console.log(`   Rate for contract: ${rateForContract}`);
      console.log('');
      
      console.log('📝 To update StableFXAdapter, run:');
      console.log(`   node scripts/update-rates.js`);
      console.log('');
      console.log('   Or manually call:');
      console.log(`   setExchangeRate(EURC, USDC, ${rateForContract})`);
      console.log('');
      
      return {
        rate,
        rateForContract,
        timestamp: new Date().toISOString()
      };
    } else {
      throw new Error('Invalid response format from CoinGecko');
    }
    
  } catch (error) {
    console.error('❌ Error fetching market rates:', error.message);
    console.log('');
    console.log('💡 Alternatives:');
    console.log('   1. Use Chainlink Price Feeds (if available on ARC)');
    console.log('   2. Use CoinMarketCap API (requires free API key)');
    console.log('   3. Use fallback rate (current: 1.09)');
    console.log('');
    
    // Fallback to current rate
    console.log('⚠️  Using fallback rate: 1.09');
    const fallbackRate = 1.09;
    const rateForContract = Math.floor(fallbackRate * 1e6);
    
    return {
      rate: fallbackRate,
      rateForContract,
      timestamp: new Date().toISOString(),
      fallback: true
    };
  }
}

// Execute
fetchMarketRates().then(result => {
  if (result) {
    console.log('✅ Rate fetch completed successfully!');
    console.log('');
    console.log('📊 Summary:');
    console.log(`   Rate: ${result.rate}`);
    console.log(`   Contract Value: ${result.rateForContract}`);
    console.log(`   Timestamp: ${result.timestamp}`);
    if (result.fallback) {
      console.log(`   ⚠️  Using fallback data`);
    }
  }
});
