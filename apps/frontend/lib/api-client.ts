import { buildBackendUrl, resolveBackendBaseUrl } from "@/lib/backend-api";

export async function createTask(type: string, payload: unknown) {
  const res = await fetch(buildBackendUrl("/tasks", resolveBackendBaseUrl()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type, payload }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to create task: ${res.statusText} - ${errorText}`);
  }

  return res.json();
}

export async function getTask(taskId: string) {
  const res = await fetch(
    buildBackendUrl(`/tasks/${taskId}`, resolveBackendBaseUrl())
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to get task: ${res.statusText} - ${errorText}`);
  }

  return res.json();
}
