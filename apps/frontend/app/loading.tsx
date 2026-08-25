import { DashboardAppFrame } from "@/components/dashboard/DashboardAppFrame";
import { PageSkeleton } from "@/components/ui/skeleton-loaders";

export default function Loading() {
  return <DashboardAppFrame><PageSkeleton /></DashboardAppFrame>;
}
