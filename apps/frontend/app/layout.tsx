import type { Metadata, Viewport } from "next";
import { Toaster } from "@/components/ui/toaster";
import {
  WIZPAY_APP_URL,
  WIZPAY_OG_IMAGE_URL,
  WIZPAY_SOCIAL_DESCRIPTION,
  WIZPAY_SOCIAL_TITLE,
} from "@/lib/social";

import "./globals.css";
import { Providers } from "./providers";

/** Circle Web SDK requires client-side initialization — skip static prerendering */

export const metadata: Metadata = {
  metadataBase: new URL(WIZPAY_APP_URL),
  applicationName: "WizPay",
  title: WIZPAY_SOCIAL_TITLE,
  description: WIZPAY_SOCIAL_DESCRIPTION,
  manifest: "/manifest.webmanifest",
  icons: {
    apple: "/apple-touch-icon.png",
  },
  alternates: {
    canonical: "/",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "WizPay",
  },
  openGraph: {
    title: WIZPAY_SOCIAL_TITLE,
    description: WIZPAY_SOCIAL_DESCRIPTION,
    url: WIZPAY_APP_URL,
    siteName: "WizPay",
    images: [
      {
        url: WIZPAY_OG_IMAGE_URL,
        width: 1200,
        height: 630,
        alt: WIZPAY_SOCIAL_TITLE,
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: WIZPAY_SOCIAL_TITLE,
    description: WIZPAY_SOCIAL_DESCRIPTION,
    images: [WIZPAY_OG_IMAGE_URL],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#1a1130",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="flex min-h-full flex-col overscroll-none">
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
