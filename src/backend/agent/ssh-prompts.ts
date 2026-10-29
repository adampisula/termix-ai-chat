import { randomUUID } from "node:crypto";

export interface SshPromptRequest {
  kind: "totp" | "input" | "browser";
  prompt: string;
  echo?: boolean;
  isPush?: boolean;
  retry?: boolean;
  // Browser sign-in rounds only; the agent gives up on these.
  label?: string;
  url?: string | null;
  code?: string;
  instructions?: string;
}

export interface SshPromptAskArgs {
  userId: string;
  runId: string;
  hostId: number;
  request: SshPromptRequest;
  emit: (event: Record<string, unknown>) => void;
}

export type SshPromptEmit = (event: Record<string, unknown>) => void;

interface PendingSshPrompt {
  runId: string;
  resolve: (answer: string | null) => void;
}

/**
 * Answers SSH keyboard-interactive prompts (a key passphrase, a password, a
 * TOTP code) by asking the user through the run's event stream.
 *
 * Answers to non-echoing input prompts (passphrases, passwords) are cached
 * per user, host and prompt text, so an encrypted key is unlocked once per
 * plugin session, not once per command. TOTP codes are one-time and are never
 * cached. The pooled connection is what keeps a host reachable without
 * re-prompting in the first place; the cache covers the pool going idle.
 */
export class SshPromptRegistry {
  private pending = new Map<string, PendingSshPrompt>();
  private cache = new Map<string, string>();

  constructor(private readonly timeoutMs: number) {}

  /**
   * Asks the user. `emit` pushes the question to the run's subscribers.
   * Resolves null on timeout or when the user gives up.
   */
  ask(args: SshPromptAskArgs): Promise<string | null> {
    const { userId, runId, hostId, request, emit } = args;
    // Browser sign-in rounds need a browser; the agent cannot do that.
    if (request.kind === "browser") return Promise.resolve(null);
    const cacheKey = this.cacheKey(userId, hostId, request);
    if (cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) return Promise.resolve(cached);
    }
    const promptId = randomUUID();
    emit({
      type: "ssh_prompt",
      promptId,
      hostId,
      kind: request.kind,
      prompt: request.prompt,
      echo: request.kind === "input" ? (request.echo ?? false) : false,
    });
    const key = this.pendingKey(userId, promptId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        emit({ type: "ssh_prompt_resolved", promptId, timeout: true });
        resolve(null);
      }, this.timeoutMs);
      this.pending.set(key, {
        runId,
        resolve: (answer) => {
          clearTimeout(timer);
          if (cacheKey && answer !== null) {
            this.cache.set(cacheKey, answer);
            if (this.cache.size > 100) {
              // Drop the oldest answer; a full cache is better than a leak.
              const oldest = this.cache.keys().next().value;
              if (oldest !== undefined) this.cache.delete(oldest);
            }
          }
          resolve(answer);
        },
      });
    });
  }

  /** Answers a pending prompt. False when there is none under that id. */
  resolve(userId: string, promptId: string, answer: string | null): boolean {
    const key = this.pendingKey(userId, promptId);
    const entry = this.pending.get(key);
    if (!entry) return false;
    this.pending.delete(key);
    entry.resolve(answer);
    return true;
  }

  /** Cancels every prompt of a run: they give up, like an approval denial. */
  cancelRun(runId: string): void {
    for (const [key, entry] of [...this.pending.entries()]) {
      if (entry.runId !== runId) continue;
      this.pending.delete(key);
      entry.resolve(null);
    }
  }

  /** Cancels everything pending (plugin teardown): the prompts give up. */
  cancelAll(): void {
    for (const [key, entry] of [...this.pending.entries()]) {
      this.pending.delete(key);
      entry.resolve(null);
    }
  }

  private pendingKey(userId: string, promptId: string): string {
    return `${userId}:${promptId}`;
  }

  private cacheKey(
    userId: string,
    hostId: number,
    request: SshPromptRequest,
  ): string | null {
    // Only remember secrets the user typed once: passphrases and passwords.
    if (request.kind !== "input" || request.echo || request.isPush) return null;
    if (!request.prompt.trim()) return null;
    return `${userId}:${hostId}:${request.prompt}`;
  }
}
