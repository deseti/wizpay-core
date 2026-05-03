"use client";

import { useCallback, useState } from "react";

/**
 * useDialogState — lightweight hook for managing a single open/close dialog.
 *
 * @param initialOpen - Whether the dialog starts open (default: false)
 *
 * @example
 * const reviewDialog = useDialogState();
 * <Dialog open={reviewDialog.isOpen} onOpenChange={reviewDialog.setIsOpen}>
 *   <Button onClick={reviewDialog.open}>Review</Button>
 * </Dialog>
 */
export function useDialogState(initialOpen = false) {
  const [isOpen, setIsOpen] = useState(initialOpen);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  return { isOpen, setIsOpen, open, close, toggle };
}
