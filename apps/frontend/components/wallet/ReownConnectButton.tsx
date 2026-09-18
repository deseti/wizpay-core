"use client";

import { useAppKit } from "@reown/appkit/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ReownConnectButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "onClick" | "type"
> & {
  children: ReactNode;
};

export function ReownConnectButton({
  children,
  disabled,
  ...props
}: ReownConnectButtonProps) {
  const { open } = useAppKit();

  return (
    <button
      {...props}
      type="button"
      disabled={disabled}
      onClick={() => void open({ view: "Connect" })}
    >
      {children}
    </button>
  );
}
