import type { SharedCache, RedisCacheClient } from "../domain/shared-cache.ts";
import type { SingleFlight } from "../domain/single-flight.ts";
import type { Product } from "../domain/product.ts";

export type CoordinatorScope = "request" | "shared";

export interface Coordinator {
  id: string;
  flight: SingleFlight<Product>;
}

export interface CaseComposition {
  cache: SharedCache;
  sharedCoordinator: Coordinator | undefined;
  coordinatorForRequest(): Coordinator;
}

export function createCaseComposition(
  _scope: CoordinatorScope,
  _redis: RedisCacheClient,
  _caseId: string,
): CaseComposition {
  throw new Error("Case composition is not implemented");
}
