import fs from 'fs';
import { execSync } from 'child_process';

async function main() {
    process.env.NO_COLOR = '1';
    process.env.FORCE_COLOR = '0';
    
    let envText = fs.readFileSync('.env', 'utf8');
    if (!envText.includes('WIZPAY_ADDRESS')) {
        envText += '\nWIZPAY_ADDRESS=0x6E8B94dE557D7EB5C0628722511F0A0236a57214\n';
    }
    if (!envText.includes('MOCKFXENGINE_ADDRESS')) {
        envText += 'MOCKFXENGINE_ADDRESS=0xF939f0A6c20c90f4a4f1Af704E51300c0bEA68eA\n';
    }
    fs.writeFileSync('.env', envText);

    console.log("1️⃣  Deploying StableFXAdapter (REAL)...");
    const out = execSync("npx hardhat run scripts/deploy-stablefx-adapter.js --network arc-testnet", { env: process.env }).toString();
    
    // Clean ANSI codes just in case
    const cleanOut = out.replace(/\u001b\[.*?m/g, '');
    const match = cleanOut.match(/StableFXAdapter deployed to:\s+(0x[a-fA-F0-9]{40})/);
    
    if (match) {
        const address = match[1];
        console.log("✅ Deployed REAL Adapter to:", address);
        
        let currentEnv = fs.readFileSync('.env', 'utf8');
        if (currentEnv.includes('STABLEFX_ADAPTER_ADDRESS=')) {
            currentEnv = currentEnv.replace(/STABLEFX_ADAPTER_ADDRESS=0x[a-fA-F0-9]{40}/, 'STABLEFX_ADAPTER_ADDRESS=' + address);
        } else {
            currentEnv += `\nSTABLEFX_ADAPTER_ADDRESS=${address}\n`;
        }
        fs.writeFileSync('.env', currentEnv);
        console.log("✅ Updated .env configuration");

        console.log("\n2️⃣  Funding the Adapter with 50% available Liquidity...");
        execSync("npx hardhat run scripts/fund-adapter.js --network arc-testnet", { stdio: 'inherit', env: process.env });
        
        console.log("\n3️⃣  Migrating WizPay to REAL StableFXAdapter...");
        execSync("npx hardhat run scripts/migrate-to-stablefx.js --network arc-testnet", { stdio: 'inherit', env: process.env });
        
        console.log("\n🎉 ALL DONE! Migration to REAL infrastructure is complete.");
    } else {
        console.log("❌ Failed to parse deployed address from output:");
        console.log(cleanOut);
    }
}

main().catch(console.error);
