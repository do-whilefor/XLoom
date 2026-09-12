import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModel } from "../src/runtime/models.js";

afterEach(() => vi.unstubAllEnvs());

describe("model resolution", () => {
  it("resolves Pi's static model catalog with explicit environment credentials", async () => {
    vi.stubEnv("XLOOM_TEST_KEY", "test-model-key");
    const result = await resolveModel({ provider: "anthropic", model: "claude-sonnet-4-6", apiKeyEnv: "XLOOM_TEST_KEY", maxTokens: 2048 }, new AbortController().signal);
    expect(result.model.id).toBe("claude-sonnet-4-6");
    expect(result.model.maxTokens).toBe(2048);
    expect(result.secrets).toContain("test-model-key");
    expect(result.costKnown).toBe(true);
  });

  it("supports a custom API endpoint without network model discovery", async () => {
    vi.stubEnv("XLOOM_TEST_KEY", "local-placeholder");
    const result = await resolveModel({ provider: "local-test", model: "local", api: "openai-completions", baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "XLOOM_TEST_KEY" }, new AbortController().signal);
    expect(result.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(result.model.api).toBe("openai-completions");
    expect(result.costKnown).toBe(false);
  });

  it("fails early for missing explicit credentials and unknown models", async () => {
    vi.stubEnv("XLOOM_TEST_KEY", undefined);
    await expect(resolveModel({ provider: "test", model: "test", apiKeyEnv: "XLOOM_TEST_KEY" }, new AbortController().signal)).rejects.toThrow("Missing model credential");
    await expect(resolveModel({ provider: "test", model: "test" }, new AbortController().signal)).rejects.toThrow("Unknown Pi model");
  });

  it("rejects credentials embedded in a configured URL", async () => {
    vi.stubEnv("XLOOM_TEST_KEY", "test-model-key");
    for (const baseUrl of ["https://user:password@example.invalid/v1", "https://example.invalid/v1?api_key=secret", "file:///model"]) {
      await expect(resolveModel({ provider: "test", model: "test", api: "openai-completions", baseUrl, apiKeyEnv: "XLOOM_TEST_KEY" }, new AbortController().signal)).rejects.toThrow("without credentials");
    }
  });
});
