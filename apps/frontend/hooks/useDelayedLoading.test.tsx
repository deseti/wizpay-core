import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDelayedLoading } from "./useDelayedLoading";

function Harness({ loading, error = false }: { loading: boolean; error?: boolean }) {
  const skeleton = useDelayedLoading(loading, { delayMs: 100, minimumMs: 150 });
  if (error) return <div role="alert">Load failed</div>;
  return skeleton ? <div role="status">Skeleton</div> : <div>Content</div>;
}

describe("useDelayedLoading", () => {
  afterEach(() => vi.useRealTimers());

  it("avoids flashing for fast loads and transitions to content", () => {
    vi.useFakeTimers();
    const view = render(<Harness loading />);
    act(() => vi.advanceTimersByTime(50));
    view.rerender(<Harness loading={false} />);
    act(() => vi.runAllTimers());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Content")).toBeInTheDocument();
  });

  it("never leaves a stale skeleton over an error", () => {
    vi.useFakeTimers();
    const view = render(<Harness loading />);
    act(() => vi.advanceTimersByTime(110));
    expect(screen.getByRole("status")).toBeInTheDocument();
    view.rerender(<Harness loading={false} error />);
    expect(screen.getByRole("alert")).toHaveTextContent("Load failed");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
