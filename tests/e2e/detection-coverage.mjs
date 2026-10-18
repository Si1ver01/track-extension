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
  const detail =
    latest && typeof latest === "object" && "status" in latest
      ? JSON.stringify({
          status: latest.status,
          recordCount: latest.records?.length,
          reason: latest.reason,
          coverage: latest.coverage,
          documentId: latest.documentId,
        })
      : typeof latest;
  throw new Error(`${description}: ${detail}`);
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
  restartBackground,
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

  await run("property-remove");
  await waitSlot(property, "removed");
  const beforeRestart = await snapshot();
  const confirmRestart = await restartBackground();
  const recovered = await waitFor(
    snapshot,
    (state) =>
      state.status === "ready" &&
      beforeRestart.records.every((previous) =>
        state.records.some(
          (record) =>
            record.id === previous.id &&
            record.lifecycle === previous.lifecycle,
        ),
      ),
    `${label}: снимок не восстановлен после перезапуска background (ожидается ${beforeRestart.records.length})`,
  );
  await confirmRestart();
  assert.equal((await run("state")).token, fixture.token);
  assert.equal(recovered.documentId, documentId);
  assert.deepEqual(
    recovered.records
      .filter((record) =>
        beforeRestart.records.some((previous) => previous.id === record.id),
      )
      .map((record) => [record.id, record.lifecycle])
      .sort(),
    beforeRestart.records.map((record) => [record.id, record.lifecycle]).sort(),
  );
  assert.equal(property(recovered)[0].lifecycle, "removed");
  await run("property-readd");
  assert.equal(property(await waitSlot(property, "active"))[0].id, added.id);

  await run("overflow");
  const limited = await waitFor(
    snapshot,
    (state) =>
      state.coverage?.reasons.includes("RECORD_LIMIT_REACHED") &&
      state.records.length === state.coverage.recordLimit,
    `${label}: переполнение не обозначено`,
  );
  assert.equal(limited.status, "limited");
  assert.equal(limited.records.length, limited.coverage.recordLimit);
  await waitFor(
    coverageText,
    (text) => text.includes("Достигнут лимит сбора"),
    `${label}: popup не объяснил переполнение`,
  );

  const confirmLimitedRestart = await restartBackground();
  await run("spa-after-back");
  await confirmLimitedRestart();
  const recoveredLimited = await waitFor(
    snapshot,
    (state) =>
      state.coverage?.reasons.includes("RECORD_LIMIT_REACHED") &&
      state.records.length === limited.coverage.recordLimit,
    `${label}: восстановление потеряло признак переполнения`,
  );
  assert.equal(recoveredLimited.documentId, documentId);
  assert.equal((await run("state")).token, fixture.token);

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
  const restoredSnapshot = await waitFor(
    snapshot,
    (state) =>
      state.documentId === documentId &&
      state.status === "limited" &&
      state.records.length === limited.coverage.recordLimit,
    `${label}: BFCache не восстановил сбор автоматически`,
  );
  assert.deepEqual(
    restoredSnapshot.records.map((record) => record.id).sort(),
    recoveredLimited.records.map((record) => record.id).sort(),
  );
  assert.ok(
    restoredSnapshot.records.every(
      (record) => record.documentId !== next.documentId,
    ),
  );
  await run("property-remove");
  assert.equal(property(await waitSlot(property, "removed"))[0].id, added.id);
  await run("property-readd");
  const afterResume = await waitSlot(property, "active");
  assert.equal(property(afterResume)[0].id, added.id);
  assert.equal(
    new Set(afterResume.records.map((record) => record.id)).size,
    afterResume.records.length,
  );
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
        "pageshow.persisted=true; token и ID сохранены; сбор возобновлён без reload",
      background:
        "две настоящие остановки; idle replay и новое событие; overflow сохранён",
      overflow: limited.coverage.recordLimit,
      privacy: "проверена",
    }),
  );
}

export async function verifyRevokedBFCache({
  label,
  navigate,
  run,
  snapshot,
  back,
  revoke,
}) {
  await navigate("/detection-contexts.html");
  const initial = await waitFor(
    snapshot,
    (state) => state.status === "ready",
    `${label}: сборщик перед revoke не готов`,
  );
  await run("property-add");
  const fixture = await run("state");
  await navigate("/navigation-target.html");
  await waitFor(
    snapshot,
    (state) => state.documentId && state.documentId !== initial.documentId,
    `${label}: навигация перед revoke не завершилась`,
  );
  await revoke();
  await back();
  const restored = await waitFor(
    () => run("state"),
    (state) => state && state.persisted !== null,
    `${label}: документ после revoke не восстановлен`,
  );
  assert.equal(
    restored.persisted,
    true,
    `${label}: проверка revoke требует настоящего BFCache`,
  );
  assert.equal(restored.token, fixture.token);
  await run("property-readd");
  const denied = await waitFor(
    snapshot,
    // После навигации Chromium отзывает activeTab и скрывает URL без host grant.
    (state) => state.status === "no-access" || state.status === "unsupported",
    `${label}: BFCache возобновил сбор после revoke`,
  );
  assert.deepEqual(denied.records, []);
  console.debug(
    JSON.stringify({
      scope: label,
      phase: "BFCache-после-revoke",
      persisted: true,
      records: 0,
    }),
  );
}
