"use client";

import { ExternalLink, Search, ChevronLeft, ChevronRight, Clock, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { TOKEN_BY_ADDRESS } from "@/constants/erc20";
import type { UnifiedHistoryItem, HistoryActionType } from "@/lib/types";
import {
  formatTokenAmount,
  getExplorerTxUrl,
} from "@/lib/wizpay";
import { useActivityHistory, type ActivityFilter } from "@/hooks/useActivityHistory";

/** Returns the best explorer URL for a history item.
 *  For bridge items, prefers step-level explorerUrls from normalizedTransfer
 *  when the primary txHash is a Solana signature (not an EVM hash). */
function resolveExplorerUrl(item: UnifiedHistoryItem): string | null {
  const evmUrl = getExplorerTxUrl(item.txHash);
  if (evmUrl) return evmUrl;

  // Bridge: walk steps for the first valid explorerUrl
  const bt = (item as UnifiedHistoryItem & { bridgeTransfer?: { steps?: { explorerUrl: string | null }[] } }).bridgeTransfer;
  if (bt?.steps) {
    for (const step of bt.steps) {
      if (step.explorerUrl && step.explorerUrl.startsWith("https://")) {
        return step.explorerUrl;
      }
    }
  }

  return null;
}

function formatDateTime(timestampMs: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestampMs);
}

const ACTION_CONFIG: Record<
  HistoryActionType,
  { label: string; className: string }
> = {
  payroll: {
    label: "Payroll Batch",
    className: "bg-emerald-500/12 text-emerald-300/90 border-emerald-500/25",
  },
  add_lp: {
    label: "Add LP",
    className: "bg-blue-500/12 text-blue-300/90 border-blue-500/25",
  },
  remove_lp: {
    label: "Remove LP",
    className: "bg-amber-500/12 text-amber-300/90 border-amber-500/25",
  },
  swap: {
    label: "Swap",
    className: "bg-violet-500/12 text-violet-300/90 border-violet-500/25",
  },
  bridge: {
    label: "Bridge",
    className: "bg-cyan-500/12 text-cyan-300/90 border-cyan-500/25",
  },
  fx: {
    label: "FX",
    className: "bg-pink-500/12 text-pink-300/90 border-pink-500/25",
  },
};

const FILTER_TABS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "payroll", label: "Payroll" },
  { value: "swap", label: "Swap" },
  { value: "bridge", label: "Bridge" },
  { value: "fx", label: "FX" },
  { value: "add_lp", label: "Add LP" },
  { value: "remove_lp", label: "Remove LP" },
];

function getDetailText(item: UnifiedHistoryItem): string {
  if (item.type === "payroll") {
    const inToken =
      TOKEN_BY_ADDRESS.get(item.tokenIn?.toLowerCase() ?? "")?.symbol ?? "?";
    return `${item.recipientCount} recipients · ${formatTokenAmount(item.totalAmountIn ?? 0n, 6)} ${inToken}`;
  }
  if (item.type === "swap") {
    const inSym = TOKEN_BY_ADDRESS.get(item.tokenIn?.toLowerCase() ?? "")?.symbol ?? "Token";
    const outSym = TOKEN_BY_ADDRESS.get(item.tokenOut?.toLowerCase() ?? "")?.symbol ?? "Token";
    const amt = formatTokenAmount(item.totalAmountIn ?? 0n, 6);
    return `${amt} ${inSym} → ${outSym}`;
  }
  if (item.type === "bridge" || item.type === "fx") {
    const inSym = TOKEN_BY_ADDRESS.get(item.tokenIn?.toLowerCase() ?? "")?.symbol ?? "Token";
    const amt = formatTokenAmount(item.totalAmountIn ?? 0n, 6);
    return `${amt} ${inSym}`;
  }
  const tokenSym =
    TOKEN_BY_ADDRESS.get(item.lpToken?.toLowerCase() ?? "")?.symbol ?? "Token";
  const amount = formatTokenAmount(item.lpAmount ?? 0n, 6);
  return `${amount} ${tokenSym}`;
}

function getReferenceText(item: UnifiedHistoryItem): string {
  if (item.referenceId) return item.referenceId;
  if (item.type === "add_lp") return "Deposit Liquidity";
  if (item.type === "remove_lp") return "Withdraw Liquidity";
  if (item.type === "swap") return "Token Swap";
  if (item.type === "bridge") return "Bridge Transfer";
  if (item.type === "fx") return "FX Settlement";
  return "—";
}

/* ── Skeleton rows ── */
function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <TableRow key={`skel-${i}`}>
          <TableCell>
            <Skeleton className="h-4 w-28 bg-muted/20" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-16 bg-muted/20" />
          </TableCell>
          <TableCell>
            <div className="space-y-1">
              <Skeleton className="h-4 w-32 bg-muted/20" />
              <Skeleton className="h-3 w-24 bg-muted/20" />
            </div>
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-20 bg-muted/20" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-6 w-20 bg-muted/20" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

interface TransactionHistoryProps {
  unifiedHistory: UnifiedHistoryItem[];
  isLoading: boolean;
}

export function TransactionHistory({
  unifiedHistory,
  isLoading,
}: TransactionHistoryProps) {
  const {
    items: displayItems,
    totalCount,
    currentPage,
    totalPages,
    filter,
    searchTerm,
    setFilter,
    setSearchTerm,
    nextPage,
    prevPage,
    hasNextPage,
    hasPrevPage,
    resetFilters,
  } = useActivityHistory(unifiedHistory, { pageSize: 10 });

  const isFiltered = filter !== "all" || searchTerm.trim().length > 0;

  return (
    <Card className="glass-card border-border/40">
      <CardHeader className="space-y-3 border-b border-border/30 pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Clock className="h-3.5 w-3.5" />
            </div>
            Activity
          </CardTitle>
          <div className="flex items-center gap-2">
            {isFiltered && (
              <Button variant="ghost" size="sm" onClick={resetFilters} className="h-7 gap-1 text-xs text-muted-foreground">
                <X className="h-3 w-3" /> Clear
              </Button>
            )}
            <Badge variant="outline" className="border-primary/20 text-primary/70 bg-primary/5 text-xs">
              {totalCount} {filter === "all" ? "events" : ACTION_CONFIG[filter as HistoryActionType]?.label ?? filter}
            </Badge>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setFilter(tab.value)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                filter === tab.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
          <Input
            placeholder="Search by ref ID, tx hash..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-9 bg-background/50 pl-9 border-border/40 text-sm"
          />
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {isLoading ? (
          /* Skeleton Loading */
          <div className="overflow-hidden rounded-2xl border border-border/40">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-border/30">
                  <TableHead>Date/Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <SkeletonRows />
              </TableBody>
            </Table>
          </div>
        ) : displayItems.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/40 bg-background/30 p-8 text-center">
            <p className="text-sm font-semibold">
              {isFiltered ? "No matching transactions found" : "No confirmed transactions yet"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground/70">
              {isFiltered
                ? "Try adjusting your filters or search term."
                : "Once a transaction is confirmed, it will appear here automatically."}
            </p>
            {isFiltered && (
              <Button variant="ghost" size="sm" className="mt-3 text-xs" onClick={resetFilters}>
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-hidden rounded-2xl border border-border/40 md:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent border-border/30">
                    <TableHead>Date/Time</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayItems.map((item, idx) => {
                    const cfg = ACTION_CONFIG[item.type];
                    const txUrl = resolveExplorerUrl(item);
                    return (
                      <TableRow key={`${item.txHash}-${idx}`} className="border-border/20 hover:bg-primary/3 transition-colors">
                        <TableCell className="text-sm whitespace-nowrap">
                          {formatDateTime(item.timestampMs)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cfg.className}
                          >
                            {cfg.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-0.5">
                            <p className="font-semibold text-sm">
                              {getReferenceText(item)}
                            </p>
                            <p className="text-xs text-muted-foreground/60">
                              {getDetailText(item)}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-sm whitespace-nowrap">
                          {(item.type === "payroll" || item.type === "swap" || item.type === "bridge" || item.type === "fx")
                            ? `${formatTokenAmount(item.totalAmountIn ?? 0n, 6)} ${TOKEN_BY_ADDRESS.get(item.tokenIn?.toLowerCase() ?? "")?.symbol ?? ""}`
                            : `${formatTokenAmount(item.lpAmount ?? 0n, 6)} ${TOKEN_BY_ADDRESS.get(item.lpToken?.toLowerCase() ?? "")?.symbol ?? ""}`}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {(item as { backendStatus?: string }).backendStatus && (item as { backendStatus?: string }).backendStatus !== "executed" ? (
                              <Badge className={
                                (item as { backendStatus?: string }).backendStatus === "failed"
                                  ? "bg-red-500/12 text-red-300/90 border-red-500/25"
                                  : "bg-yellow-500/12 text-yellow-300/90 border-yellow-500/25"
                              }>
                                {(item as { backendStatus?: string }).backendStatus}
                              </Badge>
                            ) : (
                              <Badge className="bg-emerald-500/12 text-emerald-300/90 border-emerald-500/25">
                                Confirmed
                              </Badge>
                            )}
                            {txUrl && (
                              <a
                                href={txUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-sm text-primary hover:underline transition-colors"
                              >
                                View tx
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {displayItems.map((item, idx) => {
                const cfg = ACTION_CONFIG[item.type];
                const txUrl = resolveExplorerUrl(item);
                return (
                  <Card
                    key={`${item.txHash}-mobile-${idx}`}
                    className="surface-panel border border-border/40"
                  >
                    <CardContent className="space-y-3 pt-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold">{getReferenceText(item)}</p>
                          <p className="text-xs text-muted-foreground/60">
                            {formatDateTime(item.timestampMs)}
                          </p>
                        </div>
                        <Badge variant="outline" className={cfg.className}>
                          {cfg.label}
                        </Badge>
                      </div>
                      <div className="rounded-xl border border-border/40 bg-background/35 px-3 py-2.5">
                        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground/60 font-semibold">
                          {item.type === "payroll" ? "Total Amount" : "LP Amount"}
                        </p>
                        <p className="mt-1 font-mono text-sm font-medium">
                          {getDetailText(item)}
                        </p>
                      </div>
                      {txUrl ? (
                        <a
                          href={txUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-primary hover:underline transition-colors"
                        >
                          Open on ArcScan
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <p className="text-xs text-muted-foreground/60">
                          Tx hash pending, explorer link not available yet.
                        </p>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <p className="text-xs text-muted-foreground/60">
                  Page {currentPage + 1} of {totalPages} · {totalCount} total
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!hasPrevPage}
                    onClick={prevPage}
                    className="h-8 gap-1 border-border/40 hover:border-primary/20"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Prev
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!hasNextPage}
                    onClick={nextPage}
                    className="h-8 gap-1 border-border/40 hover:border-primary/20"
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
