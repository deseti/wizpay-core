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
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/maskable-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}