# OpenClaw Outer Loop

Plugin + runtime patch for OpenClaw 3.13.

Autonomous same-session continuation for OpenClaw.

This project adds a bounded outer-loop mechanism so an OpenClaw agent can continue work across multiple completed turns until the task is done or truly blocked, instead of stopping early and waiting for another human "go ahead" message.

## TL;DR / Quick Reference

Core commands:
- `/outerloop status`
- `/outerloop on`
- `/outerloop off`
- `/outerloop max <n>`

Max continuation bounds:
- minimum: `1`
- maximum: `20`
- default: `3`

What it does:
- lets an agent continue across completed turns in the same session
- stops on completion, interruption, failure, repeated no-progress, or max continuations

What you need for it to work:
- the `outer-loop` plugin
- the patched OpenClaw runtime shim

Fast install shape:
1. load/allow the plugin in OpenClaw config
2. replace the matching installed runtime bundle file with the patched one
3. restart OpenClaw
4. run `/outerloop status`

## Status

**Version:** `v0.1.1`

## What's in v0.1.1

- **Transcript/internal tagging** — continuation turn prompts are now prefixed with a machine-readable tag `[outer-loop:continuation chainId=<id> n=<count>]` so they are distinguishable from ordinary user messages in session history
- **Per-chain run log** — each chain writes a JSON log to `~/.openclaw/logs/outer-loop/<chainId>.json` with chain ID, agent ID, session key, start/end time, per-iteration action/result, stop reason, and total turns
- **Agent scope fix** — `/outerloop status` now correctly resolves and displays the actual agent ID instead of `unknown`
- **Banner bridge-visible timing fix** — startup banner now labels the value `runtime bridge visible at register=` to clarify it is a register-time snapshot, not a guaranteed runtime state
- **Max continuations ceiling raised** — upper limit raised from 10 to 20; default remains 3

## What was in v0.1.0

- live same-session continuation bridge
- plugin-driven continuation policy
- duplicate-pending protection
- real inbound preemption protection
- bounded continuation count with live user controls
- startup banner and operator-facing command UX
- live proof in a patched OpenClaw gateway

## What is **not** included yet

- dedicated compaction-recovery logic
- polished upstream integration into OpenClaw core
- dedicated internal trigger value for continuation turns (currently uses a tolerated placeholder)

## What this solves

OpenClaw agents are often capable of doing more work than they actually complete in a single turn. They may stop after partial progress, a summary, or a soft uncertainty even when the next step is still obvious and self-clearable.

This project adds a bounded outer loop:
1. agent finishes a turn
2. plugin decides whether to continue
3. runtime shim safely enqueues another turn in the same session
4. loop stops on completion, real interruption, guardrails, or max continuations

## Architecture

`v0.1.1` uses a deliberately narrow split:

- **plugin policy layer**
  - decides whether to continue
  - tracks per-session chain state
  - applies no-progress and max-continuation guardrails
  - exposes live `/outerloop` controls
  - writes per-chain JSON run logs

- **runtime shim**
  - exposes same-session continuation enqueue to plugins
  - prevents duplicate pending continuations
  - respects real inbound interruption/preemption
  - re-enters the normal embedded agent/session flow

## Current commands

The plugin supports live per-agent controls in chat:

- `/outerloop status`
- `/outerloop on`
- `/outerloop off`
- `/outerloop max <n>`

### Max continuation bounds

- minimum: `1`
- maximum: `20`
- default: `3`

`maxContinuations` is the maximum number of **autonomous continuation turns** allowed after the original user-triggered turn.

Example:
- user sends one task
- agent finishes that turn
- outer loop may enqueue up to `N` additional turns, where `N = maxContinuations`

## Stop conditions

The outer loop is intentionally conservative.

It stops when:
- the task appears done because there is no clear next action to continue with
- a real inbound user message interrupts the session
- the chain hits `maxContinuations`
- the plugin sees repeated no-progress via the same inferred next action on a continuation turn
- the turn fails

This is designed to prefer stopping early over running away.

## Per-chain run logs

Each chain writes a JSON log file to:

```
~/.openclaw/logs/outer-loop/<chainId>.json
```

Log schema:

```json
{
  "chainId": "...",
  "sessionKey": "...",
  "agentId": "...",
  "startedAt": 1234567890000,
  "endedAt": 1234567891500,
  "stopReason": "max_continuations_reached",
  "totalTurns": 3,
  "iterations": [
    { "n": 1, "action": "...", "enqueuedAt": 1234567890100, "result": "ok" },
    { "n": 2, "action": "...", "enqueuedAt": 1234567890600, "result": "ok" },
    { "n": 3, "action": "...", "enqueuedAt": 1234567891100, "result": "ok" }
  ],
  "errors": []
}
```

Possible `stopReason` values:
- `interrupted_by_user` — a real user message arrived and preempted the chain
- `run_failed` — a continuation turn returned `success: false`
- `no_next_action` — the agent's last message contained no recognizable next action
- `no_progress` — same next action seen on two consecutive continuation turns
- `max_continuations_reached` — chain hit the configured cap
- `enqueue_failed:<reason>` — the runtime rejected the enqueue for a non-duplicate reason

Chains interrupted by stale state expiry (10 min idle) do not produce a finalized log.

## Transcript tagging

Continuation turn prompts now begin with a machine-readable tag line:

```
[outer-loop:continuation chainId=<uuid> n=<count>]
Continue the current approved task.
...
```

This allows any downstream session history reader to distinguish outer-loop-injected turns from real user messages.

## Compatibility

Tested on:
- **OpenClaw 3.13**

Important:
- the runtime patch file name is bundled and version-specific
- the exact target file may change on OpenClaw update
- if you update OpenClaw, re-check the installed dist file name before applying the patch

## Installation overview

This release currently has two parts:

1. **Outer Loop plugin**
2. **Patched OpenClaw runtime shim**

The plugin alone is not enough. Stock OpenClaw does not expose `api.runtime.outerLoop` yet, so the runtime patch is required for continuation to work.

## Plugin installation

The plugin folder contains:
- `package.json`
- `openclaw.plugin.json`
- `index.ts`

Load the plugin from its folder path and allow it in config.

Example plugin config:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/outer-loop"
      ]
    },
    "allow": [
      "outer-loop"
    ],
    "entries": {
      "outer-loop": {
        "enabled": true,
        "config": {
          "enabled": true,
          "maxContinuations": 3
        }
      }
    }
  }
}
```

## Runtime patch installation

`v0.1.1` requires replacing one installed OpenClaw runtime bundle file with the patched version that exposes:

- `api.runtime.outerLoop.queueSessionContinuation(...)`
- `api.runtime.outerLoop.markRealInboundSessionActivity(...)`
- `api.runtime.outerLoop.getRealInboundSessionActivityAt(...)`

### 1. Find the installed OpenClaw package path

Example Homebrew/global install path:

```bash
npm root -g
```

Then locate the installed OpenClaw dist bundle.

### 2. Identify the target runtime file

For OpenClaw 3.13, the file used during this release was:

```text
.../dist/model-selection-CU2b7bN6.js
```

Your exact filename may differ on other versions.

### 3. Back up the original runtime file

```bash
cp /absolute/path/to/installed/openclaw/dist/model-selection-CU2b7bN6.js /absolute/path/to/installed/openclaw/dist/model-selection-CU2b7bN6.js.bak
```

### 4. Copy in the patched runtime file

```bash
cp /absolute/path/to/openclaw-outer-loop/runtime-patch/model-selection-CU2b7bN6.js /absolute/path/to/installed/openclaw/dist/model-selection-CU2b7bN6.js
```

### 5. Restart the gateway

```bash
openclaw gateway restart
```

### 6. Verify startup banner and bridge visibility

On successful startup, the plugin should log a banner like:

```text
[outer-loop] ================================================
[outer-loop] Outer Loop - Autonomous Looper v0.1.1
[outer-loop] enabled=true maxContinuations=3
[outer-loop] runtime bridge visible at register=true
[outer-loop] ================================================
```

If `runtime bridge visible at register=false`, the plugin loaded but the runtime patch is not active yet. Note: this value is captured at plugin registration time. If the bridge becomes available later, `/outerloop status` (which checks at call time) will reflect the correct state.

## Operator experience

The plugin logs a startup banner showing:
- enabled state
- current continuation cap
- whether the patched runtime bridge was visible at register time

The plugin also supports live per-agent control commands in chat, without a gateway restart:
- `/outerloop status`
- `/outerloop on`
- `/outerloop off`
- `/outerloop max <n>`

`/outerloop status` checks bridge visibility at call time and is the reliable source of truth for current bridge state.

## Publishing to ClawHub / community listing

ClawHub (`clawhub` CLI) currently supports **skills**, not plugins. Plugin publishing uses a separate path.

To get this plugin listed in the OpenClaw community plugins docs:

1. Publish the plugin package to npm:
   ```bash
   npm publish --access public
   ```
   Package name: `@openclaw/outer-loop` (or your scoped name)

2. Host source on a public GitHub repository with an issue tracker.

3. Open a PR to the OpenClaw docs repository adding an entry to the community plugins page (`docs/plugins/community.md`) using the required format:

   ```
   - **Outer Loop** — Bounded same-session autonomous continuation for OpenClaw agents.
     npm: `@openclaw/outer-loop`
     repo: `https://github.com/<your-org>/openclaw-outer-loop`
     install: `openclaw plugins install @openclaw/outer-loop`
   ```

4. The PR must satisfy the review bar: useful, documented, active maintainer, and safe to operate.

Note: the runtime patch is a non-standard install step that may complicate listing until the bridge is upstreamed into OpenClaw core.

## Validation summary

`v0.1.0` reached all of the following before release:
- mechanical bridge validation
- focused plugin-file tests
- modeled runtime-shim validation
- live patched-gateway proof
- live chat command control verification

Live proof confirmed:
- plugin load
- plugin register execution
- `agent_end` hook execution
- runtime bridge visibility to the plugin
- autonomous same-session continuation across multiple turns without human intervention

## Recommended use

Good use cases:
- internal work
- multi-step workspace tasks
- low-risk iterative tasks
- agents that often stop early despite a clear next step

Avoid or be cautious with:
- customer-facing destructive actions
- high-stakes tasks without observability
- long autonomous chains without reviewing run logs

## Known limitations

- the runtime shim is currently implemented as a patch against the installed OpenClaw runtime, not as a fully upstreamed core extension
- no dedicated compaction-recovery behavior has been added yet
- continuation policy still relies on a conservative `Next action` extraction heuristic
- current continuation trigger semantics rely on a tolerated placeholder runtime trigger value (`"memory"`) rather than a final dedicated continuation trigger — this will change in a future release
- chains interrupted by stale state expiry (10 min idle) do not produce a finalized log entry
- ClawHub (skills registry) does not support plugin publishing; plugin listing requires npm + OpenClaw community docs PR

## Roadmap

### later
- dedicated internal trigger value for continuation turns (replace `"memory"` placeholder)
- simpler installation UX, ideally toward a more fluid one-line install path once packaging/runtime integration is clean enough
- better continuation semantics
- improved compaction recovery if still needed after lossless context tooling
- cleaner upstream packaging / PR path into OpenClaw core

## License

MIT
