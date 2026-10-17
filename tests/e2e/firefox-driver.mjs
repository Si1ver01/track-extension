import { firefox } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const extensionUuid = "12345678-1234-4321-8321-123456789abc";

export async function poll(read, accept, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await delay(100);
  }
  throw new Error(`${description}: ${JSON.stringify(latest)}`);
}

export async function launchFirefoxExtension() {
  const profile = await mkdtemp(path.join(tmpdir(), "listener-lens-firefox-"));
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const preferences = {
    "marionette.port": port,
    "extensions.webextensions.uuids": JSON.stringify({
      "listener-lens@example.invalid": extensionUuid,
    }),
    "extensions.webextensions.optional-permissions-prompts": true,
    "browser.shell.checkDefaultBrowser": false,
    "browser.startup.homepage_override.mstone": "ignore",
  };
  await writeFile(
    path.join(profile, "user.js"),
    Object.entries(preferences)
      .map(
        ([key, value]) =>
          `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`,
      )
      .join("\n"),
  );
  const child = spawn(
    firefox.executablePath(),
    [
      "--headless",
      "--no-remote",
      "--profile",
      profile,
      "--marionette",
      "--remote-allow-system-access",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-12_000);
    });
  }
  let socket;
  const pending = new Map();
  let sequence = 0;
  const close = async () => {
    socket?.destroy();
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("Firefox driver closed"));
    }
    pending.clear();
    if (child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([stopped, delay(4000)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await stopped;
      }
    }
    await rm(profile, { recursive: true, force: true });
  };
  try {
    socket = await poll(
      async () => {
        if (child.exitCode !== null)
          throw new Error(`Firefox exited: ${output}`);
        return new Promise((resolve) => {
          const candidate = net.createConnection(port, "127.0.0.1");
          candidate.once("connect", () => resolve(candidate));
          candidate.once("error", () => {
            candidate.destroy();
            resolve(null);
          });
        });
      },
      Boolean,
      "Firefox Marionette endpoint unavailable",
    );
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const colon = buffer.indexOf(":");
        if (colon < 0) break;
        const length = Number(buffer.subarray(0, colon).toString());
        if (buffer.length < colon + 1 + length) break;
        const message = JSON.parse(
          buffer.subarray(colon + 1, colon + 1 + length).toString(),
        );
        buffer = buffer.subarray(colon + 1 + length);
        if (!Array.isArray(message)) continue;
        const request = pending.get(message[1]);
        if (!request) continue;
        pending.delete(message[1]);
        clearTimeout(request.timer);
        const [, , error, result] = message;
        if (error)
          request.reject(new Error(`${error.error}: ${error.message}`));
        else request.resolve(result);
      }
    });
    const call = (method, parameters = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Firefox command timed out: ${method}; ${output}`));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        const message = JSON.stringify([0, id, method, parameters]);
        socket.write(`${Buffer.byteLength(message)}:${message}`);
      });
    const execute = async (script, args = []) =>
      (await call("WebDriver:ExecuteScript", { script, args })).value;
    const executeAsync = async (script, args = []) => {
      const result = (
        await call("WebDriver:ExecuteAsyncScript", {
          script: `const done = arguments[arguments.length - 1];
          Promise.resolve().then(async () => { ${script} }).then(
            value => done({ value }), error => done({ error: String(error) })
          );`,
          args,
        })
      ).value;
      if (result.error) throw new Error(result.error);
      return result.value;
    };
    await call("WebDriver:NewSession", {});
    await call("WebDriver:SetTimeouts", { script: 12_000, pageLoad: 15_000 });
    const installed = await call("Addon:Install", {
      path: path.resolve(".output/firefox-mv3"),
      temporary: true,
    });
    if (installed.value !== "listener-lens@example.invalid") {
      throw new Error("Firefox installed an unexpected add-on");
    }
    return { call, execute, executeAsync, close, output: () => output };
  } catch (error) {
    await close();
    throw error;
  }
}
