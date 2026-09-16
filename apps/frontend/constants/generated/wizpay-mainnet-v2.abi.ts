// Generated from a clean temporary Foundry build. Do not edit manually.
// Source commit: e0793a886cd4d772b703a025aa20b40a2607b853; compiler digest: 0x4752c1e6ebfe900ea66129b469fdf156585bd8ed26c25cc7d018dc79412246d5.
// Mainnet ABI only; legacy and Testnet ABIs remain separate.
export const WIZPAY_MAINNET_V2_ABI = [
  {
    type: 'constructor',
    inputs: [
      {
        name: '_canonicalUsdc',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'initialOwner',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_feeCollector',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_feeBps',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'MAX_BATCH_SIZE',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_FEE_BPS',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_REFERENCE_ID_LENGTH',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'batchRouteAndPay',
    inputs: [
      {
        name: 'tokenIn',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'tokenOuts',
        type: 'address[]',
        internalType: 'address[]',
      },
      {
        name: 'recipients',
        type: 'address[]',
        internalType: 'address[]',
      },
      {
        name: 'amountsIn',
        type: 'uint256[]',
        internalType: 'uint256[]',
      },
      {
        name: 'minAmountsOut',
        type: 'uint256[]',
        internalType: 'uint256[]',
      },
      {
        name: 'referenceId',
        type: 'string',
        internalType: 'string',
      },
    ],
    outputs: [
      {
        name: 'totalOut',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'canonicalBatchDigest',
    inputs: [
      {
        name: 'payer',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'recipients',
        type: 'address[]',
        internalType: 'address[]',
      },
      {
        name: 'amounts',
        type: 'uint256[]',
        internalType: 'uint256[]',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'canonicalReferenceHash',
    inputs: [
      {
        name: 'payer',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'referenceId',
        type: 'string',
        internalType: 'string',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'canonicalUsdc',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract IERC20',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'emergencyWithdraw',
    inputs: [
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'feeBps',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'feeCollector',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getBatchEstimatedOutputs',
    inputs: [
      {
        name: 'tokenIn',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'tokenOuts',
        type: 'address[]',
        internalType: 'address[]',
      },
      {
        name: 'amountsIn',
        type: 'uint256[]',
        internalType: 'uint256[]',
      },
    ],
    outputs: [
      {
        name: 'estimatedAmountsOut',
        type: 'uint256[]',
        internalType: 'uint256[]',
      },
      {
        name: 'totalEstimatedOut',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'totalFees',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'pause',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'paused',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'renounceOwnership',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transferOwnership',
    inputs: [
      {
        name: 'newOwner',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'unpause',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'updateFee',
    inputs: [
      {
        name: 'nextFeeBps',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'updateFeeCollector',
    inputs: [
      {
        name: 'nextCollector',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'usedReferenceHashes',
    inputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'BatchPaymentRouted',
    inputs: [
      {
        name: 'sender',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'tokenIn',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'tokenOut',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'totalAmountIn',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'totalAmountOut',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'totalFees',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'recipientCount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'referenceId',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'DirectUsdcPayment',
    inputs: [
      {
        name: 'referenceHash',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'payer',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'recipient',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'paymentIndex',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'grossAmount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'netAmount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'feeAmount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'EmergencyWithdraw',
    inputs: [
      {
        name: 'token',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'to',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'FeeCollected',
    inputs: [
      {
        name: 'token',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'FeeCollectorUpdated',
    inputs: [
      {
        name: 'oldCollector',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'newCollector',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'FeeUpdated',
    inputs: [
      {
        name: 'oldFeeBps',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'newFeeBps',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OwnershipTransferred',
    inputs: [
      {
        name: 'previousOwner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'newOwner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Paused',
    inputs: [
      {
        name: 'account',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'PayrollReferenceConsumed',
    inputs: [
      {
        name: 'referenceHash',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'payer',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'token',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'batchDigest',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'totalAmount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'totalOut',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'totalFees',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'recipientCount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'referenceId',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Unpaused',
    inputs: [
      {
        name: 'account',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'AmountMustBeGreaterThanZero',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ArrayLengthMismatch',
    inputs: [],
  },
  {
    type: 'error',
    name: 'BatchTooLarge',
    inputs: [
      {
        name: 'provided',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'maxAllowed',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'CanonicalUsdcHasNoCode',
    inputs: [
      {
        name: 'canonicalUsdc',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'CanonicalUsdcZeroAddress',
    inputs: [],
  },
  {
    type: 'error',
    name: 'DirectTransferBelowMinimum',
    inputs: [
      {
        name: 'amountOut',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'minAmountOut',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'EmptyBatch',
    inputs: [],
  },
  {
    type: 'error',
    name: 'EnforcedPause',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ExpectedPause',
    inputs: [],
  },
  {
    type: 'error',
    name: 'FeeCollectorZeroAddress',
    inputs: [],
  },
  {
    type: 'error',
    name: 'FeeExceedsMaximum',
    inputs: [
      {
        name: 'feeBps',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'maxFeeBps',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'InitialOwnerHasNoCode',
    inputs: [
      {
        name: 'initialOwner',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'InsufficientTokenBalance',
    inputs: [
      {
        name: 'balance',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'OwnableInvalidOwner',
    inputs: [
      {
        name: 'owner',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'OwnableUnauthorizedAccount',
    inputs: [
      {
        name: 'account',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'RecipientZeroAddress',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ReentrancyGuardReentrantCall',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ReferenceAlreadyUsed',
    inputs: [
      {
        name: 'referenceHash',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
  },
  {
    type: 'error',
    name: 'ReferenceIdRequired',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ReferenceIdTooLong',
    inputs: [
      {
        name: 'provided',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'maxAllowed',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'SafeERC20FailedOperation',
    inputs: [
      {
        name: 'token',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'SelfPaymentNotAllowed',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TokenMustBeCanonicalUsdc',
    inputs: [
      {
        name: 'token',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'UnexpectedUsdcBalance',
    inputs: [
      {
        name: 'expected',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'actual',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
] as const;
