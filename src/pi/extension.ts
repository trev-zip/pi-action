import { writeFileSync } from "node:fs";
import path from "node:path";

export const SUBMIT_RESULT_TOOL = "submit_result";
export const MCP_CONFIG_ENV = "PI_ACTION_MCP_CONFIG";
export const SECRET_ENV_ENV = "PI_ACTION_SECRET_ENV";
export const FILE_ROOT_ENV = "PI_ACTION_FILE_ROOT";
export const EXCLUDE_TOOLS_ENV = "PI_ACTION_EXCLUDE_TOOLS";
export const REVIEW_EVENTS_ENV = "PI_ACTION_REVIEW_EVENTS";
export const MCP_PROTOCOL_VERSION = "2025-06-18";

// pi has no structured output mode, so the action registers a tool that the
// agent calls with its commit message and comment once it is done. Released
// pi versions also have no MCP support, so the extension bridges the tools of
// the platform MCP server into pi over stdio. The extension also keeps secrets
// out of pi's shell commands and confines file tools to the workspace when no
// shell tool is active.
export const PI_ACTION_EXTENSION = `import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MCP_CONFIG_ENV = "${MCP_CONFIG_ENV}";
const SECRET_ENV_ENV = "${SECRET_ENV_ENV}";
const FILE_ROOT_ENV = "${FILE_ROOT_ENV}";
const EXCLUDE_TOOLS_ENV = "${EXCLUDE_TOOLS_ENV}";
const REVIEW_EVENTS_ENV = "${REVIEW_EVENTS_ENV}";
const FILE_TOOLS = ["read", "grep", "find", "ls", "edit", "write"];
const SHELL_TOOLS = ["bash", "powershell"];
const MCP_PROTOCOL_VERSION = "${MCP_PROTOCOL_VERSION}";
const MCP_REQUEST_TIMEOUT_MS = 60000;
const MCP_RESULT_MAX_CHARS = 100000;

export default function (pi) {
  // The review fields only exist when the run submits a pull request review,
  // and only offer the review states the review input allows.
  const reviewEvents = (process.env[REVIEW_EVENTS_ENV] ?? "").split(",").filter(Boolean);
  const reviewParameters =
    reviewEvents.length > 0
      ? {
          review_event: Type.Union(
            reviewEvents.map((event) => Type.Literal(event)),
            { description: "State of the pull request review that pr_comment is posted as." },
          ),
          review_comments: Type.Array(
            Type.Object({
              path: Type.String({
                description: "Path of a file changed by the pull request, relative to the repository root.",
              }),
              line: Type.Integer({
                minimum: 1,
                description: "Line number in the pull request's version of the file.",
              }),
              body: Type.String({ description: "Review comment for this line in Markdown." }),
            }),
            {
              description:
                "Inline review comments on lines the pull request adds or changes, or an empty array.",
            },
          ),
        }
      : {};

  pi.registerTool({
    name: "${SUBMIT_RESULT_TOOL}",
    label: "Submit result",
    description:
      "Submit the final result of this run. Call this exactly once, after all repository changes are made.",
    promptSnippet: "Submit the commit message and pull request comment when finished",
    promptGuidelines: [
      "Call ${SUBMIT_RESULT_TOOL} exactly once as your final action; the run ends when it is called.",
    ],
    parameters: Type.Object({
      commit_message: Type.String({
        description:
          "Concise imperative git commit message, or an empty string when no changes were made.",
      }),
      pr_comment: Type.String({
        description:
          "Pull request comment body in Markdown, or an empty string when no comment should be posted.",
      }),
      fail_reason: Type.String({
        description:
          "Short reason to fail the workflow run when the task asks for it, or an empty string otherwise.",
      }),
      ...reviewParameters,
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "Result submitted." }],
        details: params,
        terminate: true,
      };
    },
  });

  // Secrets stay in pi's environment for model requests and the MCP server,
  // but not in the environment of the commands pi runs. pi also drops excluded
  // tools, but skipping the registration does not rely on that.
  const secretEnv = [SECRET_ENV_ENV, ...(process.env[SECRET_ENV_ENV] ?? "").split(",")];
  const excludedTools = (process.env[EXCLUDE_TOOLS_ENV] ?? "").split(",");

  if (!excludedTools.includes("bash")) {
    pi.registerTool(
      createBashToolDefinition(process.cwd(), {
        spawnHook: (context) => {
          const env = { ...context.env };

          for (const name of secretEnv) {
            delete env[name];
          }

          return { ...context, env };
        },
      }),
    );
  }

  const fileRoot = process.env[FILE_ROOT_ENV];

  if (fileRoot) {
    const root = realpathSync(fileRoot);

    // A shell can read any file, so confinement only matters without one.
    pi.on("tool_call", (event) => {
      const shellActive = pi.getActiveTools().some((name) => SHELL_TOOLS.includes(name));

      if (shellActive || !FILE_TOOLS.includes(event.toolName)) {
        return undefined;
      }

      const input = typeof event.input?.path === "string" ? event.input.path : ".";
      const target = resolveRealPath(resolveToolPath(input));

      if (target === root || target.startsWith(root + path.sep)) {
        return undefined;
      }

      return { block: true, reason: "Path is outside the workspace: " + input };
    });
  }

  let client;

  pi.on("session_start", async () => {
    const configPath = process.env[MCP_CONFIG_ENV];

    if (!configPath || client) {
      return;
    }

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    client = new McpClient(config);

    try {
      await client.initialize();
      const listedTools = await client.listTools();
      const tools = config.tools
        ? listedTools.filter((tool) => config.tools.includes(tool.name))
        : listedTools;

      for (const tool of tools) {
        pi.registerTool(createMcpTool(client, config.name, tool));
      }

      console.error("Connected to " + config.name + " MCP server with " + tools.length + " tools");
    } catch (error) {
      console.error("Could not start " + config.name + " MCP server: " + errorMessage(error));
      client.close();
    }
  });

  pi.on("session_shutdown", () => {
    client?.close();
  });
}

// Mirrors how pi resolves file tool paths, so the workspace check sees the
// same file the tool would open.
function resolveToolPath(input) {
  let value = input.replace(/[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]/g, " ");

  if (value.startsWith("@")) {
    value = value.slice(1);
  }

  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }

  if (value.startsWith("file://")) {
    return fileURLToPath(value);
  }

  return path.resolve(process.cwd(), value);
}

// Resolves symlinks in the longest existing prefix of the path.
function resolveRealPath(target) {
  try {
    return realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target ? target : path.join(resolveRealPath(parent), path.basename(target));
  }
}

function createMcpTool(client, server, tool) {
  const schema = tool.inputSchema ?? {};

  return {
    name: (server + "_" + tool.name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
    label: server + "/" + tool.name,
    description: tool.description || tool.title || tool.name,
    // pi validates plain JSON schemas as well as TypeBox schemas.
    parameters: {
      ...schema,
      type: schema.type ?? "object",
      properties: schema.properties ?? {},
    },
    async execute(_toolCallId, params, signal) {
      const result = await client.request(
        "tools/call",
        { name: tool.name, arguments: params ?? {} },
        signal,
      );
      const content = toPiContent(result);

      if (result.isError) {
        throw new Error(content.map((part) => part.text ?? "").join("\\n") || "MCP tool failed");
      }

      return { content, details: undefined };
    },
  };
}

function toPiContent(result) {
  const content = [];
  let remaining = MCP_RESULT_MAX_CHARS;

  const pushText = (text) => {
    if (remaining <= 0) {
      return;
    }

    const truncated = text.length > remaining;
    content.push({
      type: "text",
      text: truncated ? text.slice(0, remaining) + "\\n[output truncated]" : text,
    });
    remaining -= text.length;
  };

  for (const part of result.content ?? []) {
    if (part.type === "text") {
      pushText(part.text);
    } else if (part.type === "image") {
      content.push({ type: "image", data: part.data, mimeType: part.mimeType });
    } else if (part.type === "resource" && typeof part.resource?.text === "string") {
      pushText(part.resource.text);
    } else {
      pushText(JSON.stringify(part));
    }
  }

  if (content.length === 0 && result.structuredContent !== undefined) {
    pushText(JSON.stringify(result.structuredContent));
  }

  return content;
}

class McpClient {
  constructor(config) {
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.child = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\\n");

      while (newline !== -1) {
        this.handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\\n");
      }
    });

    // Keep only the end of stderr so startup failures can explain themselves.
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });

    this.child.stdin.on("error", () => {});
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code) => {
      const detail = this.stderr.trim();
      this.rejectAll(
        new Error("MCP server exited with code " + code + (detail ? ": " + detail : "")),
      );
    });
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "pi-action", version: "1.0.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools() {
    const tools = [];
    let cursor;

    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return tools;
  }

  request(method, params, signal) {
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        callback(value);
      };
      const onAbort = () => {
        this.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "aborted" },
        });
        finish(reject, new Error("MCP request " + method + " was aborted"));
      };
      const timeout = setTimeout(
        () => finish(reject, new Error("MCP request " + method + " timed out")),
        MCP_REQUEST_TIMEOUT_MS,
      );

      if (signal?.aborted) {
        onAbort();
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  handleLine(line) {
    let message;

    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.method !== undefined) {
      // The client declares no capabilities, so the server can only ping it.
      if (message.id !== undefined) {
        this.send(
          message.method === "ping"
            ? { jsonrpc: "2.0", id: message.id, result: {} }
            : {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "Method not found" },
              },
        );
      }

      return;
    }

    const pending = this.pending.get(message.id);

    if (!pending) {
      return;
    }

    if (message.error) {
      pending.reject(new Error(message.error.message ?? "MCP request failed"));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  send(message) {
    if (this.child.stdin.writable) {
      this.child.stdin.write(JSON.stringify(message) + "\\n");
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
`;

export function writePiActionExtension(agentDir: string): string {
  const extensionPath = path.join(agentDir, "pi-action-extension.ts");
  writeFileSync(extensionPath, PI_ACTION_EXTENSION, { mode: 0o600 });
  return extensionPath;
}
