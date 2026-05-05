import type { Metadata, Viewport } from "next";
import { Geist_Mono, Manrope } from "next/font/google";
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

const manrope = Manrope({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(WIZPAY_APP_URL),
  title: WIZPAY_SOCIAL_TITLE,
  description: WIZPAY_SOCIAL_DESCRIPTION,
  alternates: {
    canonical: "/",
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
    <html
      lang="en"
      className={`${manrope.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="flex min-h-full flex-col overscroll-none">
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
