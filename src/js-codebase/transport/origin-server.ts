import { createServer, type Server, type ServerResponse } from "node:http";
import { fixedProduct } from "../domain/product.ts";
import { caseId, configureServer, correlationHeader, exactKeys, HttpError, isMain, listenCli, MAX_CASE_REQUESTS, MAX_CASES, ORIGIN_DEADLINE_MS, pathname, readObject, sendError, sendJson } from "./http.ts";

export interface OriginEvent {
  seq: number;
  atNs: string;
  type: "case-created" | "arrived" | "released" | "completed" | "failed" | "aborted";
  requestId?: string;
  coordinatorId?: string;
  statusCode?: number;
  held?: boolean;
}

export interface OriginRequest {
  requestId: string;
  coordinatorId: string;
  arrivedSeq: number;
  status: "pending" | "completed" | "failed" | "aborted";
  statusCode?: number;
  completedSeq?: number;
}

interface PendingResponse {
  response: ServerResponse;
  record: OriginRequest;
  deadline: ReturnType<typeof setTimeout>;
}

interface OriginCase {
  caseId: string;
  held: boolean;
  released: boolean;
  requests: OriginRequest[];
  events: OriginEvent[];
  pending: Set<PendingResponse>;
}

function event(state: OriginCase, type: OriginEvent["type"], detail: Omit<OriginEvent, "seq" | "atNs" | "type"> = {}): OriginEvent {
  const entry = { seq: state.events.length + 1, atNs: process.hrtime.bigint().toString(), type, ...detail };
  state.events.push(entry);
  return entry;
}

function snapshot(state: OriginCase) {
  const responseCounts: Record<string, number> = {};
  for (const record of state.requests) {
    if (record.statusCode !== undefined) responseCounts[String(record.statusCode)] = (responseCounts[String(record.statusCode)] ?? 0) + 1;
  }
  return {
    caseId: state.caseId,
    held: state.held,
    released: state.released,
    arrivals: state.requests.length,
    completed: state.requests.filter((record) => record.status === "completed").length,
    failed: state.requests.filter((record) => record.status === "failed" || record.status === "aborted").length,
    active: state.requests.filter((record) => record.status === "pending").length,
    responseCounts,
    requests: state.requests,
    events: state.events,
  };
}

/** Test origin. No knowledge of expected concurrency or number of followers. */
export function createOrigin(): Server {
  const cases = new Map<string, OriginCase>();
  const findCase = (id: string): OriginCase => {
    const state = cases.get(caseId(id));
    if (!state) throw new HttpError(404, "Unknown caseId");
    return state;
  };
  const reply = (pending: PendingResponse) => sendJson(pending.response, 200, fixedProduct);

  const server = createServer((request, response) => {
    void (async () => {
      const path = pathname(request);
      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, { status: "ok", service: "origin" });
        return;
      }
      if (process.env.DEMO_MODE !== "true") throw new HttpError(404, "Demo endpoints are disabled");
      if (request.method === "POST" && path === "/__demo/cases") {
        const body = await readObject(request);
        exactKeys(body, ["caseId", "held"]);
        const id = caseId(body.caseId);
        if (typeof body.held !== "boolean") throw new HttpError(400, "held must be a boolean");
        if (cases.has(id)) throw new HttpError(400, "caseId already exists");
        if (cases.size >= MAX_CASES) throw new HttpError(400, "Case capacity exceeded; restart this demo instance");
        const state: OriginCase = { caseId: id, held: body.held, released: !body.held, requests: [], events: [], pending: new Set() };
        event(state, "case-created", { held: state.held });
        cases.set(id, state);
        sendJson(response, 201, snapshot(state));
        return;
      }
      const releaseMatch = /^\/__demo\/cases\/([^/]+)\/release$/.exec(path);
      if (request.method === "POST" && releaseMatch) {
        const state = findCase(releaseMatch[1]!);
        if (!state.released) {
          state.held = false;
          state.released = true;
          event(state, "released");
          for (const pending of state.pending) reply(pending);
        }
        sendJson(response, 200, snapshot(state));
        return;
      }
      const inspectMatch = /^\/__demo\/cases\/([^/]+)$/.exec(path);
      if (request.method === "GET" && inspectMatch) {
        sendJson(response, 200, snapshot(findCase(inspectMatch[1]!)));
        return;
      }
      if (request.method === "GET" && path === "/products/sku-demo") {
        const state = findCase(correlationHeader(request.headers, "x-case-id"));
        const requestId = correlationHeader(request.headers, "x-request-id");
        const coordinatorId = correlationHeader(request.headers, "x-coordinator-id");
        if (state.requests.some((record) => record.requestId === requestId)) throw new HttpError(400, "Duplicate requestId");
        if (state.requests.length >= MAX_CASE_REQUESTS) throw new HttpError(400, "Case request capacity exceeded");
        const arrival = event(state, "arrived", { requestId, coordinatorId });
        const record: OriginRequest = { requestId, coordinatorId, arrivedSeq: arrival.seq, status: "pending" };
        state.requests.push(record);
        const finish = (status: OriginRequest["status"], statusCode?: number) => {
          if (record.status !== "pending") return;
          record.status = status;
          if (statusCode !== undefined) record.statusCode = statusCode;
          record.completedSeq = event(state, status === "pending" ? "failed" : status, { requestId, coordinatorId, ...(statusCode === undefined ? {} : { statusCode }) }).seq;
          clearTimeout(pending.deadline);
          state.pending.delete(pending);
        };
        const pending: PendingResponse = {
          response,
          record,
          deadline: setTimeout(() => sendJson(response, 504, { error: "Held origin request deadline exceeded" }), ORIGIN_DEADLINE_MS),
        };
        pending.deadline.unref();
        state.pending.add(pending);
        response.once("finish", () => finish(response.statusCode === 200 ? "completed" : "failed", response.statusCode));
        response.once("close", () => finish("aborted"));
        if (!state.held) reply(pending);
        return;
      }
      throw new HttpError(404, "Unknown route");
    })().catch((error: unknown) => sendError(response, error));
  });
  return configureServer(server);
}

if (isMain(import.meta.url)) listenCli(createOrigin(), 3011);
