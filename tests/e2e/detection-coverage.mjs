import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

async function waitFor(read, accept, description) {
  const deadline = Date.now() + 12_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await delay(100);
  }
  throw new Error(description);
}

// Один набор проверок для двух установленных расширений. Адаптеры используют
// настоящие MAIN world, extension messaging и browser navigation APIs.
export async function verifyDetectionCoverage({
  label,
  navigate,
  run,
  snapshot,
  back,
  reload,
  coverageText,
}) {
  await navigate("/detection-contexts.html");
  const initial = await waitFor(
    snapshot,
    (state) => state.status === "ready" && state.documentId,
    `${label}: сборщик не готов`,
  );
  const documentId = initial.documentId;
  const fixture = await waitFor(
    () => run("state"),
    Boolean,
    `${label}: fixture не готов`,
  );
  const readSlot = (state, sourceKind, path, eventType) =>
    state.records.filter(
      (record) =>
        record.frameId === 0 &&
        record.contextKind === "document" &&
        record.source.sourceKind === sourceKind &&
        record.source.path === path &&
        record.eventType === eventType,
    );
  const property = (state) =>
    readSlot(state, "event-handler-property", "button", "click");
  const inline = (state) =>
    readSlot(state, "inline-attribute", "section", "focus");
  const waitSlot = (select, lifecycle, previousTime) =>
    waitFor(
      snapshot,
      (state) => {
        const records = select(state);
        return (
          records.length === 1 &&
          records[0].lifecycle === lifecycle &&
          (previousTime === undefined || records[0].capturedAt > previousTime)
        );
      },
      `${label}: lifecycle ${lifecycle} не доставлен`,
    );

  const native = await run("property-add");
  assert.equal(native.getterIdentity, true);
  assert.equal(native.correctThis, true);
  assert.equal(native.cancelled, true);
  assert.equal(native.firstCalls, 1);
  const added = property(await waitSlot(property, "active"))[0];
  assert.equal(added.documentId, documentId);
  assert.ok(added.reasonCodes.includes("SURFACE_UNVERIFIED"));
  await run("property-repeat");
  const replacedNative = await run("property-replace");
  assert.equal(replacedNative.getterIdentity, true);
  assert.equal(replacedNative.firstCalls, 2);
  assert.equal(replacedNative.secondCalls, 1);
  assert.equal(replacedNative.cancelled, true);
  const replaced = property(
    await waitSlot(property, "active", added.capturedAt),
  )[0];
  assert.equal(replaced.id, added.id);
  assert.equal(replaced.listenerKey, added.listenerKey);
  const removedNative = await run("property-remove");
  assert.equal(removedNative.cancelled, false);
  assert.equal(removedNative.secondCalls, 1);
  assert.equal(property(await waitSlot(property, "removed"))[0].id, added.id);
  await run("property-readd");
  assert.equal(property(await waitSlot(property, "active"))[0].id, added.id);

  const initialInline = inline(await waitSlot(inline, "active"))[0];
  await run("inline-replace");
  assert.equal(
    inline(await waitSlot(inline, "active", initialInline.capturedAt))[0].id,
    initialInline.id,
  );
  await run("inline-remove");
  assert.equal(
    inline(await waitSlot(inline, "removed"))[0].id,
    initialInline.id,
  );
  await run("inline-readd");
  assert.equal(
    inline(await waitSlot(inline, "active"))[0].id,
    initialInline.id,
  );

  await run("shadow");
  const shadowState = await waitFor(
    snapshot,
    (state) =>
      state.records.filter((record) => record.contextKind === "shadow-root")
        .length === 6,
    `${label}: open/closed Shadow DOM не собран`,
  );
  for (const [eventType, sourceKind] of [
    ["copy", "add-event-listener"],
    ["pointerdown", "event-handler-property"],
    ["blur", "inline-attribute"],
  ]) {
    const records = shadowState.records.filter(
      (record) =>
        record.contextKind === "shadow-root" &&
        record.eventType === eventType &&
        record.source.sourceKind === sourceKind,
    );
    assert.equal(records.length, 2);
    assert.equal(new Set(records.map((record) => record.id)).size, 2);
    if (sourceKind !== "add-event-listener") {
      assert.equal(
        new Set(records.map((record) => record.listenerKey)).size,
        2,
      );
    }
    assert.ok(records.every((record) => record.documentId === documentId));
  }
  assert.doesNotMatch(
    JSON.stringify(shadowState),
    /coverage-(?:input|callback|inline|shadow).*secret/,
  );

  for (const [operation, eventType] of [
    ["spa-push", "keyup"],
    ["spa-replace", "change"],
  ]) {
    const state = await run(operation);
    assert.equal(state.token, fixture.token);
    const spa = await waitFor(
      snapshot,
      (value) => value.records.some((record) => record.eventType === eventType),
      `${label}: доставка после ${operation} остановилась`,
    );
    assert.equal(spa.documentId, documentId);
    assert.ok(spa.records.some((record) => record.id === added.id));
  }
  await back();
  const popped = await waitFor(
    () => run("state"),
    (state) => state?.popCount === 1 && state.route === "",
    `${label}: настоящий popstate не получен`,
  );
  assert.equal(popped.token, fixture.token);
  await run("spa-after-back");
  const afterPop = await waitFor(
    snapshot,
    (state) => state.records.some((record) => record.eventType === "paste"),
    `${label}: доставка после popstate остановилась`,
  );
  assert.equal(afterPop.documentId, documentId);

  await run("overflow");
  const limited = await waitFor(
    snapshot,
    (state) => state.coverage?.reasons.includes("RECORD_LIMIT_REACHED"),
    `${label}: переполнение не обозначено`,
  );
  assert.equal(limited.status, "limited");
  assert.equal(limited.records.length, limited.coverage.recordLimit);
  await waitFor(
    coverageText,
    (text) => text.includes("Достигнут лимит сбора"),
    `${label}: popup не объяснил переполнение`,
  );

  await navigate("/navigation-target.html");
  const next = await waitFor(
    snapshot,
    (state) =>
      state.documentId &&
      state.documentId !== documentId &&
      state.records.some((record) => record.source.path === "textarea"),
    `${label}: полная навигация не создала новый документ`,
  );
  assert.equal(next.status, "ready");
  assert.equal(next.coverage, undefined);
  assert.ok(next.records.every((record) => record.documentId !== documentId));

  await back();
  const restored = await waitFor(
    () => run("state"),
    (state) => state && state.persisted !== null,
    `${label}: pageshow не получен`,
  );
  assert.equal(
    restored.persisted,
    true,
    `${label}: браузер не восстановил страницу из настоящего BFCache`,
  );
  assert.equal(
    restored.token,
    fixture.token,
    `${label}: BFCache заменён новой загрузкой`,
  );
  const paused = await waitFor(
    snapshot,
    (state) => state.status === "reload-required",
    `${label}: BFCache не требует перезапуска`,
  );
  assert.deepEqual(paused.records, []);
  await reload();
  const reloadedFixture = await waitFor(
    () => run("state"),
    (state) =>
      state && state.token !== fixture.token && state.persisted !== null,
    `${label}: reload не заменил документ`,
  );
  assert.equal(reloadedFixture.persisted, false);
  const resumed = await waitFor(
    snapshot,
    (state) =>
      state.status === "ready" &&
      state.documentId &&
      state.documentId !== documentId &&
      state.records.some((record) => record.eventType === "click"),
    `${label}: сбор после reload не восстановился`,
  );
  assert.notEqual(resumed.documentId, next.documentId);
  assert.equal(resumed.coverage, undefined);
  console.debug(
    JSON.stringify({
      scope: label,
      phase: "покрытие-детектора",
      propertyInline: "проверены",
      shadow: "open/closed",
      spa: "push/replace/popstate",
      fullNavigation: "проверена",
      bfcache:
        "pageshow.persisted=true; token сохранён; reload восстановил сбор",
      overflow: limited.coverage.recordLimit,
      privacy: "проверена",
    }),
  );
}
