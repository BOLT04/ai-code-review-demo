import type { RuntimeApiEvidence } from "./types.ts";
import { request as httpRequest, type IncomingMessage } from "node:http";

const REQUEST_TIMEOUT_MS = 2_000;
const RESPONSE_LIMIT_BYTES = 4 * 1024;
const MAX_METHOD_LENGTH = 32;
export const RUNTIME_API_PATHS = [
  "/health",
  "/counter",
  "/profile/ada/en",
  "/profile/ada/es",
  "/profile/grace/es",
] as const;
const ALLOWED_PATHS: ReadonlySet<string> = new Set(RUNTIME_API_PATHS);

export const RUNTIME_API_TOOL_NAME = "check_runtime_api";

export function parseRuntimeApiBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Runtime API URL must be a credential-free loopback HTTP origin");
  }
  return url;
}

function parseMethod(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_METHOD_LENGTH ||
    !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)
  ) {
    throw new Error(`HTTP method must be a valid token no longer than ${MAX_METHOD_LENGTH} characters`);
  }
  return value.toUpperCase();
}

function parseRequestUrl(baseUrl: string, path: string): URL {
  const base = parseRuntimeApiBaseUrl(baseUrl);
  if (!ALLOWED_PATHS.has(path)) {
    throw new Error(`Request path must be one of: ${RUNTIME_API_PATHS.join(", ")}`);
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin) {
    throw new Error("Request path must remain on the configured loopback origin");
  }
  return url;
}

export async function checkRuntimeApi(
  baseUrl: string,
  methodInput: string,
  path: string,
): Promise<RuntimeApiEvidence> {
  const method = parseMethod(methodInput);
  const url = parseRequestUrl(baseUrl, path);
  const request = { method, url: url.toString() };
  return new Promise((resolve) => {
    let responseEvidence: RuntimeApiEvidence["response"];
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      resolve({
        request,
        ...(responseEvidence ? { response: responseEvidence } : {}),
        ...(error ? { error: error.slice(0, 300) } : {}),
      });
    };
    const captureResponse = (response: IncomingMessage, closeSocket?: () => void) => {
      const contentType = response.headers["content-type"];
      responseEvidence = {
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? "",
        contentType: Array.isArray(contentType) ? contentType.join(", ") : contentType ?? null,
        body: "",
      };
      if (closeSocket) {
        finish();
        closeSocket();
        return;
      }
      const chunks: Buffer[] = [];
      let byteCount = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteCount += buffer.byteLength;
        if (byteCount > RESPONSE_LIMIT_BYTES) {
          responseEvidence!.body = "[response body omitted]";
          finish(`Response exceeded ${RESPONSE_LIMIT_BYTES} bytes`);
          clientRequest.destroy();
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        if (!settled) responseEvidence!.body = Buffer.concat(chunks).toString("utf8");
        finish();
      });
      response.on("error", (error: Error) => finish(error.message));
    };
    const clientRequest = httpRequest(url, {
      method,
      headers: { accept: "application/json" },
    }, captureResponse);
    clientRequest.on("connect", (response, socket) => {
      captureResponse(response, () => socket.destroy());
    });
    clientRequest.on("upgrade", (response, socket) => {
      captureResponse(response, () => socket.destroy());
    });
    clientRequest.setTimeout(REQUEST_TIMEOUT_MS, () => {
      clientRequest.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    clientRequest.on("error", (error: Error) => finish(error.message));
    clientRequest.end();
  });
}
