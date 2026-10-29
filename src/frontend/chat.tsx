import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useSettings,
  useTranslation,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Badge,
  Button,
  Input,
  PanelShell,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";

type Translate = (key: string) => string;

interface ChatSummary {
  id: number;
  title: string;
  approvalMode: string;
}

interface ToolCallView {
  id: string;
  hostId: number;
  command: string;
  state: "pending" | "approved" | "denied" | "done";
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
  error?: string;
}

interface StoredMessage {
  id: number;
  seq: number;
  role: string;
  parts: {
    text?: string;
    thinking?: string;
    toolCalls?: Array<{ id: string; hostId: number; command: string }>;
    toolCallId?: string;
    hostId?: number;
    command?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    truncated?: boolean;
    timedOut?: boolean;
    denied?: boolean;
    error?: string;
  };
}

interface ModelOption {
  id: string;
  name: string;
}

interface LiveState {
  text: string;
  toolCards: ToolCallView[];
  error: string | null;
}

type ApprovalMode = "ask" | "auto-safe" | "auto";
type Effort = "none" | "low" | "medium" | "high";

const EFFORTS: Effort[] = ["none", "low", "medium", "high"];
const APPROVAL_MODES: ApprovalMode[] = ["ask", "auto-safe", "auto"];

/** Renders assistant text with fenced code blocks; deliberately tiny. */
function AssistantText({ text }: { text: string }) {
  const segments = text.split(/```/);
  return (
    <div className="flex flex-col gap-2 text-sm">
      {segments.map((segment, index) =>
        index % 2 === 1 ? (
          <pre
            key={index}
            className="overflow-x-auto rounded-md border border-border bg-muted p-2 text-xs"
          >
            <code>{segment.replace(/^[a-zA-Z0-9_-]*\n/, "")}</code>
          </pre>
        ) : segment.trim() ? (
          <p key={index} className="whitespace-pre-wrap">
            {segment}
          </p>
        ) : null,
      )}
    </div>
  );
}

function ToolCard({ card, t }: { card: ToolCallView; t: Translate }) {
  const [open, setOpen] = useState(false);
  const done = card.state === "done";
  const failed = done && ((card.exitCode ?? 0) !== 0 || !!card.error);
  const output = [card.stdout, card.stderr]
    .filter((part) => part?.trim())
    .join("\n");
  return (
    <div className="rounded-md border border-border bg-card p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="break-all font-mono">{card.command}</span>
        <Badge variant={failed ? "destructive" : "secondary"}>
          {card.state === "pending"
            ? t("tab.tool.running")
            : card.state === "denied"
              ? t("tab.tool.denied")
              : done
                ? `${t("tab.tool.exit")} ${card.exitCode ?? "—"}`
                : t("tab.tool.running")}
        </Badge>
      </div>
      {card.error && <p className="mt-1 text-destructive">{card.error}</p>}
      {card.timedOut && (
        <p className="mt-1 text-destructive">{t("tab.tool.timedOut")}</p>
      )}
      {output.trim() && (
        <>
          <button
            type="button"
            className="mt-1 text-muted-foreground underline"
            onClick={() => setOpen(!open)}
          >
            {t("tab.tool.output")}
          </button>
          {open && (
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">
              {output}
              {card.truncated ? `\n${t("tab.tool.truncated")}` : ""}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/** Reads a stream of `data: {...}` SSE events. */
async function* parseSse(
  response: Response,
): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const dataLines = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
      if (dataLines.length > 0) {
        try {
          yield JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
        } catch {
          // Skip malformed events.
        }
      }
      index = buffer.indexOf("\n\n");
    }
  }
}

/** Props both a tab and a sidebar panel provide (all optional). */
interface SurfaceProps {
  isVisible?: boolean;
  active?: boolean;
}

export function createChatTab(app: TermixApp) {
  return function AiChatTab(_props: SurfaceProps) {
    const { t } = useTranslation();
    const confirm = useConfirm();
    const settings = useSettings("user");

    const [chats, setChats] = useState<ChatSummary[]>([]);
    const [activeId, setActiveId] = useState<number | null>(null);
    const [messages, setMessages] = useState<StoredMessage[]>([]);
    const [draft, setDraft] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [runId, setRunId] = useState<string | null>(null);
    const [runStatus, setRunStatus] = useState<string | null>(null);
    const [live, setLive] = useState<LiveState>({
      text: "",
      toolCards: [],
      error: null,
    });
    const [sshPrompt, setSshPrompt] = useState<{
      promptId: string;
      hostId: number;
      prompt: string;
      echo: boolean;
    } | null>(null);
    const [promptAnswer, setPromptAnswer] = useState("");
    const [approval, setApproval] = useState<{
      toolCallId: string;
      hostId: number;
      command: string;
    } | null>(null);
    const [models, setModels] = useState<ModelOption[]>([]);
    const [modelsError, setModelsError] = useState(false);
    const [model, setModel] = useState("");
    const [modelQuery, setModelQuery] = useState("");
    const [modelOpen, setModelOpen] = useState(false);
    const [effort, setEffort] = useState<Effort>("none");
    const [approvalMode, setApprovalMode] = useState<ApprovalMode>("ask");
    const streamRef = useRef<AbortController | null>(null);
    const activeIdRef = useRef<number | null>(null);
    activeIdRef.current = activeId;

    const defaultModel =
      typeof settings.values.model === "string" ? settings.values.model : "";
    const defaultEffort = EFFORTS.includes(
      settings.values.reasoningEffort as Effort,
    )
      ? (settings.values.reasoningEffort as Effort)
      : "none";
    const defaultMode = APPROVAL_MODES.includes(
      settings.values.defaultApprovalMode as ApprovalMode,
    )
      ? (settings.values.defaultApprovalMode as ApprovalMode)
      : "ask";

    // Defaults are read once, when the tab mounts.
    const [initial] = useState({ model: defaultModel, effort: defaultEffort });
    useEffect(() => {
      setModel(initial.model);
      setEffort(initial.effort);
    }, [initial]);

    const loadChats = useCallback(async () => {
      try {
        const { data } = await app.api.get<{ chats: ChatSummary[] }>("/chats");
        setChats(data.chats);
        return data.chats;
      } catch {
        setError(t("tab.error"));
        return [];
      }
    }, [app, t]);

    const openChat = useCallback(
      async (chatId: number) => {
        streamRef.current?.abort();
        setActiveId(chatId);
        setLive({ text: "", toolCards: [], error: null });
        setApproval(null);
        setSshPrompt(null);
        setRunId(null);
        setRunStatus(null);
        setError(null);
        try {
          const { data } = await app.api.get<{
            chat: ChatSummary;
            messages: StoredMessage[];
          }>(`/chats/${chatId}/messages`);
          setMessages(data.messages);
          setApprovalMode(
            APPROVAL_MODES.includes(data.chat.approvalMode as ApprovalMode)
              ? (data.chat.approvalMode as ApprovalMode)
              : "ask",
          );
        } catch {
          setError(t("tab.error"));
        }
      },
      [app, t],
    );

    useEffect(() => {
      void loadChats();
    }, [loadChats]);

    useEffect(() => {
      let cancelled = false;
      const load = async () => {
        try {
          const { data } = await app.api.get<{ models: ModelOption[] }>(
            "/models",
          );
          if (!cancelled) {
            // Alphabetical by display name, deduplicated by id.
            const seen = new Set<string>();
            const sorted = [...data.models]
              .sort((a, b) => a.name.localeCompare(b.name))
              .filter((option) => {
                if (seen.has(option.id)) return false;
                seen.add(option.id);
                return true;
              });
            setModels(sorted);
            setModelsError(false);
          }
        } catch {
          if (!cancelled) setModelsError(true);
        }
      };
      void load();
      return () => {
        cancelled = true;
      };
    }, [app]);

    const filteredModels = useMemo(() => {
      const query = modelQuery.trim().toLowerCase();
      if (!query) return models;
      return models.filter((option) =>
        `${option.name} ${option.id}`.toLowerCase().includes(query),
      );
    }, [models, modelQuery]);
    const selectedModel = models.find((option) => option.id === model);

    const openStream = useCallback(
      async (id: string) => {
        const controller = new AbortController();
        streamRef.current = controller;
        let finished = false;
        try {
          const response = await app.fetch(`/runs/${id}/stream`, {
            signal: controller.signal,
          });
          for await (const event of parseSse(response)) {
            const type = event.type as string;
            if (type === "text" && typeof event.delta === "string") {
              const delta = event.delta;
              setLive((prev) => ({ ...prev, text: prev.text + delta }));
            } else if (type === "tool_call") {
              setLive((prev) => ({
                ...prev,
                toolCards: [
                  ...prev.toolCards,
                  {
                    id: String(event.toolCallId),
                    hostId: Number(event.hostId),
                    command: String(event.command),
                    state: "pending",
                  },
                ],
              }));
            } else if (type === "approval_request") {
              setApproval({
                toolCallId: String(event.toolCallId),
                hostId: Number(event.hostId),
                command: String(event.command),
              });
            } else if (type === "approval_resolved") {
              const toolCallId = String(event.toolCallId);
              const decision =
                event.decision === "approved" ? "approved" : "denied";
              setApproval((prev) =>
                prev?.toolCallId === toolCallId ? null : prev,
              );
              setLive((prev) => ({
                ...prev,
                toolCards: prev.toolCards.map((card) =>
                  card.id === toolCallId && card.state === "pending"
                    ? { ...card, state: decision as ToolCallView["state"] }
                    : card,
                ),
              }));
            } else if (type === "ssh_prompt") {
              setSshPrompt({
                promptId: String(event.promptId),
                hostId: Number(event.hostId),
                prompt: String(event.prompt),
                echo: event.echo === true,
              });
              setPromptAnswer("");
            } else if (type === "ssh_prompt_resolved") {
              const promptId = String(event.promptId);
              setSshPrompt((prev) =>
                prev?.promptId === promptId ? null : prev,
              );
            } else if (type === "tool_result") {
              const toolCallId = String(event.toolCallId);
              setLive((prev) => ({
                ...prev,
                toolCards: prev.toolCards.map((card) =>
                  card.id === toolCallId
                    ? {
                        ...card,
                        state: "done",
                        stdout:
                          typeof event.stdout === "string" ? event.stdout : "",
                        stderr:
                          typeof event.stderr === "string" ? event.stderr : "",
                        exitCode:
                          typeof event.exitCode === "number"
                            ? event.exitCode
                            : null,
                        timedOut: event.timedOut === true,
                        truncated: event.truncated === true,
                        error:
                          typeof event.error === "string"
                            ? event.error
                            : undefined,
                      }
                    : card,
                ),
              }));
            } else if (type === "error" && typeof event.message === "string") {
              const message = event.message;
              setLive((prev) => ({ ...prev, error: message }));
            } else if (type === "status" && typeof event.status === "string") {
              setRunStatus(event.status);
            } else if (type === "done") {
              finished = true;
              break;
            }
          }
        } catch {
          // Aborted or network failure; the next refresh shows the state.
        } finally {
          streamRef.current = null;
          setRunId(null);
          setRunStatus(null);
          setApproval(null);
          setSshPrompt(null);
          if (finished && activeIdRef.current != null) {
            try {
              const { data } = await app.api.get<{ messages: StoredMessage[] }>(
                `/chats/${activeIdRef.current}/messages`,
              );
              setMessages(data.messages);
            } catch {
              // Keep what the events showed when the refresh fails.
            }
            void loadChats();
          }
          setLive({ text: "", toolCards: [], error: null });
        }
      },
      [app, loadChats],
    );

    const send = async () => {
      const text = draft.trim();
      if (!text || activeId == null || runId) return;
      setDraft("");
      setError(null);
      try {
        const { data } = await app.api.post<{ runId: string }>(
          `/chats/${activeId}/messages`,
          {
            text,
            model: model || undefined,
            effort,
          },
        );
        setRunId(data.runId);
        setRunStatus("running");
        setLive({ text: "", toolCards: [], error: null });
        void openStream(data.runId);
      } catch (caught) {
        const payload =
          typeof caught === "object" && caught !== null && "response" in caught
            ? (caught as { response?: { data?: { error?: string } } }).response
                ?.data
            : undefined;
        setError(payload?.error || t("tab.error"));
        setDraft(text);
      }
    };

    const decide = async (decision: "approved" | "denied") => {
      if (!runId || !approval) return;
      try {
        await app.api.post(`/runs/${runId}/approvals/${approval.toolCallId}`, {
          decision,
        });
      } catch {
        // The approval may have timed out; the run continues either way.
      }
    };

    const answerPrompt = async (giveUp: boolean) => {
      if (!runId || !sshPrompt) return;
      try {
        await app.api.post(`/runs/${runId}/prompts/${sshPrompt.promptId}`, {
          answer: giveUp ? null : promptAnswer,
        });
        setSshPrompt((prev) =>
          prev?.promptId === sshPrompt.promptId ? null : prev,
        );
        setPromptAnswer(``);
      } catch {
        // The prompt may have timed out; the run continues either way.
      }
    };

    const stop = async () => {
      if (!runId) return;
      try {
        await app.api.post(`/runs/${runId}/cancel`);
      } catch {
        // Already finished.
      }
    };

    const newChat = async () => {
      try {
        const { data } = await app.api.post<{ chat: ChatSummary }>("/chats", {
          approvalMode: defaultMode,
        });
        await loadChats();
        await openChat(data.chat.id);
      } catch {
        setError(t("tab.error"));
      }
    };

    const removeChat = async (chatId: number) => {
      const ok = await confirm({
        title: t("tab.delete"),
        description: t("tab.deleteConfirm"),
      });
      if (!ok) return;
      try {
        await app.api.delete(`/chats/${chatId}`);
        if (activeId === chatId) {
          setActiveId(null);
          setMessages([]);
        }
        await loadChats();
      } catch {
        setError(t("tab.error"));
      }
    };

    const changeMode = async (mode: ApprovalMode) => {
      setApprovalMode(mode);
      if (activeId == null) return;
      try {
        await app.api.patch(`/chats/${activeId}`, { approvalMode: mode });
      } catch {
        setError(t("tab.error"));
      }
    };

    return (
      <PanelShell
        icon={<BotGlyph />}
        title={t("tab.title")}
        scroll={false}
        toolbar={
          <div className="flex items-center gap-2">
            <Popover open={modelOpen} onOpenChange={setModelOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex h-7 w-64 items-center justify-between gap-2 rounded-md border border-border bg-transparent px-2 text-xs hover:bg-muted/50"
                  title={t("tab.model.label")}
                >
                  <span className="truncate">
                    {selectedModel
                      ? selectedModel.name
                      : model || t("tab.model.label")}
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-3 shrink-0 opacity-50"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-1" align="start">
                <Input
                  value={modelQuery}
                  onChange={(event) => setModelQuery(event.target.value)}
                  placeholder={t("tab.model.search")}
                  className="mb-1 h-7 text-xs"
                  autoFocus
                />
                <div className="max-h-64 overflow-y-auto">
                  {models.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      {modelsError
                        ? t("tab.model.error")
                        : t("tab.model.loading")}
                    </p>
                  ) : filteredModels.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      {t("tab.model.none")}
                    </p>
                  ) : (
                    filteredModels.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`flex w-full flex-col items-start rounded px-2 py-1 text-left text-xs hover:bg-muted ${
                          option.id === model ? "bg-muted" : ""
                        }`}
                        onClick={() => {
                          setModel(option.id);
                          setModelOpen(false);
                          setModelQuery("");
                        }}
                      >
                        <span className="w-full truncate">{option.name}</span>
                        <span className="w-full truncate text-muted-foreground">
                          {option.id}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </PopoverContent>
            </Popover>
            <Select
              value={effort}
              onValueChange={(value) => setEffort(value as Effort)}
            >
              <SelectTrigger className="h-7 w-28 text-xs" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFORTS.map((value) => (
                  <SelectItem key={value} value={value} className="text-xs">
                    {t(`tab.effort.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={approvalMode}
              onValueChange={(value) => void changeMode(value as ApprovalMode)}
            >
              <SelectTrigger className="h-7 w-40 text-xs" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APPROVAL_MODES.map((value) => (
                  <SelectItem key={value} value={value} className="text-xs">
                    {t(
                      `tab.approvalMode.${
                        value === "ask"
                          ? "ask"
                          : value === "auto-safe"
                            ? "autoSafe"
                            : "auto"
                      }`,
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      >
        <div className="flex h-full">
          <aside className="flex w-56 shrink-0 flex-col border-r border-border">
            <div className="p-2">
              <Button className="w-full" onClick={() => void newChat()}>
                {t("tab.newChat")}
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {chats.map((chat) => (
                <div
                  key={chat.id}
                  className={`group flex items-center gap-1 px-2 py-1.5 text-sm ${
                    chat.id === activeId
                      ? "bg-muted font-medium"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <button
                    type="button"
                    className="flex-1 truncate text-left"
                    onClick={() => void openChat(chat.id)}
                  >
                    {chat.title || t("tab.chat.untitled")}
                  </button>
                  <button
                    type="button"
                    aria-label={t("tab.delete")}
                    className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => void removeChat(chat.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {chats.length === 0 && (
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  {t("tab.noChats")}
                </p>
              )}
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto p-3">
              {activeId == null ? (
                <p className="text-sm text-muted-foreground">
                  {t("tab.empty")}
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {messages.map((message) => (
                    <MessageRow key={message.id} message={message} t={t} />
                  ))}
                  {live.toolCards.map((card) => (
                    <ToolCard key={card.id} card={card} t={t} />
                  ))}
                  {sshPrompt && (
                    <div className="rounded-md border border-border bg-card p-3 text-sm">
                      <p className="mb-2 font-medium">
                        {t("tab.prompt.title")}
                      </p>
                      <p className="mb-1 text-xs text-muted-foreground">
                        {t("tab.tool.host")}: {sshPrompt.hostId}
                      </p>
                      <p className="mb-1 break-all text-xs text-muted-foreground">
                        {sshPrompt.prompt}
                      </p>
                      <Input
                        type={sshPrompt.echo ? "text" : "password"}
                        value={promptAnswer}
                        placeholder={t("tab.prompt.placeholder")}
                        className="mb-1 h-8 text-xs"
                        onChange={(event) =>
                          setPromptAnswer(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void answerPrompt(false);
                          }
                        }}
                        autoFocus
                      />
                      {!sshPrompt.echo && (
                        <p className="mb-2 text-xs text-muted-foreground">
                          {t("tab.prompt.secret")}
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={!promptAnswer.trim()}
                          onClick={() => void answerPrompt(false)}
                        >
                          {t("tab.prompt.submit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void answerPrompt(true)}
                        >
                          {t("tab.prompt.cancel")}
                        </Button>
                      </div>
                    </div>
                  )}
                  {approval && (
                    <div className="rounded-md border border-border bg-card p-3 text-sm">
                      <p className="mb-2 font-medium">
                        {t("tab.approval.title")}
                      </p>
                      <p className="mb-1 text-xs text-muted-foreground">
                        {t("tab.tool.host")}: {approval.hostId}
                      </p>
                      <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
                        {approval.command}
                      </pre>
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => void decide("approved")}
                        >
                          {t("tab.approval.run")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void decide("denied")}
                        >
                          {t("tab.approval.deny")}
                        </Button>
                      </div>
                    </div>
                  )}
                  {live.text && (
                    <div className="text-sm">
                      <AssistantText text={live.text} />
                    </div>
                  )}
                  {(runStatus === "running" ||
                    runStatus === "waiting-approval") &&
                    !live.text &&
                    live.toolCards.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        {t("tab.thinking")}
                      </p>
                    )}
                  {live.error && (
                    <p className="text-sm text-destructive">{live.error}</p>
                  )}
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              )}
            </div>

            {activeId != null && (
              <div className="flex gap-2 border-t border-border p-2">
                <textarea
                  className="max-h-40 min-h-9 flex-1 resize-y rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                  value={draft}
                  placeholder={t("tab.placeholder")}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  disabled={!!runId}
                />
                {runId ? (
                  <Button variant="outline" onClick={() => void stop()}>
                    {t("tab.stop")}
                  </Button>
                ) : (
                  <Button onClick={() => void send()} disabled={!draft.trim()}>
                    {t("tab.send")}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </PanelShell>
    );
  };
}

function MessageRow({ message, t }: { message: StoredMessage; t: Translate }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">
          {message.parts.text}
        </div>
      </div>
    );
  }
  if (message.role === "assistant") {
    return (
      <div className="flex flex-col gap-2">
        {message.parts.text ? (
          <AssistantText text={message.parts.text} />
        ) : null}
        {(message.parts.toolCalls ?? []).map((call) => (
          <div
            key={call.id}
            className="rounded-md border border-border bg-card p-2 text-xs"
          >
            <span className="break-all font-mono">{call.command}</span>
            <span className="ml-2 text-muted-foreground">
              {t("tab.tool.host")} {call.hostId}
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (message.role === "tool") {
    const card: ToolCallView = {
      id: message.parts.toolCallId ?? String(message.id),
      hostId: message.parts.hostId ?? 0,
      command: message.parts.command ?? "",
      state: message.parts.denied ? "denied" : "done",
      stdout: message.parts.stdout,
      stderr: message.parts.stderr,
      exitCode: message.parts.exitCode,
      timedOut: message.parts.timedOut,
      truncated: message.parts.truncated,
      error: message.parts.error,
    };
    return <ToolCard card={card} t={t} />;
  }
  return null;
}

function BotGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </svg>
  );
}
