import type { Product } from "./product.ts";
import type { SharedCache } from "./shared-cache.ts";
import type { SingleFlight, FlightRole } from "./single-flight.ts";

export interface ProductObservation {
  lookup(hit: boolean): void;
  flight(role: FlightRole): void;
}

export async function getProduct(
  _cache: SharedCache,
  _flight: SingleFlight<Product>,
  _fetchProduct: () => Promise<Product>,
  _observe: ProductObservation,
): Promise<Product> {
  throw new Error("Product retrieval is not implemented");
}
