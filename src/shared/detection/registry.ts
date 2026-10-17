import type { ListenerLifecycle, ListenerRecord } from "../contracts/records";
import { createLogger } from "../logger";

const logger = createLogger("detection.registry");
const DEFAULT_MAX_RECORDS = 2000;

export interface RegistrationIdentity {
  eventType: string;
  targetPath: string;
  targetId?: string;
  capture: boolean;
  listenerKey: string;
}

export interface RegistryEntry extends ListenerRecord {
  lifecycle: ListenerLifecycle;
  listenerKey: string;
  listenerOptions?: ListenerRecord["listenerOptions"];
}

function identityKey(identity: RegistrationIdentity): string {
  return [
    identity.eventType,
    identity.targetPath,
    identity.targetId ?? "target-unknown",
    identity.capture ? "1" : "0",
    identity.listenerKey,
  ].join("|");
}

export class ListenerRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  constructor(private readonly maxRecords = DEFAULT_MAX_RECORDS) {}

  add(identity: RegistrationIdentity, record: ListenerRecord): RegistryEntry {
    const key = identityKey(identity);
    const existing = this.entries.get(key);
    if (existing?.lifecycle === "active") {
      logger.debug("duplicate registration ignored", {
        eventType: identity.eventType,
        targetPath: identity.targetPath,
        targetId: identity.targetId,
      });
      return existing;
    }

    if (!existing && this.entries.size >= this.maxRecords) {
      logger.warn("[FIX] registry limit reached", {
        maxRecords: this.maxRecords,
      });
      return {
        ...record,
        lifecycle: "unknown",
        listenerKey: key,
        reasonCodes: [...record.reasonCodes, "RECORD_LIMIT_REACHED"],
      };
    }

    const entry: RegistryEntry = {
      ...record,
      lifecycle: "active",
      listenerKey: key,
    };
    this.entries.set(key, entry);
    logger.debug("registration added", {
      eventType: identity.eventType,
      targetPath: identity.targetPath,
      targetId: identity.targetId,
      count: this.entries.size,
    });
    return entry;
  }

  remove(identity: RegistrationIdentity): RegistryEntry | undefined {
    const key = identityKey(identity);
    const entry = this.entries.get(key);
    if (!entry || entry.lifecycle !== "active") {
      logger.debug("remove missed", {
        eventType: identity.eventType,
        targetPath: identity.targetPath,
        targetId: identity.targetId,
      });
      return undefined;
    }
    const removed = { ...entry, lifecycle: "removed" as const };
    this.entries.set(key, removed);
    logger.debug("registration removed", {
      eventType: identity.eventType,
      targetPath: identity.targetPath,
      targetId: identity.targetId,
    });
    return removed;
  }

  list(lifecycle: ListenerLifecycle = "active"): RegistryEntry[] {
    return [...this.entries.values()].filter(
      (entry) => entry.lifecycle === lifecycle,
    );
  }

  clear(): void {
    this.entries.clear();
    logger.debug("[FIX] registry cleared");
  }
}

export function createListenerKey(
  listener: EventListenerOrEventListenerObject,
): string {
  return (
    listenerIdentity.get(listener as object) ??
    registerListenerIdentity(listener as object)
  );
}

const listenerIdentity = new WeakMap<object, string>();

function registerListenerIdentity(listener: object): string {
  const key = `listener-${crypto.randomUUID()}`;
  listenerIdentity.set(listener, key);
  return key;
}
