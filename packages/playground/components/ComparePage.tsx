"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";

interface EvalDetail {
  name: string;
  totalRuns: number;
  passedRuns: number;
  passRate: number;
  meanDuration: number;
}

interface ExperimentDetailData {
  name: string;
  timestamp: string;
  evals: EvalDetail[];
}

interface SelectOption {
  value: string;
  label: string;
}

interface ComparePageProps {
  options: SelectOption[];
  detailsMap: Record<string, ExperimentDetailData | null>;
}

export function ComparePage({ options, detailsMap }: ComparePageProps) {

  // Pre-select the two most recent runs if available
  const defaultLeft = options.length >= 1 ? options[0].value : "";
  const defaultRight = options.length >= 2 ? options[1].value : "";

  const [leftValue, setLeftValue] = useState(defaultLeft);
  const [rightValue, setRightValue] = useState(defaultRight);

  // Look up detail data directly from the pre-loaded map
  const leftData = leftValue ? (detailsMap[leftValue] ?? null) : null;
  const rightData = rightValue ? (detailsMap[rightValue] ?? null) : null;

  // Merge eval names from both sides
  const allEvalNames = new Set<string>();
  leftData?.evals?.forEach((e) => allEvalNames.add(e.name));
  rightData?.evals?.forEach((e) => allEvalNames.add(e.name));
  const evalNames = Array.from(allEvalNames).sort();

  const leftMap = new Map(leftData?.evals?.map((e) => [e.name, e]) ?? []);
  const rightMap = new Map(rightData?.evals?.map((e) => [e.name, e]) ?? []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Compare</h1>
        <p className="text-muted-foreground mt-1">
          Compare two experiment runs side-by-side.
        </p>
      </div>

      {/* Selection */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-muted-foreground">
              Left
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Select
              value={leftValue || undefined}
              onValueChange={setLeftValue}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select experiment run..." />
              </SelectTrigger>
              <SelectContent>
                {options.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-muted-foreground">
              Right
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Select
              value={rightValue || undefined}
              onValueChange={setRightValue}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select experiment run..." />
              </SelectTrigger>
              <SelectContent>
                {options.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </div>

      {/* Comparison table */}
      {leftData && rightData && evalNames.length > 0 && (
        <>
          <Separator />

          {/* Summary comparison */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <ComparisonStat
              label="Overall Pass Rate"
              left={avgPassRate(leftData.evals)}
              right={avgPassRate(rightData.evals)}
              format={(v) => `${v.toFixed(0)}%`}
              higherIsBetter
            />
            <ComparisonStat
              label="Avg Duration"
              left={avgDuration(leftData.evals)}
              right={avgDuration(rightData.evals)}
              format={(v) => `${v.toFixed(1)}s`}
              higherIsBetter={false}
            />
            <ComparisonStat
              label="Evals Passed"
              left={leftData.evals.filter((e) => e.passedRuns === e.totalRuns).length}
              right={rightData.evals.filter((e) => e.passedRuns === e.totalRuns).length}
              format={(v) => `${v}`}
              higherIsBetter
            />
          </div>

          {/* Per-eval comparison table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Per-Eval Comparison</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Eval</TableHead>
                    <TableHead className="text-center">Left Pass Rate</TableHead>
                    <TableHead className="text-center">Right Pass Rate</TableHead>
                    <TableHead className="text-center">Delta</TableHead>
                    <TableHead className="text-center">Left Duration</TableHead>
                    <TableHead className="text-center">Right Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {evalNames.map((name) => {
                    const left = leftMap.get(name);
                    const right = rightMap.get(name);
                    const leftRate = left?.passRate ?? 0;
                    const rightRate = right?.passRate ?? 0;
                    const delta = rightRate - leftRate;

                    return (
                      <TableRow key={name}>
                        <TableCell className="font-medium">{name}</TableCell>
                        <TableCell className="text-center">
                          {left ? (
                            <Badge
                              variant={
                                left.passRate === 100 ? "default" : "destructive"
                              }
                            >
                              {left.passRate.toFixed(0)}%
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">--</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          {right ? (
                            <Badge
                              variant={
                                right.passRate === 100 ? "default" : "destructive"
                              }
                            >
                              {right.passRate.toFixed(0)}%
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">--</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          {left && right ? (
                            <span
                              className={
                                delta > 0
                                  ? "text-green-500"
                                  : delta < 0
                                    ? "text-red-500"
                                    : "text-muted-foreground"
                              }
                            >
                              {delta > 0 ? "+" : ""}
                              {delta.toFixed(0)}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground">--</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center text-sm text-muted-foreground">
                          {left ? `${left.meanDuration.toFixed(1)}s` : "--"}
                        </TableCell>
                        <TableCell className="text-center text-sm text-muted-foreground">
                          {right ? `${right.meanDuration.toFixed(1)}s` : "--"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {/* Prompt to select both */}
      {(!leftData || !rightData) && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              Select two experiment runs above to compare them.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ComparisonStat({
  label,
  left,
  right,
  format,
  higherIsBetter,
}: {
  label: string;
  left: number;
  right: number;
  format: (v: number) => string;
  higherIsBetter: boolean;
}) {
  const delta = right - left;
  const improved = higherIsBetter ? delta > 0 : delta < 0;
  const regressed = higherIsBetter ? delta < 0 : delta > 0;

  return (
    <Card>
      <CardContent className="py-4 px-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="flex items-baseline gap-4 mt-1">
          <span className="text-lg font-medium">{format(left)}</span>
          <span className="text-muted-foreground">→</span>
          <span className="text-lg font-medium">{format(right)}</span>
          {delta !== 0 && (
            <Badge
              variant={improved ? "default" : regressed ? "destructive" : "secondary"}
              className="text-xs"
            >
              {delta > 0 ? "+" : ""}
              {format(Math.abs(delta))}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function avgPassRate(evals: EvalDetail[]): number {
  if (evals.length === 0) return 0;
  return evals.reduce((s, e) => s + e.passRate, 0) / evals.length;
}

function avgDuration(evals: EvalDetail[]): number {
  if (evals.length === 0) return 0;
  return evals.reduce((s, e) => s + e.meanDuration, 0) / evals.length;
}

