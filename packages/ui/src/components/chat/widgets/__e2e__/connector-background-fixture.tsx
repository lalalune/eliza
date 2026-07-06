/**
 * Render fixture for chat-native connector setup and background picker widgets.
 * It mounts the real `MessageContent` parsing path for `[CONFIG:telegram]` and
 * `[BACKGROUND]` so screenshots prove the same widget tree the live transcript
 * renders. The runner supplies browser shims for shell/runtime-only imports.
 */

import type { PluginParamDef } from "@elizaos/shared";
import { createRoot } from "react-dom/client";
import type { ConversationMessage } from "../../../../api/client-types-chat";
import type { PluginInfo } from "../../../../api/client-types-config";
import { MessageContent } from "../../MessageContent";

function param(
  over: Partial<PluginParamDef> & { key: string },
): PluginParamDef {
  return {
    type: "string",
    description: "",
    required: false,
    sensitive: false,
    currentValue: null,
    isSet: false,
    ...over,
  };
}

export const TELEGRAM_PLUGIN: PluginInfo = {
  id: "telegram",
  name: "Telegram",
  description: "Telegram bot connector",
  enabled: false,
  configured: false,
  envKey: null,
  category: "connector",
  source: "bundled",
  icon: "\u{1F4AC}",
  parameters: [
    param({
      key: "TELEGRAM_BOT_TOKEN",
      description: "Bot token from @BotFather",
      required: true,
      sensitive: true,
    }),
    param({ key: "TELEGRAM_API_ROOT", description: "API root override" }),
    param({
      key: "TELEGRAM_ALLOWED_CHATS",
      description: "Comma-separated chat allowlist",
    }),
  ],
  validationErrors: [],
  validationWarnings: [],
};

function assistant(id: string, text: string): ConversationMessage {
  return {
    id,
    role: "assistant",
    text,
    timestamp: 1_783_317_600_000,
  } as ConversationMessage;
}

function Fixture() {
  return (
    <main
      data-testid="connector-background-fixture"
      className="min-h-screen bg-bg p-4 text-txt"
    >
      <section className="mx-auto flex max-w-xl flex-col gap-4">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-muted">
            Connector setup from chat
          </div>
          <MessageContent
            message={assistant(
              "connector",
              "Let's set Telegram up.\n\n[CONFIG:telegram]",
            )}
          />
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-muted">
            Background picker from chat
          </div>
          <MessageContent
            message={assistant(
              "background",
              "Here are your background options.\n\n[BACKGROUND]",
            )}
          />
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
