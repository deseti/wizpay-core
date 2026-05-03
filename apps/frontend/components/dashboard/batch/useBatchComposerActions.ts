"use client";

import { useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  buildCsvPreview,
  CSV_TEMPLATE_CONTENT,
  type CsvPreviewState,
} from "@/lib/batch-csv";
import type { RecipientDraft, TokenSymbol } from "@/lib/wizpay";


export interface BatchComposerActionsParams {
  selectedToken: TokenSymbol;
  importRecipients: (rows: RecipientDraft[]) => void;
  setErrorMessage: (msg: string | null) => void;
  updateRecipient: (
    id: string,
    field: keyof Omit<RecipientDraft, "id">,
    value: string,
  ) => void;
  clearFieldError: (key: string) => void;
}

export function useBatchComposerActions({
  selectedToken,
  importRecipients,
  setErrorMessage,
  updateRecipient,
  clearFieldError,
}: BatchComposerActionsParams) {
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const [csvPreview, setCsvPreview] = useState<CsvPreviewState | null>(null);
  const [showAllRecipients, setShowAllRecipients] = useState(false);
  const [scannerRecipientId, setScannerRecipientId] = useState<string | null>(
    null,
  );
  const { toast } = useToast();

  const handleDownloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE_CONTENT], {
      type: "text/csv;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "wizpay-recipients-template.csv";
    link.click();
    URL.revokeObjectURL(objectUrl);
  };

  const handleScannedAddress = (address: string) => {
    if (!scannerRecipientId) {
      return;
    }
    updateRecipient(scannerRecipientId, "address", address);
    clearFieldError(`${scannerRecipientId}-address`);
    setErrorMessage(null);
    setScannerRecipientId(null);
    toast({
      title: "Address added",
      description: "The scanned wallet address was filled in for you.",
    });
  };

  const handleConfirmCsvImport = () => {
    if (!csvPreview || csvPreview.validRows.length === 0) {
      return;
    }
    importRecipients(csvPreview.validRows);
    setCsvPreview(null);

    if (csvPreview.invalidCount > 0) {
      setErrorMessage(
        `Imported ${csvPreview.validRows.length} valid rows. ${csvPreview.invalidCount} rows still need fixes in the source file.`,
      );
      toast({
        title: "Imported with review notes",
        description: `${csvPreview.validRows.length} rows were added. ${csvPreview.invalidCount} rows were skipped.`,
      });
      return;
    }

    setErrorMessage(null);
    toast({
      title: "CSV imported",
      description: `${csvPreview.validRows.length} recipients are ready to send.`,
    });
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setCsvLoading(true);

    const reader = new FileReader();

    reader.onerror = () => {
      setCsvLoading(false);
      toast({
        title: "CSV Upload Failed",
        description:
          "Could not read the file. Please check it is a valid .csv file.",
        variant: "destructive",
      });
      if (csvInputRef.current) csvInputRef.current.value = "";
    };

    reader.onload = (event) => {
      const text = event.target?.result as string;

      if (!text || !text.trim()) {
        setCsvLoading(false);
        toast({
          title: "CSV Upload Failed",
          description: "The file appears to be empty.",
          variant: "destructive",
        });
        if (csvInputRef.current) csvInputRef.current.value = "";
        return;
      }

      const preview = buildCsvPreview(file.name, text, selectedToken);
      setCsvLoading(false);

      if (!preview || preview.rows.length === 0) {
        toast({
          title: "CSV Import Failed",
          description: "No rows were found in the file.",
          variant: "destructive",
        });
        if (csvInputRef.current) csvInputRef.current.value = "";
        return;
      }

      setCsvPreview(preview);

      if (preview.validRows.length === 0) {
        toast({
          title: "CSV needs review",
          description:
            "No valid rows yet. Review the row errors before importing.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "CSV ready to review",
          description: `${preview.rows.length} rows parsed. Review before importing.`,
        });
      }

      if (csvInputRef.current) csvInputRef.current.value = "";
    };

    reader.readAsText(file);
  };

  return {
    csvInputRef,
    csvLoading,
    csvPreview,
    setCsvPreview,
    showAllRecipients,
    setShowAllRecipients,
    scannerRecipientId,
    setScannerRecipientId,
    handleDownloadTemplate,
    handleScannedAddress,
    handleConfirmCsvImport,
    handleCsvUpload,
  };
}
