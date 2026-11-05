import { isProductResponse } from "../contracts/product.ts";
import type { Product } from "../domain/product.ts";
import { HttpError, requestJson } from "./http.ts";
import { fromProductResponse } from "./product-mapping.ts";

export interface ProductRequestContext {
  caseId: string;
  requestId: string;
  coordinatorId: string;
}

export async function fetchProduct(originUrl: string, context: ProductRequestContext): Promise<Product> {
  const response = await requestJson<unknown>(new URL("/products/sku-demo", originUrl), {
    headers: {
      "x-case-id": context.caseId,
      "x-request-id": context.requestId,
      "x-coordinator-id": context.coordinatorId,
    },
  });
  if (response.status !== 200 || !isProductResponse(response.body)) {
    throw new HttpError(502, "Origin returned an invalid product response");
  }
  return fromProductResponse(response.body);
}