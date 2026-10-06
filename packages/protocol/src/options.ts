export const MAX_TEST_ITERATIONS = 10_000_000;
export const MAX_RANDOM_SEED = Number.MAX_SAFE_INTEGER;
export const MIN_RANDOM_SEED = Number.MIN_SAFE_INTEGER;
export const ITERATIONS_ERROR = "Iterations must be an integer between 1 and 10,000,000.";
export const SEED_ERROR = "Seed must be an integer between -9,007,199,254,740,991 and 9,007,199,254,740,991.";

/**
 * Validate numeric wire/configuration input. UI text parsing is deliberately stricter; use parseIterations there.
 */
export function validIterations(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TEST_ITERATIONS;
}

/**
 * Require an exactly representable integer so TypeScript and Kotlin use the same deterministic seed.
 */
export function validSeed(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_RANDOM_SEED && value <= MAX_RANDOM_SEED;
}

/**
 * Parse unsigned decimal editor input; spaces, signs, fractions, and exponent notation are rejected.
 */
export function parseIterations(text: string): number | undefined {
  const value = Number(text);
  return /^\d+$/.test(text) && validIterations(value) ? value : undefined;
}

/**
 * Parse decimal editor input with an optional minus sign, returning undefined instead of throwing on invalid text.
 */
export function parseSeed(text: string): number | undefined {
  const value = Number(text);
  return /^-?\d+$/.test(text) && validSeed(value) ? value : undefined;
}

export const SEED_RANGE_ERROR = "Seed plus iterations minus one must remain within the safe integer range.";

/**
 * Validate every iteration's seed: the last seed is seed + iterations - 1 and must remain a safe integer.
 */
export function validSeedRange(seed: number, iterations: number): boolean {
  return validSeed(seed) && validIterations(iterations) && seed <= MAX_RANDOM_SEED - (iterations - 1);
}
