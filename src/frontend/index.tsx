import type { Disposer, TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { createChatTab } from "./chat.js";

const TAB_ID = "agent-chat";

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

/**
 * Registers the chat where the user's placement setting asks for it: a tab
 * opened from the sidebar rail (default) or a panel that lives in the
 * sidebar. Re-registers when the setting changes.
 */
export async function activate(app: TermixApp): Promise<void> {
  let disposer: Disposer | null = null;
  let token = 0;

  const apply = async () => {
    const mine = ++token;
    let placement = "tab";
    try {
      const { data } = await app.api.get<{ placement?: string }>("/status");
      if (data.placement === "panel") placement = "panel";
    } catch {
      // Without the permission or before the backend answers, default to tab.
    }
    if (mine !== token) return;
    disposer?.();
    disposer = null;
    if (placement === "panel") {
      disposer = app.registerPanel(TAB_ID, createChatTab(app), {
        keepMounted: true,
      });
      return;
    }
    const undoRail = app.registerRailItem({
      id: TAB_ID,
      icon: BotIcon,
      titleKey: "tab.title",
      kind: "tab",
      permission: "use",
    });
    const undoTab = app.registerTab(TAB_ID, createChatTab(app), {
      icon: BotIcon,
      titleKey: "tab.title",
      singleton: true,
      hostless: true,
    });
    disposer = () => {
      undoRail();
      undoTab();
    };
  };

  await apply();
  app.onSettingsChanged(() => void apply());
}
