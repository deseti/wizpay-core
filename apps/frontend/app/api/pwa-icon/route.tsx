import type { NextRequest } from "next/server";

import { createPwaIconImage } from "@/src/features/pwa/icon-art";

export const runtime = "edge";

function parseSize(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, 1024);
}

export function GET(request: NextRequest) {
  const size = parseSize(request.nextUrl.searchParams.get("size"), 512);
  const variantParam = request.nextUrl.searchParams.get("variant");
  const variant =
    variantParam === "maskable" || variantParam === "apple"
      ? variantParam
      : "any";

  return createPwaIconImage({ size, variant });
}