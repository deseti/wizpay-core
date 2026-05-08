import { createPwaIconImage } from "@/src/features/pwa/icon-art";

export const contentType = "image/png";
export const size = {
  height: 256,
  width: 256,
};

export default function Icon() {
  return createPwaIconImage({ size: 256, variant: "any" });
}