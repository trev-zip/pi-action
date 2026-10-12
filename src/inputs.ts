import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import * as core from "@actions/core";

import { SUBMIT_RESULT_TOOL } from "./pi/extension.ts";
import type { ActionInputs, ReviewLevel } from "./types.ts";

const DEFAULT_AUTH_SECRET = "PI_ACTION_AUTH";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const REVIEW_LEVELS: ReviewLevel[] = ["comment", "request-changes", "approve"];

export function readInputs(): ActionInputs {
  const auth = parseOptionalString(core.getInput("auth"));
  const authSecret = validateSecretName(core.getInput("auth-secret") || DEFAULT_AUTH_SECRET);
  const prompt = core.getInput("prompt", { required: true });
  const provider = parseOptionalString(core.getInput("provider"));
  const model = parseOptionalString(core.getInput("model"));
  const baseUrl = parseOptionalString(core.getInput("base-url"));
  const api = parseOptionalString(core.getInput("api"));
  const apiKey = parseOptionalString(core.getInput("api-key"));
  const models = parseOptionalString(core.getInput("models"));
  const thinking = parseThinkingLevel(core.getInput("thinking"));
  const excludeTools = parseExcludeTools(core.getInput("exclude-tools"));
  const token = parseOptionalString(core.getInput("token"));
  const githubAppClientId = parseOptionalString(core.getInput("client-id"));
  const githubAppPrivateKey = parseOptionalString(core.getInput("private-key"));
  const automerge = parseOptionalBoolean(core.getInput("automerge"), "automerge");
  const review = parseReviewLevel(core.getInput("review"));
  const dryRun = parseOptionalBoolean(core.getInput("dry-run"), "dry-run") ?? false;
  const push = parseOptionalBoolean(core.getInput("push"), "push") ?? true;
  const comment = parseOptionalBoolean(core.getInput("comment"), "comment") ?? true;

  validateActionAuthentication(token, githubAppClientId, githubAppPrivateKey);
  validateProviderInputs(provider, model, baseUrl, api, apiKey);

  if (auth) {
    core.setSecret(auth);
  }

  if (apiKey) {
    core.setSecret(apiKey);
  }

  if (token) {
    core.setSecret(token);
  }

  if (githubAppPrivateKey) {
    core.setSecret(githubAppPrivateKey);
  }

  return {
    auth,
    authSecret,
    prompt,
    provider,
    model,
    baseUrl,
    api,
    apiKey,
    models,
    thinking,
    excludeTools,
    token,
    githubAppClientId,
    githubAppPrivateKey,
    automerge,
    review,
    push: push && !dryRun,
    comment: comment && !dryRun,
    dryRun,
  };
}

export function validateActionAuthentication(
  token: string | undefined,
  githubAppClientId: string | undefined,
  githubAppPrivateKey: string | undefined,
): void {
  const hasGitHubAppCredentials = Boolean(githubAppClientId || githubAppPrivateKey);

  if (token && hasGitHubAppCredentials) {
    throw new Error("provide either token or client-id/private-key, not both");
  }

  if (!token && !hasGitHubAppCredentials) {
    throw new Error("token is required unless client-id and private-key are provided");
  }

  if (hasGitHubAppCredentials && (!githubAppClientId || !githubAppPrivateKey)) {
    throw new Error("client-id and private-key must be provided together");
  }
}

export function validateProviderInputs(
  provider: string | undefined,
  model: string | undefined,
  baseUrl: string | undefined,
  api: string | undefined,
  apiKey: string | undefined,
): void {
  if (baseUrl && !model) {
    throw new Error("model is required when base-url is provided");
  }

  // pi 1.x rejects --provider without --model instead of picking a default.
  if (provider && !model) {
    throw new Error("model is required when provider is set");
  }

  if (api && !baseUrl) {
    throw new Error("api requires base-url");
  }

  if (apiKey && !baseUrl && !provider) {
    throw new Error("provider is required when api-key is provided without base-url");
  }
}

export function parseThinkingLevel(value: string): string | undefined {
  const level = parseOptionalString(value)?.toLowerCase();

  if (level && !THINKING_LEVELS.includes(level)) {
    throw new Error(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }

  return level;
}

export function parseReviewLevel(value: string): ReviewLevel | undefined {
  const level = parseOptionalString(value)?.toLowerCase();

  if (level && !REVIEW_LEVELS.includes(level as ReviewLevel)) {
    throw new Error(`review must be one of ${REVIEW_LEVELS.join(", ")}, or omitted`);
  }

  return level as ReviewLevel | undefined;
}

export function parseExcludeTools(value: string): string[] {
  const tools = value.split(/[\s,]+/).filter(Boolean);
  // The extension matches excluded tools by exact name, so a pattern such as
  // "ba*" could disable bash in pi while the extension still registered it.
  const invalid = tools.find((tool) => !/^[A-Za-z0-9_-]+$/.test(tool));

  if (invalid) {
    throw new Error(`exclude-tools must list exact tool names; "${invalid}" is not one`);
  }

  if (tools.includes(SUBMIT_RESULT_TOOL)) {
    throw new Error(`exclude-tools cannot include ${SUBMIT_RESULT_TOOL}`);
  }

  return tools;
}

export function parseOptionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function validateSecretName(value: string): string {
  const name = value.trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      "auth-secret must contain only letters, numbers, and underscores, and cannot start with a number",
    );
  }

  if (name.toUpperCase().startsWith("GITHUB_")) {
    throw new Error("auth-secret must not start with GITHUB_");
  }

  return name;
}

export function parseOptionalBoolean(value: string, name: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be true, false, or omitted`);
}

export function resolvePromptInput(input: string, workspace: string): string {
  return resolveFileInput(input, workspace);
}

export function resolveFileInput(input: string, workspace: string): string {
  const inputPath = path.resolve(workspace, input);

  if (existsSync(inputPath) && statSync(inputPath).isFile()) {
    return readFileSync(inputPath, "utf8");
  }

  return input;
}
