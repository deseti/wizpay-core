import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_ICON_NAMES,
  ActivityTypeIcon,
} from "@/components/dashboard/ActivityTypeIcon";
import type { HistoryActionType } from "@/lib/types";

describe("ActivityTypeIcon", () => {
  it("defines and renders a distinct explicit icon for every supported activity type", () => {
    const types = [
      "send",
      "receive",
      "payroll",
      "swap",
      "bridge",
      "fx",
      "invoice_payment",
    ] satisfies HistoryActionType[];
    expect(new Set(types.map((type) => ACTIVITY_ICON_NAMES[type])).size).toBe(
      types.length,
    );
    for (const type of types) {
      const { container, unmount } = render(<ActivityTypeIcon type={type} />);
      expect(container.querySelector("svg")).toHaveAttribute(
        "data-activity-icon",
        ACTIVITY_ICON_NAMES[type],
      );
      unmount();
    }
  });
});
