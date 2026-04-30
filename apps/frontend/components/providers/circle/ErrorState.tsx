import React from "react";

export function ErrorState({
  authStatus,
  authError,
}: {
  authStatus: string | null;
  authError: string | null;
}) {
  return (
    <>
      {authStatus ? (
        <div className="rounded-xl border border-border/40 bg-background/50 px-3 py-2.5 text-sm text-muted-foreground">
          {authStatus}
        </div>
      ) : null}

      {authError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          {authError}
        </div>
      ) : null}
    </>
  );
}
