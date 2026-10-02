import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = 4173;
const fixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", `http://localhost:${port}`)
    .pathname;
  const fixtureName = pathname === "/" ? "basic.html" : path.basename(pathname);
  const fixturePath = path.join(fixtureDirectory, fixtureName);

  response.setHeader("Content-Type", "text/html; charset=utf-8");
  createReadStream(fixturePath)
    .on("error", () => {
      response.statusCode = 404;
      response.end("Not found");
    })
    .pipe(response);
});

server.listen(port, "localhost", () => {
  console.debug(
    JSON.stringify({
      level: "DEBUG",
      scope: "fixture-server",
      message: "started",
      port,
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
