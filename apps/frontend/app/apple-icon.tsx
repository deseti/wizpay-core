import { createPwaIconImage } from "@/src/features/pwa/icon-art";

export const contentType = "image/png";
export const size = {
  height: 180,
  width: 180,
};

export default function AppleIcon() {
  return createPwaIconImage({ size: 180, variant: "apple" });
}