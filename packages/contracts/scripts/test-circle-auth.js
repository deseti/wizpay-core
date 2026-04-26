import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;

/**
 * Test Circle API authentication following official documentation
 * https://developers.circle.com/circle-mint/testing-connectivity-and-api-keys
 */

async function testCircleAuthentication() {
  console.log('🔐 Testing Circle API Authentication\n');
  console.log('Following: https://developers.circle.com/circle-mint/testing-connectivity-and-api-keys\n');
  
  // Test 1: Ping (no auth required)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Test 1: Raw Connectivity (No Auth)');
  console.log('GET https://api-sandbox.circle.com/ping');
  
  try {
    const pingResponse = await fetch('https://api-sandbox.circle.com/ping', {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    
    const pingData = await pingResponse.json();
    console.log(`Status: ${pingResponse.status}`);
    console.log(`Response:`, pingData);
    
    if (pingData.message === 'pong') {
      console.log('✅ Connection successful!\n');
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }
  
  // Test 2: Configuration endpoint (requires auth)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Test 2: API Key Authentication');
  console.log('GET https://api-sandbox.circle.com/v1/configuration');
  console.log(`API Key: ${CIRCLE_API_KEY.substring(0, 30)}...`);
  
  try {
    const configResponse = await fetch('https://api-sandbox.circle.com/v1/configuration', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${CIRCLE_API_KEY}`
      }
    });
    
    console.log(`Status: ${configResponse.status}`);
    const configText = await configResponse.text();
    
    if (configResponse.ok) {
      console.log('✅ API Key is valid!');
      const configData = JSON.parse(configText);
      console.log('Response:', JSON.stringify(configData, null, 2));
      console.log('');
      
      // Check what products are enabled
      console.log('📊 Enabled Products/Services:');
      if (configData.data) {
        Object.keys(configData.data).forEach(key => {
          console.log(`   ✓ ${key}`);
        });
      }
      console.log('');
      
    } else {
      console.log('❌ API Key authentication failed');
      console.log(`Response: ${configText}`);
      console.log('');
    }
    
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }
  
  // Test 3: StableFX endpoint
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Test 3: StableFX API Access');
  console.log('POST https://api-sandbox.circle.com/v1/exchange/stablefx/quotes');
  
  try {
    const stablefxResponse = await fetch('https://api-sandbox.circle.com/v1/exchange/stablefx/quotes', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${CIRCLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: { currency: 'EURC', amount: '1.00' },
        to: { currency: 'USDC' },
        tenor: 'instant'
      })
    });
    
    console.log(`Status: ${stablefxResponse.status}`);
    const stablefxText = await stablefxResponse.text();
    
    if (stablefxResponse.ok) {
      console.log('✅ StableFX API access granted!');
      const stablefxData = JSON.parse(stablefxText);
      console.log('Response:', JSON.stringify(stablefxData, null, 2));
      console.log('');
      console.log('🎉 SUCCESS! You have StableFX API access!');
    } else {
      console.log('❌ StableFX API not accessible');
      console.log(`Response: ${stablefxText}`);
      console.log('');
      
      if (stablefxResponse.status === 401) {
        console.log('💡 Diagnosis:');
        console.log('   - API key is valid (passed /v1/configuration test)');
        console.log('   - But does NOT have StableFX product access');
        console.log('');
        console.log('📝 Solution:');
        console.log('   1. Contact Circle Support: support@circle.com');
        console.log('   2. Request "StableFX" product access for sandbox');
        console.log('   3. Or join Discord: https://discord.com/invite/buildoncircle');
      }
    }
    
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

testCircleAuthentication();
