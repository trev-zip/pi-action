import { createSign } from "node:crypto";

import * as core from "@actions/core";
import * as github from "@actions/github";
import sodium from "libsodium-wrappers";

import type {
  ActionUser,
  McpReleaseAsset,
  PlatformClient,
  PlatformMcp,
  PullRequestPayload,
} from "../types.ts";
import { errorMessage } from "../utils.ts";
import { getPullRequestNumber } from "./context.ts";

export const GITHUB_APP_INSTALLATION_PERMISSIONS = {
  actions: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
  secrets: "write",
} as const;

const GITHUB_MCP_VERSION = "1.14.0";
const GITHUB_MCP_TOOLSETS = "repos,issues,pull_requests,actions";

type GitHubAppInstallationAuthentication = {
  token: string;
  appSlug: string;
};

export const githubMcp: PlatformMcp = {
  createServerConfig(executable, serverUrl) {
    return {
      name: "github",
      command: executable,
      tokenEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
      args: ["stdio"],
      env: {
        GITHUB_HOST: serverUrl,
        GITHUB_TOOLSETS: GITHUB_MCP_TOOLSETS,
        GITHUB_READ_ONLY: "1",
      },
    };
  },

  getReleaseAsset: getGitHubMcpReleaseAsset,

  getReleaseAssetUrl(nodePlatform = process.platform, arch = process.arch) {
    const asset = getGitHubMcpReleaseAsset(nodePlatform, arch);
    return `https://github.com/github/github-mcp-server/releases/download/v${asset.version}/${asset.assetName}`;
  },

  getExecutableOverride() {
    return process.env.GITHUB_MCP_SERVER_PATH;
  },
};

export class GitHubPlatformClient implements PlatformClient {
  readonly type = "github";
  readonly mcp = githubMcp;
  readonly token: string;
  private readonly appSlug: string | undefined;
  private readonly octokit: ReturnType<typeof github.getOctokit>;

  constructor(token: string, appSlug?: string) {
    this.token = token;
    this.appSlug = appSlug;
    this.octokit = github.getOctokit(token);
  }

  async getActionUser(): Promise<ActionUser> {
    if (this.appSlug) {
      return this.getGitHubAppBotUser(this.appSlug);
    }

    try {
      const { data } = await this.octokit.rest.users.getAuthenticated();

      return {
        login: data.login,
        id: data.id,
        email: data.email ?? `${data.id}+${data.login}@users.noreply.github.com`,
      };
    } catch (error) {
      if (!isGitHubAppInstallationUserError(error)) {
        throw error;
      }

      core.info("GitHub installation token cannot read /user; using github-actions[bot]");
      return getGitHubActionsBotUser();
    }
  }

  private async getGitHubAppBotUser(appSlug: string): Promise<ActionUser> {
    const { data } = await this.octokit.rest.users.getByUsername({
      username: getGitHubAppBotLogin(appSlug),
    });

    return {
      login: data.login,
      id: data.id,
      email: buildGitHubNoreplyEmail(data.id, data.login),
    };
  }

  async postPullRequestComment(body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: getPullRequestNumber(),
      body,
    });

    core.info("Posted pi pull request comment");
  }

  async setPullRequestAutomerge(enabled: boolean): Promise<void> {
    const pullRequestId = await this.getPullRequestNodeId();

    if (enabled) {
      await this.octokit.graphql(
        `mutation($pullRequestId: ID!) {
          enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId}) {
            pullRequest { id }
          }
        }`,
        { pullRequestId },
      );
      core.info("Enabled GitHub pull request automerge");
      return;
    }

    try {
      await this.octokit.graphql(
        `mutation($pullRequestId: ID!) {
          disablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId}) {
            pullRequest { id }
          }
        }`,
        { pullRequestId },
      );
      core.info("Disabled GitHub pull request automerge");
    } catch (error) {
      core.warning(`Could not disable GitHub pull request automerge: ${errorMessage(error)}`);
    }
  }

  async updateRepositoryAuthSecret(secretName: string, value: string): Promise<void> {
    const publicKey = await this.octokit.rest.actions.getRepoPublicKey(github.context.repo);
    const encryptedValue = await encryptGithubSecret(value, publicKey.data.key);

    await this.octokit.rest.actions.createOrUpdateRepoSecret({
      ...github.context.repo,
      secret_name: secretName,
      encrypted_value: encryptedValue,
      key_id: publicKey.data.key_id,
    });
  }

  private async getPullRequestNodeId(): Promise<string> {
    const payload = github.context.payload as PullRequestPayload;

    if (payload.pull_request?.node_id) {
      return payload.pull_request.node_id;
    }

    const { data } = await this.octokit.rest.pulls.get({
      ...github.context.repo,
      pull_number: getPullRequestNumber(),
    });

    return data.node_id;
  }
}

export function getGitHubActionsBotUser(): ActionUser {
  const login = "github-actions[bot]";
  const id = 41898282;

  return {
    login,
    id,
    email: buildGitHubNoreplyEmail(id, login),
  };
}

export function getGitHubAppBotLogin(appSlug: string): string {
  return `${appSlug}[bot]`;
}

export function buildGitHubNoreplyEmail(id: number | string, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

export function createGitHubAppJwt(
  clientId: string,
  privateKey: string,
  nowMs = Date.now(),
): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: clientId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(normalizePrivateKey(privateKey), "base64url");

  return `${signingInput}.${signature}`;
}

export function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n");
}

export function isGitHubAppInstallationUserError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  const message = (error as { message?: unknown }).message;

  return (
    status === 403 &&
    typeof message === "string" &&
    message.includes("Resource not accessible by integration")
  );
}

export async function createGitHubAppInstallationAuthentication(
  clientId: string,
  privateKey: string,
): Promise<GitHubAppInstallationAuthentication> {
  core.setSecret(normalizePrivateKey(privateKey));
  const jwt = createGitHubAppJwt(clientId, privateKey);
  core.setSecret(jwt);

  const appOctokit = github.getOctokit(jwt);
  const [{ data: app }, { data: installation }] = await Promise.all([
    appOctokit.rest.apps.getAuthenticated(),
    appOctokit.rest.apps.getRepoInstallation(github.context.repo),
  ]);

  if (!app?.slug) {
    throw new Error("GitHub App response did not include a slug");
  }
  const appSlug = app.slug;

  const { data: installationAccessToken } =
    await appOctokit.rest.apps.createInstallationAccessToken({
      installation_id: installation.id,
      repositories: [github.context.repo.repo],
      permissions: GITHUB_APP_INSTALLATION_PERMISSIONS,
    });

  core.setSecret(installationAccessToken.token);
  core.info(`Created GitHub App installation token for ${appSlug}`);

  return {
    token: installationAccessToken.token,
    appSlug,
  };
}

function getGitHubMcpReleaseAsset(
  nodePlatform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): McpReleaseAsset {
  const os = getGitHubMcpOs(nodePlatform);
  const releaseArch = getGitHubMcpArch(arch);

  if (!os || !releaseArch) {
    throw new Error(`Unsupported GitHub MCP platform: ${nodePlatform} (${arch})`);
  }

  const format = nodePlatform === "win32" ? "zip" : "tar";
  const extension = format === "zip" ? "zip" : "tar.gz";

  return {
    cacheName: "github-mcp-server",
    version: GITHUB_MCP_VERSION,
    target: `${os}-${releaseArch}`,
    assetName: `github-mcp-server_${os}_${releaseArch}.${extension}`,
    format,
    executableNames: nodePlatform === "win32" ? ["github-mcp-server.exe"] : ["github-mcp-server"],
  };
}

function getGitHubMcpOs(platform: NodeJS.Platform): string | null {
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

function getGitHubMcpArch(arch: string): string | null {
  if (arch === "x64") {
    return "x86_64";
  }

  if (arch === "arm64") {
    return "arm64";
  }

  return null;
}

async function encryptGithubSecret(value: string, publicKey: string): Promise<string> {
  await sodium.ready;
  const binaryPublicKey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const encryptedBytes = sodium.crypto_box_seal(value, binaryPublicKey);
  return sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
