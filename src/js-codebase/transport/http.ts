import { request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const MAX_CASES = 64;
export const MAX_CASE_REQUESTS = 64;
export const MAX_JSON_BYTES = 4096;
export const ORIGIN_DEADLINE_MS = 30_000;
export const HTTP_DEADLINE_MS = 35_000;

export class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const json = JSON.stringify(value);
  response.writeHead(statusCode, { "content-type": "application/json", "content-length": Buffer.byteLength(json), "cache-control": "no-store" });
  response.end(json);
}

export function sendError(response: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.statusCode : 500;
  sendJson(response, status, { error: error instanceof HttpError ? error.message : "Internal server error" });
}

export async function readObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes <= MAX_JSON_BYTES) chunks.push(buffer);
    // Drain without retaining excess bytes, so the caller can receive a 413.
  }
  if (bytes > MAX_JSON_BYTES) throw new HttpError(413, `JSON body must be at most ${MAX_JSON_BYTES} bytes`);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Expected a JSON object"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "Expected a JSON object");
  return parsed as Record<string, unknown>;
}

export function exactKeys(body: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(body, key))) {
    throw new HttpError(400, `Expected only ${keys.join(", ")}`);
  }
}

export function caseId(value: unknown): string {
  if (typeof value !== "string" || !/^case-[a-zA-Z0-9-]{1,80}$/.test(value)) throw new HttpError(400, "Invalid caseId");
  return value;
}

export function correlationHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(value)) throw new HttpError(400, `Invalid ${name}`);
  return value;
}

export function pathname(request: IncomingMessage): string {
  // Do not normalize traversal or accept absolute-form URLs.
  const path = request.url ?? "";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#")) throw new HttpError(400, "Expected an exact supported path without query parameters");
  return path;
}

export interface JsonResponse<T = unknown> {
  status: number;
  body: T;
}

/** Native HTTP, one request, no retries, explicit deadline and response-size bound. */
export function requestJson<T = unknown>(
  url: URL,
  options: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<JsonResponse<T>> {
  if (url.protocol !== "http:" || url.username || url.password) return Promise.reject(new HttpError(400, "Only credential-free HTTP is supported"));
  return new Promise((resolveResponse, reject) => {
    const encoded = options.body === undefined ? undefined : JSON.stringify(options.body);
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(error);
    };
    const outbound = request(url, {
      method: options.method ?? "GET",
      agent: false,
      headers: { ...options.headers, ...(encoded === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) }) },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          const error = new HttpError(502, "HTTP response exceeded its size bound");
          finishError(error);
          response.destroy(error);
          outbound.destroy(error);
        } else chunks.push(chunk);
      });
      response.on("error", finishError);
      response.on("aborted", () => finishError(new HttpError(502, "HTTP response aborted")));
      response.on("end", () => {
        if (settled) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
          settled = true;
          clearTimeout(deadline);
          resolveResponse({ status: response.statusCode ?? 502, body });
        } catch { finishError(new HttpError(502, "HTTP response was not valid JSON")); }
      });
    });
    const deadline = setTimeout(() => {
      const error = new HttpError(504, "HTTP request deadline exceeded");
      finishError(error);
      outbound.destroy(error);
    }, options.timeoutMs ?? HTTP_DEADLINE_MS);
    deadline.unref();
    outbound.on("error", finishError);
    outbound.end(encoded);
  });
}

export function configureServer(server: Server): Server {
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  server.keepAliveTimeout = 1_000;
  return server;
}

export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(url);
}

export function listenCli(server: Server, defaultPort: number): void {
  const port = Number(process.env.PORT ?? defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
  server.listen(port, process.env.HOST ?? "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "listening", address: server.address() }));
  });
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
