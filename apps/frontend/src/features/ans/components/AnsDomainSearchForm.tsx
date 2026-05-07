"use client"

import type { FormEvent } from "react"
import { Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { ANS_YEAR_OPTIONS } from "../pricing/constants"
import type { AnsNamespaceKey } from "../types/ans"
import { formatRelativeYears } from "../utils/format"

export function AnsDomainSearchForm({
  inputValue,
  namespace,
  durationYears,
  isBusy = false,
  submitLabel = "Search name",
  onInputValueChange,
  onNamespaceChange,
  onDurationYearsChange,
  onSubmit,
}: {
  inputValue: string
  namespace: AnsNamespaceKey
  durationYears: number
  isBusy?: boolean
  submitLabel?: string
  onInputValueChange: (value: string) => void
  onNamespaceChange: (value: AnsNamespaceKey) => void
  onDurationYearsChange: (value: number) => void
  onSubmit: () => void
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit()
  }

  return (
    <Card className="glass-card border-border/40">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Exact on-chain search</CardTitle>
        <p className="text-sm text-muted-foreground/75">
          Search only exact second-level names under .arc and .wizpay. There is no public indexer in this release, so human-readable discovery stays exact-match only.
        </p>
      </CardHeader>

      <CardContent>
        <form className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(180px,0.7fr)_minmax(180px,0.7fr)_auto]" onSubmit={handleSubmit}>
          <div className="space-y-2 lg:col-span-1">
            <Label htmlFor="ans-search-input">Label or full domain</Label>
            <Input
              id="ans-search-input"
              value={inputValue}
              onChange={(event) => onInputValueChange(event.target.value)}
              placeholder="treasury or treasury.wizpay"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-10"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="ans-namespace-select">Namespace</Label>
            <Select value={namespace} onValueChange={(value) => onNamespaceChange(value as AnsNamespaceKey)}>
              <SelectTrigger id="ans-namespace-select">
                <SelectValue placeholder="Select namespace" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="arc">.arc</SelectItem>
                <SelectItem value="wizpay">.wizpay</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ans-duration-select">Duration</Label>
            <Select
              value={String(durationYears)}
              onValueChange={(value) => onDurationYearsChange(Number(value))}
            >
              <SelectTrigger id="ans-duration-select">
                <SelectValue placeholder="Select duration" />
              </SelectTrigger>
              <SelectContent>
                {ANS_YEAR_OPTIONS.map((year) => (
                  <SelectItem key={year} value={String(year)}>
                    {formatRelativeYears(year)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-end">
            <Button type="submit" className="h-10 w-full gap-2 lg:w-auto" disabled={isBusy}>
              <Search className="h-4 w-4" />
              {submitLabel}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}