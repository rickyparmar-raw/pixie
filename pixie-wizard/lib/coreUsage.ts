import { coreUsage, type CoreUsageAggregate, type CoreUsageParams } from "@/lib/pixieCore";

export type { CoreUsageAggregate, CoreUsageParams };

export async function fetchCoreUsage(programId: string, params: CoreUsageParams): Promise<CoreUsageAggregate> {
  return coreUsage(programId, params);
}
