-- Additive Arc Mainnet atomic cross-token route for execution intents.
-- Stored only when Arc Mainnet swap/cross-token capabilities are explicitly
-- enabled; all capabilities remain disabled by default. This migration
-- contains no data rewrite and is not executed by the application.
ALTER TYPE "ExecutionIntentRoute" ADD VALUE 'CROSS_TOKEN_ATOMIC';
