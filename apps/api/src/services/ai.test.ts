import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredSummaryModel } from "./ai.js";

const config = vi.hoisted(() => ({
  AI_SUMMARY_PROVIDER: "groq",
  GROQ_API_KEY: "test-only",
  ANTHROPIC_API_KEY: "test-only",
  ANTHROPIC_SUMMARY_MODEL: "claude-test",
}));
vi.mock("../config.js", () => ({ config }));

afterEach(() => {
  vi.unstubAllGlobals();
  config.AI_SUMMARY_PROVIDER = "groq";
  config.GROQ_API_KEY = "test-only";
});

describe("configured summary model", () => {
  it("requests a structured response from Groq and parses its content", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      choices: [{ finish_reason: "stop", message: { content: '{"items":[]}' } }],
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(configuredSummaryModel('{"untrustedEvidence":{}}')).resolves.toEqual({ items: [] });
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(options?.headers).toMatchObject({ authorization: "Bearer test-only" });
    expect(JSON.parse(String(options?.body))).toMatchObject({
      model: "openai/gpt-oss-20b",
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
  });

  it("requires a key for the selected provider without falling back", async () => {
    config.GROQ_API_KEY = "";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(configuredSummaryModel("{}")).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries a Groq structured output failure once", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: "json_validate_failed" } }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ finish_reason: "stop", message: { content: '{"items":[]}' } }],
      }));
    vi.stubGlobal("fetch", fetch);
    await expect(configuredSummaryModel("{}")).resolves.toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves Claude as a configured option", async () => {
    config.AI_SUMMARY_PROVIDER = "claude";
    const fetch = vi.fn().mockResolvedValue(Response.json({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"items":[]}' }],
    }));
    vi.stubGlobal("fetch", fetch);
    await expect(configuredSummaryModel("{}")).resolves.toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.anything());
  });
});
