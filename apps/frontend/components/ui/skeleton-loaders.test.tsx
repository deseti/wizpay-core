import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PageSkeleton, SendPageSkeleton, SkeletonList } from "./skeleton-loaders";

describe("skeleton design system", () => {
  it("exposes accessible geometry-specific page and list loading layouts", () => {
    const { container } = render(<><PageSkeleton cards={2} /><SkeletonList count={3} /><SendPageSkeleton /></>);
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(3);
    expect(container.querySelectorAll(".wiz-skeleton").length).toBeGreaterThan(10);
    expect(
      [...container.querySelectorAll("div")].some((node) =>
        node.classList.contains("min-h-[430px]"),
      ),
    ).toBe(true);
  });

  it("disables shimmer for reduced-motion users", () => {
    const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/\.wiz-skeleton::after[\s\S]*animation: none/);
  });
});
