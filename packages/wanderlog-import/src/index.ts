export type SourceKind = "cli-json" | "html-mobx";

export interface ParsedWanderlogSource {
  kind: SourceKind;
  data: Record<string, unknown>;
}

const MOBX_MARKER = "window.__MOBX_STATE__ =";

export function detectSourceKind(contents: string): SourceKind {
  const trimmed = contents.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "cli-json";
  if (contents.includes(MOBX_MARKER)) return "html-mobx";
  throw new Error("Unsupported input: expected Wanderlog CLI JSON or HTML containing window.__MOBX_STATE__");
}

function findJsonObjectEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  throw new Error("Embedded MobX state is incomplete or malformed");
}

export function extractMobxState(html: string): Record<string, unknown> {
  const markerIndex = html.indexOf(MOBX_MARKER);
  if (markerIndex < 0) throw new Error("window.__MOBX_STATE__ assignment was not found");

  const objectStart = html.indexOf("{", markerIndex + MOBX_MARKER.length);
  if (objectStart < 0) throw new Error("MobX state does not begin with a JSON object");

  const objectEnd = findJsonObjectEnd(html, objectStart);
  const state = JSON.parse(html.slice(objectStart, objectEnd)) as Record<string, unknown>;
  return state;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseWanderlogSource(contents: string): ParsedWanderlogSource {
  const kind = detectSourceKind(contents);

  if (kind === "cli-json") {
    const data = JSON.parse(contents) as unknown;
    const record = asRecord(data);
    if (!record) throw new Error("Wanderlog CLI output must be a JSON object");
    return { kind, data: record };
  }

  const state = extractMobxState(contents);
  const tripPlanStore = asRecord(state.tripPlanStore);
  const data = asRecord(tripPlanStore?.data);
  if (!data) throw new Error("MobX state is missing tripPlanStore.data");
  return { kind, data };
}
