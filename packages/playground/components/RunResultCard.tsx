import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";


interface RunResult {
  status: "passed" | "failed";
  error?: string;
  duration: number;
  o11y?: {
    totalToolCalls: number;
    thinkingBlocks: number;
    errors: string[];
  };
  usage?: {
    totalTokens?: number;
    costUsd?: number;
  };
}

interface RunResultCardProps {
  runName: string;
  result: RunResult | null;
  experiment: string;
  timestamp: string;
  evalName: string;
}

export function RunResultCard({
  runName,
  result,
  experiment,
  timestamp,
  evalName,
}: RunResultCardProps) {
  if (!result) {
    return (
      <Card className="opacity-50">
        <CardContent className="py-3 px-4">
          <span className="text-sm text-muted-foreground">{runName}: No result</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Link
      href={`/transcript/${encodeURIComponent(experiment)}/${encodeURIComponent(timestamp)}/${encodeURIComponent(evalName)}/${encodeURIComponent(runName)}`}
      className="block cursor-pointer"
    >
      <Card className="transition-colors hover:bg-muted">
        <CardContent className="py-3 px-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">{runName}</span>
            <Badge
              variant={result.status === "passed" ? "default" : "destructive"}
            >
              {result.status}
            </Badge>
            {result.error && (
              <span className="text-xs text-destructive truncate max-w-64">
                {result.error}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            {result.o11y && (
              <span>{result.o11y.totalToolCalls} tool calls</span>
            )}
            {result.usage?.totalTokens !== undefined && (
              <span>{result.usage.totalTokens.toLocaleString("en-US")} tokens</span>
            )}
            {result.usage?.costUsd !== undefined && (
              <span>${result.usage.costUsd.toFixed(4)}</span>
            )}
            <span>{result.duration.toFixed(1)}s</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
