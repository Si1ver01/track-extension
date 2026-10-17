import { afterEach, expect, it, vi } from "vitest";
import { createId } from "../../src/shared/id";

afterEach(() => vi.unstubAllGlobals());

it("creates session IDs on HTTP pages without crypto.randomUUID", () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal("crypto", { getRandomValues });
  const first = createId();
  expect(first).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(createId()).not.toBe(first);
});
