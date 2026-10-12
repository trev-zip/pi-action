# pi-action

[![check](https://trev.zip/llc/pi-action/actions/workflows/check.yaml/badge.svg?branch=main&logo=forgejo&logoColor=%23bac2de&label=check&labelColor=%23313244)](https://trev.zip/llc/pi-action/actions?workflow=check.yaml)
[![vulnerable](https://trev.zip/llc/pi-action/actions/workflows/vulnerable.yaml/badge.svg?branch=main&logo=forgejo&logoColor=%23bac2de&label=vulnerable&labelColor=%23313244)](https://trev.zip/llc/pi-action/actions?workflow=vulnerable.yaml)
[![nixpkgs](https://img.shields.io/endpoint?url=https%3A%2F%2Fnix-shield.trev.zip%2Fbadge%3Furl%3Dhttps%253A%252F%252Ftrev.zip%252Fllc%252Fpi-action%252Fraw%252Fbranch%252Fmain%252Fflake.lock%26input%3Dnixpkgs&logoColor=%23bac2de&labelColor=%23313244&color=%235277C3)](https://nixos.org/)
[![node](https://img.shields.io/badge/dynamic/json?url=https://trev.zip/llc/pi-action/raw/branch/main/package.json&query=%24.engines.node&logo=nodedotjs&logoColor=%23bac2de&label=version&labelColor=%23313244&color=%23339933)](https://nodejs.org/en/about/previous-releases)

Use the [pi](https://pi.dev) coding agent in a GitHub/Gitea/Forgejo action,
with any provider pi supports or any OpenAI-, Anthropic-, or Google-compatible
endpoint such as [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

## Examples

### CLIProxyAPI

Point `base-url` at any compatible endpoint. The action adds it to pi's
`models.json` as a `custom` provider (rename it with `provider`) and selects
`model` on it. `api` defaults to `openai-completions`; use `openai-responses`,
`anthropic-messages`, or `google-generative-ai` when the endpoint speaks another
API.

```yaml
name: pi

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  pi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: trev-zip/pi-action@main
        with:
          base-url: https://cliproxy.example.com/v1
          api-key: ${{ secrets.CLIPROXY_API_KEY }}
          model: claude-sonnet-5
          token: ${{ secrets.PI_ACTION_TOKEN }}
          prompt: Update the documentation for the latest changes.
```

The API key only reaches pi through an environment variable; `models.json`
references it as `$PI_ACTION_API_KEY` so the key is never written to disk.

The action reads the model's context window and output limit from the
endpoint's model list, which CLIProxyAPI provides, and passes them to pi.
Without them, pi assumes a 128000-token context window and cuts each response
off at 16384 tokens. Limits set for the model in `models` take precedence.

### Built-in Providers

For providers pi already knows, set `provider`, `model`, and either `api-key`
or the provider's usual environment variable. pi requires `model` whenever
`provider` is set.

```yaml
- uses: trev-zip/pi-action@main
  with:
    provider: anthropic
    api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    model: claude-opus-5-5
    thinking: high
    token: ${{ secrets.PI_ACTION_TOKEN }}
    prompt: Fix the failing tests.
```

```yaml
- uses: trev-zip/pi-action@main
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
  with:
    provider: openrouter
    model: moonshotai/kimi-k2
    token: ${{ secrets.PI_ACTION_TOKEN }}
    prompt: Fix the failing tests.
```

`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`;
pi clamps it to what the selected model supports.

### Multiple Providers

`models` accepts pi [`models.json`](https://pi.dev/docs/models) content, or a
path to a file in the workspace. Values can use `$NAME`, `${NAME}`, or
`!command`, which are resolved from the step environment when pi makes a
request. `base-url`, `api`, `api-key`, and `model` are merged on top of the
provider named by `provider`.

```yaml
- uses: trev-zip/pi-action@main
  env:
    LOCAL_API_KEY: ${{ secrets.LOCAL_API_KEY }}
  with:
    provider: local
    model: qwen3-coder
    models: |
      {
        "providers": {
          "local": {
            "baseUrl": "https://llm.example.com/v1",
            "api": "openai-completions",
            "apiKey": "$LOCAL_API_KEY",
            "models": [{ "id": "qwen3-coder", "contextWindow": 262144 }]
          }
        }
      }
    token: ${{ secrets.PI_ACTION_TOKEN }}
    prompt: .github/prompts/refactor.md
```

### Subscription Auth

To use a subscription login, run `pi` locally, sign in with `/login`, and store
`~/.pi/agent/auth.json` (as-is or base64 encoded) in the `PI_ACTION_AUTH`
repository secret.

```sh
base64 -w0 ~/.pi/agent/auth.json | gh secret set PI_ACTION_AUTH
```

```yaml
- uses: trev-zip/pi-action@main
  with:
    auth: ${{ secrets.PI_ACTION_AUTH }}
    provider: openai-codex
    model: gpt-5.5
    token: ${{ secrets.PI_ACTION_TOKEN }}
    prompt: Make the requested repository update.
```

When pi refreshes OAuth tokens during a run, the action stores the new
`auth.json` in the secret named by `auth-secret` (default `PI_ACTION_AUTH`), so
the token needs permission to write Actions secrets. Credentials in `auth.json`
take precedence over `api-key` for the same provider.

### GitHub App

Instead of `token`, pass a GitHub App client ID and private key. The action
creates a repository-scoped installation token with the permissions it needs and
commits as `<app-slug>[bot]`.

```yaml
- uses: trev-zip/pi-action@main
  with:
    base-url: ${{ secrets.CLIPROXY_URL }}
    api-key: ${{ secrets.CLIPROXY_API_KEY }}
    model: claude-sonnet-5
    client-id: ${{ vars.CLIENT_ID }}
    private-key: ${{ secrets.PRIVATE_KEY }}
    prompt: Update the documentation for the latest changes.
```

The GitHub App installation must grant these repository permissions:

- Actions: read
- Contents: read and write
- Issues: read and write
- Pull requests: read and write
- Secrets: read and write

### Gitea or Forgejo

On Gitea and Forgejo, pass a token with repository contents, pull request, issue
comment, workflow, and Actions secret access.

### MCP Context

The action gives pi read-only access to the matching platform MCP server with
the same API token used by the action, so pi can inspect pull request comments,
issues, repository data, and workflow context:

- `github-mcp-server` from `github/github-mcp-server` on GitHub, in read-only
  mode with the `repos`, `issues`, `pull_requests`, and `actions` toolsets.
- `gitea-mcp` from `gitea/gitea-mcp` on Gitea, in read-only mode.
- `forgejo-mcp` from `goern/forgejo-mcp` on Forgejo.

On Gitea and Forgejo, pi only sees the read tools for repository contents,
commits, branches, releases, issues, pull requests, and workflow runs. This keeps
write tools away from pi and keeps tool definitions from inflating every model
request.

No container runtime is required. The pi and MCP release binaries are downloaded
and cached in both the runner tool cache and, when available, the Actions cache
service. The action's pi extension starts the MCP server over stdio and exposes
its tools to pi, so this works with released pi versions that have no built-in
MCP support. The API token is forwarded through environment variables and is not
written to the MCP configuration.

Set `PI_PATH` to a preinstalled pi executable to skip the pi download.

### Prompts

If `prompt` points to a file in the workspace, the action reads that file.
Otherwise, the input value is used as the prompt text.

Prompts should describe the task clearly enough for pi to complete it without
follow-up questions: the goal, relevant files, what is out of scope, and which
formatting, build, or test commands to run.

Do not ask pi to commit, push, or post comments. When pi finishes, it submits a
commit message and optional pull request comment, and the action handles
commits, pushes, pull request comments, and automerge.

To make the step fail, tell pi when the run should fail, such as "fail the run
if you find any problems". pi then submits a failure reason, and the action
fails the step after committing, pushing, and commenting as usual. On pull
requests, the failure reason is posted as the comment when pi leaves none. The
step also fails if pi finishes without submitting a result.

pi runs with project trust declined, so `.pi` settings, extensions, skills, and
MCP servers from the repository are ignored. `AGENTS.md` and `CLAUDE.md` context
files are still loaded.

Set `push: false` to keep pi's changes as a local commit instead of pushing
them, or `comment: false` to skip posting pi's pull request comment. Set
`dry-run: true` to do both and also skip automerge updates; it overrides `push`
and `comment`. Refreshed auth is still saved to the configured repository
secret.

### Pull Requests

On pull request events, pi can leave a PR comment or a
[review](#pull-request-reviews), and optionally toggle automerge. Non-empty
comments and reviews include a footer identifying pi and the model used for the
run. When pi fails the run, the action skips enabling automerge.

```yaml
name: pi-pr

on:
  pull_request:

jobs:
  pi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: trev-zip/pi-action@main
        with:
          base-url: ${{ secrets.CLIPROXY_URL }}
          api-key: ${{ secrets.CLIPROXY_API_KEY }}
          model: gpt-5.5
          token: ${{ secrets.PI_ACTION_TOKEN }}
          automerge: true
          prompt: Review this pull request and fix straightforward issues.
```

### Pull Request Reviews

Set `review` to post pi's result as a pull request review instead of a comment.
pi's comment becomes the review body, and pi can attach inline comments to lines
the pull request adds or changes. `review` sets the strongest state pi may
choose:

- `comment`: comment reviews only.
- `request-changes`: comment, or request changes.
- `approve`: comment, request changes, or approve.

The action posts the review, so pi still has no MCP write tools. When pi fails
the run, an approval is posted as a comment review instead. Inline comments on
files the pull request does not change are listed in the review body. If the
platform rejects the review, for example because an inline comment is outside
the diff, the action posts it again with every inline comment listed in the
body. If that is also rejected, for example because the token's user opened the
pull request and cannot approve or request changes on it, the action posts a
comment review instead. `comment: false` and `dry-run: true` skip the review.

The action does not dismiss earlier reviews, so a run on every push adds a
review each time. If branch protection blocks merging on rejected reviews, an
old request for changes keeps blocking the pull request after the problems are
fixed until someone dismisses it.

To review when someone requests a review from the token's user, trigger on
`review_requested` and check the requested reviewer. Re-requesting the review
runs it again. Reviews can only be requested from users with access to the
repository, so the token must belong to a user rather than an automatic token
or GitHub App.

```yaml
name: pi-review

on:
  pull_request:
    types: [review_requested]

jobs:
  review:
    if: github.event.requested_reviewer.login == 'pi-bot'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: trev-zip/pi-action@main
        with:
          base-url: ${{ secrets.CLIPROXY_URL }}
          api-key: ${{ secrets.CLIPROXY_API_KEY }}
          model: claude-sonnet-5
          token: ${{ secrets.PI_BOT_TOKEN }}
          exclude-tools: bash,edit,write
          push: false
          review: request-changes
          prompt: Review this pull request. Request changes if you find any problems.
```

To request pi's review on every pull request, add a `CODEOWNERS` file that
names the token's user, such as `.* @pi-bot` in `.forgejo/CODEOWNERS` (Forgejo
and Gitea patterns are regular expressions). Forgejo only requests code owner
reviews when a pull request opens or leaves WIP, so also trigger on
`synchronize` to review later pushes. Forgejo reports those pushes as `synchronized`, so compare only
`review_requested` by name:

```yaml
on:
  pull_request:
    types: [review_requested, synchronize]

jobs:
  review:
    if: >-
      github.event.action == 'review_requested'
      && github.event.requested_reviewer.login == 'pi-bot'
      || github.event.action != 'review_requested'
      && github.event.pull_request.user.login != 'pi-bot'
```

Allow `approve` only when an approval from pi should carry weight. A prompt
injection in the pull request could talk pi into approving it, and the approval
counts toward required approvals if branch protection accepts reviews from the
token's user.

### Untrusted Input

Pull request descriptions, comments, and changed files can contain prompt
injection. The action keeps the `token` and `api-key` values out of the
environment of commands pi runs, but a shell on the runner can still read the
job's other secrets: the `auth.json` written for the `auth` input, environment
variables set on the step, and anything visible through `/proc`, including the
`token` and `api-key` themselves.

For reviews of content you don't trust, disable the shell with
`exclude-tools: bash,edit,write` and set `push: false`. Without a shell tool,
the action confines pi's file tools to the workspace, so pi can only read the
checkout and call the platform MCP tools, which are limited to read operations
(see [MCP Context](#mcp-context)). Those tools can still read anything the
`token` can, so give review jobs a token scoped to the repository. When `bash`
is excluded, the action also turns on pi's `grep`, `find`, and `ls` tools so pi
can still search the checkout, and provides the pinned ripgrep and fd releases
those tools run, cached like the pi and MCP binaries.

```yaml
- uses: trev-zip/pi-action@main
  with:
    base-url: ${{ secrets.CLIPROXY_URL }}
    api-key: ${{ secrets.CLIPROXY_API_KEY }}
    model: claude-sonnet-5
    token: ${{ secrets.PI_ACTION_TOKEN }}
    exclude-tools: bash,edit,write
    push: false
    prompt: Review this pull request. Fail the run if you find any problems.
```

## Inputs

| Input           | Description                                                                     |
| --------------- | ------------------------------------------------------------------------------- |
| `prompt`        | Prompt text, or a path to a prompt file (required)                              |
| `provider`      | pi provider name, or the name for the `base-url` provider (default `custom`)    |
| `model`         | Model ID; required with `base-url` or `provider`                                |
| `base-url`      | OpenAI-, Anthropic-, or Google-compatible endpoint, such as a CLIProxyAPI `/v1` |
| `api`           | API type for `base-url` (default `openai-completions`)                          |
| `api-key`       | API key for `base-url` or `provider`                                            |
| `models`        | pi `models.json` content, or a path to one                                      |
| `thinking`      | Thinking level                                                                  |
| `exclude-tools` | Exact pi tool names to disable; without a shell, file tools are confined        |
| `auth`          | pi `auth.json` content, or its base64 encoding                                  |
| `auth-secret`   | Secret to update with refreshed auth (default `PI_ACTION_AUTH`)                 |
| `token`         | GitHub, Gitea, or Forgejo token                                                 |
| `client-id`     | GitHub App client ID, used with `private-key` instead of `token`                |
| `private-key`   | GitHub App private key                                                          |
| `automerge`     | `true` to enable automerge, `false` to disable it, or omit for no change        |
| `review`        | Post a review instead of a comment: `comment`, `request-changes`, or `approve`  |
| `push`          | `false` to commit locally without pushing (default `true`)                      |
| `comment`       | `false` to skip posting the pull request comment (default `true`)               |
| `dry-run`       | Commit locally but skip pushes, comments, and automerge (default `false`)       |

## contributing

see [CONTRIBUTING.md](CONTRIBUTING.md) for requirements and getting started
