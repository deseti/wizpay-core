import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
const API_BASE_URL = 'https://api-sandbox.circle.com';

async function testAuthFormats() {
  console.log('🔐 Testing Different Circle API Authorization Formats\n');
  console.log(`API Key: ${CIRCLE_API_KEY}\n`);
  
  // Format 1: Bearer Token
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Format 1: Bearer Token (Current)');
  console.log(`Authorization: Bearer ${CIRCLE_API_KEY}\n`);
  
  try {
    const res = await fetch(`${API_BASE_URL}/v1/configuration`, {
      headers: {
        'Authorization': `Bearer ${CIRCLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`Status: ${res.status}`);
    if (!res.ok) {
      const err = await res.text();
      console.log(`Error: ${err}`);
    } else {
      const data = await res.json();
      console.log(`✅ Success!`);
    }
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
  
  // Format 2: Basic Auth (API Key as username)
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Format 2: Basic Auth');
  const basicAuth = Buffer.from(`${CIRCLE_API_KEY}:`).toString('base64');
  console.log(`Authorization: Basic [base64]\n`);
  
  try {
    const res = await fetch(`${API_BASE_URL}/v1/configuration`, {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`Status: ${res.status}`);
    if (!res.ok) {
      const err = await res.text();
      console.log(`Error: ${err}`);
    } else {
      const data = await res.json();
      console.log(`✅ Success!`);
    }
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
  
  // Format 3: API Key in custom header
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Format 3: X-Circle-API-Key header');
  console.log(`X-Circle-API-Key: ${CIRCLE_API_KEY}\n`);
  
  try {
    const res = await fetch(`${API_BASE_URL}/v1/configuration`, {
      headers: {
        'X-Circle-API-Key': CIRCLE_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    console.log(`Status: ${res.status}`);
    if (!res.ok) {
      const err = await res.text();
      console.log(`Error: ${err}`);
    } else {
      const data = await res.json();
      console.log(`✅ Success!`);
    }
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
}

testAuthFormats().catch(console.error);
