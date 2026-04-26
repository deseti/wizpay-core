# WizPay Backend

Stablecoin payroll infrastructure API for the WizPay platform.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Start development server (hot-reload)
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## API Endpoints

| Method | Path                     | Description              |
| ------ | ------------------------ | ------------------------ |
| GET    | `/health`                | Server health check      |
| POST   | `/api/fx/quote`          | Request an FX quote      |
| POST   | `/api/fx/execute`        | Execute a quoted trade   |
| GET    | `/api/fx/status/:tradeId`| Check settlement status  |

### Example: Request a Quote

```bash
curl -X POST http://localhost:4000/api/fx/quote \
  -H "Content-Type: application/json" \
  -d '{"sourceCurrency":"USDC","targetCurrency":"EURC","sourceAmount":"1000"}'
```

## Deployment (Render)

1. Set the **Build Command** to `npm run build`
2. Set the **Start Command** to `npm start`
3. Add environment variables from `.env.example`
