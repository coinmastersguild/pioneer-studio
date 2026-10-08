import type { JobModel } from "./api";
import { pickModel } from "./pipeline";

/** Retained catalog rows during an outage cannot advertise paid capabilities. */
export function modelActionAvailable(
  catalog: { models: JobModel[]; catalogAvailable: boolean },
  capability: Parameters<typeof pickModel>[1],
): boolean {
  return catalog.catalogAvailable && !!pickModel(catalog.models, capability);
}
