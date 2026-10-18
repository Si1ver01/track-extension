import type { SiteAccessSnapshot } from "../../src/shared/contracts/site-access";

interface CoverageAdapter {
  label: string;
  navigate(pathname: string): Promise<unknown>;
  run(operation: string): Promise<unknown>;
  snapshot(): Promise<SiteAccessSnapshot>;
  back(): Promise<unknown>;
  reload(): Promise<unknown>;
  coverageText(): Promise<string>;
  restartBackground(): Promise<() => Promise<void>>;
}

export function verifyDetectionCoverage(
  adapter: CoverageAdapter,
): Promise<void>;

export function verifyRevokedBFCache(
  adapter: Pick<
    CoverageAdapter,
    "label" | "navigate" | "run" | "snapshot" | "back"
  > & { revoke(): Promise<unknown> },
): Promise<void>;
