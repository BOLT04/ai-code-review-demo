import { createServer, type Server } from "node:http";
import { createClient } from "redis";
import type { CoordinatorScope } from "../composition/create-case.ts";
import type { RedisCacheClient } from "../domain/shared-cache.ts";
import { configureServer, HttpError, isMain, listenCli, pathname, requestJson, sendError, sendJson } from "./http.ts";

export interface CatalogRedis extends RedisCacheClient {
  ping(): Promise<string>;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
}

export function createCatalog(originUrl: string, scope: CoordinatorScope, redis: CatalogRedis): Server {
  if (scope !== "request" && scope !== "shared") throw new Error("COORDINATOR_SCOPE must be request or shared");
  const origin = new URL(originUrl);
  if (origin.protocol !== "http:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("originUrl must be a credential-free HTTP origin without path, query, or fragment");
  }
  const server = createServer((request, response) => {
    void (async () => {
      const path = pathname(request);
      if (request.method === "GET" && path === "/health") {
        try {
          const health = await requestJson<{ status?: string }>(new URL("/health", origin), { timeoutMs: 2_000 });
          if (health.status !== 200 || health.body.status !== "ok") throw new Error("Origin unhealthy");
          if (await redis.ping() !== "PONG") throw new Error("Redis unhealthy");
          sendJson(response, 200, {
            status: "ok", service: "catalog", implementation: "stub", scope, origin: "ok", redis: "ok",
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Catalog health check failed: ${message}`);
          sendJson(response, 503, {
            status: "error", service: "catalog", implementation: "stub", scope, origin: "unavailable", redis: "unavailable",
          });
        }
        return;
      }
      if (process.env.DEMO_MODE !== "true") throw new HttpError(404, "Demo endpoints are disabled");
      console.warn(`Catalog stub: ${request.method} ${path} is not implemented`);
      sendJson(response, 501, { error: "Catalog application is not implemented", implementation: "stub" });
    })().catch((error: unknown) => sendError(response, error));
  });
  return configureServer(server);
}

if (isMain(import.meta.url)) {
  const scope = process.env.COORDINATOR_SCOPE ?? "request";
  if (scope !== "request" && scope !== "shared") throw new Error("COORDINATOR_SCOPE must be request or shared");
  const redis = createClient({
    url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    socket: {
      connectTimeout: 10_000,
      reconnectStrategy: (retries) => retries >= 5
        ? new Error("Redis reconnect limit exceeded")
        : Math.min(200 * 2 ** retries, 3_000),
    },
  });
  redis.on("error", (error) => console.error(`Redis client error: ${error.message}`));
  await redis.connect();
  const server = createCatalog(process.env.ORIGIN_URL ?? "http://127.0.0.1:3011", scope, redis);
  server.once("close", () => { void redis.quit(); });
  listenCli(server, 3010);
}
