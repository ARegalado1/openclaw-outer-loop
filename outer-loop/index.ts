import crypto from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type OuterLoopPluginConfig = {
  enabled?: boolean;
  maxContinuations?: number;
};

type SessionChainState = {
  chainId: string;
  continuationCount: number;
  lastNextAction?: string;
  lastReason?: string;
  lastTrigger?: string;
  lastEnqueueAt?: number;
  noProgressStreak: number;
  updatedAt: number;
};

type AgentOverrideState = {
  enabled?: boolean;
  maxContinuations?: number;
};

const chainStateBySessionKey = new Map<string, SessionChainState>();
const agentOverrideByAgentId = new Map<string, AgentOverrideState>();
const CHAIN_STATE_STALE_MS = 10 * 60 * 1000;
const OUTER_LOOP_VERSION = "0.1.0";
const DEFAULT_MAX_CONTINUATIONS = 3;
const MIN_MAX_CONTINUATIONS = 1;
const MAX_MAX_CONTINUATIONS = 10;

function normalizeAgentId(agentId: unknown): string {
  return typeof agentId === "string" ? agentId.trim() : "";
}

function getAgentOverride(agentId: unknown): AgentOverrideState | undefined {
  const key = normalizeAgentId(agentId);
  if (!key) return undefined;
  return agentOverrideByAgentId.get(key);
}

function setAgentOverride(agentId: unknown, patch: AgentOverrideState): AgentOverrideState | undefined {
  const key = normalizeAgentId(agentId);
  if (!key) return undefined;
  const next = {
    ...(agentOverrideByAgentId.get(key) ?? {}),
    ...patch,
  };
  agentOverrideByAgentId.set(key, next);
  return next;
}

function isEnabled(pluginConfig: unknown, agentId?: unknown): boolean {
  const override = getAgentOverride(agentId);
  if (typeof override?.enabled === "boolean") return override.enabled;
  if (!pluginConfig || typeof pluginConfig !== "object") return false;
  return (pluginConfig as OuterLoopPluginConfig).enabled === true;
}

function clampMaxContinuations(value: number): number {
  return Math.min(MAX_MAX_CONTINUATIONS, Math.max(MIN_MAX_CONTINUATIONS, Math.floor(value)));
}

function getMaxContinuations(pluginConfig: unknown, agentId?: unknown): number {
  const override = getAgentOverride(agentId);
  if (typeof override?.maxContinuations === "number" && Number.isFinite(override.maxContinuations)) {
    return clampMaxContinuations(override.maxContinuations);
  }
  if (!pluginConfig || typeof pluginConfig !== "object") return DEFAULT_MAX_CONTINUATIONS;
  const raw = (pluginConfig as OuterLoopPluginConfig).maxContinuations;
  return typeof raw === "number" && Number.isFinite(raw)
    ? clampMaxContinuations(raw)
    : DEFAULT_MAX_CONTINUATIONS;
}

function extractLastAssistantText(messages: unknown[]): string {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") continue;
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string" && content.trim()) return content.trim();
  }
  return "";
}

function inferNextAction(messages: unknown[]): string | null {
  const text = extractLastAssistantText(messages);
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const marker = lines.find((line) => /^(next action|next step|next)\b/i.test(line));
  if (!marker) return null;
  return marker.replace(/^(next action|next step|next)\s*[:\-]?\s*/i, "").trim() || null;
}

function buildContinuationPrompt(params: {
  nextAction: string;
  continuationCount: number;
  recoveryMode: "none" | "post_compaction";
}): string {
  return [
    "Continue the current approved task.",
    "Reason: next step remains self-clearable.",
    `Next action: ${params.nextAction}`,
    `Recovery mode: ${params.recoveryMode}`,
    `Continuation count: ${params.continuationCount}`,
    "Stop only if truly blocked.",
  ].join("\n");
}

function createChainState(trigger?: string): SessionChainState {
  return {
    chainId: crypto.randomUUID(),
    continuationCount: 0,
    noProgressStreak: 0,
    updatedAt: Date.now(),
    lastTrigger: trigger,
  };
}

function getChainState(sessionKey: string): SessionChainState | undefined {
  const state = chainStateBySessionKey.get(sessionKey);
  if (!state) return undefined;
  if (Date.now() - state.updatedAt > CHAIN_STATE_STALE_MS) {
    chainStateBySessionKey.delete(sessionKey);
    return undefined;
  }
  return state;
}

function startNewChainState(sessionKey: string, trigger?: string): SessionChainState {
  const nextState = createChainState(trigger);
  chainStateBySessionKey.set(sessionKey, nextState);
  return nextState;
}

function touchChainState(sessionKey: string, state: SessionChainState): SessionChainState {
  state.updatedAt = Date.now();
  chainStateBySessionKey.set(sessionKey, state);
  return state;
}

function clearChainState(sessionKey: string): void {
  chainStateBySessionKey.delete(sessionKey);
}

function formatStatus(pluginConfig: unknown, agentId: unknown, runtimeVisible: boolean): string {
  const enabled = isEnabled(pluginConfig, agentId);
  const maxContinuations = getMaxContinuations(pluginConfig, agentId);
  return [
    `Outer Loop v${OUTER_LOOP_VERSION}`,
    `enabled=${enabled}`,
    `maxContinuations=${maxContinuations}`,
    `runtimeBridgeVisible=${runtimeVisible}`,
    `scope=agent:${normalizeAgentId(agentId) || "unknown"}`,
  ].join(" | ");
}

function parseOuterLoopArgs(args: string): { kind: "status" | "on" | "off" | "max"; value?: number } | null {
  const trimmed = args.trim();
  if (!trimmed || /^status$/i.test(trimmed)) return { kind: "status" };
  if (/^on$/i.test(trimmed)) return { kind: "on" };
  if (/^off$/i.test(trimmed)) return { kind: "off" };
  const maxMatch = trimmed.match(/^max\s+(\d+)$/i);
  if (maxMatch) return { kind: "max", value: Number(maxMatch[1]) };
  return null;
}

export default {
  id: "outer-loop",
  name: "Outer Loop",
  description: "Bounded same-session continuation policy plugin.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      maxContinuations: { type: "number" },
    },
  },
  register(api: OpenClawPluginApi) {
    const runtimeOuterLoopAtRegister = (api as any)?.runtime?.outerLoop;
    const enabled = isEnabled((api as any)?.pluginConfig);
    const maxContinuations = getMaxContinuations((api as any)?.pluginConfig);
    console.log("[outer-loop] ================================================");
    console.log(`[outer-loop] Outer Loop - Autonomous Looper v${OUTER_LOOP_VERSION}`);
    console.log(`[outer-loop] enabled=${enabled} maxContinuations=${maxContinuations}`);
    console.log(`[outer-loop] runtime bridge visible=${Boolean(runtimeOuterLoopAtRegister)}`);
    console.log("[outer-loop] ================================================");

    api.registerCommand({
      name: "outerloop",
      description: "Show or change outer-loop settings.",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const command = parseOuterLoopArgs(ctx.args?.trim() ?? "");
        if (!command) {
          return {
            text: [
              "Usage: /outerloop [status|on|off|max <1-10>]",
              "Examples:",
              "- /outerloop status",
              "- /outerloop on",
              "- /outerloop off",
              "- /outerloop max 10",
            ].join("\n"),
          };
        }

        const agentId = ctx.config?.agent?.id;
        const runtimeVisible = Boolean((api as any)?.runtime?.outerLoop);

        if (command.kind === "status") {
          const status = formatStatus((api as any)?.pluginConfig, agentId, runtimeVisible);
          console.log("[outer-loop] command status", { agentId, status });
          return { text: status };
        }

        if (command.kind === "on") {
          const next = setAgentOverride(agentId, { enabled: true });
          const message = `Outer loop enabled for agent ${normalizeAgentId(agentId) || "unknown"}.`;
          console.log("[outer-loop] command on", { agentId, next, status: formatStatus((api as any)?.pluginConfig, agentId, runtimeVisible) });
          return { text: message };
        }

        if (command.kind === "off") {
          const next = setAgentOverride(agentId, { enabled: false });
          const message = `Outer loop disabled for agent ${normalizeAgentId(agentId) || "unknown"}.`;
          console.log("[outer-loop] command off", { agentId, next, status: formatStatus((api as any)?.pluginConfig, agentId, runtimeVisible) });
          return { text: message };
        }

        const value = command.value;
        if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_MAX_CONTINUATIONS || value > MAX_MAX_CONTINUATIONS) {
          const message = `Max continuations must be between ${MIN_MAX_CONTINUATIONS} and ${MAX_MAX_CONTINUATIONS}.`;
          console.log("[outer-loop] command max rejected", {
            agentId,
            attempted: value,
            message,
          });
          return { text: message };
        }

        const nextValue = Math.floor(value);
        const next = setAgentOverride(agentId, { maxContinuations: nextValue });
        const message = `Max continuations set to ${nextValue} for agent ${normalizeAgentId(agentId) || "unknown"}.`;
        console.log("[outer-loop] command max", { agentId, next, status: formatStatus((api as any)?.pluginConfig, agentId, runtimeVisible) });
        return { text: message };
      },
    });

    api.on(
      "agent_end",
      async (event, ctx) => {
        const runtimeOuterLoopAtHook = (api as any)?.runtime?.outerLoop;
        console.log("[outer-loop] agent_end hook entered", {
          trigger: (ctx as any)?.trigger,
          sessionKey: (ctx as any)?.sessionKey,
          success: (event as any)?.success,
          hasMessages: Array.isArray((event as any)?.messages),
          messageCount: Array.isArray((event as any)?.messages) ? (event as any).messages.length : 0,
          pluginConfig: (api as any)?.pluginConfig ?? null,
          hasRuntimeOuterLoop: Boolean(runtimeOuterLoopAtHook),
          runtimeOuterLoopKeys: runtimeOuterLoopAtHook ? Object.keys(runtimeOuterLoopAtHook) : [],
          hasQueueSessionContinuation: Boolean(runtimeOuterLoopAtHook?.queueSessionContinuation),
        });
        if (!isEnabled((api as any).pluginConfig, (ctx as any).agentId)) return;
        if ((ctx as any).sessionKey == null || !(ctx as any).sessionKey.trim()) return;
        if ((ctx as any).trigger !== "user" && (ctx as any).trigger !== "memory") return;

        const sessionKey = (ctx as any).sessionKey.trim();
        const existingState = getChainState(sessionKey);

        if ((ctx as any).trigger === "user") {
          if (existingState) {
            clearChainState(sessionKey);
          }
        } else if (!existingState) {
          return;
        }

        if ((event as any).success !== true) {
          clearChainState(sessionKey);
          return;
        }

        const maxContinuations = getMaxContinuations((api as any).pluginConfig, (ctx as any).agentId);
        const nextAction = inferNextAction(Array.isArray((event as any).messages) ? (event as any).messages : []);
        if (!nextAction) {
          clearChainState(sessionKey);
          return;
        }

        const state = (ctx as any).trigger === "memory"
          ? existingState ?? startNewChainState(sessionKey, (ctx as any).trigger)
          : startNewChainState(sessionKey, (ctx as any).trigger);

        if ((ctx as any).trigger === "memory") {
          if (state.lastNextAction && state.lastNextAction === nextAction) {
            state.noProgressStreak += 1;
          } else {
            state.noProgressStreak = 0;
          }
          if (state.noProgressStreak >= 1) {
            clearChainState(sessionKey);
            return;
          }
        } else {
          state.noProgressStreak = 0;
        }

        const continuationReason = state.noProgressStreak > 0
          ? "next action changed after prior no-progress warning"
          : "next step remains self-clearable";

        const nextContinuationCount = state.continuationCount + 1;
        if (nextContinuationCount > maxContinuations) {
          clearChainState(sessionKey);
          return;
        }

        state.continuationCount = nextContinuationCount;
        state.lastNextAction = nextAction;
        state.lastReason = continuationReason;
        state.lastTrigger = (ctx as any).trigger;
        state.lastEnqueueAt = Date.now();
        touchChainState(sessionKey, state);

        const result = await (api as any).runtime.outerLoop.queueSessionContinuation({
          sessionKey,
          sessionId: (ctx as any).sessionId,
          agentId: (ctx as any).agentId,
          workspaceDir: (ctx as any).workspaceDir,
          messageProvider: (ctx as any).messageProvider,
          prompt: buildContinuationPrompt({
            nextAction,
            continuationCount: nextContinuationCount,
            recoveryMode: "none",
          }),
          metadata: {
            source: "outer_loop_plugin",
            chainId: state.chainId,
            continuationCount: nextContinuationCount,
            reason: continuationReason,
            nextAction,
            recoveryMode: "none",
            internal: true,
          },
        });

        console.log("[outer-loop] queueSessionContinuation result", result);

        if (!result.ok) {
          if (result.reason !== "duplicate_pending") {
            clearChainState(sessionKey);
            return;
          }
          touchChainState(sessionKey, state);
        }
      },
      { priority: -10 },
    );
  },
};
