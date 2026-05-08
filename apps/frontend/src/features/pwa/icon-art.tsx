import { ImageResponse } from "next/og";

type IconVariant = "any" | "apple" | "maskable";

interface CreatePwaIconImageOptions {
  size: number;
  variant?: IconVariant;
}

function createShellInset(size: number, variant: IconVariant) {
  if (variant === "maskable") {
    return Math.round(size * 0.18);
  }

  if (variant === "apple") {
    return Math.round(size * 0.12);
  }

  return Math.round(size * 0.1);
}

export function createPwaIconImage({
  size,
  variant = "any",
}: CreatePwaIconImageOptions) {
  const shellInset = createShellInset(size, variant);
  const shellRadius = Math.round(size * (variant === "apple" ? 0.24 : 0.28));
  const accentSize = Math.round(size * 0.18);
  const markSize = Math.round(size * 0.34);
  const captionSize = Math.max(16, Math.round(size * 0.08));

  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background:
            "radial-gradient(circle at 18% 18%, rgba(84,255,207,0.24), transparent 34%), radial-gradient(circle at 82% 14%, rgba(255,178,112,0.24), transparent 30%), linear-gradient(160deg, #07131b 0%, #0d1f2c 48%, #091017 100%)",
          color: "#f4f7f2",
          display: "flex",
          height: "100%",
          justifyContent: "center",
          position: "relative",
          width: "100%",
        }}
      >
        <div
          style={{
            background:
              "linear-gradient(155deg, rgba(21,46,63,0.98) 0%, rgba(11,24,34,0.92) 100%)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: shellRadius,
            boxShadow:
              "0 40px 110px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08)",
            display: "flex",
            height: size - shellInset * 2,
            left: shellInset,
            overflow: "hidden",
            position: "absolute",
            top: shellInset,
            width: size - shellInset * 2,
          }}
        >
          <div
            style={{
              background:
                "linear-gradient(145deg, rgba(62,240,208,0.18) 0%, rgba(14,36,48,0) 55%)",
              inset: 0,
              position: "absolute",
            }}
          />
          <div
            style={{
              background:
                "radial-gradient(circle at 50% 22%, rgba(84,255,207,0.35), transparent 45%)",
              inset: 0,
              position: "absolute",
            }}
          />
          <div
            style={{
              alignItems: "center",
              display: "flex",
              flexDirection: "column",
              gap: Math.round(size * 0.045),
              inset: 0,
              justifyContent: "center",
              position: "absolute",
            }}
          >
            <div
              style={{
                alignItems: "center",
                color: "#f7fbf7",
                display: "flex",
                fontSize: markSize,
                fontWeight: 800,
                letterSpacing: "-0.08em",
                lineHeight: 1,
                textShadow: "0 12px 30px rgba(84,255,207,0.2)",
              }}
            >
              W
            </div>
            <div
              style={{
                color: "rgba(236,246,240,0.72)",
                display: "flex",
                fontSize: captionSize,
                fontWeight: 600,
                letterSpacing: "0.26em",
                paddingLeft: "0.26em",
                textTransform: "uppercase",
              }}
            >
              Pay
            </div>
          </div>
          <div
            style={{
              background:
                "linear-gradient(145deg, rgba(84,255,207,0.95) 0%, rgba(23,182,152,0.92) 100%)",
              borderRadius: Math.round(accentSize * 0.4),
              boxShadow: "0 12px 28px rgba(46,214,182,0.35)",
              height: accentSize,
              position: "absolute",
              right: Math.round(size * 0.16),
              top: Math.round(size * 0.18),
              transform: "rotate(18deg)",
              width: accentSize,
            }}
          />
          <div
            style={{
              background:
                "linear-gradient(145deg, rgba(255,178,112,0.92) 0%, rgba(255,120,76,0.92) 100%)",
              borderRadius: Math.round(accentSize * 0.6),
              boxShadow: "0 16px 30px rgba(255,134,82,0.28)",
              height: Math.round(accentSize * 0.72),
              left: Math.round(size * 0.16),
              position: "absolute",
              top: Math.round(size * 0.68),
              width: Math.round(accentSize * 1.15),
            }}
          />
        </div>
      </div>
    ),
    {
      height: size,
      width: size,
    },
  );
}