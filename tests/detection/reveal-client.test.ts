import { afterEach, describe, expect, it, vi } from "vitest";
import { RevealClient } from "../../src/shared/detection/reveal-client";

afterEach(() => vi.useRealTimers());
describe("Корреляция подсветки через bridge", () => {
  it("принимает только ответ с точными nonce, document, request и record", async () => {
    const post = vi.fn();
    const client = new RevealClient({
      nonce: "nonce",
      documentId: "document",
      post,
    });
    const pending = client.request("record");
    const request = post.mock.calls[0]![0];
    const response = {
      ...request,
      type: "target-revealed",
      result: { status: "REVEALED", payload: "private" },
    };
    for (const override of [
      { nonce: "other" },
      { documentId: "other" },
      { requestId: "other" },
      { recordId: "other" },
      { source: "other" },
      { result: { status: "forged" } },
    ])
      expect(client.accept({ ...response, ...override })).toBe(false);
    expect(client.accept(response)).toBe(true);
    expect(await pending).toEqual({ status: "REVEALED" });
    expect(client.accept(response)).toBe(false);
  });

  it("завершает таймаут и отменяет все ожидания при pagehide/stop", async () => {
    vi.useFakeTimers();
    const client = new RevealClient({
      nonce: "nonce",
      documentId: "document",
      post: vi.fn(),
    });
    const timeout = client.request("record");
    vi.advanceTimersByTime(1500);
    expect(await timeout).toEqual({ status: "TIMEOUT" });
    const first = client.request("one");
    const second = client.request("two");
    client.cancel();
    expect(await first).toEqual({ status: "CANCELLED" });
    expect(await second).toEqual({ status: "CANCELLED" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("обрабатывает отказ post и ограничивает параллельные ожидания", async () => {
    const failed = new RevealClient({
      nonce: "nonce",
      documentId: "document",
      post: () => {
        throw new Error("private");
      },
    });
    expect(await failed.request("one")).toEqual({ status: "REVEAL_FAILED" });
    const client = new RevealClient({
      nonce: "nonce",
      documentId: "document",
      post: vi.fn(),
    });
    const pending = Array.from({ length: 8 }, (_, i) =>
      client.request(String(i)),
    );
    expect(await client.request("extra")).toEqual({ status: "REVEAL_FAILED" });
    client.cancel();
    await Promise.all(pending);
  });
});
