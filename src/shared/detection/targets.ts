import type { RevealResult } from "../contracts/reveal";
import { createLogger } from "../logger";

const logger = createLogger("detection.targets");
export const MAX_REVEAL_TARGETS = 4000;

export class ListenerTargets {
  private targets = new Map<
    string,
    { reference: WeakRef<Element>; shadowHost: boolean }
  >();
  private overlay?: HTMLElement;
  private timer?: ReturnType<typeof setTimeout>;

  remember(id: string, target: EventTarget): void {
    const shadowHost = target instanceof ShadowRoot;
    const element = shadowHost ? target.host : target;
    if (!(element instanceof Element)) return;
    this.targets.delete(id);
    this.targets.set(id, { reference: new WeakRef(element), shadowHost });
    if (this.targets.size > MAX_REVEAL_TARGETS)
      this.targets.delete(this.targets.keys().next().value!);
  }

  reveal(id: string): RevealResult {
    this.hide();
    const target = this.targets.get(id);
    const element = target?.reference.deref();
    if (!element || !element.isConnected || element.ownerDocument !== document)
      return { status: "TARGET_UNAVAILABLE" };
    try {
      element.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0)
        return { status: "TARGET_UNAVAILABLE" };
      const overlay = document.createElement("div");
      overlay.dataset.listenerLensHighlight = "true";
      overlay.setAttribute("aria-hidden", "true");
      overlay.style.cssText = `all: initial !important; position: fixed !important; pointer-events: none !important; z-index: 2147483647 !important; box-sizing: border-box !important; border: 3px solid #2155cd !important; background: rgb(33 85 205 / 12%) !important; left: ${rect.left}px !important; top: ${rect.top}px !important; width: ${rect.width}px !important; height: ${rect.height}px !important;`;
      document.documentElement.append(overlay);
      this.overlay = overlay;
      this.timer = setTimeout(() => this.hide(), 2000);
      const status = target?.shadowHost ? "SHADOW_HOST" : "REVEALED";
      logger.debug("Цель подсвечена", { status });
      return { status };
    } catch {
      this.hide();
      logger.warn("Подсветка недоступна", { code: "REVEAL_FAILED" });
      return { status: "REVEAL_FAILED" };
    }
  }

  hide(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.overlay?.remove();
    this.overlay = undefined;
  }

  clear(): void {
    this.hide();
    this.targets.clear();
  }
}
