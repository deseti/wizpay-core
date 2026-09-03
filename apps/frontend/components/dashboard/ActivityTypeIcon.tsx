import {
  ArrowDownLeft,
  ArrowUpRight,
  BriefcaseBusiness,
  Coins,
  FileCheck2,
  Landmark,
  Repeat2,
  Route,
  Waves,
} from "lucide-react";
import type { HistoryActionType } from "@/lib/types";

export const ACTIVITY_ICON_NAMES: Record<HistoryActionType, string> = {
  send: "arrow-up-right",
  receive: "arrow-down-left",
  payroll: "briefcase-business",
  swap: "repeat",
  bridge: "route",
  fx: "landmark",
  invoice_payment: "file-check",
};

const ICONS = {
  send: ArrowUpRight,
  receive: ArrowDownLeft,
  payroll: BriefcaseBusiness,
  swap: Repeat2,
  bridge: Route,
  fx: Landmark,
  invoice_payment: FileCheck2,
} satisfies Record<HistoryActionType, typeof ArrowUpRight>;

export function ActivityTypeIcon({
  type,
  className = "h-4 w-4",
}: {
  type: HistoryActionType;
  className?: string;
}) {
  const Icon = ICONS[type];
  return (
    <Icon
      data-activity-icon={ACTIVITY_ICON_NAMES[type]}
      className={className}
      aria-hidden="true"
    />
  );
}
