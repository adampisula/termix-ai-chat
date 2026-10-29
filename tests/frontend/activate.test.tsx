import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

describe(`${manifest.id} activate`, () => {
  it("registers the rail item and tab", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["agent-chat"]);
    expect(rendered.registered.railItems()).toEqual([
      expect.objectContaining({
        id: "agent-chat",
        permission: "agent-chat.use",
      }),
    ]);
  });

  it("renders the empty tab with a new-chat button", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async (path: string) => {
          if (path === "/models") return { data: { models: [] } };
          return { data: { chats: [] } };
        }),
      } as never,
    });
    rendered.renderTab("agent-chat", { isVisible: true });
    expect(await screen.findByText(locales.tab.newChat)).toBeTruthy();
    expect(screen.getByText(locales.tab.empty)).toBeTruthy();
    expect(screen.getByText(locales.tab.noChats)).toBeTruthy();
  });

  it("renders chats and messages from the API", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async (path: string) => {
          if (path === "/models") {
            return { data: { models: [{ id: "m1", name: "Model One" }] } };
          }
          if (path === "/chats") {
            return {
              data: {
                chats: [{ id: 1, title: "Disk check", approvalMode: "ask" }],
              },
            };
          }
          if (path.startsWith("/chats/1/messages")) {
            return {
              data: {
                chat: { id: 1, title: "Disk check", approvalMode: "ask" },
                messages: [
                  {
                    id: 1,
                    seq: 1,
                    role: "user",
                    parts: { text: "check disk" },
                  },
                  {
                    id: 2,
                    seq: 2,
                    role: "tool",
                    parts: {
                      toolCallId: "t1",
                      hostId: 3,
                      command: "df -h",
                      stdout: "/dev/sda1 90%",
                      exitCode: 0,
                    },
                  },
                  {
                    id: 3,
                    seq: 3,
                    role: "assistant",
                    parts: { text: "Disk is 90% full." },
                  },
                ],
              },
            };
          }
          return { data: {} };
        }),
      } as never,
    });
    rendered.renderTab("agent-chat", { isVisible: true });
    expect(await screen.findByText("Disk check")).toBeTruthy();
    // Click the chat to load it.
    (screen.getByText("Disk check") as HTMLElement).click();
    expect(await screen.findByText("check disk")).toBeTruthy();
    expect(await screen.findByText("Disk is 90% full.")).toBeTruthy();
    expect(screen.getByText("df -h")).toBeTruthy();
    // The model picker shows the placeholder until a model is chosen.
    expect(screen.getByText(locales.tab.model.label)).toBeTruthy();
  });
});
