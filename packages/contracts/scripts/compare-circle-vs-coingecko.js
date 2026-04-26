import fetch from 'node-fetch';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
const CIRCLE_API_BASE_URL = 'https://api-sandbox.circle.com';

/**
 * EXAMPLE: How to use Circle StableFX API for RFQ trading
 * 
 * WARNING: This is COMPLEX and requires:
 * - Multiple API calls
 * - EIP-712 signatures from user wallet
 * - Permit2 approvals
 * - On-chain transaction execution
 * 
 * For WizPay rate updates, CoinGecko is MUCH simpler!
 */

async function getCircleStableFXRate() {
  console.log('🔄 Circle StableFX RFQ Flow (Complex Example)\n');
  
  try {
    // Step 1: Request a quote
    console.log('📊 Step 1: Requesting quote from Circle StableFX...');
    const quoteResponse = await fetch(`${CIRCLE_API_BASE_URL}/v1/exchange/stablefx/quotes`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${CIRCLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: {
          currency: 'USDC',
          amount: '1000.00'
        },
        to: {
          currency: 'EURC'
        },
        tenor: 'instant'
      })
    });
    
    if (!quoteResponse.ok) {
      const error = await quoteResponse.text();
      console.error('❌ Quote request failed:', quoteResponse.status, error);
      return null;
    }
    
    const quote = await quoteResponse.json();
    console.log('✅ Quote received:');
    console.log(`   Rate: ${quote.rate}`);
    console.log(`   Quote ID: ${quote.id}`);
    console.log(`   Expiry: ${quote.expiry}`);
    console.log('');
    
    // Step 2: Create a trade (accept quote)
    console.log('📝 Step 2: Creating trade...');
    const tradeResponse = await fetch(`${CIRCLE_API_BASE_URL}/v1/exchange/stablefx/trades`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${CIRCLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotencyKey: ethers.hexlify(ethers.randomBytes(16)),
        quoteId: quote.id
      })
    });
    
    if (!tradeResponse.ok) {
      const error = await tradeResponse.text();
      console.error('❌ Trade creation failed:', tradeResponse.status, error);
      return null;
    }
    
    const trade = await tradeResponse.json();
    console.log('✅ Trade created:');
    console.log(`   Trade ID: ${trade.id}`);
    console.log(`   Status: ${trade.status}`);
    console.log('');
    
    // Step 3: Get signature data (EIP-712)
    console.log('🔐 Step 3: Getting signature data...');
    console.log('⚠️  Would require EIP-712 wallet signature here');
    console.log('⚠️  Then submit signature to /v1/exchange/stablefx/signatures');
    console.log('');
    
    // Step 4: Fund trade (Permit2)
    console.log('💰 Step 4: Funding trade...');
    console.log('⚠️  Would require Permit2 approval + signature');
    console.log('⚠️  Then submit to /v1/exchange/stablefx/fund');
    console.log('');
    
    console.log('📊 Rate from Circle StableFX:', quote.rate);
    console.log('');
    console.log('⚠️  COMPLEXITY ALERT:');
    console.log('   - Requires 4+ API calls');
    console.log('   - Requires 2 wallet signatures (EIP-712)');
    console.log('   - Requires Permit2 approvals');
    console.log('   - Requires on-chain execution');
    console.log('');
    console.log('💡 For WizPay rate updates, CoinGecko is MUCH simpler!');
    
    return quote.rate;
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    return null;
  }
}

// Compare with CoinGecko (simple)
async function getCoinGeckoRate() {
  console.log('\n🚀 CoinGecko API (Simple Example)\n');
  
  const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=euro-coin&vs_currencies=usd');
  const data = await response.json();
  const rate = data['euro-coin'].usd;
  
  console.log('✅ Rate from CoinGecko:', rate);
  console.log('');
  console.log('✨ SIMPLICITY:');
  console.log('   - Single API call');
  console.log('   - No signatures required');
  console.log('   - No API key needed');
  console.log('   - Instant response');
  
  return rate;
}

// Run comparison
async function compare() {
  console.log('=' .repeat(60));
  console.log('Circle StableFX vs CoinGecko Comparison');
  console.log('=' .repeat(60));
  console.log('');
  
  // Try Circle StableFX (complex)
  const circleRate = await getCircleStableFXRate();
  
  // Use CoinGecko (simple)
  const coingeckoRate = await getCoinGeckoRate();
  
  console.log('');
  console.log('=' .repeat(60));
  console.log('CONCLUSION: CoinGecko is MUCH better for WizPay use case');
  console.log('=' .repeat(60));
}

compare();
