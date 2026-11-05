import type { ProductResponse } from "../contracts/product.ts";
import type { Product } from "../domain/product.ts";

export function toProductResponse(product: Product): ProductResponse {
  return {
    sku: product.sku,
    name: product.name,
    priceCents: product.priceCents,
    version: product.version,
  };
}

export function fromProductResponse(response: ProductResponse): Product {
  return {
    sku: response.sku,
    name: response.name,
    priceCents: response.priceCents,
    version: response.version,
  };
}