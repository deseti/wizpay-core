import type { MetadataRoute } from "next";

import { WIZPAY_SOCIAL_DESCRIPTION } from "@/lib/social";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "WizPay",
    short_name: "WizPay",
    description: WIZPAY_SOCIAL_DESCRIPTION,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#091017",
    theme_color: "#0d1f2c",
    orientation: "portrait",
    categories: ["finance", "utilities"],
    icons: [
      {
        src: "/api/pwa-icon?size=192&variant=any",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/api/pwa-icon?size=512&variant=any",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/api/pwa-icon?size=512&variant=maskable",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}