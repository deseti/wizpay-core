"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export function SkeletonText({
  className,
  lines = 3,
}: {
  className?: string;
  lines?: number;
}) {
  return (
    <div className={cn("space-y-2.5", className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          className="h-3"
          style={{ width: index === lines - 1 ? "62%" : `${92 - index * 7}%` }}
        />
      ))}
    </div>
  );
}

interface SkeletonCardProps {
  className?: string;
  lines?: number;
}

export function SkeletonCard({ className, lines = 3 }: SkeletonCardProps) {
  return (
    <div
      className={cn(
        "glass-card rounded-2xl border border-border/40 p-5 space-y-4",
        className
      )}
    >
      <div className="flex items-center gap-3" aria-hidden="true">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-36" />
        </div>
      </div>
      <SkeletonText lines={lines} />
    </div>
  );
}

interface SkeletonRowProps {
  columns?: number;
}

export function SkeletonRow({ columns = 5 }: SkeletonRowProps) {
  return (
    <div className="flex items-center gap-4 border-b border-border/20 px-4 py-3 last:border-0" aria-hidden="true">
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-4 flex-1"
          style={{ maxWidth: i === 0 ? "8rem" : "6rem" }}
        />
      ))}
    </div>
  );
}

export function SkeletonList({
  className,
  count = 4,
  columns = 4,
}: {
  className?: string;
  count?: number;
  columns?: number;
}) {
  return (
    <div className={cn("overflow-hidden rounded-2xl border border-border/40", className)} role="status" aria-label="Loading list">
      <span className="sr-only">Loading</span>
      {Array.from({ length: count }).map((_, index) => (
        <SkeletonRow columns={columns} key={index} />
      ))}
    </div>
  );
}

export function PageSkeleton({
  children,
  className,
  cards = 3,
}: {
  children?: ReactNode;
  className?: string;
  cards?: number;
}) {
  return (
    <div className={cn("space-y-6", className)} role="status" aria-label="Loading page">
      <span className="sr-only">Loading</span>
      <div className="space-y-2" aria-hidden="true">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      {children ?? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: cards }).map((_, index) => (
            <SkeletonCard key={index} lines={3} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SendPageSkeleton() {
  return (
    <PageSkeleton cards={0}>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
        <SkeletonCard className="min-h-[430px]" lines={5} />
        <SkeletonCard className="min-h-[280px]" lines={4} />
      </div>
    </PageSkeleton>
  );
}

export function SkeletonBalance() {
  return (
    <div className="space-y-2" role="status" aria-label="Loading balance">
      <span className="sr-only">Loading balance</span>
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-3 w-20" />
    </div>
  );
}
