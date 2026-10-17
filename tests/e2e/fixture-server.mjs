import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requestedPort = Number(process.env.FIXTURE_PORT ?? 4173);
const fixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const server = createServer((request, response) => {
  const pathname = new URL(
    request.url ?? "/",
    `http://localhost:${requestedPort}`,
  ).pathname;
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

server.on("error", (error) => {
  if (error.code !== "EADDRINUSE" || requestedPort !== 4173) throw error;
  server.listen(0, "localhost", () => {
    const address = server.address();
    console.warn(
      JSON.stringify({
        level: "WARN",
        scope: "fixture-server",
        message: "requested port busy; using ephemeral port",
        requestedPort,
        port: typeof address === "object" && address ? address.port : null,
      }),
    );
  });
});
server.listen(requestedPort, "localhost", () => {
  const address = server.address();
  console.debug(
    JSON.stringify({
      level: "DEBUG",
      scope: "fixture-server",
      message: "started",
      port:
        typeof address === "object" && address ? address.port : requestedPort,
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
