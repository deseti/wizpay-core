import fetch from 'node-fetch';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
const CIRCLE_API_BASE_URL = process.env.CIRCLE_API_BASE_URL || 'https://api-sandbox.circle.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.ARC_TESTNET_RPC_URL;

/**
 * Circle StableFX Integration - Get Real-Time Rate via RFQ
 * Following official documentation: https://developers.circle.com/stablefx/quickstarts/fx-trade-taker
 */

async function getStableFXRate() {
  console.log('🔄 Fetching Rate from Circle StableFX API\n');
  
  if (!CIRCLE_API_KEY) {
    console.error('❌ CIRCLE_API_KEY not found in .env');
    process.exit(1);
  }
  
  try {
    // Step 1: Request a quote for USDC to EURC
    console.log('📊 Step 1: Requesting quote from Circle StableFX...');
    console.log(`   Endpoint: ${CIRCLE_API_BASE_URL}/v1/exchange/stablefx/quotes`);
    console.log('');
    
    const quoteResponse = await fetch(`${CIRCLE_API_BASE_URL}/v1/exchange/stablefx/quotes`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${CIRCLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: {
          currency: 'EURC',
          amount: '1.00'
        },
        to: {
          currency: 'USDC'
        },
        tenor: 'instant'
      })
    });
    
    console.log(`Response Status: ${quoteResponse.status}`);
    
    if (!quoteResponse.ok) {
      const error = await quoteResponse.text();
      console.error('❌ Quote request failed:');
      console.error(`   Status: ${quoteResponse.status}`);
      console.error(`   Error: ${error}`);
      console.log('');
      console.log('💡 Possible reasons:');
      console.log('   1. API key not authorized for StableFX');
      console.log('   2. Endpoint not available on testnet yet');
      console.log('   3. Account needs additional permissions');
      console.log('');
      console.log('📝 To get StableFX access:');
      console.log('   1. Visit: https://console.circle.com');
      console.log('   2. Navigate to API Keys');
      console.log('   3. Ensure "StableFX" permission is enabled');
      return null;
    }
    
    const quote = await quoteResponse.json();
    console.log('✅ Quote received successfully!');
    console.log('');
    console.log('📊 Quote Details:');
    console.log(`   Quote ID: ${quote.id}`);
    console.log(`   Rate: ${quote.rate}`);
    console.log(`   From: ${quote.from.amount} ${quote.from.currency}`);
    console.log(`   To: ${quote.to.amount} ${quote.to.currency}`);
    console.log(`   Timestamp: ${quote.timestamp}`);
    console.log(`   Expiry: ${quote.expiry}`);
    
    if (quote.fee) {
      console.log(`   Fee: ${quote.fee.amount} ${quote.fee.currency}`);
    }
    console.log('');
    
    // Calculate exchange rate (1 EURC = X USDC)
    const fromAmount = parseFloat(quote.from.amount);
    const toAmount = parseFloat(quote.to.amount);
    const exchangeRate = toAmount / fromAmount;
    
    console.log('💱 Exchange Rate:');
    console.log(`   1 EURC = ${exchangeRate} USDC`);
    console.log(`   Rate for contract: ${ethers.parseUnits(exchangeRate.toFixed(18), 18).toString()}`);
    console.log('');
    
    return {
      rate: exchangeRate,
      quoteId: quote.id,
      expiry: quote.expiry,
      rawQuote: quote
    };
    
  } catch (error) {
    console.error('❌ Error fetching rate from Circle StableFX:');
    console.error(`   ${error.message}`);
    console.log('');
    
    if (error.code === 'ENOTFOUND') {
      console.log('💡 Network error - check your internet connection');
    }
    
    return null;
  }
}

// Execute
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Circle StableFX - Get Exchange Rate via RFQ API');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  
  const result = await getStableFXRate();
  
  if (result) {
    console.log('✅ SUCCESS: Retrieved rate from Circle StableFX');
    console.log('');
    console.log('📝 To update StableFXAdapter:');
    console.log(`   node scripts/auto-update-rates.js`);
    console.log('');
    console.log(`   Or manually set rate: ${result.rate}`);
  } else {
    console.log('❌ FAILED: Could not retrieve rate from Circle StableFX');
    console.log('');
    console.log('📋 Next Steps:');
    console.log('   1. Verify API key has StableFX permissions');
    console.log('   2. Check Circle Console for account status');
    console.log('   3. Contact Circle support if issue persists');
  }
  
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
}

main();
