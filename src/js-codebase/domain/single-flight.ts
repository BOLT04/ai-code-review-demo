export type FlightRole = "leader" | "joined";

export class SingleFlight<T> {
  async run(_key: string, _load: () => T | Promise<T>, _observe?: (role: FlightRole) => void): Promise<T> {
    throw new Error("Single-flight coordination is not implemented");
  }

  get size(): number {
    throw new Error("Single-flight size is not implemented");
  }
}
