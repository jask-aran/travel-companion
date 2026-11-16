import { describe, expect, it, vi } from "vitest";
import { checkKeys, maskKey } from "../packages/wanderlog-import/src/key-check.js";

describe("checkKeys", () => {
  it("asks each API once, gives the provider's reason for a refusal, and never shows a key", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("places.googleapis.com")) return Response.json({ error: { message: "The caller does not have permission" } }, { status: 403 });
      if (url.includes("staticmap")) return new Response("png", { headers: { "content-type": "image/png" } });
      if (url.includes("navitime")) return new Response("{}", { headers: { "x-ratelimit-requests-remaining": "393" } });
      return Response.json({});
    });
    const checks = await checkKeys({ googleKey: "SECRET-GOOGLE", googleProject: "42", navitimeKey: "SECRET-NAVI" }, fetcher as never);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(checks.map((check) => [check.name, check.ok])).toEqual([
      ["Places API (New)", false],
      ["Maps Static API", true],
      ["Routes API", true],
      ["Cloud Translation (LLM)", true],
      ["NAVITIME (RapidAPI)", true],
    ]);
    expect(checks[0]?.detail).toBe("403: The caller does not have permission");
    expect(checks[4]?.detail).toContain("393 of the plan's requests left");
    expect(JSON.stringify(checks)).not.toMatch(/SECRET/);
  });

  it("tests only the keys given", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    expect(await checkKeys({ navitimeKey: "k" }, fetcher as never)).toHaveLength(1);
    expect(await checkKeys({}, fetcher as never)).toEqual([]);
  });

  it("masks a key to its last four characters", () => {
    expect(maskKey("AIzaSyExample1234")).toBe("set (…1234)");
    expect(maskKey(undefined)).toBe("not set");
  });
});
