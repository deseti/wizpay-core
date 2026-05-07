---
title: "Domain Multi-Tenant Architecture"
description: "Root registry, per-partner namespaces, and domain dashboard separation."
---

# Domain Multi-Tenant Architecture

WizPay domain services now assume a multi-tenant registry model from day one.

The global namespace remains `.arc`, but custom namespaces such as `.usdc`, `.pay`, and `.dao` are treated as partner-created namespaces, not platform-owned defaults.

## Namespace Model

- `.arc` is the canonical global namespace owned and governed by WizPay.
- Every custom namespace is created by a partner that pays a one-time `500 USDC` namespace registration fee.
- Namespace creation automatically provisions:
  - a dedicated registrar
  - a dedicated controller
  - a dedicated revenue vault
  - independent pricing and promo configuration

Examples:

- `deseti.arc` routes domain revenue to the WizPay platform vault.
- `alice.usdc` routes domain revenue to the vault controlled by the `.usdc` partner.

## Contract Topology

```text
ArcRegistry (ENS-style name records)
└── RootRegistry
    ├── bootstraps .arc
    │   ├── NamespaceRegistrar(.arc)
    │   └── NamespaceController(.arc)
    └── provisions partner namespaces
        ├── NamespaceRegistrar(.partner)
        ├── NamespaceController(.partner)
    └── RevenueVault(partner-owned)
```

### RootRegistry Responsibilities

- Tracks every namespace and namespace owner.
- Collects the `500 USDC` custom-namespace setup fee.
- Stores namespace pricing tiers.
- Stores namespace promo configuration.
- Stores namespace vault routing.
- Stores namespace active status.
- Stores whitelist and blacklist state.
- Allows admin-level force overrides.
- Reserves critical labels such as `.arc`, `.root`, `.admin`, and `.www` from partner registration.

### NamespaceController Responsibilities

- Registers second-level domains.
- Renews second-level domains.
- Applies namespace pricing and active promo rules from `RootRegistry`.
- Routes sales revenue to the vault configured for that namespace.

### NamespaceRegistrar Responsibilities

- Owns the namespace node in `ArcRegistry`.
- Issues ERC-721 ownership for second-level labels.
- Manages expiry and grace-period behavior.

## Revenue Rules

- `.arc` sales revenue goes to the WizPay platform vault.
- Custom namespace creation fees go to the WizPay platform vault.
- Custom namespace domain sales go to the partner vault configured for that namespace.

This keeps platform revenue and partner revenue separated at the contract level.

## Admin and Partner Controls

### Partner Controls

- Create a namespace by paying `500 USDC`.
- Manage pricing for their namespace.
- Manage promo discounts for their namespace.
- Withdraw revenue from their namespace vault.
- Operate domain sales under their own namespace immediately after creation.

### Developer/Admin Controls

- Bootstrap and govern `.arc`.
- Suspend a namespace.
- Whitelist or blacklist a namespace.
- Override partner pricing, promo, or vault settings when necessary.
- Manage the platform vault.

## Frontend Separation

The domain system should be treated as a distinct product surface from WizPay payroll and payment execution.

### Main User Dashboard

- Search domains across `.arc` and partner namespaces.
- Register `.arc` domains.
- Register domains under partner namespaces.
- Renew domains.
- Transfer domains.

### Partner Dashboard

- Create and manage a custom namespace.
- Review domain sales.
- View revenue analytics.
- Configure promos.
- Configure pricing.
- Withdraw namespace vault revenue.

### Developer/Admin Dashboard

- Inspect all namespaces.
- Suspend partners.
- Whitelist or blacklist namespaces.
- Manage `.arc`.
- Manage platform-wide overrides.
- Manage the platform vault.

### Product Boundary

Domain management should not share the same dashboard surface as WizPay payroll, treasury routing, or payment execution.

The clean boundary is:

- payroll/payment dashboards remain focused on money movement and execution workflows
- domain dashboards remain focused on namespace governance, registration, renewals, transfers, and vault analytics