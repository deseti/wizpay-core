# WizPay Codebase Analysis Report

## Executive Summary

The WizPay codebase has several critical refactoring opportunities. The analysis identified **16 files exceeding 500 lines** with multiple code complexity issues, circular dependencies, and duplicated patterns. The most pressing issues are in large monolithic components that mix concerns and need immediate decomposition.

---

## 1. LARGE/HEAVY FILES (>500 Lines)

### Frontend (10 files)

| File | Lines | Category | Risk Level |
|------|-------|----------|-----------|
| [CircleWalletProvider.tsx](apps/frontend/components/providers/CircleWalletProvider.tsx) | 1698 | Provider/Context | 🔴 CRITICAL |
| [BridgeScreen.tsx](apps/frontend/components/dashboard/BridgeScreen.tsx) | 1567 | Component | 🔴 CRITICAL |
| [BatchComposer.tsx](apps/frontend/components/dashboard/BatchComposer.tsx) | 1231 | Component | 🔴 CRITICAL |
| [stablefx-abi.ts](apps/frontend/constants/stablefx-abi.ts) | 896 | Constants | 🟡 MEDIUM |
| [circle-auth.service.ts](apps/frontend/services/circle-auth.service.ts) | 888 | Service | 🔴 CRITICAL |
| [useExternalBridge.ts](apps/frontend/components/dashboard/bridge/useExternalBridge.ts) | 748 | Hook | 🔴 CRITICAL |
| [useWizPayContract.ts](apps/frontend/hooks/wizpay/useWizPayContract.ts) | 697 | Hook | 🔴 CRITICAL |
| [SwapScreen.tsx](apps/frontend/components/dashboard/SwapScreen.tsx) | 679 | Component | 🔴 CRITICAL |
| [circle-passkey.ts](apps/frontend/lib/circle-passkey.ts) | 620 | Library | 🔴 CRITICAL |
| [transfer-service.ts](apps/frontend/lib/transfer-service.ts) | 515 | Service | 🟡 MEDIUM |

### Backend (6 files)

| File | Lines | Category | Risk Level |
|------|-------|----------|-----------|
| [task.service.ts](apps/backend/src/task/task.service.ts) | 880 | Service | 🔴 CRITICAL |
| [blockchain.service.ts](apps/backend/src/adapters/blockchain.service.ts) | 703 | Adapter | 🔴 CRITICAL |
| [circle-bridge.service.ts](apps/backend/src/adapters/circle/circle-bridge.service.ts) | 670 | Service | 🔴 CRITICAL |
| [circle.service.ts](apps/backend/src/adapters/circle.service.ts) | 659 | Service | 🟡 MEDIUM |
| [w3s-auth.service.ts](apps/backend/src/modules/wallet/w3s-auth.service.ts) | 652 | Service | 🟡 MEDIUM |
| [wallet.service.ts](apps/backend/src/modules/wallet/wallet.service.ts) | 596 | Service | 🟡 MEDIUM |

---

## 2. CODE COMPLEXITY ANALYSIS

### Backend Issues

#### **CRITICAL: TaskService (880 lines, 34 methods)**
**File:** [apps/backend/src/task/task.service.ts](apps/backend/src/task/task.service.ts)

**Multiple Responsibilities:**
1. **Task Creation** - `createTask()`, `createPayrollTask()`, `createSwapTask()`, `createLiquidityTask()`
2. **Status Management** - `updateStatus()`, validates state machine transitions
3. **Logging** - `logStep()`, `hasLogStep()` - task audit trail
4. **Unit Management** - `reportTaskUnit()`, `reportUnitBatch()` - child task tracking
5. **Transaction Tracking** - `appendTransaction()`, `updateTransaction()`, `getTransactionAggregation()`
6. **Business Logic** - normalization, metadata extraction, reference ID mapping

**Why it's problematic:**
- Task persistence, logging, unit batching, and transaction tracking are distinct concerns
- 34 methods make testing difficult
- High cognitive load for understanding task lifecycle
- Circular dependencies with `PayrollBatchService` and `PayrollValidationService` (using `forwardRef`)

**Suggested Refactoring:**
```
TaskService (core creation/state management)
├── TaskLogService (audit logging - EXTRACT)
├── TaskUnitService (unit/batch management - EXTRACT)
├── TaskTransactionService (tx tracking - EXTRACT)
└── TaskFactory (task type-specific creation - EXTRACT)
```

**Breaking it down:**
1. **TaskLogService** - Handle all logging (logStep, hasLogStep)
2. **TaskUnitService** - Handle unit reporting, batch operations
3. **TaskTransactionService** - Handle transaction append/update/aggregation
4. **TaskFactory** - Factory pattern for createPayrollTask, createSwapTask, createLiquidityTask
5. **TaskService** - Reduce to core: createTask, updateStatus, getTaskById

---

#### **CRITICAL: BlockchainService (703 lines)**
**File:** [apps/backend/src/adapters/blockchain.service.ts](apps/backend/src/adapters/blockchain.service.ts)

**Multiple Responsibilities:**
1. EVM transaction execution (approve, transfer, swap)
2. Solana transaction building and execution  
3. Network switching and gas estimation
4. Chain-specific RPC interactions
5. Error recovery and retry logic

**Why it's problematic:**
- Mixed EVM and Solana logic in single file
- No clear separation of chain-specific concerns
- Difficult to extend to new chains (Polygon, Optimism, etc.)
- Hard to test EVM logic independently of Solana

**Suggested Refactoring:**
```
BlockchainService (orchestrator)
├── EvmBlockchainService (Ethereum/Arc logic - EXTRACT)
├── SolanaBlockchainService (Solana logic - EXTRACT)
├── ChainFactory (instantiate correct handler - EXTRACT)
└── GasEstimationService (shared utility - EXTRACT)
```

---

#### **CRITICAL: CircleBridgeService (670 lines)**
**File:** [apps/backend/src/adapters/circle/circle-bridge.service.ts](apps/backend/src/adapters/circle/circle-bridge.service.ts)

**Multiple Responsibilities:**
1. Bridge initiation and setup
2. Step execution and polling
3. Blockchain-specific bridge logic (ETH-SEPOLIA, ARC-TESTNET, SOLANA-DEVNET)
4. RPC calls and attestation handling
5. Error recovery and retries

**Why it's problematic:**
- Bridge execution mixed with blockchain-specific details
- Polling logic could be reused elsewhere
- Hard to add new bridge providers (Stargate, Hyperlane, etc.)

**Suggested Refactoring:**
```
CircleBridgeService (core bridge abstraction)
├── BridgeStepExecutor (extract step execution logic)
├── BridgePollingService (extract polling with retry - EXTRACT)
├── CircleAttestationHandler (extract attestation logic - EXTRACT)
└── BridgeErrorRecoveryService (extract error handling - EXTRACT)
```

---

#### **MEDIUM: CircleService (659 lines)**
**File:** [apps/backend/src/adapters/circle.service.ts](apps/backend/src/adapters/circle.service.ts)

**Multiple Responsibilities:**
1. Transfer operations
2. FX (foreign exchange) quotes and trades
3. Wallet balance queries
4. Status polling with retries

**Suggested Fix:**
```
CircleAdapterService (main orchestrator)
├── CircleTransferService (EXTRACT - transfers only)
├── CircleFxService (EXTRACT - FX operations)
└── CircleStatusPollingService (EXTRACT - polling logic)
```

---

### Frontend Issues

#### **CRITICAL: CircleWalletProvider (1698 lines)**
**File:** [apps/frontend/components/providers/CircleWalletProvider.tsx](apps/frontend/components/providers/CircleWalletProvider.tsx)

**Multiple Responsibilities:**
1. Circle W3S SDK initialization and lifecycle
2. Passkey authentication handling
3. Google OAuth integration  
4. Email OTP authentication
5. Device token management
6. Cookie and local storage persistence
7. Challenge creation and execution
8. Wallet balance fetching and caching

**Why it's problematic:**
- Provider is 1698 lines - massive for a context provider
- Mixing authentication methods makes testing difficult
- Hard to add new auth methods (WebAuthn, Farcaster, etc.)
- Storage logic interspersed with auth logic
- ~200+ lines of imports shows high coupling

**Suggested Refactoring:**
```
CircleWalletProvider (coordinates sub-providers)
├── CircleW3SProvider (EXTRACT - W3S auth only)
├── CirclePasskeyProvider (EXTRACT - Passkey auth only)
├── CircleGoogleAuthProvider (EXTRACT - Google OAuth)
├── CircleStorageService (EXTRACT - persistence logic)
└── CircleDeviceTokenProvider (EXTRACT - device management)
```

**Or use composition pattern:**
```
CircleWalletProvider
├── GoogleOAuthHandler
├── PasskeyAuthHandler  
├── EmailOtpHandler
├── W3SSdkHandler
└── StorageManager
```

---

#### **CRITICAL: BridgeScreen (1567 lines)**
**File:** [apps/frontend/components/dashboard/BridgeScreen.tsx](apps/frontend/components/dashboard/BridgeScreen.tsx)

**Multiple Responsibilities:**
1. UI rendering (form inputs, dialogs, modals)
2. Bridge state management (30+ useState calls)
3. Wallet operations (bootstrap, refresh, sync)
4. Transfer polling and recovery
5. Chain/token configuration
6. External wallet integration
7. Error handling and validation

**Why it's problematic:**
- 30+ state variables make component hard to reason about
- Mixed concerns: UI, state, business logic, API calls
- 150+ lines of useEffect hooks
- useCallback and useMemo scattered throughout for optimization

**State Variables Breakdown:**
- Blockchain selection: 2 (sourceChain, destinationChain)
- User input: 3 (amount, destinationAddress, passkeySolanaInput)
- Transfer state: 2 (transfer, transferWallet)
- UI state: 10+ (errorMessage, isSubmitting, isWalletLoading, etc.)
- Wallet state: 3+ (destinationWallets, externalUsdcBalance, etc.)
- Dialog state: 3 (isReviewDialogOpen, isSuccessDialogOpen, etc.)
- Refs: 4+ (restoredTransferRef, terminalNoticeRef, etc.)

**Suggested Refactoring:**
```typescript
// 1. Create BridgeScreenState hook
export const useBridgeScreenState = () => ({
  sourceChain,
  setSourceChain,
  destinationChain,
  setDestinationChain,
  amount,
  setAmount,
  // ... all state in one hook
});

// 2. Extract logic into custom hooks
useBridgeWalletManagement()  // wallet bootstrap, refresh
useBridgeTransferPolling()   // transfer polling, recovery
useBridgeValidation()         // validation logic
useBridgeExternalWallet()     // external wallet integration
useBridgeDestinationWallets() // destination wallet loading

// 3. Split into smaller components
<BridgeSourceSelector />
<BridgeDestinationSelector />
<BridgeTransferForm />
<BridgeProgressIndicator />
<BridgeWalletInfo />
<BridgeDialogs />

// 4. Final structure
<BridgeScreen />
├── <BridgeSourceSelector />
├── <BridgeDestinationSelector />
├── <BridgeTransferForm />
├── <BridgeProgressIndicator />
├── <BridgeWalletInfo />
└── <BridgeDialogs />
```

---

#### **CRITICAL: BatchComposer (1231 lines)**
**File:** [apps/frontend/components/dashboard/BatchComposer.tsx](apps/frontend/components/dashboard/BatchComposer.tsx)

**Multiple Responsibilities:**
1. Batch recipient management (add, remove, edit)
2. CSV import/export functionality
3. Token and amount input validation
4. QR code scanning for recipient addresses
5. Batch summary calculation
6. Recipient reconciliation
7. UI rendering (table, dialogs, forms)

**Suggested Refactoring:**
```
<BatchComposer /> (orchestrator)
├── useBatchRecipients() (state management)
├── useBatchImportExport() (CSV logic)
├── useBatchValidation() (validation)
├── <RecipientTable />
├── <RecipientForm />
├── <BatchImportDialog />
├── <BatchSummary />
└── <RecipientScanner />
```

---

#### **CRITICAL: useExternalBridge Hook (748 lines)**
**File:** [apps/frontend/components/dashboard/bridge/useExternalBridge.ts](apps/frontend/components/dashboard/bridge/useExternalBridge.ts)

**Multiple Responsibilities:**
1. CCTP V2 bridge execution
2. EVM transaction signing
3. Attestation polling
4. Solana bridge handling
5. Error recovery and retries
6. Status tracking

**Why it's problematic:**
- Custom hook with 748 lines is essentially a service
- Mixed EVM and Solana logic
- Tightly coupled to component usage

**Suggested Refactoring:**
```
useCctpV2Bridge() (pure EVM bridge logic)
useSolanaBridge() (pure Solana bridge logic)
useBridgeAttestation() (attestation polling)
useBridgeErrorRecovery() (error retry logic)
useExternalBridge() (orchestrates above)
```

---

#### **MEDIUM: circle-auth.service.ts (888 lines)**
**File:** [apps/frontend/services/circle-auth.service.ts](apps/frontend/services/circle-auth.service.ts)

**Multiple Responsibilities:**
1. Type definitions (100+ exported types)
2. Helper utilities for auth
3. Storage/persistence utilities
4. Error message generation
5. OAuth configuration building
6. Device token management

**Suggested Split:**
```
circle-auth.types.ts (all TypeScript interfaces/types)
circle-auth.utils.ts (helper functions)
circle-auth-storage.ts (persistence logic)
circle-auth-errors.ts (error handling)
circle-oauth.ts (OAuth-specific logic)
```

---

#### **MEDIUM: circle-passkey.ts (620 lines)**
**File:** [apps/frontend/lib/circle-passkey.ts](apps/frontend/lib/circle-passkey.ts)

**Multiple Responsibilities:**
1. Passkey SDK initialization
2. Passkey credential storage/retrieval
3. Transaction signing operations
4. Account abstraction interactions
5. Token balance fetching

**Suggested Refactoring:**
```
circle-passkey.ts (main orchestrator)
├── passkey-storage.ts (EXTRACT - credential storage)
├── passkey-signing.ts (EXTRACT - signing operations)
├── passkey-config.ts (EXTRACT - configuration)
└── passkey-runtime.ts (EXTRACT - runtime setup)
```

---

#### **MEDIUM: transfer-service.ts (515 lines)**
**File:** [apps/frontend/lib/transfer-service.ts](apps/frontend/lib/transfer-service.ts)

**Multiple Responsibilities:**
1. Transfer creation and polling
2. Wallet bootstrap and syncing
3. Status tracking
4. Error recovery

**Suggested Refactoring:**
```
transfer-service.ts (main API)
├── transfer-wallet.ts (EXTRACT - wallet operations)
├── transfer-polling.ts (EXTRACT - polling logic)
└── transfer-status.ts (EXTRACT - status tracking)
```

---

## 3. CIRCULAR DEPENDENCIES

### Backend

**TaskService → PayrollBatchService ↔ PayrollValidationService**
```
apps/backend/src/task/task.service.ts
├── Injects PayrollBatchService (forwardRef)
├── Injects PayrollValidationService (forwardRef)
└── Both are used in createPayrollTask()

apps/backend/src/agents/payroll/payroll.agent.ts
└── Also depends on TaskService
```

**Risk:** Using `forwardRef` indicates potential design issue where services are too tightly coupled.

**Recommendation:** 
- Move payroll validation to dedicated `PayrollValidator` interface
- Extract batch logic to `PayrollBatcher` interface
- Inject these interfaces instead of concrete services
- This breaks the circular dependency chain

---

### Frontend

**CircleWalletProvider → circle-auth.service → CircleWalletProvider (indirect)**
```
CircleWalletProvider.tsx (1698 lines)
├── Imports from circle-auth.service.ts (888 lines)
├── Imports from circle-passkey.ts (620 lines)
├── Imports from backend-wallets.ts
└── Many of these re-export CircleWalletProvider types
```

**Recommendation:** 
- Extract auth logic from provider
- Create separate service layer for auth without circular references
- Use inversion of control (dependency injection) for better testability

---

## 4. DUPLICATED CODE PATTERNS

### Backend

#### Pattern 1: Validation at Service Entry Points
```typescript
// In multiple services (circle.service.ts, circle-bridge.service.ts, etc.)
if (!walletId) {
  throw new Error(`Required field missing: walletId`);
}
if (!toAddress || !isAddress(toAddress)) {
  throw new Error(`Invalid address: ${toAddress}`);
}
```

**Solution:** Create shared validation utilities
```typescript
// src/common/validation.ts
export const validateWalletId = (id: any): string => {
  if (!id) throw new Error('walletId required');
  return id as string;
};

export const validateBlockchainAddress = (addr: any, chain: string): string => {
  // chain-specific validation
};
```

---

#### Pattern 2: Status Polling with Retry
```typescript
// In circle.service.ts, circle-bridge.service.ts, transaction-poller.service.ts
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  const status = await this.getStatus(id);
  if (TERMINAL_STATUSES.has(status)) {
    return status;
  }
  if (attempt < maxAttempts - 1) {
    await sleep(retryDelayMs);
  }
}
```

**Solution:** Create reusable polling utility
```typescript
// src/common/polling.service.ts
export const pollWithRetry = async <T>(
  fn: () => Promise<T>,
  isTerminal: (result: T) => boolean,
  options: PollOptions
): Promise<T> => {
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    const result = await fn();
    if (isTerminal(result)) return result;
    if (attempt < options.maxAttempts - 1) {
      await sleep(options.delayMs);
    }
  }
  throw new Error('Max polling attempts exceeded');
};
```

---

#### Pattern 3: Error Message Mapping
```typescript
// Multiple places map status to error messages
const errorMap: Record<string, string> = {
  'FAILED': 'Transaction failed',
  'PENDING': 'Still processing',
  'CANCELLED': 'User cancelled',
};
```

**Solution:** Centralized error mapping
```typescript
// src/common/error-messages.ts
export const CIRCLE_ERROR_MESSAGES: Record<string, string> = {...};
export const BRIDGE_ERROR_MESSAGES: Record<string, string> = {...};
```

---

### Frontend

#### Pattern 1: Wallet Balance Formatting
```typescript
// In BridgeScreen.tsx, SwapScreen.tsx, LiquidityScreen.tsx
const formatted = formatUnits(balance, decimals);
const parsed = parseFloat(formatted);
const display = parsed > 0.01 ? parsed.toFixed(2) : '0.00';
```

**Solution:** Create utility hook
```typescript
export const useFormattedBalance = (balance: bigint, decimals: number) => ({
  raw: balance,
  formatted: formatUnits(balance, decimals),
  display: /* formatting logic */,
  isSmall: /* small balance check */,
});
```

---

#### Pattern 2: Transfer Status Polling
```typescript
// In BridgeScreen.tsx, useExternalBridge.ts, and other places
const poll = async () => {
  try {
    const status = await getTransferStatus(transferId);
    if (TERMINAL_STATUSES.includes(status.status)) {
      setIsPolling(false);
      return;
    }
  } catch (err) {
    setError(err.message);
  }
};
```

**Solution:** Extract to reusable hook
```typescript
export const useTransferPolling = (transferId: string | null) => ({
  transfer,
  isPolling,
  error,
  startPolling,
  stopPolling,
});
```

---

#### Pattern 3: Dialog/Modal State Management
```typescript
// In BridgeScreen.tsx, BatchComposer.tsx, SwapScreen.tsx
const [isDialogOpen, setIsDialogOpen] = useState(false);
const [dialogError, setDialogError] = useState<string | null>(null);
const [isDialogLoading, setIsDialogLoading] = useState(false);

const openDialog = () => setIsDialogOpen(true);
const closeDialog = () => {
  setIsDialogOpen(false);
  setDialogError(null);
  setIsDialogLoading(false);
};
```

**Solution:** Create dialog state hook
```typescript
export const useDialogState = (onClose?: () => void) => ({
  isOpen,
  setIsOpen,
  error,
  setError,
  isLoading,
  setIsLoading,
  open: () => setIsOpen(true),
  close: () => { setIsOpen(false); setError(null); },
});
```

---

## 5. MODULE STRUCTURE GAPS

### Backend Issues

#### Gap 1: No Query/Read Service Pattern
All task-related queries go through `TaskService` which also handles writes. This violates CQRS principle.

**Recommendation:**
```
task-write.service.ts (createTask, updateStatus, append/update transactions)
task-query.service.ts (getTaskById, getTasksByStatus, getTaskHistory)
task.module.ts (exports both services)
```

---

#### Gap 2: Blockchain Adapter Pattern Incomplete
Each blockchain has its own service (ethereum, solana) but no clear interface.

**Recommendation:**
```
// src/adapters/blockchain/blockchain.adapter.ts
export interface IBlockchainAdapter {
  executeTransfer(input: TransferInput): Promise<TransferResult>;
  estimateGas(input: TransferInput): Promise<string>;
  queryBalance(address: string): Promise<Balance>;
}

// src/adapters/blockchain/ethereum.adapter.ts
export class EthereumAdapter implements IBlockchainAdapter { }

// src/adapters/blockchain/solana.adapter.ts
export class SolanaAdapter implements IBlockchainAdapter { }

// src/adapters/blockchain/blockchain-factory.ts
export class BlockchainAdapterFactory {
  static create(chain: SupportedChain): IBlockchainAdapter { }
}
```

---

#### Gap 3: No Middleware for Common Cross-Cutting Concerns
Logging, metrics, error handling are scattered across services.

**Recommendation:** Create decorator-based middleware
```typescript
// src/common/decorators/
@WithLogging()
@WithErrorHandling()
@WithMetrics()
async transfer(input: TransferInput) { }
```

---

### Frontend Issues

#### Gap 1: No Shared State Management for Complex Features
Each screen manages its own state (Bridge, Swap, Payroll) with similar patterns.

**Recommendation:** Create shared state management utilities
```
hooks/state/
├── useBridgeState.ts (bridge-specific state machine)
├── useSwapState.ts (swap-specific state machine)
├── usePayrollState.ts (payroll-specific state machine)
└── useAsyncState.ts (reusable async operation state)

// Example
const useBridgeState = () => {
  const [state, dispatch] = useReducer(bridgeReducer, initialState);
  return { state, dispatch, startBridge, completeBridge, failBridge };
};
```

---

#### Gap 2: Utility Functions Scattered in `lib/`
Functions are organized by feature, not by responsibility.

**Recommendation:** Organize by utility type
```
lib/
├── formatting/
│   ├── balance.ts (balance formatting utilities)
│   ├── address.ts (address formatting)
│   └── token.ts (token display utilities)
├── validation/
│   ├── address.ts (address validation)
│   ├── amount.ts (amount validation)
│   └── chain.ts (chain validation)
├── polling/
│   └── polling.ts (reusable polling logic)
├── errors/
│   └── error-messages.ts (centralized error messages)
└── ... (feature-specific utilities)
```

---

#### Gap 3: No Clear Separation Between Backend & Frontend Bridge Logic
Both handle CCTP but with different abstractions.

**Recommendation:** Create shared abstractions
```
// Frontend creates transfer via backend
frontend: createCircleTransfer() → POST /api/transfers
backend: TaskService.createBridgeTask()

// These should use same validation/types
shared/schemas/ (use Zod or similar)
├── transfer.schema.ts
├── bridge.schema.ts
└── bridge-status.schema.ts
```

---

## 6. REFACTORING PRIORITY

### Phase 1: Quick Wins (1-2 weeks)
**Extract high-reuse utilities with minimal breaking changes**

1. **Backend Polling Service** → Extract from circle.service.ts and others
2. **Frontend Utility Hooks** → Extract dialog state, balance formatting, polling
3. **Shared Error Messages** → Centralize error mappings
4. **Shared Validation** → Extract validation from multiple services

---

### Phase 2: Service Decomposition (2-3 weeks)
**Break down monolithic services**

1. **TaskService Split** → LogService, UnitService, TransactionService
2. **CircleWalletProvider Split** → Separate auth methods into sub-providers
3. **BridgeScreen Refactor** → Extract state management into hooks
4. **BatchComposer Refactor** → Extract CSV/recipient logic into utilities

---

### Phase 3: Architecture Improvements (3-4 weeks)
**Implement proper patterns**

1. **Blockchain Adapter Pattern** → Create IBlockchainAdapter interface
2. **CQRS for TaskService** → Separate read and write services
3. **State Machine** → Use xstate for complex component state
4. **Middleware/Decorators** → Centralize logging, metrics, error handling

---

### Phase 4: Module Reorganization (4+ weeks)
**Restructure directories for better organization**

Backend:
```
src/
├── modules/
│   ├── task/ (task management)
│   ├── bridge/ (bridge operations)
│   ├── swap/ (swap operations)
│   ├── payroll/ (payroll operations)
│   └── wallet/ (wallet management)
├── adapters/ (blockchain/third-party)
├── common/ (shared utilities)
└── core/ (domain logic)
```

Frontend:
```
app/
├── (dashboard)/
│   ├── bridge/ (bridge feature)
│   ├── swap/ (swap feature)
│   └── payroll/ (payroll feature)
├── lib/
│   ├── formatting/
│   ├── validation/
│   ├── api/
│   └── hooks/
└── components/
    └── shared/
```

---

## 7. REFACTORING WITHOUT BREAKING FEATURES

### Strategy: Strangler Pattern

1. **Create new service alongside old** (shadow implementation)
2. **Route new feature usage to new service** 
3. **Keep old service for backward compatibility**
4. **Gradually migrate consumers**
5. **Remove old service when complete**

Example for TaskService:
```typescript
// Phase 1: New services exist alongside old
src/task/task-log.service.ts (new, parallel)
src/task/task-unit.service.ts (new, parallel)
src/task/task.service.ts (old, still used)

// Phase 2: Update TaskService to delegate
export class TaskService {
  constructor(
    private readonly logService: TaskLogService, // new
    private readonly unitService: TaskUnitService, // new
    private readonly prisma: PrismaService,
  ) {}

  async logStep(taskId, step, status, message) {
    return this.logService.log(taskId, step, status, message);
  }
}

// Phase 3: When all consumers migrated, remove delegation
// and use services directly

// Phase 4: Deprecate TaskService if no longer needed
```

---

## 8. TESTING IMPLICATIONS

Current state requires testing large monolithic components.

### After Refactoring:

| Current | Refactored | Testing Benefit |
|---------|-----------|-----------------|
| TaskService (880 lines, 1 test file) | TaskLogService (100 lines) | 10x simpler to test |
| BridgeScreen (1567 lines) | Multiple hooks + components | Test each hook independently |
| CircleWalletProvider (1698 lines) | Separate auth providers | Mock individual auth methods |

---

## 9. DEPENDENCIES GRAPH

### Most Tightly Coupled

**Backend:**
```
TaskService 
  ├→ PrismaService
  ├→ PayrollBatchService (circular risk)
  ├→ PayrollValidationService (circular risk)
  └→ Used by: OrchestratorService, all Agents, Queue Processors
```

**Frontend:**
```
BridgeScreen (1567 lines)
  ├→ CircleWalletProvider (1698 lines)
  ├→ HybridWalletProvider
  ├→ useExternalBridge (748 lines)
  ├→ transfer-service (515 lines)
  ├→ CCTP logic
  └→ Multiple other custom hooks
```

---

## 10. ACTIONABLE CHECKLIST

### For Backend Team

- [ ] Extract `TaskLogService` from `TaskService`
- [ ] Extract `TaskUnitService` from `TaskService`
- [ ] Extract `TaskTransactionService` from `TaskService`
- [ ] Create `PollingService` utility used by Circle services
- [ ] Create `IBlockchainAdapter` interface
- [ ] Extract `EthereumBlockchainAdapter` from `BlockchainService`
- [ ] Extract `SolanaBlockchainAdapter` from `BlockchainService`
- [ ] Move validation logic to `src/common/validation`
- [ ] Create task read/write service separation
- [ ] Reduce `forwardRef` usage in TaskModule

---

### For Frontend Team

- [ ] Extract auth providers from `CircleWalletProvider`
  - [ ] `CircleW3SProvider`
  - [ ] `CirclePasskeyProvider`
  - [ ] `CircleGoogleAuthProvider`
- [ ] Break down `BridgeScreen` into 5-6 smaller components
- [ ] Extract custom hooks from `BridgeScreen`
- [ ] Split `circle-auth.service.ts` into 5 focused files
- [ ] Extract dialog state hook used across screens
- [ ] Create shared `useTransferPolling` hook
- [ ] Centralize error messages in `lib/errors`
- [ ] Create `useFormattedBalance` hook
- [ ] Refactor `BatchComposer` to use extracted utilities
- [ ] Add proper TypeScript interfaces for large state objects

---

## Conclusion

The codebase requires systematic refactoring to improve maintainability. The biggest wins come from:

1. **Breaking down monolithic services** (TaskService, CircleWalletProvider)
2. **Extracting reusable utilities** (polling, validation, formatting)
3. **Separating concerns** (auth methods, blockchain adapters)
4. **Creating proper abstractions** (interfaces, factories, hooks)

Each refactoring should follow the **Strangler Pattern** to avoid breaking existing features. Start with Phase 1 (quick wins) to build momentum before tackling larger architectural changes.
