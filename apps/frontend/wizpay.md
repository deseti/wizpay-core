# WizPay Workspace Notes

- Frontend app: `/home/deseti213/projects/wizpay/apps/frontend`
- Backend service: `/home/deseti213/projects/wizpay/apps/backend-legacy`
- Contracts workspace: `/home/deseti213/projects/wizpay/packages/contracts`
- Landing site: `/home/deseti213/projects/wizpay/apps/landing`

## Active Layout

```text
wizpay/
├── apps/
│   ├── frontend/
│   ├── backend-legacy/
│   └── landing/
└── packages/
    └── contracts/
```

## Local Commands

```bash
npm --prefix /home/deseti213/projects/wizpay/apps/frontend run dev
npm --prefix /home/deseti213/projects/wizpay/apps/backend-legacy run dev
npm --prefix /home/deseti213/projects/wizpay/apps/landing run dev
cd /home/deseti213/projects/wizpay/packages/contracts && forge test
```
