"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { backendFetch } from "@/lib/backend-api";

// ─── Types ──────────────────────────────────────────────────────────

export interface TaskLogEntry {
  id: string;
  taskId: string;
  step: string;
  status: string;
  message: string;
  createdAt: string;
}

export interface TaskStatusResponse {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  logs: TaskLogEntry[];
}

export type TaskPollingStatus =
  | "idle"
  | "submitting"
  | "polling"
  | "completed"
  | "failed"
  | "error";

interface UseTaskPollingOptions {
  /** Polling interval in ms (default: 2000) */
  pollIntervalMs?: number;
  /** Max polling duration in ms (default: 300000 = 5 min) */
  maxPollingDurationMs?: number;
  /** Called when the task reaches a terminal state */
  onComplete?: (task: TaskStatusResponse) => void;
  /** Called when the task fails */
  onError?: (error: string) => void;
}

interface UseTaskPollingResult {
  /** Current polling status */
  status: TaskPollingStatus;
  /** The task ID being tracked */
  taskId: string | null;
  /** Latest task data from the server */
  task: TaskStatusResponse | null;
  /** Progress logs from the task */
  logs: TaskLogEntry[];
  /** Latest progress message */
  progressMessage: string | null;
  /** Error message if submission or polling failed */
  errorMessage: string | null;
  /** Submit a new task to POST /tasks */
  submitTask: (
    type: string,
    payload: Record<string, unknown>
  ) => Promise<TaskStatusResponse>;
  /** Reset polling state */
  reset: () => void;
}

// ─── Terminal states ────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(["executed", "failed"]);

// ─── Hook ───────────────────────────────────────────────────────────

/**
 * useTaskPolling — Submit tasks to the backend and poll for status.
 *
 * Replaces the frontend's direct transaction execution (useWizPayContract,
 * useBatchPayroll, useTransactionExecutor) with a simple task submission
 * and status polling pattern.
 *
 * Usage:
 *   const { submitTask, status, task, progressMessage } = useTaskPolling();
 *   await submitTask("payroll", { recipients, sourceToken, referenceId });
 *   // UI shows progress via `status` and `progressMessage`
 */
export function useTaskPolling(
  options: UseTaskPollingOptions = {}
): UseTaskPollingResult {
  const {
    pollIntervalMs = 2000,
    maxPollingDurationMs = 300_000,
    onComplete,
    onError,
  } = options;

  const [status, setStatus] = useState<TaskPollingStatus>("idle");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskStatusResponse | null>(null);
  const [logs, setLogs] = useState<TaskLogEntry[]>([]);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const callbacksRef = useRef({ onComplete, onError });

  // Keep callbacks ref up to date
  useEffect(() => {
    callbacksRef.current = { onComplete, onError };
  }, [onComplete, onError]);

  // ── Cleanup on unmount ──────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, []);

  // ── Poll a single task ──────────────────────────────────────────

  const pollTask = useCallback(
    async (id: string) => {
      try {
        const response = await backendFetch<TaskStatusResponse>(
          `/tasks/${encodeURIComponent(id)}`
        );

        setTask(response);
        setLogs(response.logs ?? []);

        // Extract latest progress message from logs
        const latestLog =
          response.logs?.length > 0
            ? response.logs[response.logs.length - 1]
            : null;
        if (latestLog) {
          setProgressMessage(latestLog.message);
        }

        // Check terminal state
        if (TERMINAL_STATUSES.has(response.status)) {
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }

          if (response.status === "executed") {
            setStatus("completed");
            setProgressMessage("Backend task completed successfully.");
            callbacksRef.current.onComplete?.(response);
          } else {
            const failMessage =
              latestLog?.message ?? "Task failed.";
            setStatus("failed");
            setProgressMessage(null);
            setErrorMessage(failMessage);
            callbacksRef.current.onError?.(failMessage);
          }
          return;
        }

        // Check timeout
        if (Date.now() - startTimeRef.current > maxPollingDurationMs) {
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          setStatus("error");
          setErrorMessage(
            "Task is still processing on the backend. Check the dashboard for updates."
          );
        }
      } catch (err) {
        // Don't stop polling on transient fetch errors
        const message =
          err instanceof Error ? err.message : "Failed to check task status";
        setProgressMessage(`Polling: ${message}`);
      }
    },
    [maxPollingDurationMs]
  );

  // ── Submit a task ───────────────────────────────────────────────

  const submitTask = useCallback(
    async (type: string, payload: Record<string, unknown>) => {
      // Clean up any existing poll
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }

      setStatus("submitting");
      setTask(null);
      setLogs([]);
      setProgressMessage("Submitting backend task...");
      setErrorMessage(null);
      setTaskId(null);

      try {
        const response = await backendFetch<TaskStatusResponse>("/tasks", {
          method: "POST",
          body: JSON.stringify({ type, payload }),
        });

        setTaskId(response.id);
        setTask(response);
        setLogs(response.logs ?? []);
        setProgressMessage("Backend task submitted. Waiting for Arc execution...");

        // Check if already terminal (edge case for sync execution)
        if (TERMINAL_STATUSES.has(response.status)) {
          if (response.status === "executed") {
            setStatus("completed");
            setProgressMessage("Backend task completed.");
            callbacksRef.current.onComplete?.(response);
            return response;
          }

          const immediateFailureMessage =
            response.logs?.[response.logs.length - 1]?.message ??
            "Task failed immediately.";
          throw new Error(immediateFailureMessage);
        }

        // Start polling
        setStatus("polling");
        startTimeRef.current = Date.now();

        pollingRef.current = setInterval(() => {
          pollTask(response.id);
        }, pollIntervalMs);

        return response;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to submit task";
        setStatus("error");
        setErrorMessage(message);
        setProgressMessage(null);
        callbacksRef.current.onError?.(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [pollIntervalMs, pollTask]
  );

  // ── Reset ───────────────────────────────────────────────────────

  const reset = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setStatus("idle");
    setTaskId(null);
    setTask(null);
    setLogs([]);
    setProgressMessage(null);
    setErrorMessage(null);
  }, []);

  return {
    status,
    taskId,
    task,
    logs,
    progressMessage,
    errorMessage,
    submitTask,
    reset,
  };
}
