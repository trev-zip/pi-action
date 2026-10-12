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

  const listed = formatBody(appendReviewComments(review.body, review.comments));
  // Platforms reject comments on lines outside the diff, which moving the
  // comments into the body fixes without changing the review state. They also
  // reject approving or requesting changes on the token user's own pull
  // request, which only a comment review gets past.
  const attempts: PullRequestReview[] = [
    {
      event: review.event,
      body: formatBody(appendReviewComments(review.body, outside)),
      comments: inline,
    },
    ...(inline.length > 0 ? [{ event: review.event, body: listed, comments: [] }] : []),
    ...(review.event !== "comment"
      ? [{ event: "comment" as const, body: listed, comments: [] }]
      : []),
  ];

  for (const [index, attempt] of attempts.entries()) {
    const next = attempts[index + 1];

    try {
      await client.createPullRequestReview(attempt);
      return;
    } catch (error) {
      if (!next) {
        throw error;
      }

      core.warning(
        `Could not post pi pull request review: ${errorMessage(error)}; retrying as a ${next.event} review without inline comments`,
      );
    }
  }
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
