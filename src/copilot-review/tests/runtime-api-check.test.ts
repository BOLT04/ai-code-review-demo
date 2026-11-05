import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import { checkRuntimeApi } from "../src/application/runtime-api-check.ts";

async function startServer(
  context: TestContext,
  handler: RequestListener,
): Promise<string> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("checkRuntimeApi captures the selected method, path, and response", async (context) => {
  let actualRequest = "";
  const baseUrl = await startServer(context, (request, response) => {
    actualRequest = `${request.method} ${request.url}`;
    response.writeHead(201, { "content-type": "application/json" });
    response.end('{"count":1}');
  });

  const evidence = await checkRuntimeApi(baseUrl, "PURGE", "/counter");

  assert.equal(actualRequest, "PURGE /counter");
  assert.deepEqual(evidence, {
    request: { method: "PURGE", url: `${baseUrl}/counter` },
    response: {
      status: 201,
      statusText: "Created",
      contentType: "application/json",
      body: '{"count":1}',
    },
  });
});

test("checkRuntimeApi captures HTTP error responses", async (context) => {
  const baseUrl = await startServer(context, (_request, response) => {
    response.writeHead(503, "Unavailable");
    response.end('{"status":"degraded"}');
  });

  const evidence = await checkRuntimeApi(baseUrl, "GET", "/health");

  assert.equal(evidence.response?.status, 503);
  assert.equal(evidence.response?.statusText, "Unavailable");
  assert.equal(evidence.response?.body, '{"status":"degraded"}');
  assert.equal(evidence.error, undefined);
});

test("checkRuntimeApi captures connection failures", async (context) => {
  const baseUrl = await startServer(context, (request) => request.socket.destroy());

  const evidence = await checkRuntimeApi(baseUrl, "HEAD", "/health");

  assert.deepEqual(evidence.request, {
    method: "HEAD",
    url: `${baseUrl}/health`,
  });
  assert.match(evidence.error ?? "", /socket hang up|reset|aborted/i);
});

test("checkRuntimeApi rejects invalid origins, methods, and paths", async () => {
  await assert.rejects(
    () => checkRuntimeApi("https://127.0.0.1", "GET", "/health"),
    /loopback HTTP origin/,
  );
  await assert.rejects(
    () => checkRuntimeApi("http://example.com", "GET", "/health"),
    /loopback HTTP origin/,
  );
  await assert.rejects(
    () => checkRuntimeApi("http://127.0.0.1:3010", "GET", "//example.com"),
    /Request path must be one of/,
  );
  await assert.rejects(
    () => checkRuntimeApi("http://127.0.0.1:3010", "GET", "/other"),
    /Request path must be one of/,
  );
  await assert.rejects(
    () => checkRuntimeApi("http://127.0.0.1:3010", "GET", "/profile/ada/en?debug=true"),
    /Request path must be one of/,
  );
  await assert.rejects(
    () => checkRuntimeApi("http://127.0.0.1:3010", "bad method", "/health"),
    /valid token/,
  );
});

test("checkRuntimeApi bounds captured response bodies", async (context) => {
  const baseUrl = await startServer(context, (_request, response) => {
    response.writeHead(200);
    response.end("x".repeat(5 * 1024));
  });

  const evidence = await checkRuntimeApi(baseUrl, "GET", "/health");

  assert.match(evidence.error ?? "", /exceeded 4096 bytes/);
  assert.equal(evidence.response?.status, 200);
  assert.equal(evidence.response?.body, "[response body omitted]");
});
