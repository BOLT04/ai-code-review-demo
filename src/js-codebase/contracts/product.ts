export interface ProductResponse {
  sku: string;
  name: string;
  priceCents: number;
  version: number;
}

const PRODUCT_RESPONSE_KEYS = ["sku", "name", "priceCents", "version"] as const;

export function isProductResponse(value: unknown): value is ProductResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== PRODUCT_RESPONSE_KEYS.length) return false;
  if (!PRODUCT_RESPONSE_KEYS.every((key) => Object.hasOwn(candidate, key))) return false;
  return typeof candidate.sku === "string" && candidate.sku.length > 0
    && typeof candidate.name === "string" && candidate.name.length > 0
    && Number.isSafeInteger(candidate.priceCents) && (candidate.priceCents as number) >= 0
    && Number.isSafeInteger(candidate.version) && (candidate.version as number) > 0;
}