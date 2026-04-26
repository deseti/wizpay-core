import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
const CIRCLE_API_BASE_URL = process.env.CIRCLE_API_BASE_URL || 'https://api-sandbox.circle.com';

async function testCircleAPI() {
  console.log('🔍 Testing Circle API Connectivity...\n');
  
  if (!CIRCLE_API_KEY) {
    console.error('❌ CIRCLE_API_KEY not found in .env file');
    process.exit(1);
  }
  
  console.log('✅ API Key found');
  console.log('🌐 Base URL:', CIRCLE_API_BASE_URL);
  console.log('🔑 API Key:', CIRCLE_API_KEY.substring(0, 20) + '...\n');
  
  try {
    // Test 1: Check API health/ping
    console.log('📊 Test 1: Testing API connection...');
    const healthResponse = await fetch(`${CIRCLE_API_BASE_URL}/v1/ping`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CIRCLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Health Status:', healthResponse.status);
    if (healthResponse.ok) {
      const healthData = await healthResponse.text();
      console.log('✅ API connection successful');
      console.log('Response:', healthData);
    } else {
      const errorText = await healthResponse.text();
      console.log('Response:', errorText);
    }
    console.log('');
    
    // Test 2: Try to fetch exchange rates (Circle FX API)
    console.log('📊 Test 2: Fetching exchange rates from Circle API...');
    
    // Try different possible endpoints
    const endpoints = [
      '/v1/w3s/transfers/config',
      '/v1/businessAccount/configuration',
      '/v1/configuration',
    ];
    
    for (const endpoint of endpoints) {
      console.log(`Trying endpoint: ${endpoint}`);
      const response = await fetch(`${CIRCLE_API_BASE_URL}${endpoint}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${CIRCLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log(`Status: ${response.status}`);
      const text = await response.text();
      console.log(`Response: ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`);
      console.log('');
      
      if (response.ok) {
        console.log('✅ Found working endpoint!');
        break;
      }
    }
    
    console.log('\n✅ Circle API test completed successfully!');
    
  } catch (error) {
    console.error('❌ Error testing Circle API:', error.message);
    console.error(error);
  }
}

testCircleAPI();
