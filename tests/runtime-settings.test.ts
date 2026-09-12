import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryModelsStore, type AuthInteraction, type Credential } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SettingsService, type SettingsRuntime } from "../src/runtime/settings.js";

let directory: string;
let service: SettingsService;
let configure: ((runtime: ModelRuntime) => void) | undefined;
const unrelated: Credential = { type: "oauth", access: "unrelated-test-access", refresh: "unrelated-test-refresh", expires: Date.now() + 3_600_000 };
const readAuth = async () => JSON.parse(await readFile(join(directory, "auth.json"), "utf8"));
const createRuntime = async (signal?: AbortSignal) => {
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false, signal });
  configure?.(runtime);
  return runtime;
};
const interaction = (): AuthInteraction => ({ prompt: vi.fn(async () => "test-code"), notify: vi.fn() });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "xloom-settings-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENCODE_API_KEY"]) vi.stubEnv(name, undefined);
  configure = undefined;
  service = new SettingsService(createRuntime);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("Pi settings service", () => {
  it("reads local alias capacity without resolving command-backed credentials or making a network request", async () => {
    const modelsPath = join(directory, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { "fixture-alias": { api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
      apiKey: "!header-must-not-execute-this-credential-command", models: [{ id: "local-model", contextWindow: 1_048_576, maxTokens: 8192 }] } } }));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Header must not use the network"));
    let getAuth!: ReturnType<typeof vi.spyOn>;
    const metadata = new SettingsService(async signal => {
      const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath,
        modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, signal });
      getAuth = vi.spyOn(runtime, "getAuth");
      return runtime;
    });
    expect(await metadata.describeModel({ provider: "fixture-alias", model: "local-model" })).toEqual({ contextWindow: 1_048_576, authLabel: "API Key" });
    expect(getAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors explicit context and environment credentials over a stored subscription", async () => {
    configure = runtime => {
      vi.spyOn(runtime, "isUsingSubscription").mockReturnValue(true);
      vi.spyOn(runtime, "isUsingOAuth").mockReturnValue(true);
    };
    vi.stubEnv("HEADER_FIXTURE_KEY", "synthetic-private-key");
    expect(await service.describeModel({ provider: "anthropic", model: "missing-alias", contextWindow: 200_000, apiKeyEnv: "HEADER_FIXTURE_KEY" }))
      .toEqual({ contextWindow: 200_000, authLabel: "API Key" });
    vi.stubEnv("HEADER_FIXTURE_KEY", undefined);
    expect(await service.describeModel({ provider: "anthropic", model: "missing-alias", apiKeyEnv: "HEADER_FIXTURE_KEY" })).toEqual({ authLabel: "未配置认证" });
    expect(await service.describeModel({ provider: "anthropic", model: "missing-alias" })).toEqual({ authLabel: "Subscription" });
  });

  it("describes OAuth without claiming subscription billing and tolerates unknown model capacity", async () => {
    configure = runtime => {
      vi.spyOn(runtime, "isUsingSubscription").mockReturnValue(false);
      vi.spyOn(runtime, "isUsingOAuth").mockReturnValue(true);
    };
    expect(await service.describeModel({ provider: "anthropic", model: "missing-alias" })).toEqual({ authLabel: "OAuth" });
  });

  it("cancels optional metadata reads and does not expose configuration errors", async () => {
    const controller = new AbortController(); controller.abort();
    const factory = vi.fn(createRuntime);
    await expect(new SettingsService(factory).describeModel({ provider: "anthropic", model: "missing" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(factory).not.toHaveBeenCalled();
    const invalid = new SettingsService(async () => { throw new Error("secret-runtime-value"); });
    await expect(invalid.describeModel({ provider: "anthropic", model: "missing" })).rejects.not.toThrow("secret-runtime-value");
  });

  it("lists local model choices without headers, credentials, or auth resolution", async () => {
    let getAuth!: ReturnType<typeof vi.spyOn>;
    configure = (runtime) => { getAuth = vi.spyOn(runtime, "getAuth"); };
    const choices = await service.listModels();
    expect(choices).toContainEqual({ provider: "opencode-go", model: "deepseek-v4-flash", name: expect.any(String) });
    expect(Object.keys(choices[0]).sort()).toEqual(["model", "name", "provider"]);
    expect(getAuth).not.toHaveBeenCalled();
  });

  it("lists only interactive auth methods; subscription login is oauth", async () => {
    const providers = await service.listProviders();
    expect(providers).toContainEqual({ id: "opencode-go", name: "OpenCode Go", authTypes: ["api_key"] });
    expect(providers.find((provider) => provider.id === "anthropic")?.authTypes).toEqual(["api_key", "oauth"]);
    expect(providers.every((provider) => Object.keys(provider).sort().join() === "authTypes,id,name")).toBe(true);
  });

  it("persists API keys through real Pi login while retaining other provider credentials", async () => {
    await writeFile(join(directory, "auth.json"), JSON.stringify({ "other-provider": unrelated }));
    await service.saveApiKey("opencode-go", "test-settings-key");
    expect(await readAuth()).toEqual({ "other-provider": unrelated, "opencode-go": { type: "api_key", key: "test-settings-key" } });
    const fresh = await createRuntime();
    expect((await fresh.getAuth("opencode-go"))?.auth.apiKey).toBe("test-settings-key");
  });

  it("stores pasted dollar signs and leading exclamation marks as literal keys, not Pi commands", async () => {
    const key = "!test-${NOT_A_REAL_TOKEN_ENV}-$value-$$";
    await service.saveApiKey("opencode-go", key);
    expect((await readAuth())["opencode-go"].key).toBe("$!test-$${NOT_A_REAL_TOKEN_ENV}-$$value-$$$$");
    expect((await (await createRuntime()).getAuth("opencode-go"))?.auth.apiKey).toBe(key);
  });

  it("replaces only the selected provider credential on API-key save", async () => {
    await writeFile(join(directory, "auth.json"), JSON.stringify({ anthropic: unrelated, "opencode-go": { type: "api_key", key: "old-test-key" } }));
    await service.saveApiKey("opencode-go", "new-test-key");
    expect((await readAuth()).anthropic).toEqual(unrelated);
    expect((await readAuth())["opencode-go"].key).toBe("new-test-key");
  });

  it("uses the actual provider OAuth flow and delegates all callbacks", async () => {
    const callbacks = interaction();
    configure = (runtime) => {
      vi.spyOn(runtime.getProvider("anthropic")!.auth.oauth!, "login").mockImplementation(async (passed) => {
        passed.notify({ type: "auth_url", url: "https://login.example.invalid/authorize" });
        expect(await passed.prompt({ type: "manual_code", message: "Paste callback code" })).toBe("test-code");
        return { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3_600_000 };
      });
    };
    await service.login("anthropic", callbacks);
    expect(callbacks.notify).toHaveBeenCalledWith({ type: "auth_url", url: "https://login.example.invalid/authorize" });
    expect((await readAuth()).anthropic).toMatchObject({ type: "oauth", access: "test-access", refresh: "test-refresh" });
  });

  it("does not call API-key login as a substitute for browser login", async () => {
    let login!: ReturnType<typeof vi.spyOn>;
    configure = (runtime) => { login = vi.spyOn(runtime, "login"); };
    await expect(service.login("opencode-go", interaction())).rejects.toThrow("no browser/subscription login");
    expect(login).not.toHaveBeenCalled();
  });

  it("removes only the selected provider and does not clear environment credentials", async () => {
    await writeFile(join(directory, "auth.json"), JSON.stringify({ "other-provider": unrelated, "opencode-go": { type: "api_key", key: "stored-test-key" } }));
    vi.stubEnv("OPENCODE_API_KEY", "ambient-test-key");
    await service.logout("opencode-go");
    expect(await readAuth()).toEqual({ "other-provider": unrelated });
    expect(process.env.OPENCODE_API_KEY).toBe("ambient-test-key");
  });

  it.each(["", "  ", "fake\nkey", "fake\rkey", "fake\u0000key"])("rejects an empty or multiline key before runtime creation", async (key) => {
    const factory = vi.fn(createRuntime);
    await expect(new SettingsService(factory).saveApiKey("opencode-go", key)).rejects.toThrow("single-line API key");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not send a key into unexpected prompts or repeat it for provider configuration", async () => {
    configure = (runtime) => {
      vi.spyOn(runtime.getProvider("opencode-go")!.auth.apiKey!, "login").mockImplementation(async (passed) => {
        expect(await passed.prompt({ type: "secret", message: "API key" })).toBe("test-key");
        await passed.prompt({ type: "text", message: "Account id" });
        throw new Error("unreachable");
      });
    };
    await expect(service.saveApiKey("opencode-go", "test-key")).rejects.toThrow("additional setup");
    expect((await readAuth())["opencode-go"]).toBeUndefined();
  });

  it("does not echo arbitrary provider names for unsupported credential setup", async () => {
    await expect(service.saveApiKey("fake-secret-provider-id", "test-key")).rejects.toThrow("does not support API-key setup");
    await expect(service.login("fake-secret-provider-id", interaction())).rejects.not.toThrow("fake-secret-provider-id");
  });

  it("discards raw runtime errors and validation details", async () => {
    const failed = new SettingsService(async () => { throw new Error("secret-runtime-token"); });
    await expect(failed.listModels()).rejects.toThrow("Pi settings could not be loaded");
    await expect(failed.listProviders()).rejects.not.toThrow("secret-runtime-token");
    const invalid = new SettingsService(async () => ({ getError: () => "secret-config-token" } as SettingsRuntime));
    await expect(invalid.listModels()).rejects.not.toThrow("secret-config-token");
  });

  it("discards raw provider login and logout errors without attaching a cause", async () => {
    configure = (runtime) => {
      vi.spyOn(runtime, "login").mockRejectedValue(new Error("secret-provider-response"));
      vi.spyOn(runtime, "logout").mockRejectedValue(new Error("secret-provider-response"));
    };
    for (const operation of [() => service.saveApiKey("opencode-go", "test-key"), () => service.login("anthropic", interaction()), () => service.logout("opencode-go")]) {
      const error = await operation().catch((value) => value as Error);
      expect(String(error)).not.toContain("secret-provider-response");
      expect(error.cause).toBeUndefined();
    }
  });

  it("sanitizes cancellation reasons and avoids starting an already-cancelled login", async () => {
    const controller = new AbortController(); controller.abort("secret-cancellation-reason");
    const factory = vi.fn(createRuntime); const cancelled = new SettingsService(factory);
    await expect(cancelled.saveApiKey("opencode-go", "test-key", controller.signal)).rejects.toMatchObject({ name: "AbortError", message: "Credential operation cancelled." });
    await expect(cancelled.login("anthropic", { ...interaction(), signal: controller.signal })).rejects.not.toThrow("secret-cancellation-reason");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not create a runtime for already-cancelled logout or expose the cancellation reason", async () => {
    const controller = new AbortController(); controller.abort("secret-logout-cancellation");
    const factory = vi.fn(createRuntime);
    await expect(new SettingsService(factory).logout("opencode-go", controller.signal)).rejects.toMatchObject({ name: "AbortError", message: "Credential operation cancelled." });
    expect(factory).not.toHaveBeenCalled();
  });

  it("passes cancellation into Pi logout and sanitizes a mid-operation abort", async () => {
    const controller = new AbortController();
    let logout!: ReturnType<typeof vi.spyOn>;
    configure = (runtime) => {
      logout = vi.spyOn(runtime, "logout").mockImplementation(async (_provider, options) => {
        expect(options?.signal).toBe(controller.signal);
        controller.abort("secret-logout-response");
        throw controller.signal.reason;
      });
    };
    await expect(service.logout("opencode-go", controller.signal)).rejects.toMatchObject({ name: "AbortError", message: "Credential operation cancelled." });
    expect(logout).toHaveBeenCalledWith("opencode-go", { signal: controller.signal });
  });

  it("reports a saved credential separately from a synchronization failure without leaking its value", async () => {
    configure = (runtime) => {
      vi.spyOn(runtime, "login").mockRejectedValue(new CredentialSynchronizationError("opencode-go", "login", { type: "api_key", key: "secret-saved-key" }, { cause: new Error("secret-sync-error") }));
    };
    await expect(service.saveApiKey("opencode-go", "test-key")).rejects.toThrow("credential was saved");
    await expect(service.saveApiKey("opencode-go", "test-key")).rejects.not.toThrow("secret-");
  });
});
