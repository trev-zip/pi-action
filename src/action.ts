import * as core from "@actions/core";

import { commitChanges, configureGitUser, hasGitChanges, pushChanges } from "./git.ts";
import { readInputs, resolvePromptInput } from "./inputs.ts";
import { setupPiMcp } from "./mcp.ts";
import { loadPiAuth, persistPiAuth } from "./pi/auth.ts";
import { resolvePiExecutable } from "./pi/binary.ts";
import { createPiProviderEnv, setupPiModels, setupPiSettings } from "./pi/config.ts";
import { createPiToolEnv } from "./pi/env.ts";
import { writePiActionExtension } from "./pi/extension.ts";
import { createPiAgentDir } from "./pi/home.ts";
import { formatPiPullRequestComment } from "./pi/prompt.ts";
import { runPiPrompt } from "./pi/runner.ts";
import { setupPiSearchTools } from "./pi/search-tools.ts";
import { createPlatformClient, isPullRequestEvent } from "./platforms/index.ts";
import { getReviewEvents, postPullRequestReview, resolvePullRequestReview } from "./review.ts";

export async function run(): Promise<void> {
  const inputs = readInputs();
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const platformClient = await createPlatformClient({
    token: inputs.token,
    githubAppClientId: inputs.githubAppClientId,
    githubAppPrivateKey: inputs.githubAppPrivateKey,
  });
  const agentDir = createPiAgentDir();
  const piExecutable = await resolvePiExecutable();
  const updateAuthSecret = (value: string) =>
    platformClient.updateRepositoryAuthSecret(inputs.authSecret, value);

  try {
    loadPiAuth(inputs.auth, agentDir);

    const user = await platformClient.getActionUser();
    await configureGitUser(workspace, user);

    const pullRequestEvent = isPullRequestEvent();
    const { provider, model } = await setupPiModels(agentDir, inputs, workspace);
    if (setupPiSettings(agentDir, inputs.excludeTools)) {
      await setupPiSearchTools(agentDir);
    }
    const extensionPath = writePiActionExtension(agentDir);
    const mcp = await setupPiMcp(agentDir, platformClient);
    const prompt = resolvePromptInput(inputs.prompt, workspace);
    const metadata = await runPiPrompt({
      executable: piExecutable,
      agentDir,
      workspace,
      prompt,
      extensionPath,
      provider,
      model,
      thinking: inputs.thinking,
      excludeTools: inputs.excludeTools,
      reviewEvents: pullRequestEvent && inputs.review ? getReviewEvents(inputs.review) : [],
      env: {
        ...mcp.env,
        ...createPiToolEnv(workspace, inputs.excludeTools, {
          ...mcp.secretEnv,
          ...createPiProviderEnv(inputs.apiKey),
        }),
      },
    });

    const failure = metadata.failReason && `pi failed the run: ${metadata.failReason}`;
    // A failed run always explains itself on the pull request, even when pi
    // left no comment of its own.
    const prComment = metadata.prComment.trim() || failure;

    if (await hasGitChanges(workspace)) {
      await commitChanges(workspace, metadata.commitMessage);

      if (inputs.push) {
        await pushChanges(workspace, platformClient.type, user, platformClient.token);
      } else {
        core.info(`${skipReason(inputs.dryRun, "push")}; skipping push of pi changes`);
      }
    } else {
      core.info("pi did not leave repository changes to commit");
    }

    const review =
      pullRequestEvent && inputs.review
        ? resolvePullRequestReview(metadata, inputs.review, prComment, Boolean(failure))
        : undefined;

    // With the review input set, prComment becomes the review body, so it is
    // only posted on its own when reviews are off.
    if (pullRequestEvent && (review || prComment)) {
      const commentModel = metadata.model ?? model;

      if (!commentModel) {
        throw new Error("Could not determine the pi model for the pull request comment");
      }

      const formatBody = (body: string) => formatPiPullRequestComment(body, commentModel);

      if (!inputs.comment) {
        core.info(
          `${skipReason(inputs.dryRun, "comment")}; skipping pi pull request ${review ? "review" : "comment"}`,
        );
      } else if (review) {
        await postPullRequestReview(platformClient, review, formatBody);
      } else {
        await platformClient.postPullRequestComment(formatBody(prComment));
      }
    }

    if (pullRequestEvent && inputs.automerge !== undefined) {
      if (inputs.dryRun) {
        core.info("Dry run enabled; skipping pull request automerge update");
      } else if (failure && inputs.automerge) {
        core.info("pi failed the run; skipping enabling automerge");
      } else {
        await platformClient.setPullRequestAutomerge(inputs.automerge);
      }
    }

    if (failure) {
      throw new Error(failure);
    }
  } finally {
    await persistPiAuth(agentDir, inputs.auth, updateAuthSecret);
  }
}

function skipReason(dryRun: boolean, input: string): string {
  return dryRun ? "Dry run enabled" : `${input} is false`;
}
