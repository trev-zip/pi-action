import * as github from "@actions/github";

import type { PullRequestPayload, RunContext } from "../types.ts";

export function getPullRequestNumber(): number {
  const payload = github.context.payload as PullRequestPayload;
  const issueNumber = payload.pull_request?.number ?? payload.number ?? github.context.issue.number;

  if (!issueNumber) {
    throw new Error("This action is not running for a pull request event");
  }

  return issueNumber;
}

// Pins review comments to the commit pi reviewed, even if the pull request
// moves on while the run is in progress.
export function getPullRequestHeadSha(): string | undefined {
  return (github.context.payload as PullRequestPayload).pull_request?.head?.sha || undefined;
}

export function getServerUrl(): string {
  return process.env.GITHUB_SERVER_URL || github.context.serverUrl;
}

export function isPullRequestEvent(): boolean {
  return Boolean((github.context.payload as PullRequestPayload).pull_request);
}

// The run context goes into pi's prompt, so only plain values pass. The pull
// request's head branch is left out entirely, since its author chooses it.
const SAFE_REF = /^[A-Za-z0-9._/-]{1,200}$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SAFE_SHA = /^[0-9a-f]{7,64}$/;

function matching(value: string | undefined, pattern: RegExp): string | undefined {
  return value !== undefined && pattern.test(value) ? value : undefined;
}

export function getRunContext(): RunContext {
  const pullRequest = (github.context.payload as PullRequestPayload).pull_request;

  return {
    repository: matching(process.env.GITHUB_REPOSITORY, SAFE_REPOSITORY),
    serverUrl: getServerUrl(),
    eventName: github.context.eventName,
    ref: matching(github.context.ref, SAFE_REF) ?? "",
    sha: matching(github.context.sha, SAFE_SHA) ?? "",
    pullRequest: pullRequest?.number
      ? {
          number: pullRequest.number,
          headSha: matching(pullRequest.head?.sha, SAFE_SHA),
          baseRef: matching(pullRequest.base?.ref, SAFE_REF),
        }
      : undefined,
  };
}
