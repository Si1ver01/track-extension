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
  lifecyclePopup,
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

  const lifecycleRecords = (state, name) =>
    readSlot(state, "add-event-listener", `lifecycle-${name}`, "click");
  const waitLifecycle = (name, predicate) =>
    waitFor(
      snapshot,
      (state) => predicate(lifecycleRecords(state, name)),
      `${label}: lifecycle ${name} не доставлен`,
    );
  const initialized = await run("lifecycle-init");
  assert.equal(initialized.onceReads, 1);
  const onceState = await waitLifecycle(
    "once",
    (records) => records.length === 1 && records[0].lifecycle === "unknown",
  );
  const once = lifecycleRecords(onceState, "once")[0];
  assert.equal(once.listenerOptions.once, true);
  assert.ok(once.reasonCodes.includes("LIFECYCLE_UNVERIFIED"));
  assert.equal(lifecycleRecords(onceState, "ignored").length, 0);
  assert.equal((await run("lifecycle-once-fire")).lifecycleCalls.once, 1);
  const beforeReadd = await snapshot();
  const repeated = await run("lifecycle-once-readd");
  assert.equal(repeated.lifecycleCalls["once-before"], 1);
  assert.equal(repeated.lifecycleCalls["once-after"], 3);
  for (const name of ["once-before", "once-after"]) {
    const state = await waitLifecycle(
      name,
      (records) =>
        records.length === 1 && records[0].listenerOptions.once === null,
    );
    const record = lifecycleRecords(state, name)[0];
    assert.equal(record.id, lifecycleRecords(beforeReadd, name)[0].id);
    assert.equal(record.lifecycle, "unknown");
    assert.equal(record.listenerOptions.passive, null);
  }
  const oldOnceAbort = await run("lifecycle-once-old-abort");
  assert.equal(oldOnceAbort.lifecycleCalls["once-before"], 1);
  assert.equal(
    oldOnceAbort.lifecycleCalls["once-after"],
    oldOnceAbort.nativeCalls["once-after"],
  );
  for (const name of ["once-before", "once-after"]) {
    assert.equal(
      lifecycleRecords(await snapshot(), name)[0].lifecycle,
      "unknown",
    );
  }
  const popupRecord = lifecycleRecords(
    await waitLifecycle("once-abort", (records) => records.length === 1),
    "once-abort",
  )[0];
  await lifecyclePopup({
    beforeAbort: popupRecord,
    abort: async () => {
      await run("lifecycle-once-abort");
      const state = await waitLifecycle(
        "once-abort",
        (records) => records.length === 1 && records[0].lifecycle === "removed",
      );
      const removed = lifecycleRecords(state, "once-abort")[0];
      assert.equal(removed.id, popupRecord.id);
      assert.ok(!removed.reasonCodes.includes("LIFECYCLE_UNVERIFIED"));
      return removed;
    },
  });
  const signalAbort = await run("lifecycle-signal-abort");
  assert.equal(signalAbort.lifecycleCalls.signal, 0);
  await waitLifecycle(
    "signal",
    (records) =>
      records.length === 2 &&
      records.every((record) => record.lifecycle === "removed"),
  );
  const duplicate = await run("lifecycle-duplicate");
  assert.equal(duplicate.lifecycleCalls.duplicate, 2);
  const duplicateRecord = lifecycleRecords(await snapshot(), "duplicate")[0];
  assert.equal(duplicateRecord.lifecycle, "active");
  assert.equal(duplicateRecord.listenerOptions.once, false);
  assert.equal(duplicateRecord.listenerOptions.passive, true);
  await run("lifecycle-duplicate-abort");
  await waitLifecycle(
    "duplicate",
    (records) =>
      records.length === 1 &&
      records[0].lifecycle === "removed" &&
      records[0].id === duplicateRecord.id,
  );
  const oldId = lifecycleRecords(await snapshot(), "old")[0].id;
  const oldReadd = await run("lifecycle-old-readd");
  assert.equal(oldReadd.lifecycleCalls.old, oldReadd.nativeCalls.old);
  await waitLifecycle("old", (records) =>
    records.some(
      (record) => record.id !== oldId && record.lifecycle === "active",
    ),
  );
  assert.equal((await run("lifecycle-synthetic")).lifecycleCalls.synthetic, 1);
  assert.equal(
    lifecycleRecords(await snapshot(), "synthetic")[0].lifecycle,
    "active",
  );
  assert.equal((await run("lifecycle-blocked")).lifecycleCalls.blocked, 0);
  // Уведомление скрыто страницей: active означает наблюдение регистрации.
  assert.equal(
    lifecycleRecords(await snapshot(), "blocked")[0].lifecycle,
    "active",
  );
  const reentrantId = lifecycleRecords(await snapshot(), "reentrant")[0].id;
  const reentrantNative = await run("lifecycle-reentrant");
  assert.equal(
    reentrantNative.lifecycleCalls.reentrant,
    reentrantNative.nativeCalls.reentrant,
  );
  const reentrantState = await waitLifecycle("reentrant", (records) =>
    records.some(
      (record) => record.id !== reentrantId && record.lifecycle === "active",
    ),
  );
  const reentrant = lifecycleRecords(reentrantState, "reentrant").find(
    (record) => record.lifecycle === "active",
  );
  await run("lifecycle-reentrant-abort");
  await waitLifecycle("reentrant", (records) =>
    records.some(
      (record) => record.id === reentrant.id && record.lifecycle === "removed",
    ),
  );
  await run("lifecycle-remove");
  for (const name of ["once-before", "once-after"]) {
    await waitLifecycle(
      name,
      (records) => records.length === 1 && records[0].lifecycle === "removed",
    );
  }

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
      .map((record) => [
        record.id,
        record.lifecycle,
        record.reasonCodes,
        record.listenerOptions,
      ])
      .sort(),
    beforeRestart.records
      .map((record) => [
        record.id,
        record.lifecycle,
        record.reasonCodes,
        record.listenerOptions,
      ])
      .sort(),
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

  await run("lifecycle-bfcache");
  const beforeFreeze = await waitLifecycle(
    "bfcache",
    (records) => records.length === 1 && records[0].lifecycle === "unknown",
  );
  await waitLifecycle(
    "bfcache-removed",
    (records) => records.length === 1 && records[0].lifecycle === "removed",
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
    restoredSnapshot.records
      .map((record) => [
        record.id,
        record.lifecycle,
        record.reasonCodes,
        record.listenerOptions,
      ])
      .sort(),
    recoveredLimited.records
      .map((record) => [
        record.id,
        record.lifecycle,
        record.reasonCodes,
        record.listenerOptions,
      ])
      .sort(),
  );
  const bfcacheRecord = lifecycleRecords(restoredSnapshot, "bfcache")[0];
  assert.equal(
    bfcacheRecord.id,
    lifecycleRecords(beforeFreeze, "bfcache")[0].id,
  );
  assert.ok(bfcacheRecord.reasonCodes.includes("LIFECYCLE_UNVERIFIED"));
  await run("lifecycle-bfcache-abort");
  const afterBfcacheAbort = await waitLifecycle(
    "bfcache",
    (records) => records.length === 1 && records[0].lifecycle === "removed",
  );
  assert.equal(
    lifecycleRecords(afterBfcacheAbort, "bfcache")[0].id,
    bfcacheRecord.id,
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
  await run("lifecycle-init");
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
  await run("lifecycle-signal-abort");
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
