import type { CopilotSession } from "@github/copilot-sdk";

type UsageMetrics = Pick<
  Awaited<ReturnType<CopilotSession["rpc"]["usage"]["getMetrics"]>>,
  "totalNanoAiu" | "totalPremiumRequestCost"
>;

function validCost(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function aiuCost(totalNanoAiu: number): string {
  return `cost: ${(totalNanoAiu / 1_000_000_000).toFixed(6)} AIU`;
}

export async function readReviewCost(
  readMetrics: () => Promise<UsageMetrics>,
  checkpointNanoAiu: number | undefined,
  warn: (message: string) => void,
): Promise<string> {
  try {
    const metrics = await readMetrics();
    if (validCost(metrics.totalNanoAiu)) return aiuCost(metrics.totalNanoAiu);
    // Premium-request multipliers are not currency or AI units.
    if (validCost(metrics.totalPremiumRequestCost) && metrics.totalPremiumRequestCost > 0) {
      return `cost: ${metrics.totalPremiumRequestCost} premium requests (AIU unavailable)`;
    }
    warn("Final session usage did not report an AI-unit cost.");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Could not read final session usage: ${message}`);
  }

  return validCost(checkpointNanoAiu)
    ? `${aiuCost(checkpointNanoAiu)} (partial; final cost unavailable)`
    : "cost unavailable (SDK did not report billing usage)";
}
