/**
 * Shared production V8 policy applied by adapters, workers, and official tool children.
 * These component heap limits do not enforce or prove the 256 MiB combined RSS target:
 * native allocations and concurrent processes must also be measured.
 * Kotlin launch arguments mirror this policy; update and validate both adapters together.
 */
export const serverNodeArgs = ["--max-old-space-size=96", "--max-semi-space-size=2"] as const;
export const toolNodeArgs = ["--max-old-space-size=64", "--max-semi-space-size=2"] as const;
export const analysisWorkerLimits = { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 4 } as const;

/**
 * User-visible latency requirement, not permission to count a fast stale/empty/error response as successful.
 */
export const interactionDeadlineMs = 1000;
export const interactionTargetMs = 500;
