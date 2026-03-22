# OpenClaw Outer Loop

Plugin + runtime patch for OpenClaw 3.13.

Autonomous same-session continuation for OpenClaw.

This project adds a bounded outer-loop mechanism so an OpenClaw agent can continue work across multiple completed turns until the task is done or truly blocked, instead of stopping early and waiting for another human "go ahead" message.

## Status

**Version:** `v0.1.0`

`v0.1.0` is a working early release.

What is included:
- live same-session continuation bridge
- plugin-driven continuation policy
- duplicate-pending protection
- real inbound preemption protection
- bounded continuation count with live user controls
- startup banner and operator-facing command UX
- live proof in a patched OpenClaw gateway

What is **not** included yet:
- transcript/internal tagging for continuation turns
- dedicated compaction-recovery logic
- polished upstream integration into OpenClaw core

Planned next release:
- **`v0.1.1`**: transcript/internal tagging so continuation turns do not look like ordinary user messages in session history

## What this solves

OpenClaw agents are often capable of doing more work than they actually complete in a single turn. They may stop after partial progress, a summary, or a soft uncertainty even when the next step is still obvious and self-clearable.

This project adds a bounded outer loop:
1. agent finishes a turn
2. plugin decides whether to continue
3. runtime shim safely enqueues another turn in the same session
4. loop stops on completion, real interruption, guardrails, or max continuations

## Architecture

`v0.1.0` uses a deliberately narrow split:

- **plugin policy layer**
  - decides whether to continue
  - tracks per-session chain state
  - applies no-progress and max-continuation guardrails
  - exposes live `/outerloop` controls

- **runtime shim**
  - exposes same-session continuation enqueue to plugins
  - prevents duplicate pending continuations
  - respects real inbound interruption/preemption
  - re-enters the normal embedded agent/session flow

This version is intentionally minimal. It proves the bridge first and leaves deeper product polish for follow-up releases.

## Current commands

The plugin supports live per-agent controls in chat:

- `/outerloop status`
- `/outerloop on`
- `/outerloop off`
- `/outerloop max <n>`

### Max continuation bounds

- minimum: `1`
- maximum: `10`
- default: `3`

`maxContinuations` is the maximum number of **autonomous continuation turns** allowed after the original user-triggered turn.

Example:
- user sends one task
- agent finishes that turn
- outer loop may enqueue up to `N` additional turns, where `N = maxContinuations`

## Stop conditions in v0.1.0

The outer loop is intentionally conservative.

It stops when:
- the task appears done because there is no clear next action to continue with
- a real inbound user message interrupts the session
- the chain hits `maxContinuations`
- the plugin sees repeated no-progress via the same inferred next action on a continuation turn
- the turn fails

This is designed to prefer stopping early over running away.

## Known limitations in v0.1.0

- continuation transcript entries are not tagged yet, so session history may still represent them less clearly than desired
- the runtime shim is currently implemented as a patch against the installed OpenClaw runtime, not as a fully upstreamed core extension
- no dedicated compaction-recovery behavior has been added yet
- continuation policy still relies on a conservative `Next action` extraction heuristic
- current continuation trigger semantics rely on a tolerated placeholder runtime trigger value rather than a final dedicated continuation trigger
- max continuations is capped at `10` for now; this is intentionally conservative for the first public release to avoid runaway behavior and surprise costs before transcript tagging and observability are more mature. If you need higher limits for heavy internal workflows, open an issue and share the use case.

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

`v0.1.0` requires replacing one installed OpenClaw runtime bundle file with the patched version that exposes:

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
[outer-loop] Outer Loop - Autonomous Looper v0.1.0
[outer-loop] enabled=true maxContinuations=3
[outer-loop] runtime bridge visible=true
[outer-loop] ================================================
```

If `runtime bridge visible=false`, the plugin loaded but the runtime patch is not active yet.

## Operator experience

The plugin logs a startup banner showing:
- enabled state
- current continuation cap
- whether the patched runtime bridge is visible

The plugin also supports live per-agent control commands in chat, without a gateway restart:
- `/outerloop status`
- `/outerloop on`
- `/outerloop off`
- `/outerloop max <n>`

## Validation summary

`v0.1.0` is not just theoretical.

The project reached all of the following before release:
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
- long autonomous chains before transcript tagging lands

## Roadmap

### v0.1.1
- transcript/internal tagging for continuation turns

### later
- better continuation semantics
- improved compaction recovery if still needed after lossless context tooling
- cleaner upstream packaging / PR path into OpenClaw core

## Public release intent

This repository publishes a working early release of the Outer Loop plugin + runtime patch for OpenClaw 3.13.

It is meant for operators who are comfortable applying a targeted runtime patch and testing an experimental autonomy feature in internal workflows.

## License

MIT
