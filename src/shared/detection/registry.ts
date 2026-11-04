import type {
  ListenerLifecycle,
  ListenerReasonCode,
  ListenerRecord,
} from "../contracts/records";
import { createLogger } from "../logger";
import { createId } from "../id";

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

type SlotPhase =
  "known" | "known-once" | "unverified" | "ambiguous" | "removed";

interface RegistrationSlot {
  entry: RegistryEntry;
  phase: SlotPhase;
  generation: number;
}

export interface RegistrationResult {
  entry: RegistryEntry;
  change: "new" | "duplicate" | "ambiguous" | "unchanged" | "limited";
  generation: number | null;
}

function withReason(
  codes: ListenerReasonCode[],
  reason: ListenerReasonCode,
): ListenerReasonCode[] {
  return codes.includes(reason) ? codes : [...codes, reason];
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
  private readonly entries = new Map<string, RegistrationSlot>();
  private nextGeneration = 0;

  constructor(private readonly maxRecords = DEFAULT_MAX_RECORDS) {}

  add(identity: RegistrationIdentity, record: ListenerRecord): RegistryEntry {
    return this.register(identity, record).entry;
  }

  register(
    identity: RegistrationIdentity,
    record: ListenerRecord,
  ): RegistrationResult {
    const key = identityKey(identity);
    const existing = this.entries.get(key);
    if (existing?.phase === "known") {
      logger.debug("duplicate registration", {
        generation: existing.generation,
      });
      return {
        entry: existing.entry,
        change: "duplicate",
        generation: existing.generation,
      };
    }
    if (existing?.phase === "known-once" || existing?.phase === "unverified") {
      const ambiguous: RegistryEntry = {
        ...existing.entry,
        lifecycle: "unknown",
        reasonCodes: withReason(
          existing.entry.reasonCodes,
          "LIFECYCLE_UNVERIFIED",
        ),
        listenerOptions: {
          capture: identity.capture,
          passive: null,
          once: null,
        },
      };
      this.entries.set(key, {
        ...existing,
        entry: ambiguous,
        phase: "ambiguous",
      });
      logger.debug("once registration ambiguous", {
        generation: existing.generation,
      });
      return {
        entry: ambiguous,
        change: "ambiguous",
        generation: existing.generation,
      };
    }
    if (existing?.phase === "ambiguous") {
      return {
        entry: existing.entry,
        change: "unchanged",
        generation: existing.generation,
      };
    }

    if (!existing && this.entries.size >= this.maxRecords) {
      logger.warn("registry limit reached", { maxRecords: this.maxRecords });
      return {
        entry: {
          ...record,
          lifecycle: "unknown",
          listenerKey: key,
          reasonCodes: withReason(record.reasonCodes, "RECORD_LIMIT_REACHED"),
        },
        change: "limited",
        generation: null,
      };
    }

    const once = record.listenerOptions?.once === true;
    const entry: RegistryEntry = {
      ...record,
      lifecycle: once ? "unknown" : record.lifecycle,
      reasonCodes: once
        ? withReason(record.reasonCodes, "LIFECYCLE_UNVERIFIED")
        : record.reasonCodes,
      listenerKey: key,
    };
    const generation = ++this.nextGeneration;
    this.entries.set(key, {
      entry,
      phase: once ? "known-once" : "known",
      generation,
    });
    logger.debug("registration added", {
      generation,
      lifecycle: entry.lifecycle,
      count: this.entries.size,
    });
    return { entry, change: "new", generation };
  }

  remove(
    identity: RegistrationIdentity,
    generation?: number,
  ): RegistryEntry | undefined {
    const key = identityKey(identity);
    const slot = this.entries.get(key);
    if (
      !slot ||
      slot.phase === "removed" ||
      (generation !== undefined &&
        (slot.generation !== generation || slot.phase === "ambiguous"))
    ) {
      logger.debug("remove missed", { generation: generation ?? null });
      return undefined;
    }
    const removed: RegistryEntry = {
      ...slot.entry,
      lifecycle: "removed",
      reasonCodes: slot.entry.reasonCodes.filter(
        (code) => code !== "LIFECYCLE_UNVERIFIED",
      ),
    };
    this.entries.set(key, { ...slot, entry: removed, phase: "removed" });
    logger.debug("registration removed", { generation: slot.generation });
    return removed;
  }

  markUnverified(
    identity: RegistrationIdentity,
    generation: number,
  ): RegistryEntry | undefined {
    const key = identityKey(identity);
    const slot = this.entries.get(key);
    if (!slot || slot.phase === "removed" || slot.generation !== generation)
      return undefined;
    const entry: RegistryEntry = {
      ...slot.entry,
      lifecycle: "unknown",
      reasonCodes: withReason(slot.entry.reasonCodes, "LIFECYCLE_UNVERIFIED"),
    };
    this.entries.set(key, { ...slot, entry, phase: "unverified" });
    logger.debug("registration unverified", { generation });
    return entry;
  }

  current(
    identity: RegistrationIdentity,
    generation?: number,
  ): RegistryEntry | undefined {
    const slot = this.entries.get(identityKey(identity));
    return slot && (generation === undefined || slot.generation === generation)
      ? slot.entry
      : undefined;
  }

  list(lifecycle: ListenerLifecycle = "active"): RegistryEntry[] {
    return [...this.entries.values()]
      .map((slot) => slot.entry)
      .filter((entry) => entry.lifecycle === lifecycle);
  }

  clear(): void {
    this.entries.clear();
    logger.debug("registry cleared", { count: 0 });
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
  const key = `listener-${createId()}`;
  listenerIdentity.set(listener, key);
  return key;
}
