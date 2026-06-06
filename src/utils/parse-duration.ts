const DURATION_REGEX = /^(\d+)(ms|s|m|h|d)$/;

const MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * @example
 * parseDuration("30s")  // → 30000
 * parseDuration("5m")   // → 300000
 * parseDuration("1h")   // → 3600000
 * parseDuration(60000)  // → 60000 (passthrough)
 */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (input <= 0) {
      throw new Error(`Duration must be positive, got ${input}`);
    }
    return input;
  }

  const match = input.match(DURATION_REGEX);
  if (!match) {
    throw new Error(
      `Invalid duration "${input}". Use format like "30s", "5m", "1h", or a number in milliseconds.`,
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];
  const ms = value * MULTIPLIERS[unit];

  if (ms <= 0) {
    throw new Error(`Duration must be positive, got "${input}"`);
  }

  return ms;
}
