import { getRunContext } from "../platforms/index.ts";
import type { ReviewEvent, RunContext } from "../types.ts";
import { PI_VERSION } from "./binary.ts";
import { SUBMIT_RESULT_TOOL } from "./extension.ts";

export function buildPrompt(
  prompt: string,
  runContext: RunContext = getRunContext(),
  reviewEvents: ReviewEvent[] = [],
): string {
  const review = runContext.pullRequest && reviewEvents.length > 0;
  const prInstructions = !runContext.pullRequest
    ? "This event is not a pull request. Set pr_comment to an empty string."
    : review
      ? formatReviewInstructions(reviewEvents)
      : "If a pull request comment would be useful, set pr_comment to concise Markdown. Otherwise set it to an empty string.";
  const contextInstructions = formatRunContext(runContext);

  return `${prompt.trim()}

pi action instructions:
${contextInstructions ? `- ${contextInstructions}\n` : ""}- Make any requested repository changes directly in the working tree.
- Do not commit, push, or post comments yourself; this action handles that after you finish.
- When finished, call the ${SUBMIT_RESULT_TOOL} tool exactly once as your final action.
- If you made repository changes, set commit_message to a concise imperative commit message. If not, set it to an empty string.
- ${prInstructions}
- If the task asks you to fail the run under some condition and that condition is met, set fail_reason to a short explanation. Otherwise set it to an empty string.
- Platform MCP tools are available for read-only repository, pull request, issue, and workflow context. Use them when helpful, but do not create, update, merge, comment, or otherwise write through MCP.`;
}

function formatReviewInstructions(reviewEvents: ReviewEvent[]): string {
  const events = reviewEvents.map((event) => `"${event}"`).join(", ");

  return `Your result is posted as a pull request review. Set pr_comment to the review body in concise Markdown, or an empty string when the inline comments say everything. Set review_event to one of ${events}. Put findings about a specific line in review_comments, each with the path of a file the pull request changes, a line number in the pull request's version of that file on a line it adds or changes, and a short Markdown body; do not repeat them in pr_comment. Set review_comments to an empty array when there are none.`;
}

// Tells pi which repository and pull request the run is for, so it does not
// have to guess from the open pull requests.
export function formatRunContext(context: RunContext): string {
  if (!context.repository) {
    return "";
  }

  const location = `${context.repository} on ${context.serverUrl}`;
  const pullRequest = context.pullRequest;

  if (!pullRequest) {
    const parts = [
      context.ref ? `for ${context.ref}` : "",
      context.sha ? `at commit ${context.sha}` : "",
    ].filter(Boolean);
    const details = parts.length > 0 ? `, ${parts.join(" ")}` : "";
    return `This run is for a ${context.eventName} event in ${location}${details}.`;
  }

  // Each part is optional, since getRunContext drops values that are not plain.
  const parts = [
    pullRequest.headSha ? `at commit ${pullRequest.headSha}` : "",
    pullRequest.baseRef ? `into ${pullRequest.baseRef}` : "",
  ].filter(Boolean);
  const details = parts.length > 0 ? `, ${parts.join(" ")}` : "";

  return `This run is for pull request #${pullRequest.number} in ${location}${details}. "This pull request" means #${pullRequest.number}; use this number instead of looking it up.`;
}

export function formatPiPullRequestComment(comment: string, model: string): string {
  const footer = `agent: pi ${PI_VERSION} | model: <code>${escapeHtml(model)}</code>`;
  // Reviews can be posted without a body, such as an approval.
  return comment.trim() ? `${comment.trim()}\n\n---\n\n${footer}` : footer;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
