import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { createChatTab } from "./chat.js";

const TAB_ID = "ai-chat";

function BotIcon(props: { className?: string }) {
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </svg>
  );
}

export function activate(app: TermixApp): void {
  app.registerRailItem({
    id: TAB_ID,
    icon: BotIcon,
    titleKey: "tab.title",
    kind: "tab",
    permission: "use",
  });
  app.registerTab(TAB_ID, createChatTab(app), {
    icon: BotIcon,
    titleKey: "tab.title",
    singleton: true,
    hostless: true,
  });
}
