export enum TaskStatus {
  CREATED = 'created',
  ASSIGNED = 'assigned',
  IN_PROGRESS = 'in_progress',
  REVIEW = 'review',
  APPROVED = 'approved',
  EXECUTED = 'executed',
  /** Some transfers succeeded, some failed */
  PARTIAL = 'partial',
  FAILED = 'failed',
}