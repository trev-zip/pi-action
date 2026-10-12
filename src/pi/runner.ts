import { spawn } from "node:child_process";

import type { PiRunMetadata, ReviewComment, ReviewEvent } from "../types.ts";
import { DEFAULT_CUSTOM_PROVIDER } from "./config.ts";
import { createPiEnv } from "./env.ts";
import { REVIEW_EVENTS_ENV, SUBMIT_RESULT_TOOL } from "./extension.ts";
import { formatInlineLogText, logPiBlock, logPiLine, logPiText } from "./logging.ts";
import { buildPrompt } from "./prompt.ts";

export type PiRunOptions = {
  executable: string;
  agentDir: string;
  workspace: string;
  prompt: string;
  extensionPath: string;
  provider: string | undefined;
  model: string | undefined;
  thinking: string | undefined;
  excludeTools?: string[];
  // Review states pi may submit; pi submits no review when empty.
  reviewEvents?: ReviewEvent[];
  env?: Record<string, string>;
};

type PiAssistantMessage = {
  role: "assistant";
  provider?: string;
  model?: string;
  responseModel?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
};

type PiEvent = {
  type?: string;
  [key: string]: unknown;
};

export type PiStreamState = {
  lastAssistant: PiAssistantMessage | undefined;
  result: Omit<PiRunMetadata, "model"> | undefined;
};

const REVIEW_EVENTS: ReviewEvent[] = ["comment", "request_changes", "approve"];

export function createPiStreamState(): PiStreamState {
  return { lastAssistant: undefined, result: undefined };
}

export async function runPiPrompt(options: PiRunOptions): Promise<PiRunMetadata> {
  const reviewEvents = options.reviewEvents ?? [];
  const piPrompt = buildPrompt(options.prompt, undefined, reviewEvents);
  logPiText("pi prompt", piPrompt);

  const state = createPiStreamState();
  const env = { ...options.env, [REVIEW_EVENTS_ENV]: reviewEvents.join(",") };
  const exitCode = await spawnPi(buildPiArgs(options), { ...options, env }, piPrompt, (line) =>
    handlePiOutputLine(line, state),
  );

  return getPiRunMetadata(state, exitCode);
}

export function buildPiArgs(
  options: Pick<PiRunOptions, "extensionPath" | "provider" | "model" | "thinking" | "excludeTools">,
): string[] {
  const args = [
    "--mode",
    "json",
    "--no-session",
    // Ignore project-local .pi settings and discovered extensions so the
    // repository under test cannot change how the action runs pi. The action's
    // extension provides the result tool and platform MCP tools.
    "-na",
    "-ne",
    "-e",
    options.extensionPath,
  ];

  if (options.provider) {
    args.push("--provider", options.provider);
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.thinking) {
    args.push("--thinking", options.thinking);
  }

  if (options.excludeTools?.length) {
    args.push("--exclude-tools", options.excludeTools.join(","));
  }

  return args;
}

export function handlePiOutputLine(line: string, state: PiStreamState): void {
  if (!line.trim()) {
    return;
  }

  let event: PiEvent;

  try {
    event = JSON.parse(line) as PiEvent;
  } catch {
    logPiLine("stderr", line);
    return;
  }

  handlePiEvent(event, state);
}

export function handlePiEvent(event: PiEvent, state: PiStreamState): void {
  switch (event.type) {
    case "agent_start":
      logPiLine("agent", "started");
      break;
    case "agent_end":
      logPiLine("agent", "completed");
      break;
    case "message_update":
      logPiAssistantMessageEvent(event.assistantMessageEvent);
      break;
    case "message_end":
      if (isAssistantMessage(event.message)) {
        state.lastAssistant = event.message;
      }
      break;
    case "turn_end":
      if (isAssistantMessage(event.message)) {
        logPiLine("turn", `completed; ${formatPiUsage(event.message)}`);
      }
      break;
    case "tool_execution_start":
      logPiToolStart(asString(event.toolName), asRecord(event.args));
      break;
    case "tool_execution_end":
      handlePiToolEnd(event, state);
      break;
    case "auto_retry_start":
      logPiLine(
        "retry",
        `attempt ${String(event.attempt)}/${String(event.maxAttempts)} in ${String(event.delayMs)}ms: ${asString(event.errorMessage)}`,
      );
      break;
    case "compaction_start":
      logPiLine("compaction", "started");
      break;
    case "compaction_end":
      logPiLine("compaction", "completed");
      break;
  }
}

export function getPiRunMetadata(state: PiStreamState, exitCode: number): PiRunMetadata {
  const assistant = state.lastAssistant;

  if (assistant?.stopReason === "error" || assistant?.stopReason === "aborted") {
    throw new Error(`pi run failed: ${assistant.errorMessage ?? assistant.stopReason}`);
  }

  if (exitCode !== 0) {
    throw new Error(`pi exited with code ${exitCode}`);
  }

  if (!assistant) {
    throw new Error("pi did not produce a response");
  }

  // The default provider name for base-url models says nothing about the model, so leave it out.
  const model = assistant.model
    ? assistant.provider && assistant.provider !== DEFAULT_CUSTOM_PROVIDER
      ? `${assistant.provider}/${assistant.model}`
      : assistant.model
    : undefined;

  if (!state.result) {
    throw new Error(`pi finished without calling ${SUBMIT_RESULT_TOOL}`);
  }

  return { ...state.result, model };
}

function handlePiToolEnd(event: PiEvent, state: PiStreamState): void {
  const toolName = asString(event.toolName);
  const result = asRecord(event.result);
  const output = formatToolResultText(result.content);

  // Agents recover from most tool failures (such as reading a file that does
  // not exist yet), so these are logged as warnings rather than run errors.
  if (event.isError === true) {
    logPiBlock("tool-error", `${toolName} failed${output ? `: ${output}` : ""}`);
    return;
  }

  if (toolName === "bash") {
    logPiBlock("command-output", output);
  } else if (toolName === SUBMIT_RESULT_TOOL) {
    const details = asRecord(result.details);
    state.result = {
      commitMessage: asString(details.commit_message).trim(),
      prComment: asString(details.pr_comment).trim(),
      failReason: asString(details.fail_reason).trim(),
      reviewEvent: parseReviewEvent(details.review_event),
      reviewComments: parseReviewComments(details.review_comments),
    };
    logPiLine("agent", "submitted result");
  }
}

function parseReviewEvent(value: unknown): ReviewEvent | undefined {
  return REVIEW_EVENTS.find((event) => event === value);
}

// pi validates tool arguments against the schema, so this only drops comments
// that could not be posted anyway.
function parseReviewComments(value: unknown): ReviewComment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const comment = asRecord(item);
    const filePath = asString(comment.path).trim().replace(/^\.\//, "");
    const body = asString(comment.body).trim();
    const line = comment.line;

    return filePath && body && Number.isInteger(line) && (line as number) > 0
      ? [{ path: filePath, line: line as number, body }]
      : [];
  });
}

function logPiAssistantMessageEvent(value: unknown): void {
  const assistantEvent = asRecord(value);

  if (assistantEvent.type === "text_end") {
    logPiBlock("message", asString(assistantEvent.content));
  } else if (assistantEvent.type === "thinking_end") {
    logPiBlock("reasoning", asString(assistantEvent.content));
  }
}

function logPiToolStart(toolName: string, args: Record<string, unknown>): void {
  switch (toolName) {
    case "bash":
      logPiBlock("command", asString(args.command));
      break;
    case "edit":
    case "write":
      logPiLine("file", `${toolName} ${asString(args.path)}`);
      break;
    case SUBMIT_RESULT_TOOL:
      break;
    default:
      logPiLine("tool", `${toolName} ${formatInlineLogText(JSON.stringify(args))}`);
  }
}

function formatPiUsage(message: PiAssistantMessage): string {
  const usage = message.usage ?? {};
  const parts = [
    `${usage.input ?? 0} input`,
    `${usage.cacheRead ?? 0} cached input`,
    `${usage.output ?? 0} output`,
  ];

  if (usage.cost?.total) {
    parts.push(`$${usage.cost.total.toFixed(4)}`);
  }

  return parts.join(", ");
}

function formatToolResultText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => asRecord(part))
    .filter((part) => part.type === "text")
    .map((part) => asString(part.text))
    .join("\n");
}

function isAssistantMessage(value: unknown): value is PiAssistantMessage {
  return asRecord(value).role === "assistant";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function spawnPi(
  args: string[],
  options: PiRunOptions,
  prompt: string,
  onLine: (line: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, args, {
      cwd: options.workspace,
      env: createPiEnv(options.agentDir, options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    forEachLine(child.stdout, onLine);
    forEachLine(child.stderr, (line) => logPiLine("stderr", line));

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`pi was terminated by ${signal}`));
      } else {
        resolve(code ?? 1);
      }
    });

    // pi reads its initial message from stdin when stdin is not a TTY, which
    // avoids misparsing prompts that start with "-" or "@" as arguments.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

function forEachLine(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");

    while (newline !== -1) {
      onLine(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer) {
      onLine(buffer);
    }
  });
}
