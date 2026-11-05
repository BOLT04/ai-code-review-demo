import type { Product } from "./product.ts";

export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
}

export class SharedCache {
  constructor(_client: RedisCacheClient, _caseId: string, _ttlSeconds = 600) {
    throw new Error("Shared cache is not implemented");
  }

  async get(): Promise<Product | undefined> {
    throw new Error("Shared cache lookup is not implemented");
  }

  async set(_value: Product): Promise<void> {
    throw new Error("Shared cache write is not implemented");
  }
}
