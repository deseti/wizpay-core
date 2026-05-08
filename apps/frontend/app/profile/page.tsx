"use client";

import { DashboardAppFrame } from "@/components/dashboard/DashboardAppFrame";
import { ProfileHubPage } from "@/src/features/profile/ProfileHubPage";

export default function ProfilePage() {
  return (
    <DashboardAppFrame>
      <ProfileHubPage />
    </DashboardAppFrame>
  );
}