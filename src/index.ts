/**
 * pi-supervisor — A pi extension that supervises the chat and steers it toward a defined outcome.
 *
 * Commands:
 *   /supervise <outcome>          — start supervising
 *   /supervise stop               — stop supervision
 *   /supervise status             — show current status widget
 *   /supervise model              — open interactive model picker (pi-style)
 *   /supervise model <p/modelId>  — set model directly (scripting)
 *   /supervise sensitivity <low|medium|high> — adjust steering sensitivity
 *   /supervisor-tool              — toggle the start_supervision tool for this session
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { analyze, loadSystemPrompt } from "./engine.js";
import {
  SupervisorStateManager,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL_ID,
  DEFAULT_SENSITIVITY,
} from "./state.js";
import type { Sensitivity } from "./types.js";
import { pickModel } from "./ui/model-picker.js";
import { openSettings } from "./ui/settings-panel.js";
import {
  createSupervisorActivationMessage,
  createSupervisorReplyMessage,
  registerSupervisorMessageRenderer,
} from "./ui/message-renderer.js";
import { updateUI, toggleWidget, isWidgetVisible } from "./ui/status-widget.js";
import { loadWorkspaceModel, saveWorkspaceModel } from "./workspace-config.js";

const START_SUPERVISION_TOOL_NAME = "start_supervision";

/**
 * Extract partial reasoning text from the supervisor's streaming JSON response.
 * Works on incomplete JSON while the model is still generating.
 */
function extractThinking(accumulated: string): string {
  const keyIdx = accumulated.indexOf('"reasoning"');
  if (keyIdx === -1) return "";
  const after = accumulated.slice(keyIdx + '"reasoning"'.length);
  const openMatch = after.match(/^\s*:\s*"/);
  if (!openMatch) return "";
  const content = after.slice(openMatch[0].length);
  const closeIdx = content.search(/(?<!\\)"/);
  const raw = closeIdx === -1 ? content : content.slice(0, closeIdx);
  return raw.replace(/\\n/g, " ").replace(/\\"/g, '"').trim();
}

function wasRunAborted(messages: unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as any;
    if (message?.role === "assistant") {
      return message.stopReason === "aborted";
    }
  }
  return false;
}

function normalizeSupervisorReply(message: string): string {
  return message.replace(/^\[supervisor\]\s*/i, "").trim();
}

// After this many consecutive idle-state steers with no "done", run a lenient final evaluation.
const MAX_IDLE_STEERS = 5;

export default function (pi: ExtensionAPI) {
  const state = new SupervisorStateManager(pi);
  registerSupervisorMessageRenderer(pi);

  let idleSteers = 0; // consecutive agent_end steers; reset on done/stop/new supervision
  let startSupervisionToolRegistered = false;

  const ensureStartSupervisionToolRegistered = () => {
    if (startSupervisionToolRegistered) return;
    startSupervisionToolRegistered = true;

    pi.registerTool({
      name: START_SUPERVISION_TOOL_NAME,
      label: "Start Supervision",
      description:
        "Activate the supervisor to track the conversation toward a specific outcome. " +
        "The supervisor will observe every turn and steer the agent if it drifts. " +
        "Once supervision is active it is locked — only the user can change or stop it.",
      parameters: Type.Object({
        outcome: Type.String({
          description:
            "The desired end-state to supervise toward. Be specific and measurable " +
            "(e.g. 'Implement JWT auth with refresh tokens and full test coverage').",
        }),
        sensitivity: Type.Optional(
          Type.Union(
            [Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
            {
              description:
                "How aggressively to steer. low = only when seriously off track, " +
                "medium = on mild drift (default), high = proactively + mid-turn checks.",
            }
          )
        ),
        model: Type.Optional(
          Type.String({
            description:
              "Supervisor model as 'provider/modelId' (e.g. 'anthropic/claude-haiku-4-5-20251001'). " +
              "Defaults to workspace config, then the active chat model.",
          })
        ),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const text = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], details: undefined });

        if (state.isActive()) {
          const s = state.getState()!;
          return text(
            `Supervision is already active and cannot be changed by the model.\n` +
              `Active outcome: "${s.outcome}"\n` +
              `Only the user can stop or modify supervision via /supervise.`
          );
        }

        const sensitivity: Sensitivity = params.sensitivity ?? DEFAULT_SENSITIVITY;

        let provider: string;
        let modelId: string;
        if (params.model) {
          const slash = params.model.indexOf("/");
          provider = slash === -1 ? DEFAULT_PROVIDER : params.model.slice(0, slash);
          modelId = slash === -1 ? params.model : params.model.slice(slash + 1);
        } else {
          const workspaceModel = loadWorkspaceModel(ctx.cwd);
          const sessionModel = ctx.model;
          provider = workspaceModel?.provider ?? sessionModel?.provider ?? DEFAULT_PROVIDER;
          modelId = workspaceModel?.modelId ?? sessionModel?.id ?? DEFAULT_MODEL_ID;
        }

        state.start(params.outcome, provider, modelId, sensitivity);
        idleSteers = 0;
        updateUI(ctx, state.getState());

        const { source } = loadSystemPrompt(ctx.cwd);
        const promptLabel = source === "built-in" ? "built-in prompt" : ".pi/SUPERVISOR.md";

        ctx.ui.notify(
          `Supervisor started by agent: "${params.outcome.slice(0, 60)}${params.outcome.length > 60 ? "…" : ""}" | ${provider}/${modelId} | sensitivity: ${sensitivity} | ${promptLabel}`,
          "info"
        );

        return text(
          `Supervision active. Outcome: "${params.outcome}" | ${provider}/${modelId} | sensitivity: ${sensitivity}`
        );
      },
    });
  };

  const syncStartSupervisionToolActivation = () => {
    const activeTools = new Set(pi.getActiveTools());
    if (state.isToolEnabled()) {
      ensureStartSupervisionToolRegistered();
      activeTools.add(START_SUPERVISION_TOOL_NAME);
    } else {
      activeTools.delete(START_SUPERVISION_TOOL_NAME);
    }
    pi.setActiveTools(Array.from(activeTools));
  };

  const sendSupervisorReply = async (
    message: string,
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean }
  ) => {
    await pi.sendMessage(createSupervisorReplyMessage(message), options);
  };

  const onSessionLoad = (ctx: ExtensionContext) => {
    state.loadFromSession(ctx);
    syncStartSupervisionToolActivation();
    updateUI(ctx, state.getState());
  };

  pi.on("session_start", async (_event, ctx) => onSessionLoad(ctx));
  pi.on("session_switch", async (_event, ctx) => onSessionLoad(ctx));
  pi.on("session_fork", async (_event, ctx) => onSessionLoad(ctx));
  pi.on("session_tree", async (_event, ctx) => onSessionLoad(ctx));

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return;
    if (!state.isActive() || !state.isPausedUntilHuman()) return;

    state.setPausedUntilHuman(false);
    updateUI(ctx, state.getState());
  });

  // turn_end fires after each LLM sub-turn (tool-call cycle) while the agent is still running.
  // low:    no mid-run checks at all
  // medium: check every 3rd tool cycle (turns 2, 5, 8, …), confidence >= 0.9
  // high:   check every tool cycle from turn 2, confidence >= 0.85
  pi.on("turn_end", async (event, ctx) => {
    if (!state.isActive()) return;
    const s = state.getState()!;

    if (s.pausedUntilHuman) return;
    if (s.sensitivity === "low") return;
    if (event.turnIndex < 2) return;
    if (s.sensitivity === "medium" && (event.turnIndex - 2) % 3 !== 0) return;

    let decision;
    try {
      decision = await analyze(ctx, s, false, false);
    } catch {
      return;
    }

    const threshold = s.sensitivity === "medium" ? 0.9 : 0.85;
    if (decision.action === "steer" && decision.message && decision.confidence >= threshold) {
      const supervisorMessage = normalizeSupervisorReply(decision.message);
      state.addIntervention({
        turnCount: s.turnCount,
        message: supervisorMessage,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
      });
      updateUI(ctx, state.getState(), { type: "steering", message: supervisorMessage });
      await sendSupervisorReply(supervisorMessage, { deliverAs: "steer" });
    }
  });

  // agent_end fires once per user prompt, always with the agent idle and waiting for input.
  // This is the critical checkpoint for all sensitivity levels.
  pi.on("agent_end", async (event, ctx) => {
    if (!state.isActive()) return;

    if (wasRunAborted(event.messages)) {
      state.setPausedUntilHuman(true);
      updateUI(ctx, state.getState());
      return;
    }

    const activeState = state.getState();
    if (!activeState || activeState.pausedUntilHuman) {
      updateUI(ctx, activeState);
      return;
    }

    state.incrementTurnCount();
    const s = state.getState()!;
    const stagnating = idleSteers >= MAX_IDLE_STEERS;

    updateUI(ctx, s, { type: "analyzing", turn: s.turnCount });

    const decision = await analyze(ctx, s, true, stagnating, undefined, (accumulated) => {
      const thinking = extractThinking(accumulated);
      updateUI(ctx, state.getState()!, { type: "analyzing", turn: s.turnCount, thinking });
    });

    if (decision.action === "steer" && decision.message) {
      const supervisorMessage = normalizeSupervisorReply(decision.message);
      idleSteers++;
      state.addIntervention({
        turnCount: s.turnCount,
        message: supervisorMessage,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
      });
      updateUI(ctx, state.getState(), { type: "steering", message: supervisorMessage });
      await sendSupervisorReply(supervisorMessage, { triggerTurn: true });
    } else if (decision.action === "done") {
      idleSteers = 0;
      updateUI(ctx, state.getState(), { type: "done" });
      const suffix = stagnating ? ` (stopped after ${MAX_IDLE_STEERS} steering attempts — goal substantially achieved)` : "";
      ctx.ui.notify(`Supervisor: outcome achieved! "${s.outcome}"${suffix}`, "info");
      state.stop();
      updateUI(ctx, state.getState());
    } else {
      updateUI(ctx, state.getState(), { type: "watching" });
    }
  });

  pi.registerCommand("supervisor-tool", {
    description: "Toggle the start_supervision tool for this session",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /supervisor-tool", "warning");
        return;
      }

      const enabled = !state.isToolEnabled();
      state.setToolEnabled(enabled);
      syncStartSupervisionToolActivation();
      ctx.ui.notify(`Supervisor tool ${enabled ? "enabled" : "disabled"}.`, "info");
    },
  });

  pi.registerCommand("supervise", {
    description: "Supervise the chat toward a desired outcome (/supervise <outcome>)",
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      if (trimmed === "widget") {
        const visible = toggleWidget();
        if (state.isActive()) {
          updateUI(ctx, state.getState());
        }
        ctx.ui.notify(`Supervisor widget ${visible ? "shown" : "hidden"}.`, "info");
        return;
      }

      if (trimmed === "stop") {
        if (!state.isActive()) {
          ctx.ui.notify("Supervisor is not active.", "warning");
          return;
        }
        state.stop();
        idleSteers = 0;
        updateUI(ctx, state.getState());
        ctx.ui.notify("Supervisor stopped.", "info");
        return;
      }

      if (trimmed === "status") {
        const s = state.getState();
        if (!s?.active) {
          ctx.ui.notify("No active supervision. Use /supervise <outcome> to start.", "info");
          return;
        }
        const result = await openSettings(ctx, s, DEFAULT_PROVIDER, DEFAULT_MODEL_ID, DEFAULT_SENSITIVITY);
        if (result?.model) {
          if (state.isActive()) state.setModel(result.model.provider, result.model.modelId);
          saveWorkspaceModel(ctx.cwd, result.model.provider, result.model.modelId);
        }
        if (result?.sensitivity && state.isActive()) state.setSensitivity(result.sensitivity);
        if (result?.widget !== undefined && result.widget !== isWidgetVisible()) toggleWidget();
        if (result?.action === "stop" && state.isActive()) {
          state.stop();
          idleSteers = 0;
        }
        updateUI(ctx, state.getState());
        return;
      }

      if (trimmed === "model" || trimmed.startsWith("model ")) {
        const spec = trimmed.slice(5).trim();

        if (!spec) {
          const s = state.getState();
          const picked = await pickModel(ctx, s?.provider, s?.modelId);
          if (!picked) return;

          const provider = picked.provider;
          const modelId = picked.id;

          if (state.isActive()) {
            state.setModel(provider, modelId);
            updateUI(ctx, state.getState());
          }
          const saved = saveWorkspaceModel(ctx.cwd, provider, modelId);
          ctx.ui.notify(
            `Supervisor model set to ${provider}/${modelId}${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
              (saved ? " · saved to .pi/" : ""),
            "info"
          );
          return;
        }

        const slashIdx = spec.indexOf("/");
        let provider: string;
        let modelId: string;
        if (slashIdx === -1) {
          provider = state.getState()?.provider ?? DEFAULT_PROVIDER;
          modelId = spec;
        } else {
          provider = spec.slice(0, slashIdx);
          modelId = spec.slice(slashIdx + 1);
        }

        if (state.isActive()) {
          state.setModel(provider, modelId);
          updateUI(ctx, state.getState());
        }
        const saved = saveWorkspaceModel(ctx.cwd, provider, modelId);
        ctx.ui.notify(
          `Supervisor model set to ${provider}/${modelId}${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
            (saved ? " · saved to .pi/" : ""),
          "info"
        );
        return;
      }

      if (trimmed.startsWith("sensitivity ")) {
        const level = trimmed.slice(12).trim() as Sensitivity;
        if (level !== "low" && level !== "medium" && level !== "high") {
          ctx.ui.notify("Usage: /supervise sensitivity <low|medium|high>", "warning");
          return;
        }
        if (!state.isActive()) {
          ctx.ui.notify(`Sensitivity will be set to "${level}" on next /supervise.`, "info");
        } else {
          state.setSensitivity(level);
          updateUI(ctx, state.getState());
          ctx.ui.notify(`Supervisor sensitivity set to "${level}"`, "info");
        }
        return;
      }

      if (!trimmed || trimmed === "settings") {
        const s = state.getState();
        const result = await openSettings(ctx, s, DEFAULT_PROVIDER, DEFAULT_MODEL_ID, DEFAULT_SENSITIVITY);
        if (!result) return;

        if (result.model) {
          const { provider: p, modelId: m } = result.model;
          if (state.isActive()) {
            state.setModel(p, m);
          }
          const saved = saveWorkspaceModel(ctx.cwd, p, m);
          ctx.ui.notify(
            `Supervisor model set to ${p}/${m}${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
              (saved ? " · saved to .pi/" : ""),
            "info"
          );
        }

        if (result.sensitivity) {
          if (state.isActive()) {
            state.setSensitivity(result.sensitivity);
          }
          ctx.ui.notify(`Supervisor sensitivity set to "${result.sensitivity}"`, "info");
        }

        if (result.widget !== undefined) {
          const currentlyVisible = isWidgetVisible();
          if (result.widget !== currentlyVisible) {
            toggleWidget();
          }
        }

        if (result.action === "stop" && state.isActive()) {
          state.stop();
          idleSteers = 0;
          ctx.ui.notify("Supervisor stopped.", "info");
        }

        updateUI(ctx, state.getState());
        return;
      }

      const existing = state.getState();
      const workspaceModel = loadWorkspaceModel(ctx.cwd);
      const sessionModel = ctx.model;
      let provider = existing?.provider ?? workspaceModel?.provider ?? sessionModel?.provider ?? DEFAULT_PROVIDER;
      let modelId = existing?.modelId ?? workspaceModel?.modelId ?? sessionModel?.id ?? DEFAULT_MODEL_ID;
      const sensitivity = existing?.sensitivity ?? DEFAULT_SENSITIVITY;

      if (!existing) {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
        if (!apiKey) {
          ctx.ui.notify(`No API key for "${provider}/${modelId}" — pick a model with an available key.`, "warning");
          const picked = await pickModel(ctx, provider, modelId);
          if (!picked) return;
          provider = picked.provider;
          modelId = picked.id;
        }
      }

      state.start(trimmed, provider, modelId, sensitivity);
      idleSteers = 0;
      updateUI(ctx, state.getState());
      await pi.sendMessage(createSupervisorActivationMessage(trimmed));

      const { source } = loadSystemPrompt(ctx.cwd);
      const promptLabel = source === "built-in" ? "built-in prompt" : source.replace(ctx.cwd, ".");
      ctx.ui.notify(
        `Supervisor active: "${trimmed.slice(0, 50)}${trimmed.length > 50 ? "…" : ""}" | ${provider}/${modelId} | ${promptLabel}`,
        "info"
      );
    },
  });
}
