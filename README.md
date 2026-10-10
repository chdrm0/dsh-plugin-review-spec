# dsh-plugin-review-spec

Host-side `/review` and `/spec` slash commands for DeepSeek Harness. The plugin
only assembles a payload and routes it to a subagent; all judgement lives in
prompt files under `~/.dsh/prompts/`, re-read on every invocation (edit them
and the next call changes — no restart, no rebuild). The repo ships starter
templates (`review.md`, `spec.md`) — copy them to `~/.dsh/prompts/` once; the
plugin refuses to run without those files and has no built-in fallback.

## Install (any DSH instance)

```
dsh plugin --profile <name> add /absolute/path/to/dsh-plugin-review-spec
```

or from a running Harness: `plugin_manager` → `install_bundle` with the absolute
directory as target. The bundle self-activates via `cordis.patch.yml`; no other
composition changes are needed.

## Commands

```
/review [<path> | diff [<base>]] [--model <provider/model>] [-- <focus note>]
```

- no argument or `diff` → `git diff` against HEAD (or `<base>`); a path → that
  file's contents with line numbers
- lock files, binaries and `.gitignore`-matched files are excluded
- payload over the cap → refused with both sizes named, never truncated
- delegation: in-process subagent, blocking; reviewer tools restricted to
  `read`, `grep`, `glob`
- reviewer route: `claude/claude-opus-5-5` at effort `medium` by default,
  overridable per call with `--model <provider/model>` or permanently via the
  config keys below — any model the instance can route works (subscription
  providers, local llama.cpp gguf ids, …)
- prompt = `~/.dsh/prompts/review.md` + payload + focus note, in that order
- missing prompt file → loud error naming the expected path, no fallback

```
/spec <free-form task description>
```

- route: the local default model (from `agentDefaultModel`), effort `low`,
  no tools; returns the spec verbatim and starts no implementation
- prompt = `~/.dsh/prompts/spec.md` + the user's text

## Config (on the `review-spec-commands` row)

| key | default | meaning |
|---|---|---|
| `payloadCapBytes` | 204800 | hard cap on the assembled payload |
| `rateCap` | 15 | `/review` delegations per rolling 5-hour window |
| `reviewProvider` | `claude` | reviewer route provider |
| `reviewModel` | `claude-opus-5-5` | reviewer route model id |
| `reviewEffort` | `medium` | reviewer reasoning effort (`off`…`max`) |

`reviewProvider` and `reviewModel` must be set together. A route id is
`provider/model` split on the FIRST slash, so model ids that contain slashes
(local gguf paths) work: `--model llama-cpp//home/me/models/model.gguf`.
`--model` overrides only provider/model; effort stays at the config/default
value. If the target model does not declare reasoning-effort levels, the
runtime rejects the delegation with `UNSUPPORTED_REASONING_EFFORT` — declare
`reasoningEfforts` for that model in the provider config.

Over the rate cap the command refuses with the current count and asks for an
explicit `--confirm` re-invocation; it does not block outright. Remaining
budget is printed in every successful result.

## Usage log

One JSON line per invocation (including refusals) to
`~/.dsh/logs/commands.jsonl`: `ts, command, model, effort, payloadBytes,
inputTokens, outputTokens, durationMs, findings, outcome`. Outcomes: `ok`,
`oversized`, `empty-diff`, `missing-prompt`, `rate-capped`, `error`. Payload
contents and credentials are never logged.

## Known limitation

`toolFilter` cannot remove `subagent` and `list_subagent_models` from the child:
the runtime never restricts tools registered in the child's own layer
(dsh-tools: "a restriction filters what a scope inherits — never what its OWN
layer registers"). Everything else — `bash`, `write`, `edit`, web tools,
`subagent_fork`, `workflow`, `plugin_manager`, goal tools — is filtered out by
the allowlist. For those two the restriction is prompt-only.
