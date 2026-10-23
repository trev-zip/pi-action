import * as core from "@actions/core";
import * as github from "@actions/github";

import type {
  ActionUser,
  GiteaCommentResponse,
  GiteaReviewCommentResponse,
  GiteaReviewResponse,
  GiteaUserResponse,
  McpReleaseAsset,
  PlatformClient,
  PlatformMcp,
  PullRequestNote,
  PullRequestReview,
  SubmittedReview,
} from "../types.ts";
import { errorMessage } from "../utils.ts";
import { getPullRequestHeadSha, getPullRequestNumber, getServerUrl } from "./context.ts";
import { parseGiteaComment, parseGiteaReview, parseGiteaReviewComment } from "./reviews.ts";

const GITEA_MCP_VERSION = "1.11.0";

// Read-only mode already drops write tools; the allowlist also drops unrelated
// read tools (packages, notifications, users, wikis) to keep requests small.
const GITEA_MCP_TOOLS = [
  "get_file_contents",
  "get_dir_contents",
  "get_repository_tree",
  "get_commit",
  "list_commits",
  "list_branches",
  "list_releases",
  "get_latest_release",
  "issue_read",
  "list_issues",
  "search_issues",
  "label_read",
  "milestone_read",
  "pull_request_read",
  "list_pull_requests",
  "actions_run_read",
];

const MAX_PAGES = 100;

const REVIEW_EVENTS = {
  comment: "COMMENT",
  request_changes: "REQUEST_CHANGES",
  approve: "APPROVED",
} as const;

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const giteaMcp: PlatformMcp = {
  createServerConfig(executable, serverUrl) {
    return {
      name: "gitea",
      command: executable,
      tokenEnvVar: "GITEA_ACCESS_TOKEN",
      args: ["-t", "stdio", "--host", serverUrl],
      env: {
        GITEA_READONLY: "true",
        GITEA_TOOLS: GITEA_MCP_TOOLS.join(","),
      },
    };
  },

  getReleaseAsset: getGiteaMcpReleaseAsset,

  getReleaseAssetUrl(nodePlatform = process.platform, arch = process.arch) {
    const asset = getGiteaMcpReleaseAsset(nodePlatform, arch);
    return `https://gitea.com/gitea/gitea-mcp/releases/download/v${asset.version}/${asset.assetName}`;
  },

  getExecutableOverride() {
    return process.env.GITEA_MCP_PATH;
  },
};

export class GiteaPlatformClient implements PlatformClient {
  readonly type = "gitea";
  readonly mcp = giteaMcp;
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async getActionUser(): Promise<ActionUser> {
    const response = await giteaRequest<GiteaUserResponse>("GET", "/user", this.token);
    const login = response.login ?? response.username ?? response.name;

    if (!login) {
      throw new Error("gitea user response did not include a login");
    }

    const id = response.id ?? login;
    const host = new URL(getServerUrl()).hostname;

    return {
      login,
      id,
      email: response.email || `${id}+${login}@users.noreply.${host}`,
    };
  }

  async postPullRequestComment(body: string): Promise<void> {
    const { owner, repo } = github.context.repo;
    await giteaRequest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${getPullRequestNumber()}/comments`,
      this.token,
      { body },
    );

    core.info("Posted pi pull request comment");
  }

  async listPullRequestFiles(): Promise<string[]> {
    const files = await giteaPages<{ filename?: string }>(
      `${pullRequestRoute()}/files`,
      this.token,
    );
    return files.flatMap((file) => (file.filename ? [file.filename] : []));
  }

  async createPullRequestReview(review: PullRequestReview): Promise<void> {
    const { owner, repo } = github.context.repo;
    await giteaRequest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${getPullRequestNumber()}/reviews`,
      this.token,
      {
        event: REVIEW_EVENTS[review.event],
        body: review.body,
        commit_id: getPullRequestHeadSha(),
        // new_position is the line number in the new version of the file.
        comments: review.comments.map((comment) => ({
          path: comment.path,
          body: comment.body,
          new_position: comment.line,
        })),
      },
    );

    core.info("Posted pi pull request review");
  }

  async listPullRequestReviews(): Promise<SubmittedReview[]> {
    const reviews = await giteaPages<GiteaReviewResponse>(
      `${pullRequestRoute()}/reviews`,
      this.token,
    );
    return reviews.flatMap(parseGiteaReview);
  }

  async listPullRequestReviewComments(reviewId: number): Promise<PullRequestNote[]> {
    const comments = await giteaRequest<GiteaReviewCommentResponse[]>(
      "GET",
      `${pullRequestRoute()}/reviews/${reviewId}/comments`,
      this.token,
    );
    return comments.flatMap(parseGiteaReviewComment);
  }

  async listPullRequestComments(since: string): Promise<PullRequestNote[]> {
    const { owner, repo } = github.context.repo;
    const comments = await giteaPages<GiteaCommentResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${getPullRequestNumber()}/comments?since=${encodeURIComponent(since)}`,
      this.token,
    );
    return comments.flatMap(parseGiteaComment);
  }

  async setPullRequestAutomerge(enabled: boolean): Promise<void> {
    const { owner, repo } = github.context.repo;
    const route = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${getPullRequestNumber()}/merge`;

    try {
      if (enabled) {
        await giteaRequest("POST", route, this.token, {
          Do: "merge",
          merge_when_checks_succeed: true,
        });
        core.info("Enabled gitea pull request automerge");
        return;
      }

      await giteaRequest("DELETE", route, this.token);
      core.info("Disabled gitea pull request automerge");
    } catch (error) {
      const suffix = error instanceof HttpError ? `HTTP ${error.status}` : errorMessage(error);
      core.warning(
        `Could not ${enabled ? "enable" : "disable"} gitea pull request automerge: ${suffix}`,
      );
    }
  }

  async updateRepositoryAuthSecret(secretName: string, value: string): Promise<void> {
    const { owner, repo } = github.context.repo;
    await giteaRequest(
      "PUT",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets/${encodeURIComponent(secretName)}`,
      this.token,
      { data: value },
    );
  }
}

function getGiteaMcpReleaseAsset(
  nodePlatform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): McpReleaseAsset {
  const os = getGiteaMcpOs(nodePlatform);
  const releaseArch = getGiteaMcpArch(arch);

  if (!os || !releaseArch) {
    throw new Error(`Unsupported Gitea MCP platform: ${nodePlatform} (${arch})`);
  }

  const format = nodePlatform === "win32" ? "zip" : "tar";
  const extension = format === "zip" ? "zip" : "tar.gz";

  return {
    cacheName: "gitea-mcp",
    version: GITEA_MCP_VERSION,
    target: `${os}-${releaseArch}`,
    assetName: `gitea-mcp_${os}_${releaseArch}.${extension}`,
    format,
    executableNames: nodePlatform === "win32" ? ["gitea-mcp.exe"] : ["gitea-mcp"],
  };
}

function getGiteaMcpOs(platform: NodeJS.Platform): string | null {
  if (platform === "linux") {
    return "Linux";
  }

  if (platform === "darwin") {
    return "Darwin";
  }

  if (platform === "win32") {
    return "Windows";
  }

  return null;
}

function getGiteaMcpArch(arch: string): string | null {
  if (arch === "x64") {
    return "x86_64";
  }

  if (arch === "arm64") {
    return "arm64";
  }

  return null;
}

function pullRequestRoute(): string {
  const { owner, repo } = github.context.repo;
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${getPullRequestNumber()}`;
}

// The server caps the page size, so read pages until one comes back empty.
async function giteaPages<T>(route: string, token: string): Promise<T[]> {
  const items: T[] = [];
  const separator = route.includes("?") ? "&" : "?";

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await giteaRequest<T[]>(
      "GET",
      `${route}${separator}page=${page}&limit=50`,
      token,
    );

    if (response.length === 0) {
      break;
    }

    items.push(...response);
  }

  return items;
}

async function giteaRequest<T = unknown>(
  method: string,
  route: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(`api/v1${route}`, ensureTrailingSlash(getServerUrl()));
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      authorization: `token ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new HttpError(response.status, text || response.statusText);
  }

  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
