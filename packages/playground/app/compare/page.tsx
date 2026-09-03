import { ComparePage } from "@/components/ComparePage";
import { listExperiments, getExperimentDetail } from "@/lib/data";

export const dynamic = "force-dynamic";

function formatTimestamp(ts: string): string {
  try {
    const isoString = ts.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return ts;
    return date.toLocaleString();
  } catch {
    return ts;
  }
}

export default async function CompareRoute() {
  const { items: experiments } = listExperiments();

  // Build options and details map server-side to avoid hydration mismatch
  // (toLocaleString differs between Node.js and browser)
  const options = experiments.flatMap((exp) =>
    (exp.timestamps ?? []).map((ts) => ({
      value: `${exp.name}|||${ts}`,
      label: `${exp.name} / ${formatTimestamp(ts)}`,
    }))
  );

  const detailsMap: Record<string, ReturnType<typeof getExperimentDetail>> = {};
  for (const exp of experiments) {
    for (const ts of exp.timestamps ?? []) {
      const detail = getExperimentDetail(exp.name, ts);
      if (detail) {
        detailsMap[`${exp.name}|||${ts}`] = detail;
      }
    }
  }

  return <ComparePage options={options} detailsMap={detailsMap} />;
}
