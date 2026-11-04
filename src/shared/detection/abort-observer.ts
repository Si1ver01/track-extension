import { createLogger } from "../logger";

const logger = createLogger("detection.abort");

interface Binding {
  signal: WeakRef<AbortSignal>;
  listener: EventListener;
  generation: number;
  reconcile: () => void;
}

export class AbortObserver {
  private readonly bindings = new Map<string, Binding>();
  private stopped = false;

  constructor(
    private readonly nativeAdd: typeof EventTarget.prototype.addEventListener,
    private readonly nativeRemove: typeof EventTarget.prototype.removeEventListener,
    private readonly isAborted: (signal: AbortSignal) => boolean,
    private readonly maxBindings = 2000,
  ) {}

  get count(): number {
    return this.bindings.size;
  }

  observe(
    key: string,
    generation: number,
    signal: AbortSignal,
    onAbort: () => void,
    onUnverified: () => void,
  ): boolean {
    if (this.stopped) return false;
    this.forget(key);
    if (this.count >= this.maxBindings) {
      logger.debug("abort observation limit reached", { count: this.count });
      return false;
    }
    const signalRef = new WeakRef(signal);
    const handleAbort = () => {
      const current = signalRef.deref();
      if (!current || !this.isCurrent(key, generation)) return;
      try {
        if (!this.isAborted(current)) return;
      } catch {
        this.forget(key, generation);
        try {
          onUnverified();
        } catch {
          logger.warn("unverified update failed");
        }
        logger.warn("signal state unavailable");
        return;
      }
      this.forget(key, generation);
      try {
        onAbort();
      } catch {
        logger.warn("abort update failed");
      }
    };
    const listener: EventListener = () => handleAbort();
    try {
      this.bindings.set(key, {
        signal: signalRef,
        listener,
        generation,
        reconcile: handleAbort,
      });
      this.nativeAdd.call(signal, "abort", listener);
      if (this.isAborted(signal)) handleAbort();
      logger.debug("abort observation installed", {
        count: this.count,
        generation,
      });
      return true;
    } catch {
      this.forget(key, generation);
      logger.warn("abort observation failed");
      return false;
    }
  }

  forget(key: string, generation?: number): void {
    const binding = this.bindings.get(key);
    if (
      !binding ||
      (generation !== undefined && binding.generation !== generation)
    )
      return;
    this.bindings.delete(key);
    const signal = binding.signal.deref();
    if (signal) {
      try {
        this.nativeRemove.call(signal, "abort", binding.listener);
      } catch {
        logger.warn("abort observation cleanup failed");
      }
    }
    logger.debug("abort observation removed", {
      count: this.count,
      generation: binding.generation,
    });
  }

  reconcile(key: string): void {
    this.bindings.get(key)?.reconcile();
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const key of this.bindings.keys()) this.forget(key);
    logger.debug("abort observation disposed", { count: this.count });
  }

  private isCurrent(key: string, generation: number): boolean {
    return !this.stopped && this.bindings.get(key)?.generation === generation;
  }
}
