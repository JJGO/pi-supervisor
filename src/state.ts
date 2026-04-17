/**
 * SupervisorStateManager — manages in-memory supervisor state and session persistence.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  SupervisorState,
  SupervisorIntervention,
  Sensitivity,
  SupervisorSessionConfig,
} from "./types.js";

const STATE_ENTRY_TYPE = "supervisor-state";
const CONFIG_ENTRY_TYPE = "supervisor-config";

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL_ID = "claude-haiku-4-5-20251001";
export const DEFAULT_SENSITIVITY: Sensitivity = "medium";

const DEFAULT_CONFIG: SupervisorSessionConfig = {
  toolEnabled: false,
};

export class SupervisorStateManager {
  private state: SupervisorState | null = null;
  private config: SupervisorSessionConfig = { ...DEFAULT_CONFIG };
  private pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  start(outcome: string, provider: string, modelId: string, sensitivity: Sensitivity): void {
    this.state = {
      active: true,
      outcome,
      provider,
      modelId,
      sensitivity,
      interventions: [],
      startedAt: Date.now(),
      turnCount: 0,
      pausedUntilHuman: false,
    };
    this.persistState();
  }

  stop(): void {
    if (!this.state) return;
    this.state.active = false;
    this.state.pausedUntilHuman = false;
    this.persistState();
  }

  isActive(): boolean {
    return this.state?.active === true;
  }

  getState(): SupervisorState | null {
    return this.state;
  }

  addIntervention(intervention: SupervisorIntervention): void {
    if (!this.state) return;
    this.state.interventions.push(intervention);
    this.persistState();
  }

  incrementTurnCount(): void {
    if (!this.state) return;
    this.state.turnCount++;
    this.persistState();
  }

  setModel(provider: string, modelId: string): void {
    if (!this.state) return;
    this.state.provider = provider;
    this.state.modelId = modelId;
    this.persistState();
  }

  setSensitivity(sensitivity: Sensitivity): void {
    if (!this.state) return;
    this.state.sensitivity = sensitivity;
    this.persistState();
  }

  setPausedUntilHuman(pausedUntilHuman: boolean): void {
    if (!this.state) return;
    this.state.pausedUntilHuman = pausedUntilHuman;
    this.persistState();
  }

  isPausedUntilHuman(): boolean {
    return this.state?.pausedUntilHuman === true;
  }

  setToolEnabled(toolEnabled: boolean): void {
    this.config = { toolEnabled };
    this.persistConfig();
  }

  isToolEnabled(): boolean {
    return this.config.toolEnabled === true;
  }

  /** Restore state from session entries (finds the most recent config + supervisor-state entries). */
  loadFromSession(ctx: ExtensionContext): void {
    let restoredState: SupervisorState | null = null;
    let restoredConfig: SupervisorSessionConfig = { ...DEFAULT_CONFIG };
    let foundState = false;
    let foundConfig = false;

    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom") continue;

      const customType = (entry as any).customType;
      if (!foundState && customType === STATE_ENTRY_TYPE) {
        restoredState = this.normalizeState((entry as any).data);
        foundState = true;
      }
      if (!foundConfig && customType === CONFIG_ENTRY_TYPE) {
        restoredConfig = this.normalizeConfig((entry as any).data);
        foundConfig = true;
      }
      if (foundState && foundConfig) break;
    }

    this.state = restoredState;
    this.config = restoredConfig;
  }

  private normalizeState(data: unknown): SupervisorState | null {
    if (!data || typeof data !== "object") return null;

    const state = data as Partial<SupervisorState>;
    if (
      typeof state.outcome !== "string" ||
      typeof state.provider !== "string" ||
      typeof state.modelId !== "string" ||
      (state.sensitivity !== "low" && state.sensitivity !== "medium" && state.sensitivity !== "high") ||
      !Array.isArray(state.interventions) ||
      typeof state.startedAt !== "number" ||
      typeof state.turnCount !== "number"
    ) {
      return null;
    }

    return {
      active: state.active === true,
      outcome: state.outcome,
      provider: state.provider,
      modelId: state.modelId,
      sensitivity: state.sensitivity,
      interventions: state.interventions as SupervisorIntervention[],
      startedAt: state.startedAt,
      turnCount: state.turnCount,
      pausedUntilHuman: state.pausedUntilHuman === true,
    };
  }

  private normalizeConfig(data: unknown): SupervisorSessionConfig {
    if (!data || typeof data !== "object") return { ...DEFAULT_CONFIG };
    const config = data as Partial<SupervisorSessionConfig>;
    return {
      toolEnabled: config.toolEnabled === true,
    };
  }

  private persistState(): void {
    if (!this.state) return;
    this.pi.appendEntry(STATE_ENTRY_TYPE, { ...this.state });
  }

  private persistConfig(): void {
    this.pi.appendEntry(CONFIG_ENTRY_TYPE, { ...this.config });
  }
}
