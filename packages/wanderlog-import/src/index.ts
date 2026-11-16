/** The plan as Wanderlog's API returns it: one JSON object. */
export function parseWanderlogSource(contents: string): { data: Record<string, unknown> } {
  const data = JSON.parse(contents) as unknown;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Wanderlog's response must be a JSON object");
  }
  return { data: data as Record<string, unknown> };
}
