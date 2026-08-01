export type AnsPendingSubmission<TSubmission> = {
  current: TSubmission | null
}

export async function executeAnsStepOnce<TSubmission, TConfirmation>({
  checkCompleted,
  confirm,
  pendingSubmission,
  submit,
}: {
  checkCompleted: () => Promise<TConfirmation | null>
  confirm: (submission: TSubmission) => Promise<TConfirmation>
  pendingSubmission: AnsPendingSubmission<TSubmission>
  submit: () => Promise<TSubmission>
}): Promise<TConfirmation> {
  const completed = await checkCompleted()

  if (completed !== null) {
    pendingSubmission.current = null
    return completed
  }

  const submission = pendingSubmission.current ?? (await submit())
  pendingSubmission.current = submission

  const confirmation = await confirm(submission)
  pendingSubmission.current = null
  return confirmation
}

export function executeAnsFlowOnce<T>(
  inFlight: AnsPendingSubmission<Promise<T>>,
  flow: () => Promise<T>
): Promise<T> {
  if (inFlight.current) {
    return inFlight.current
  }

  const promise = flow()
  inFlight.current = promise

  void promise.then(
    () => {
      if (inFlight.current === promise) {
        inFlight.current = null
      }
    },
    () => {
      if (inFlight.current === promise) {
        inFlight.current = null
      }
    }
  )

  return promise
}
