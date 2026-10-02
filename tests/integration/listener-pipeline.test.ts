import { afterEach, describe, expect, it } from "vitest";
import { handleRuntimeMessage } from "../../src/background/messages";
import { resetTabState } from "../../src/background/tab-state";
import { createBridgeMessage } from "../../src/shared/detection/bridge";

const tabId = 41;

describe("listener record pipeline", () => {
  afterEach(() => resetTabState(tabId));

  it("routes normalized metadata from the bridge to the sender tab and frame", async () => {
    const message = createBridgeMessage(
      "copy",
      0,
      "button#copy",
      "fixture-nonce",
    );

    expect(message).not.toBeNull();
    if (!message)
      throw new Error("bridge did not create the expected fixture message");
    const state = await handleRuntimeMessage(message, {
      tab: { id: tabId },
      frameId: 3,
    });

    expect(state).toMatchObject({ tabId, status: "ready" });
    expect(state?.records).toHaveLength(1);
    expect(state?.records[0]).toMatchObject({
      eventType: "copy",
      tabId,
      frameId: 3,
    });
    expect(state?.records[0]).not.toHaveProperty("payload");
    expect(state?.records[0]?.source).not.toHaveProperty("value");
  });
});
