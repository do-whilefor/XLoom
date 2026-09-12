import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, InMemoryModelsStore, type AssistantMessage, type Credential } from "@earendil-works/pi-ai";
import { getApiProviders } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { listModels, resolveModel } from "../src/runtime/models.js";

const realCreate = ModelRuntime.create.bind(ModelRuntime);
const selection = { provider: "anthropic", model: "claude-sonnet-4-6" };
let directory: string;
let runtime: ModelRuntime;
let configureRuntime: ((value: ModelRuntime) => void) | undefined;
const signal = () => new AbortController().signal;
const saveAuth = (credentials: Record<string, Credential>) => writeFile(join(directory, "auth.json"), JSON.stringify(credentials));
const saveModels = (providers: Record<string, unknown>) => writeFile(join(directory, "models.json"), JSON.stringify({ providers }));

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "xloom-models-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "PI_OFFLINE", "XLOOM_TEST_KEY"]) vi.stubEnv(name, undefined);
  configureRuntime = undefined;
  // Exercise Pi's real config/auth code, but never a user credential store or a network catalog.
  vi.spyOn(ModelRuntime, "create").mockImplementation(async (options) => {
    runtime = await realCreate({ ...options, refreshOnCreate: false, modelsStore: new InMemoryModelsStore() });
    vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
    configureRuntime?.(runtime);
    return runtime;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("Pi model resolution", () => {
  it("uses Pi's static model and an explicit environment override", async () => {
    vi.stubEnv("XLOOM_TEST_KEY", "test-model-key");
    const requestSignal = signal();
    const result = await resolveModel({ ...selection, apiKeyEnv: "XLOOM_TEST_KEY", maxTokens: 2048 }, requestSignal);
    expect(ModelRuntime.create).toHaveBeenCalledWith({ allowModelNetwork: false, signal: requestSignal });
    expect(result.model.id).toBe(selection.model);
    expect(result.model.maxTokens).toBe(2048);
    expect(result.secrets).toContain("test-model-key");
    expect(result.costKnown).toBe(true);
  });

  it("uses Pi's normal environment names without apiKeyEnv", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "standard-provider-key");
    const result = await resolveModel(selection, signal());
    expect(result.secrets).toContain("standard-provider-key");
  });

  it("uses Pi auth.json with Pi's stored-key precedence over the environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "unused-environment-key");
    await saveAuth({ anthropic: { type: "api_key", key: "stored-test-key" } });
    const result = await resolveModel(selection, signal());
    expect(result.secrets).toContain("stored-test-key");
    expect(result.secrets).not.toContain("unused-environment-key");
  });

  it("accepts header-only provider auth and redacts the bare bearer token too", async () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "header-only-token");
    const result = await resolveModel(selection, signal());
    expect(result.secrets).toEqual(expect.arrayContaining(["Bearer header-only-token", "header-only-token"]));
  });

  it("delegates stored OAuth refresh and persistence to Pi", async () => {
    await saveAuth({ anthropic: { type: "oauth", access: "old-access", refresh: "fake-refresh", expires: 0 } });
    const refreshed: Credential = { type: "oauth", access: "refreshed-access", refresh: "rotated-refresh", expires: Date.now() + 3_600_000 };
    let refresh!: ReturnType<typeof vi.fn>;
    configureRuntime = (value) => {
      const oauth = value.getProvider("anthropic")!.auth.oauth!;
      refresh = vi.spyOn(oauth, "refresh").mockResolvedValue(refreshed);
      vi.spyOn(oauth, "toAuth").mockImplementation(async (credential) => ({ apiKey: credential.access }));
    };
    const result = await resolveModel(selection, signal());
    expect(refresh).toHaveBeenCalledOnce();
    expect(result.secrets).toContain("refreshed-access");
    expect(JSON.parse(await readFile(join(directory, "auth.json"), "utf8")).anthropic).toEqual(refreshed);
  });

  it("keeps the credential list live as Pi reauthenticates between model turns", async () => {
    await saveAuth({ anthropic: { type: "api_key", key: "before-rotation" } });
    const result = await resolveModel(selection, signal());
    const liveSecrets = result.secrets;
    const provider = runtime.getProvider("anthropic")!;
    const message: AssistantMessage = {
      role: "assistant", api: result.model.api, provider: "anthropic", model: selection.model,
      content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const providerStream = vi.spyOn(provider, "streamSimple").mockImplementation(() => {
      const stream = createAssistantMessageEventStream(); stream.end(message); return stream;
    });
    await saveAuth({ anthropic: { type: "api_key", key: "after-rotation", env: { AWS_SECRET_ACCESS_KEY: "scoped-secret", AWS_REGION: "region-not-a-secret" } } });
    const requestSignal = signal();
    const stream = await result.streamFn(result.model, { messages: [] }, { signal: requestSignal, reasoning: "high" });
    expect(await stream.result()).toEqual(message);
    expect(providerStream).toHaveBeenCalledWith(expect.objectContaining({ id: selection.model }), { messages: [] }, expect.objectContaining({ apiKey: "after-rotation", signal: requestSignal, reasoning: "high", maxTokens: result.model.maxTokens }));
    expect(result.secrets).toBe(liveSecrets);
    expect(liveSecrets).toEqual(expect.arrayContaining(["before-rotation", "after-rotation", "scoped-secret"]));
    expect(liveSecrets).not.toContain("region-not-a-secret");
  });

  it("does not replace OAuth with a resolved API key in stream options", async () => {
    configureRuntime = (value) => vi.spyOn(value, "getAuth").mockResolvedValue({ auth: { apiKey: "oauth-token", baseUrl: "https://tenant.invalid" }, source: "OAuth" });
    const result = await resolveModel(selection, signal());
    const fakeStream = createAssistantMessageEventStream();
    const stream = vi.spyOn(runtime, "streamSimple").mockReturnValue(fakeStream);
    result.streamFn(result.model, { messages: [] });
    expect(stream).toHaveBeenCalledWith(result.model, { messages: [] }, expect.objectContaining({ apiKey: undefined }));
  });

  it("does not fall back to an environment key when Pi OAuth refresh fails", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "unused-environment-key");
    await saveAuth({ anthropic: { type: "oauth", access: "expired-access", refresh: "invalid-refresh", expires: 0 } });
    configureRuntime = (value) => vi.spyOn(value.getProvider("anthropic")!.auth.oauth!, "refresh").mockRejectedValue(new Error("refresh diagnostic with invalid-refresh"));
    await expect(resolveModel(selection, signal())).rejects.toThrow("Pi could not resolve credentials for anthropic; check Pi login and provider configuration.");
  });

  it.each(getApiProviders().map((provider) => provider.api))("routes inline %s through Pi's registry", async (api) => {
    vi.stubEnv("XLOOM_TEST_KEY", "local-placeholder");
    const result = await resolveModel({ provider: "local-test", model: "local", api, baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "XLOOM_TEST_KEY" }, signal());
    expect(result.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(result.model.api).toBe(api);
    expect(result.costKnown).toBe(false);
    expect(runtime.refresh).toHaveBeenCalledWith(expect.objectContaining({ allowNetwork: false }));
  });

  it("keeps models.json model metadata, provider headers and custom auth", async () => {
    vi.stubEnv("XLOOM_TEST_KEY", "custom-config-key");
    await saveModels({ "custom-google": {
      api: "google-generative-ai", baseUrl: "https://example.invalid/v1beta", apiKey: "$XLOOM_TEST_KEY", headers: { "x-test-auth": "custom-header-secret" },
      models: [{ id: "custom-gemma", input: ["text", "image"], reasoning: true, thinkingLevelMap: { high: "high", max: "max" }, contextWindow: 262144, maxTokens: 32768,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
    } });
    const result = await resolveModel({ provider: "custom-google", model: "custom-gemma" }, signal());
    expect(result.model).toMatchObject({ api: "google-generative-ai", input: ["text", "image"], contextWindow: 262144, maxTokens: 32768, thinkingLevelMap: { max: "max" } });
    expect(result.secrets).toEqual(expect.arrayContaining(["custom-config-key", "custom-header-secret"]));
    expect(result.costKnown).toBe(true);
  });

  it("supports models.json custom providers with credentials only in auth.json", async () => {
    await saveModels({ "custom-local": { api: "openai-completions", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "local", compat: { supportsDeveloperRole: false } }] } });
    await saveAuth({ "custom-local": { type: "api_key", key: "local-placeholder" } });
    const result = await resolveModel({ provider: "custom-local", model: "local" }, signal());
    expect(result.model.compat).toMatchObject({ supportsDeveloperRole: false });
    expect(result.secrets).toContain("local-placeholder");
  });

  it("discovers a missing model only through the selected known Pi provider", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    configureRuntime = (value) => {
      const original = value.getModel.bind(value);
      let discovered = false;
      vi.spyOn(value, "getModel").mockImplementation((provider, model) => provider === "anthropic" && model === "dynamic-model" && discovered
        ? { ...original("anthropic", selection.model)!, id: "dynamic-model" } : original(provider, model));
      vi.mocked(value.refresh).mockImplementation(async () => { discovered = true; return { aborted: false, errors: new Map() }; });
    };
    const requestSignal = signal();
    const result = await resolveModel({ provider: "anthropic", model: "dynamic-model" }, requestSignal);
    expect(result.model.id).toBe("dynamic-model");
    expect(runtime.refresh).toHaveBeenCalledExactlyOnceWith({ providers: ["anthropic"], allowNetwork: true, signal: requestSignal });
  });

  it("honors PI_OFFLINE when a model is missing", async () => {
    vi.stubEnv("PI_OFFLINE", "1");
    await expect(resolveModel({ provider: "anthropic", model: "unknown" }, signal())).rejects.toThrow("Unknown Pi model");
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("reports metadata refresh failures without leaking provider diagnostics", async () => {
    configureRuntime = (value) => vi.mocked(value.refresh).mockResolvedValue({ aborted: false, errors: new Map([["anthropic", new Error("metadata secret-value")]]) });
    await expect(resolveModel({ provider: "anthropic", model: "unknown" }, signal())).rejects.toThrow("Pi could not refresh the model catalog for anthropic.");
  });

  it("sanitizes thrown catalog and initialization errors before a model is returned", async () => {
    configureRuntime = (value) => vi.mocked(value.refresh).mockRejectedValue(new Error("unsafe key literal"));
    await expect(resolveModel({ provider: "anthropic", model: "unknown" }, signal())).rejects.toThrow("Pi could not refresh the model catalog for anthropic.");
    vi.mocked(ModelRuntime.create).mockRejectedValueOnce(new Error("unsafe configuration literal"));
    await expect(listModels()).rejects.toThrow("Pi model runtime could not be initialized; check the Pi configuration.");
  });

  it("lists the same local built-in and custom registry without resolving auth", async () => {
    await saveModels({ local: { api: "openai-completions", baseUrl: "http://localhost:1234/v1", apiKey: "!must-not-run", models: [{ id: "my-model" }] } });
    configureRuntime = (value) => vi.spyOn(value, "getAuth").mockRejectedValue(new Error("must not resolve auth while listing"));
    const listed = await listModels("local");
    expect(listed.map((model) => model.id)).toEqual(["my-model"]);
    expect(runtime.getAuth).not.toHaveBeenCalled();
    expect(runtime.refresh).not.toHaveBeenCalled();
    expect((await listModels()).some((model) => model.id === selection.model)).toBe(true);
  });

  it("fails early for missing explicit credentials and unknown providers", async () => {
    await expect(resolveModel({ provider: "test", model: "test", apiKeyEnv: "XLOOM_TEST_KEY" }, signal())).rejects.toThrow("Missing model credential");
    expect(ModelRuntime.create).not.toHaveBeenCalled();
    await expect(resolveModel({ provider: "test", model: "test" }, signal())).rejects.toThrow("Unknown Pi model");
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("reports missing provider credentials without trying a model request", async () => {
    await expect(resolveModel(selection, signal())).rejects.toThrow("No Pi credentials configured");
  });

  it("does not silently fall back if models.json is invalid", async () => {
    await writeFile(join(directory, "models.json"), '{"secret-config-value":');
    await expect(resolveModel(selection, signal())).rejects.toThrow("Pi model configuration could not be loaded");
  });

  it("rejects APIs not supported by the installed Pi runtime", async () => {
    await expect(resolveModel({ provider: "local", model: "local", api: "not-an-api", baseUrl: "http://localhost/v1" }, signal())).rejects.toThrow("No Pi API provider registered");
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });

  it("rejects incomplete inline models", async () => {
    await expect(resolveModel({ provider: "local", model: "local", api: "openai-completions" }, signal())).rejects.toThrow("Custom models require api and baseUrl");
  });

  it("rejects credentials embedded in a configured URL", async () => {
    for (const baseUrl of ["not-a-url", "https://user:password@example.invalid/v1", "https://example.invalid/v1?api_key=secret", "https://example.invalid/v1#secret", "file:///model"]) {
      await expect(resolveModel({ provider: "test", model: "test", api: "openai-completions", baseUrl }, signal())).rejects.toThrow("without credentials");
    }
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });

  it("propagates cancellation before any runtime or credential read", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(resolveModel(selection, controller.signal)).rejects.toThrow();
    await expect(listModels(undefined, controller.signal)).rejects.toThrow();
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });

  it("propagates cancellation during credential resolution instead of returning a usable model", async () => {
    const controller = new AbortController();
    configureRuntime = (value) => vi.spyOn(value, "getAuth").mockImplementation(async () => {
      controller.abort(); return { auth: { apiKey: "cancelled-key" } };
    });
    await expect(resolveModel(selection, controller.signal)).rejects.toThrow();
  });
});
