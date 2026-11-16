import type { IngestionConfig } from "./config.js";
import { parseWanderlogSource } from "./index.js";

/**
 * The plan-URL key is enough for Wanderlog to return the whole trip, with no
 * login. The Pages function calls the same endpoint, so a local pull and a
 * phone refresh read one source.
 */
export async function downloadPlan(config: IngestionConfig): Promise<string> {
  const url = `https://wanderlog.com/api/tripPlans/${encodeURIComponent(config.trip.wanderlogId)}?clientSchemaVersion=2`;
  const response = await fetch(url, { signal: AbortSignal.timeout(config.wanderlog.api.timeoutMs) });
  if (!response.ok) throw new Error(`Wanderlog returned ${response.status}`);
  const contents = await response.text();
  try {
    parseWanderlogSource(contents);
  } catch (error) {
    throw new Error("Wanderlog returned invalid trip JSON", { cause: error });
  }
  return contents;
}
