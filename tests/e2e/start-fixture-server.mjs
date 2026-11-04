import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

export async function startFixtureServer() {
  const server = createServer((request, response) => {
    const name = path.basename(
      new URL(request.url ?? "/", "http://localhost").pathname,
    );
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    createReadStream(path.resolve("tests/e2e/fixtures", name))
      .on("error", () => {
        response.statusCode = 404;
        response.end();
      })
      .pipe(response);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });

  return { server, port: server.address().port };
}
