export type Platform = "github" | "gitea" | "forgejo";

export type McpReleaseAsset = {
  cacheName: string;
  version: string;
  target: string;
  assetName: string;
  format: "tar" | "zip";
  executableNames: string[];
};

export type McpServerConfig = {
  name: string;
  command: string;
  tokenEnvVar: string;
  args: string[];
  env: Record<string, string>;
  // Tool names to expose to pi; every tool the server lists when omitted.
  tools?: string[];
};

export type PlatformMcp = {
  createServerConfig(executable: string, serverUrl: string): McpServerConfig;
  getReleaseAsset(nodePlatform?: NodeJS.Platform, arch?: string): McpReleaseAsset;
  getReleaseAssetUrl(nodePlatform?: NodeJS.Platform, arch?: string): string;
  getExecutableOverride(): string | undefined;
};

export type ActionInputs = {
  auth: string | undefined;
  authSecret: string;
  prompt: string;
  provider: string | undefined;
  model: string | undefined;
  baseUrl: string | undefined;
  api: string | undefined;
  apiKey: string | undefined;
  models: string | undefined;
  thinking: string | undefined;
  excludeTools: string[];
  token: string | undefined;
  githubAppClientId: string | undefined;
  githubAppPrivateKey: string | undefined;
  automerge: boolean | undefined;
  review: ReviewLevel | undefined;
  push: boolean;
  comment: boolean;
  dryRun: boolean;
};

export type ActionUser = {
  login: string;
  id: number | string;
  email: string;
};

export type PlatformClient = {
  type: Platform;
  token: string;
  mcp: PlatformMcp;
  getActionUser(): Promise<ActionUser>;
  postPullRequestComment(body: string): Promise<void>;
  listPullRequestFiles(): Promise<string[]>;
  createPullRequestReview(review: PullRequestReview): Promise<void>;
  setPullRequestAutomerge(enabled: boolean): Promise<void>;
  updateRepositoryAuthSecret(secretName: string, value: string): Promise<void>;
};

// The strongest review state pi may submit, from the review input.
export type ReviewLevel = "comment" | "request-changes" | "approve";

export type ReviewEvent = "comment" | "request_changes" | "approve";

export type ReviewComment = {
  path: string;
  line: number;
  body: string;
};

export type PullRequestReview = {
  event: ReviewEvent;
  body: string;
  comments: ReviewComment[];
};

export type PiRunMetadata = {
  commitMessage: string;
  prComment: string;
  failReason: string;
  reviewEvent: ReviewEvent | undefined;
  reviewComments: ReviewComment[];
  model: string | undefined;
};

export type PullRequestPayload = {
  number?: number;
  pull_request?: {
    number?: number;
    node_id?: string;
    head?: {
      ref?: string;
      sha?: string;
      repo?: {
        full_name?: string;
      };
    };
    base?: {
      ref?: string;
    };
  };
};

export type RunContext = {
  repository: string | undefined;
  serverUrl: string;
  eventName: string;
  ref: string;
  sha: string;
  pullRequest:
    | {
        number: number;
        headSha: string | undefined;
        baseRef: string | undefined;
      }
    | undefined;
};

export type GiteaUserResponse = {
  id?: number;
  login?: string;
  username?: string;
  name?: string;
  email?: string;
  full_name?: string;
};
