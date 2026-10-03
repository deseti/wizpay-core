import { getServerlessApplication } from './serverless';
import {
  ReconciliationService,
  type ReconciliationOptions,
} from './reconciliation/reconciliation.service';

/** Trusted scheduler adapter only: no public route, listener, timer, or deployment. */
export async function runReconciliationBatch(
  options: ReconciliationOptions = {},
) {
  const app = await getServerlessApplication();
  return app.get(ReconciliationService).runReconciliationBatch(options);
}
