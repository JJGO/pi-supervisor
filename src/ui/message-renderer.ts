/**
 * Chat rendering for supervisor-originated messages.
 *
 * We prefix the raw message content with [Supervisor] so the supervised agent
 * can identify the source in its context, then strip that prefix in the TUI
 * and replace it with a clearer visual treatment for humans.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import type { SupervisorChatMessageDetails } from "../types.js";

export const SUPERVISOR_MESSAGE_TYPE = "supervisor-message";
export const SUPERVISOR_PREFIX = "[Supervisor]";

function extractText(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function stripSupervisorPrefix(text: string): string {
  return text.startsWith(SUPERVISOR_PREFIX) ? text.slice(SUPERVISOR_PREFIX.length).trim() : text;
}

const DARK_CYAN_BG = "\u001b[48;2;16;86;92m";
const SUPERVISOR_TEXT_FG = "\u001b[38;2;255;244;230m";
const RESET_BG = "\u001b[49m";
const RESET_FG = "\u001b[39m";

function withSupervisorBackground(text: string): string {
  return `${DARK_CYAN_BG}${text}${RESET_BG}`;
}

function withSupervisorText(text: string): string {
  return `${SUPERVISOR_TEXT_FG}${text}${RESET_FG}`;
}

export function registerSupervisorMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<SupervisorChatMessageDetails>(SUPERVISOR_MESSAGE_TYPE, (message, _options, theme) => {
    const details = message.details;
    const kind = details?.kind ?? "reply";
    const body = details?.body ?? stripSupervisorPrefix(extractText(message.content as string | { type: string; text?: string }[]));
    const title = kind === "activation" ? "🤖 Supervisor active" : "🤖 Supervisor replied";

    const box = new Box(1, 1, withSupervisorBackground);
    box.addChild(new Text(`${theme.bold(withSupervisorText(title))}\n${withSupervisorText(body)}`, 0, 0));
    return box;
  });
}

export function createSupervisorActivationMessage(outcome: string) {
  const body = `Supervision is now active for goal "${outcome}"`;
  return {
    customType: SUPERVISOR_MESSAGE_TYPE,
    content: `${SUPERVISOR_PREFIX} Supervision is now active. Goal: ${outcome}`,
    display: true,
    details: {
      kind: "activation" as const,
      body,
    },
  };
}

export function createSupervisorReplyMessage(message: string) {
  return {
    customType: SUPERVISOR_MESSAGE_TYPE,
    content: `${SUPERVISOR_PREFIX} ${message}`,
    display: true,
    details: {
      kind: "reply" as const,
      body: message,
    },
  };
}
