import * as core from "@actions/core";

import type {
  PiRunMetadata,
  PlatformClient,
  PullRequestReview,
  ReviewComment,
  ReviewEvent,
  ReviewLevel,
} from "./types.ts";
import { errorMessage } from "./utils.ts";

const REVIEW_LEVEL_EVENTS: Record<ReviewLevel, ReviewEvent[]> = {
  comment: ["comment"],
  "request-changes": ["comment", "request_changes"],
  approve: ["comment", "request_changes", "approve"],
};

export function getReviewEvents(level: ReviewLevel): ReviewEvent[] {
  return REVIEW_LEVEL_EVENTS[level];
}

// Builds the review pi submitted, or undefined when there is nothing to post.
// pi only sees the review states the review input allows, but the action
// checks again rather than trusting the tool arguments.
export function resolvePullRequestReview(
  metadata: Pick<PiRunMetadata, "reviewEvent" | "reviewComments">,
  level: ReviewLevel,
  body: string,
  failed: boolean,
): PullRequestReview | undefined {
  let event = metadata.reviewEvent ?? "comment";

  if (!getReviewEvents(level).includes(event)) {
    core.info(`review input does not allow ${event} reviews; posting a comment review instead`);
    event = "comment";
  }

  if (failed && event === "approve") {
    core.info("pi failed the run; posting a comment review instead of an approval");
    event = "comment";
  }

  const review = { event, body: body.trim(), comments: metadata.reviewComments };

  if (review.event === "comment" && !review.body && review.comments.length === 0) {
    return undefined;
  }

  return review;
}

export async function postPullRequestReview(
  client: PlatformClient,
  review: PullRequestReview,
  formatBody: (body: string) => string,
): Promise<void> {
  const files = await listPullRequestFiles(client);
  const inline = files
    ? review.comments.filter((comment) => files.has(comment.path))
    : review.comments;
  const outside = review.comments.filter((comment) => !inline.includes(comment));

  if (outside.length > 0) {
    core.info(
      `Moving ${outside.length} review comment(s) on files the pull request does not change into the review body`,
    );
  }

  try {
    await client.createPullRequestReview({
      event: review.event,
      body: formatBody(appendReviewComments(review.body, outside)),
      comments: inline,
    });
    return;
  } catch (error) {
    // Platforms reject comments on lines outside the diff, and reviews that
    // approve or request changes on the token user's own pull request.
    core.warning(
      `Could not post pi pull request review: ${errorMessage(error)}; retrying as a comment review without inline comments`,
    );
  }

  await client.createPullRequestReview({
    event: "comment",
    body: formatBody(appendReviewComments(review.body, review.comments)),
    comments: [],
  });
}

async function listPullRequestFiles(client: PlatformClient): Promise<Set<string> | undefined> {
  try {
    return new Set(await client.listPullRequestFiles());
  } catch (error) {
    core.warning(`Could not list pull request files: ${errorMessage(error)}`);
    return undefined;
  }
}

export function appendReviewComments(body: string, comments: ReviewComment[]): string {
  if (comments.length === 0) {
    return body;
  }

  const list = comments
    .map(
      (comment) =>
        `- \`${comment.path}:${comment.line}\`: ${comment.body.replaceAll("\n", "\n  ")}`,
    )
    .join("\n");

  return body ? `${body}\n\n${list}` : list;
}
