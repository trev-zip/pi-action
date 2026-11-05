import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as core from "@actions/core";

import { resolveFileInput } from "../inputs.ts";
import type { ActionInputs } from "../types.ts";

export const PI_API_KEY_ENV = "PI_ACTION_API_KEY";
export const DEFAULT_CUSTOM_PROVIDER = "custom";
export const DEFAULT_CUSTOM_API = "openai-completions";
export const SEARCH_TOOLS = ["grep", "find", "ls"];
const MODEL_LIST_TIMEOUT_MS = 10000;

type ProviderInputs = Pick<
  ActionInputs,
  "provider" | "model" | "baseUrl" | "api" | "apiKey" | "models" | "thinking"
>;

type ModelsConfig = {
  providers: Record<string, Record<string, unknown>>;
};

export type PiModelSelection = {
  provider: string | undefined;
  model: string | undefined;
};

export type PiModelLimits = {
  contextWindow?: number;
  maxTokens?: number;
};

export type PiModelInfo = PiModelLimits & {
  ownedBy?: string;
};

// What the endpoint's model list adds to the base-url model: the API, when
// neither the api input nor the models input sets one, and the limits the
// models input leaves unset.
export type PiDiscoveredModel = PiModelLimits & {
  api?: string;
};

export async function setupPiModels(
  agentDir: string,
  inputs: ProviderInputs,
  workspace: string,
): Promise<PiModelSelection> {
  const models = inputs.models ? resolveFileInput(inputs.models, workspace) : undefined;
  const discovered = await discoverPiModel(inputs, parseModelsConfig(models));
  const config = buildPiModelsConfig(inputs, models, discovered);

  if (Object.keys(config.providers).length > 0) {
    const modelsPath = path.join(agentDir, "models.json");
    writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(modelsPath, 0o600);
    core.info(`Configured pi providers: ${Object.keys(config.providers).join(", ")}`);
  }

  return getPiModelSelection(inputs);
}

// Without bash, pi has no way to search the workspace, so turn on its
// read-only search tools; the action's extension confines them to the
// workspace. If another shell such as powershell is still active, the
// extension skips confinement, which costs nothing: that shell can already
// read any file.
export function setupPiSettings(agentDir: string, excludeTools: string[]): boolean {
  if (!excludeTools.includes("bash")) {
    return false;
  }

  const settings = { defaultTools: SEARCH_TOOLS.map((tool) => `+${tool}`) };
  writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  core.info(`Enabled pi search tools without bash: ${SEARCH_TOOLS.join(", ")}`);
  return true;
}

export function buildPiModelsConfig(
  inputs: ProviderInputs,
  models?: string,
  discovered: PiDiscoveredModel = {},
): ModelsConfig {
  const config = parseModelsConfig(models);

  if (inputs.baseUrl) {
    if (!inputs.model) {
      throw new Error("model is required when base-url is provided");
    }

    const modelId = inputs.model;
    const providerName = inputs.provider ?? DEFAULT_CUSTOM_PROVIDER;
    const existing = config.providers[providerName] ?? {};
    const existingModels = Array.isArray(existing.models) ? (existing.models as unknown[]) : [];
    const limits: PiModelLimits = {
      ...(discovered.contextWindow ? { contextWindow: discovered.contextWindow } : {}),
      ...(discovered.maxTokens ? { maxTokens: discovered.maxTokens } : {}),
    };
    // Keep a definition from the models input, which may carry context
    // window, cost, or input metadata the action cannot infer. Discovered
    // limits only hold the ones it leaves unset.
    const models = existingModels.some((model) => isModelWithId(model, modelId))
      ? existingModels.map((model) =>
          isModelWithId(model, modelId) ? { ...(model as object), ...limits } : model,
        )
      : [
          ...existingModels,
          {
            id: modelId,
            reasoning: inputs.thinking !== undefined && inputs.thinking !== "off",
            ...limits,
          },
        ];

    const api = inputs.api ?? (asString(existing.api) || discovered.api || DEFAULT_CUSTOM_API);

    config.providers[providerName] = {
      ...existing,
      baseUrl: getProviderBaseUrl(inputs.baseUrl, api),
      api,
      ...(inputs.apiKey ? { apiKey: `$${PI_API_KEY_ENV}` } : {}),
      models,
    };
  } else if (inputs.apiKey) {
    if (!inputs.provider) {
      throw new Error("provider is required when api-key is provided without base-url");
    }

    config.providers[inputs.provider] = {
      ...config.providers[inputs.provider],
      apiKey: `$${PI_API_KEY_ENV}`,
    };
  }

  return config;
}

// Reads the base-url model from the endpoint's model list.
//
// pi gives a model without limits a 128000-token context window and a
// 16384-token output limit, which cuts off long turns of models that support
// more, so fill in the limits the models input leaves unset. CLIProxyAPI only
// includes limits in the Anthropic format of that list, so the request asks
// for it.
//
// Without an api input or a models input API, also pick the API from the
// model's owner, so Claude models get pi's prompt caching over
// anthropic-messages without configuration.
export async function discoverPiModel(
  inputs: ProviderInputs,
  models: ModelsConfig,
): Promise<PiDiscoveredModel> {
  if (!inputs.baseUrl || !inputs.model) {
    return {};
  }

  const modelId = inputs.model;
  const provider = models.providers[inputs.provider ?? DEFAULT_CUSTOM_PROVIDER];
  const configuredApi = inputs.api ?? (asString(provider?.api) || undefined);
  const found = Array.isArray(provider?.models)
    ? (provider.models as unknown[]).find((model) => isModelWithId(model, modelId))
    : undefined;
  const definition = isRecord(found) ? found : {};

  if (configuredApi && definition.contextWindow && definition.maxTokens) {
    return {};
  }

  const listApi = configuredApi ?? DEFAULT_CUSTOM_API;
  const url = getModelListUrl(getProviderBaseUrl(inputs.baseUrl, listApi), listApi);
  let info: PiModelInfo;

  try {
    info = await fetchModelInfo(url, modelId, inputs.apiKey);
  } catch (error) {
    const defaults = [
      ...(definition.contextWindow && definition.maxTokens ? [] : ["its default limits"]),
      ...(configuredApi ? [] : [DEFAULT_CUSTOM_API]),
    ];
    core.info(
      `Could not read ${modelId} from ${url}; pi will use ${defaults.join(" and ")}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }

  const discovered: PiDiscoveredModel = {};

  if (!configuredApi) {
    const api = getApiForModelOwner(info.ownedBy);

    if (api) {
      discovered.api = api;
      core.info(`Detected ${api} for ${modelId}, which is owned by ${info.ownedBy}`);
    } else {
      core.info(`Using ${DEFAULT_CUSTOM_API} for ${modelId}; set api to use another API`);
    }
  }

  if (!definition.contextWindow && info.contextWindow) {
    discovered.contextWindow = info.contextWindow;
  }

  if (!definition.maxTokens && info.maxTokens) {
    discovered.maxTokens = info.maxTokens;
  }

  const limits = Object.entries(discovered).filter(([name]) => name !== "api");

  if (limits.length > 0) {
    core.info(
      `Discovered limits for ${modelId}: ${limits.map(([name, value]) => `${name} ${value}`).join(", ")}`,
    );
  } else if (!definition.contextWindow || !definition.maxTokens) {
    core.info(`${url} has no limits for ${modelId}; pi will use its defaults`);
  }

  return discovered;
}

// CLIProxyAPI reports the provider behind each model as owned_by. Only
// Anthropic is trusted: other servers fill owned_by loosely, such as "openai"
// for every model, and may not serve /responses, so they keep
// openai-completions.
export function getApiForModelOwner(ownedBy: string | undefined): string | undefined {
  return ownedBy === "anthropic" ? "anthropic-messages" : undefined;
}

// Anthropic clients add /v1 to the base URL themselves, so an OpenAI-style
// base URL that ends in /v1, such as CLIProxyAPI's, would request
// /v1/v1/messages. Dropping it lets the same URL serve either API.
export function getProviderBaseUrl(baseUrl: string, api: string): string {
  return api === "anthropic-messages" ? baseUrl.replace(/\/v1\/*$/, "") : baseUrl;
}

export function getModelListUrl(baseUrl: string, api: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  // Anthropic clients add /v1 to the base URL themselves; OpenAI clients
  // expect it to be part of the base URL already.
  return api === "anthropic-messages" ? `${base}/v1/models` : `${base}/models`;
}

export async function fetchModelInfo(
  url: string,
  modelId: string,
  apiKey: string | undefined,
): Promise<PiModelInfo> {
  const response = await fetch(url, {
    headers: {
      "anthropic-version": "2023-06-01",
      ...(apiKey ? { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
    },
    // fetch drops authorization on a cross-origin redirect, but not x-api-key.
    redirect: "error",
    signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return parseModelInfo(await response.json(), modelId);
}

// Reads the owner and the Anthropic (max_input_tokens, max_tokens) and
// OpenRouter-style (context_length, max_completion_tokens) limits of a model
// list entry.
export function parseModelInfo(body: unknown, modelId: string): PiModelInfo {
  const list = isRecord(body) && Array.isArray(body.data) ? (body.data as unknown[]) : [];
  const model = list.find((entry) => isModelWithId(entry, modelId));

  if (!isRecord(model)) {
    return {};
  }

  return {
    ownedBy: asString(model.owned_by) || undefined,
    contextWindow: asPositiveInteger(model.max_input_tokens ?? model.context_length),
    maxTokens: asPositiveInteger(model.max_tokens ?? model.max_completion_tokens),
  };
}

export function getPiModelSelection(inputs: ProviderInputs): PiModelSelection {
  if (inputs.baseUrl) {
    return { provider: inputs.provider ?? DEFAULT_CUSTOM_PROVIDER, model: inputs.model };
  }

  return { provider: inputs.provider, model: inputs.model };
}

export function createPiProviderEnv(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { [PI_API_KEY_ENV]: apiKey } : {};
}

export function parseModelsConfig(models: string | undefined): ModelsConfig {
  if (!models?.trim()) {
    return { providers: {} };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(models);
  } catch (error) {
    throw new Error(
      `models must be JSON or a path to a JSON file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("models must be a JSON object");
  }

  const providers = parsed.providers ?? {};

  if (!isRecord(providers)) {
    throw new Error("models.providers must be a JSON object");
  }

  for (const [name, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) {
      throw new Error(`models.providers.${name} must be a JSON object`);
    }
  }

  return { ...parsed, providers: providers as Record<string, Record<string, unknown>> };
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isModelWithId(model: unknown, id: string): boolean {
  return isRecord(model) && model.id === id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
