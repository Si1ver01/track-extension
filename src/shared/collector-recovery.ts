import {
  MAX_COLLECTOR_RECORDS,
  type CollectorReply,
  type CollectorSnapshot,
} from "./contracts/collector";
import type { ListenerRecord } from "./contracts/records";
import { createLogger } from "./logger";
import { safeMetadataId, sanitizeListenerRecord } from "./records/sanitize";

interface CollectorRecoveryOptions {
  documentId: string;
  send(message: Record<string, unknown>): Promise<unknown>;
  install(): Promise<void>;
  stop(): void;
  partial(): boolean;
}

const logger = createLogger("collector.recovery");

export class CollectorRecovery {
  private records = new Map<string, ListenerRecord>();
  private dirty = new Map<string, ListenerRecord>();
  private token?: string;
  private generation = 0;
  private connecting?: Promise<void>;
  private delivering?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private ready = false;
  private paused = false;
  private stopped = false;
  private installed = false;
  private framesDirty = false;
  private navigationDirty = false;
  private navigationId?: string;
  private recordLimitReached = false;
  pattern?: string;

  constructor(private options: CollectorRecoveryOptions) {}

  get status() {
    return {
      documentId: this.options.documentId,
      installed: this.installed && !this.stopped && !this.paused,
    };
  }

  get canChallenge() {
    return !this.stopped && !this.paused;
  }

  accept(value: unknown): void {
    if (this.stopped || !value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    if (message.type === "listener-record") {
      const record = sanitizeListenerRecord(message.record, {
        tabId: 0,
        frameId: 0,
        documentId: this.options.documentId,
      });
      if (!record) return;
      if (
        !this.records.has(record.id) &&
        this.records.size >= MAX_COLLECTOR_RECORDS
      ) {
        const oldest = this.records.keys().next().value!;
        this.records.delete(oldest);
        this.dirty.delete(oldest);
        this.recordLimitReached = true;
      }
      if (record.reasonCodes.includes("RECORD_LIMIT_REACHED"))
        this.recordLimitReached = true;
      this.records.set(record.id, record);
      this.dirty.set(record.id, record);
    } else if (message.type === "context-navigation") {
      this.navigationId = safeMetadataId(message.navigationId);
      this.navigationDirty = true;
    } else return;
    this.flush();
  }

  framesChanged(): void {
    this.framesDirty = true;
    this.flush();
  }

  connect(): Promise<void> {
    if (this.stopped || this.paused) return Promise.resolve();
    if (this.connecting) return this.connecting;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.ready = false;
    this.token = undefined;
    this.delivering = undefined;
    const generation = ++this.generation;
    logger.debug("collector recovery started", {
      documentId: this.options.documentId,
      generation,
      installed: this.installed,
    });
    const connection = this.establish(generation)
      .catch(() => {
        if (!this.isCurrent(generation)) return;
        logger.warn("collector recovery failed", { code: "RECOVERY_FAILED" });
        this.scheduleRetry();
      })
      .finally(() => {
        if (this.connecting === connection) this.connecting = undefined;
        if (this.isCurrent(generation) && this.ready) this.flush();
      });
    this.connecting = connection;
    return connection;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && !this.stopped && !this.paused;
  }

  private async establish(generation: number): Promise<void> {
    const response = (await this.options.send({
      type: "collector-start",
      documentId: this.options.documentId,
      resume: this.installed,
    })) as
      | {
          allowed?: boolean;
          token?: string;
          pattern?: string;
          code?: string;
          recover?: boolean;
        }
      | undefined;
    if (!this.isCurrent(generation)) return;
    if (response?.recover) {
      this.scheduleRetry();
      return;
    }
    if (!response?.allowed || !response.token || !response.pattern) {
      logger.warn("collector authorization denied", {
        code: response?.code ?? "AUTHORIZATION_DENIED",
      });
      this.stop();
      return;
    }
    this.token = response.token;
    this.pattern = response.pattern;
    if (!this.installed) {
      try {
        await this.options.install();
      } catch {
        if (!this.isCurrent(generation)) return;
        logger.warn("bridge installation failed", { code: "INSTALL_FAILED" });
        void this.options
          .send({
            type: "collector-failed",
            documentId: this.options.documentId,
            token: this.token,
          })
          .catch(() => undefined);
        this.stop();
        return;
      }
      if (!this.stopped) this.installed = true;
      if (!this.isCurrent(generation)) return;
    }
    const records = [...this.records.values()];
    this.dirty.clear();
    this.framesDirty = false;
    this.navigationDirty = false;
    const reply = (await this.options.send({
      type: "collector-snapshot",
      documentId: this.options.documentId,
      token: this.token,
      records,
      recordLimitReached: this.recordLimitReached,
      partial: this.options.partial(),
      navigationId: this.navigationId,
    } satisfies CollectorSnapshot)) as CollectorReply | undefined;
    if (!this.isCurrent(generation)) return;
    if (reply?.stop) this.stop();
    else if (reply?.recover || !reply) this.scheduleRetry();
    else {
      this.ready = true;
      this.retries = 0;
      logger.info("collector snapshot restored", {
        documentId: this.options.documentId,
        count: records.length,
        recordLimitReached: this.recordLimitReached,
      });
    }
  }

  private scheduleRetry(): void {
    this.ready = false;
    if (this.stopped || this.paused || this.retries >= 3) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, [100, 500, 1500][this.retries++]);
  }

  private flush(): void {
    if (this.stopped || this.paused) return;
    if (!this.ready) {
      if (!this.connecting && this.retryTimer === undefined)
        void this.connect();
      return;
    }
    if (this.delivering || !this.token) return;
    const generation = this.generation;
    const delivery = this.deliver(generation)
      .catch(() => {
        if (!this.isCurrent(generation)) return;
        logger.warn("collector delivery failed", { code: "DELIVERY_FAILED" });
        this.scheduleRetry();
      })
      .finally(() => {
        if (this.delivering === delivery) this.delivering = undefined;
        if (!this.isCurrent(generation)) return;
        if (!this.ready && this.retryTimer === undefined) void this.connect();
        else if (this.dirty.size || this.framesDirty || this.navigationDirty)
          this.flush();
      });
    this.delivering = delivery;
  }

  private async deliver(generation: number): Promise<void> {
    while (this.isCurrent(generation) && this.ready) {
      const entry = this.dirty.entries().next().value;
      let message: Record<string, unknown>;
      let clear: () => void;
      if (entry) {
        const [id, record] = entry;
        message = {
          type: "listener-record",
          record,
          recordLimitReached: this.recordLimitReached,
        };
        clear = () => {
          if (this.dirty.get(id) === record) this.dirty.delete(id);
        };
      } else if (this.navigationDirty) {
        const navigationId = this.navigationId;
        message = { type: "context-navigation", navigationId };
        clear = () => {
          if (this.navigationId === navigationId) this.navigationDirty = false;
        };
      } else if (this.framesDirty) {
        this.framesDirty = false;
        message = {
          type: "collector-frames-changed",
          partial: this.options.partial(),
        };
        clear = () => {};
      } else return;
      const reply = (await this.options.send({
        ...message,
        documentId: this.options.documentId,
        token: this.token,
      })) as CollectorReply | undefined;
      if (!this.isCurrent(generation)) return;
      if (reply?.stop) {
        this.stop();
        return;
      }
      if (reply?.recover || !reply) {
        this.ready = false;
        return;
      }
      clear();
    }
  }

  pause(): void {
    if (this.stopped || this.paused) return;
    const token = this.token;
    this.paused = true;
    this.ready = false;
    this.generation++;
    this.token = undefined;
    this.connecting = undefined;
    this.delivering = undefined;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (token)
      void this.options
        .send({
          type: "context-reset",
          documentId: this.options.documentId,
          token,
        })
        .catch(() => undefined);
    logger.debug("collector paused", { documentId: this.options.documentId });
  }

  resume(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.paused = false;
    return this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.installed = false;
    this.generation++;
    this.token = undefined;
    this.records.clear();
    this.dirty.clear();
    this.navigationId = undefined;
    clearTimeout(this.retryTimer);
    this.options.stop();
    logger.debug("collector recovery stopped", {
      documentId: this.options.documentId,
    });
  }
}
