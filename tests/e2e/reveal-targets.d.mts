import type { SiteAccessSnapshot } from "../../src/shared/contracts/site-access";
import type { RevealTargetRequest } from "../../src/shared/contracts/reveal";

interface PopupProbeArgs {
  id?: string;
  action: "reveal" | "state" | "stale";
  request?: RevealTargetRequest;
}

export function revealProbe(operation: string): unknown;
export function popupRevealProbe(args: PopupProbeArgs): unknown;
export function verifyTargetReveal(adapter: {
  label: string;
  run(operation: string): Promise<unknown>;
  popup(args: PopupProbeArgs): Promise<unknown>;
  snapshot(): Promise<SiteAccessSnapshot>;
}): Promise<void>;
