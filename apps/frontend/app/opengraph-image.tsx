import { ImageResponse } from "next/og";

import {
  WIZPAY_SOCIAL_DESCRIPTION,
  WIZPAY_SOCIAL_TITLE,
} from "@/lib/social";

export const alt = WIZPAY_SOCIAL_TITLE;
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          height: "100%",
          width: "100%",
          background:
            "radial-gradient(circle at top left, rgba(35, 211, 238, 0.22), transparent 38%), linear-gradient(135deg, #09090f 0%, #101522 54%, #141d34 100%)",
          color: "#f8fafc",
          fontFamily: "Manrope, sans-serif",
          padding: "56px",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: "auto -120px -200px auto",
            width: "420px",
            height: "420px",
            borderRadius: "9999px",
            background: "rgba(37, 99, 235, 0.18)",
            filter: "blur(40px)",
          }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: "100%",
            height: "100%",
            borderRadius: "32px",
            border: "1px solid rgba(148, 163, 184, 0.18)",
            background: "rgba(9, 9, 15, 0.62)",
            padding: "44px",
            boxShadow: "0 24px 80px rgba(8, 15, 28, 0.45)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "14px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "68px",
                  height: "68px",
                  borderRadius: "20px",
                  background: "rgba(90, 128, 255, 0.16)",
                  border: "1px solid rgba(96, 165, 250, 0.32)",
                  fontSize: "30px",
                  fontWeight: 800,
                }}
              >
                W
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div
                  style={{
                    fontSize: "20px",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    color: "#7dd3fc",
                  }}
                >
                  Arc Testnet
                </div>
                <div style={{ fontSize: "60px", fontWeight: 800, lineHeight: 1.04 }}>
                  WizPay
                </div>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "14px",
                maxWidth: "820px",
              }}
            >
              <div style={{ fontSize: "42px", fontWeight: 700, lineHeight: 1.14 }}>
                Cross-token payroll, swaps, bridge, and liquidity in one app.
              </div>
              <div
                style={{
                  fontSize: "28px",
                  lineHeight: 1.35,
                  color: "rgba(226, 232, 240, 0.84)",
                }}
              >
                {WIZPAY_SOCIAL_DESCRIPTION}
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "18px",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: "12px",
                flexWrap: "wrap",
              }}
            >
              {["Payroll", "Bridge", "Swap", "Liquidity"].map((label) => (
                <div
                  key={label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "10px 18px",
                    borderRadius: "9999px",
                    border: "1px solid rgba(125, 211, 252, 0.22)",
                    background: "rgba(15, 23, 42, 0.72)",
                    color: "#cbd5e1",
                    fontSize: "20px",
                    fontWeight: 600,
                  }}
                >
                  {label}
                </div>
              ))}
            </div>
            <div style={{ fontSize: "24px", color: "#93c5fd" }}>app.wizpay.xyz</div>
          </div>
        </div>
      </div>
    ),
    size
  );
}