import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";
import { isProductResponse } from "../contracts/product.ts";
import { fixedProduct } from "../domain/product.ts";
import { createOrigin } from "../transport/origin-server.ts";
import { fetchProduct } from "../transport/product-client.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("origin and client use and validate the shared product response contract", async () => {
  const previousDemoMode = process.env.DEMO_MODE;
  const origin = createOrigin();
  const originUrl = await listen(origin);
  try {
    process.env.DEMO_MODE = "true";
    const created = await fetch(`${originUrl}/__demo/cases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caseId: "case-contract", held: false }),
    });
    assert.equal(created.status, 201);

    assert.deepEqual(await fetchProduct(originUrl, {
      caseId: "case-contract",
      requestId: "request-contract",
      coordinatorId: "coordinator-contract",
    }), fixedProduct);
    assert.equal(isProductResponse({ ...fixedProduct, extra: true }), false);
  } finally {
    if (previousDemoMode === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previousDemoMode;
    await close(origin);
  }
});