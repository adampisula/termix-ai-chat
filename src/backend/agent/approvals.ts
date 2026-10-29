/**
 * In-memory pending approvals and active-run bookkeeping.
 *
 * A run that asks for approval blocks on a promise the /approvals route
 * resolves. If nobody answers within the timeout the command is denied, so
 * a forgotten browser tab cannot hold an LLM run open forever. Everything
 * here dies with the plugin process; the conversation itself lives in the
 * database and an interrupted run is simply stopped.
 */

export type ApprovalDecision = "approved" | "denied";

export interface PendingApproval {
  runId: string;
  toolCallId: string;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalRegistry {
  private pending = new Map<string, PendingApproval>();

  wait(
    runId: string,
    toolCallId: string,
    timeoutMs: number,
    onTimeout: () => void,
  ): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key(runId, toolCallId));
        onTimeout();
        resolve("denied");
      }, timeoutMs);
      this.pending.set(key(runId, toolCallId), {
        runId,
        toolCallId,
        resolve,
        timer,
      });
    });
  }

  resolve(
    runId: string,
    toolCallId: string,
    decision: ApprovalDecision,
  ): boolean {
    const entry = this.pending.get(key(runId, toolCallId));
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(key(runId, toolCallId));
    entry.resolve(decision);
    return true;
  }

  /** Rejects everything for a run: used on cancel, disable and shutdown. */
  cancelRun(runId: string): void {
    for (const [k, entry] of [...this.pending.entries()]) {
      if (entry.runId === runId) {
        clearTimeout(entry.timer);
        this.pending.delete(k);
        entry.resolve("denied");
      }
    }
  }

  cancelAll(): void {
    for (const [k, entry] of [...this.pending.entries()]) {
      clearTimeout(entry.timer);
      this.pending.delete(k);
      entry.resolve("denied");
    }
  }

  isPending(runId: string, toolCallId: string): boolean {
    return this.pending.has(key(runId, toolCallId));
  }
}

function key(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}
