import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

async function waitFor(read, accept, message) {
  const deadline = Date.now() + 10000;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await delay(100);
  }
  throw new Error(`${message}: ${JSON.stringify(latest)}`);
}

// Эти функции передаются браузеру целиком и не используют окружение Node.js.
export function revealProbe(operation) {
  if (operation === "install") {
    const probe = { fired: 0 };
    const handler = () => {
      probe.fired++;
    };
    probe.first = document.createElement("button");
    probe.first.textContent = "Первая цель";
    probe.target = document.createElement("button");
    probe.target.textContent = "Вторая цель";
    probe.target.style.cssText = "display:block;margin-top:100px";
    document.body.append(probe.first, probe.target);
    probe.first.addEventListener("click", handler);
    probe.target.addEventListener("click", handler);
    const host = document.createElement("div");
    document.body.append(host);
    probe.shadow = document.createElement("button");
    probe.shadow.textContent = "Закрытый Shadow DOM";
    host.attachShadow({ mode: "closed" }).append(probe.shadow);
    probe.shadow.addEventListener("keydown", handler);
    probe.frame = document.querySelector('iframe[title="Разрешённый фрейм"]');
    probe.child = probe.frame.contentDocument.createElement("button");
    probe.child.textContent = "Цель во фрейме";
    probe.frame.contentDocument.body.append(probe.child);
    probe.child.addEventListener("pointerdown", handler);
    window.__listenerLensRevealProbe = probe;
    return true;
  }
  const probe = window.__listenerLensRevealProbe;
  if (operation === "remove") {
    probe.target.remove();
    return true;
  }
  if (operation === "navigate-frame") {
    probe.frame.src = "/context-frame.html?reveal-replaced=1";
    return true;
  }
  const matches = (element, doc) => {
    const overlay = doc.querySelector("[data-listener-lens-highlight]");
    if (!overlay) return false;
    const rect = element.getBoundingClientRect();
    return (
      Math.abs(parseFloat(overlay.style.left) - rect.left) < 1 &&
      Math.abs(parseFloat(overlay.style.top) - rect.top) < 1 &&
      Math.abs(parseFloat(overlay.style.width) - rect.width) < 1
    );
  };
  return {
    main: matches(probe.target, document),
    shadow: matches(probe.shadow, document),
    frame: matches(probe.child, probe.child.ownerDocument),
    mainOverlay: Boolean(
      document.querySelector("[data-listener-lens-highlight]"),
    ),
    frameOverlay: Boolean(
      probe.frame.contentDocument.querySelector(
        "[data-listener-lens-highlight]",
      ),
    ),
    fired: probe.fired,
    styleUnchanged:
      probe.target.style.cssText === "display: block; margin-top: 100px;",
  };
}

export function popupRevealProbe({ id, action, request }) {
  const api = globalThis.browser ?? globalThis.chrome;
  const popup = api.extension.getViews({ type: "popup" })[0];
  if (action === "stale")
    return popup[globalThis.browser ? "browser" : "chrome"].runtime.sendMessage(
      request,
    );
  const card = [
    ...popup.document.querySelectorAll("details.listener-record"),
  ].find((node) =>
    [...node.querySelectorAll("dt")].some(
      (term) =>
        term.textContent === "Идентификатор записи (id)" &&
        term.nextElementSibling?.textContent === id,
    ),
  );
  if (!card) return { found: false };
  card.open = true;
  const button = card.querySelector("button");
  if (action === "reveal") {
    button.click();
    return { found: true };
  }
  return {
    found: true,
    busy: button.disabled,
    message: card.querySelector('[role="status"]')?.textContent ?? "",
  };
}

export async function verifyTargetReveal({ label, run, popup, snapshot }) {
  const before = await snapshot();
  const known = new Set(before.records.map((record) => record.id));
  await run("install");
  const after = await waitFor(
    snapshot,
    (state) =>
      state.records.filter((record) => !known.has(record.id)).length >= 4,
    `${label}: новые цели не собраны`,
  );
  const fresh = after.records.filter((record) => !known.has(record.id));
  const buttons = fresh.filter(
    (record) =>
      record.frameId === 0 &&
      record.eventType === "click" &&
      record.source.path === "button",
  );
  assert.equal(buttons.length, 2);
  const target = buttons[1];
  const shadow = fresh.find(
    (record) =>
      record.contextKind === "shadow-root" && record.eventType === "keydown",
  );
  const frame = fresh.find(
    (record) => record.frameId > 0 && record.eventType === "pointerdown",
  );
  assert.ok(shadow);
  assert.ok(frame);
  async function reveal(record, statusText = "Элемент подсвечен") {
    await waitFor(
      () => popup({ id: record.id, action: "reveal" }),
      (value) => value.found,
      `${label}: карточка цели отсутствует`,
    );
    await waitFor(
      () => popup({ id: record.id, action: "state" }),
      (value) => !value.busy && value.message?.includes(statusText),
      `${label}: подсветка не подтверждена`,
    );
  }
  for (const [record, location] of [
    [target, "main"],
    [shadow, "shadow"],
    [frame, "frame"],
  ]) {
    await reveal(record);
    const highlighted = await run("state");
    assert.equal(
      highlighted[location],
      true,
      `${label}: подсвечена неверная цель ${location}`,
    );
    assert.equal(highlighted.fired, 0, `${label}: подсветка вызвала callback`);
    assert.equal(highlighted.styleUnchanged, true);
  }
  await run("remove");
  await reveal(target, "Элемент удалён");
  assert.equal((await run("state")).mainOverlay, false);
  await run("navigate-frame");
  await waitFor(
    snapshot,
    (state) => !state.records.some((record) => record.id === frame.id),
    `${label}: старый документ фрейма остался в снимке`,
  );
  const stale = await popup({
    action: "stale",
    request: {
      type: "reveal-listener-target",
      tabId: after.tabId,
      frameId: frame.frameId,
      mainDocumentId: after.documentId,
      documentId: frame.documentId,
      contextKind: frame.contextKind,
      recordId: frame.id,
    },
  });
  assert.equal(stale.status, "DOCUMENT_CHANGED");
  await waitFor(
    () => run("state"),
    (value) => !value.mainOverlay && !value.frameOverlay,
    `${label}: подсветка не очищена`,
  );
  console.debug(
    JSON.stringify({
      scope: label,
      phase: "подсветка-цели",
      exactTarget: true,
      iframe: true,
      closedShadow: true,
      staleDocument: true,
      detachedTarget: true,
      cleanup: true,
    }),
  );
}
