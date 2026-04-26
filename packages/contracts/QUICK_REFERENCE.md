# 🚀 WizPay Quick Reference

## 🎯 One-Liner Commands

```bash
# Update rates now
node scripts/auto-update-rates.js

# Check status
node scripts/check-adapter-status.js

# Fetch current market rate
node scripts/fetch-market-rates.js

# Auto-update every 60 minutes
node scripts/auto-update-rates.js --watch 60

# Auto-update every 30 minutes
node scripts/auto-update-rates.js --watch 30
```

---

## 📍 Contract Addresses (ARC Testnet)

```javascript
const WIZPAY         = '0x570b3d069b3350C54Ec5E78E8b2c2677ddb38C0C';
const ADAPTER        = '0x177030FBa1dE345F99C91ccCf4Db615E8016f75D';
const USDC           = '0x3600000000000000000000000000000000000000';
const EURC           = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
```

---

## 🔧 Common Tasks

### Update Rate Manually
```bash
node scripts/auto-update-rates.js
```

### Start Auto-Updater (Development)
```bash
node scripts/auto-update-rates.js --watch 60
```

### Start Auto-Updater (Production with PM2)
```bash
pm2 start "node scripts/auto-update-rates.js --watch 60" --name wizpay-rates
pm2 logs wizpay-rates
pm2 save
```

### Check Current Rate
```bash
node scripts/check-adapter-status.js
```

### Test API Connection
```bash
node scripts/fetch-market-rates.js
```

---

## 📊 Current Status

```
Rate:       1.16 EURC = 1 USDC
Source:     CoinGecko API
Updated:    2025-12-06T10:50:41.000Z
Validity:   5 minutes
Status:     ✅ Active
```

---

## 🔍 Troubleshooting

### Rate Expired
```bash
# Solution: Update rate
node scripts/auto-update-rates.js
```

### Insufficient Funds
```bash
# Solution: Get USDC from faucet
# Visit: https://faucet.circle.com
```

### API Down
```bash
# Automatic fallback to 1.09 rate
# No action needed
```

---

## 📚 Documentation

- **Auto-Update Guide**: `docs/AUTO_UPDATE_RATES.md`
- **Implementation Summary**: `docs/IMPLEMENTATION_SUMMARY.md`
- **Completion Report**: `docs/COMPLETED.md`
- **Project README**: `README.md`

---

## 🌐 Useful Links

- **ARC Explorer**: https://testnet.arcscan.app
- **ARC Faucet**: https://faucet.circle.com
- **CoinGecko API**: https://www.coingecko.com/en/api
- **ARC Docs**: https://docs.arc.network

---

## 💡 Tips

1. **Production**: Use PM2 for 24/7 auto-updates
2. **Development**: Use watch mode for testing
3. **Monitoring**: Check status regularly
4. **Gas**: Each update costs ~$0.01 USDC

---

## ⚡ Quick Stats

- **Gas per Update**: ~37,700
- **Cost per Update**: ~$0.01
- **API Response**: <500ms
- **Rate Validity**: 5 minutes
- **Update Threshold**: 0.1%

---

**Status**: ✅ Production Ready  
**Version**: 1.0.0  
**Updated**: 2025-12-06
