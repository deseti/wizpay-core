"use client";

import { useParams } from "next/navigation";
import { PublicInvoiceCheckout } from "@/components/invoices/PublicInvoiceCheckout";

export default function PublicInvoicePage() {
  const params = useParams<{ publicId: string }>();
  return <PublicInvoiceCheckout publicId={params.publicId} />;
}
