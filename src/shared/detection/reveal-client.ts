import { isRevealResult, type RevealResult } from "../contracts/reveal";
import { createId } from "../id";
import { createLogger } from "../logger";

const logger = createLogger("content.reveal");

export class RevealClient {
  private pending = new Map<
    string,
    { recordId: string; finish: (result: RevealResult) => void }
  >();
  constructor(
    private options: {
      nonce: string;
      documentId: string;
      post: (message: unknown) => void;
    },
  ) {}

  request(recordId: string): Promise<RevealResult> {
    if (this.pending.size >= 8)
      return Promise.resolve({ status: "REVEAL_FAILED" });
    const requestId = createId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ status: "TIMEOUT" }), 1500);
      const finish = (result: RevealResult) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        logger.debug("Запрос подсветки завершён", { status: result.status });
        resolve(result);
      };
      this.pending.set(requestId, { recordId, finish });
      try {
        this.options.post({
          source: "listener-lens",
          type: "reveal-target",
          nonce: this.options.nonce,
          documentId: this.options.documentId,
          requestId,
          recordId,
        });
      } catch {
        finish({ status: "REVEAL_FAILED" });
      }
    });
  }

  accept(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    if (
      message.source !== "listener-lens" ||
      message.type !== "target-revealed" ||
      message.nonce !== this.options.nonce ||
      message.documentId !== this.options.documentId ||
      typeof message.requestId !== "string" ||
      !isRevealResult(message.result)
    )
      return false;
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.recordId !== message.recordId) return false;
    pending.finish({ status: message.result.status });
    return true;
  }

  cancel(): void {
    for (const request of this.pending.values())
      request.finish({ status: "CANCELLED" });
  }
}
