import { describe, it, expect } from 'vitest';
import { parseDuration } from '../../src/utils/parse-duration.js';

describe('parseDuration', () => {
  it('should parse seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('1s')).toBe(1_000);
  });

  it('should parse minutes', () => {
    expect(parseDuration('1m')).toBe(60_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('15m')).toBe(900_000);
  });

  it('should parse hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('should parse days', () => {
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('should parse milliseconds', () => {
    expect(parseDuration('500ms')).toBe(500);
  });

  it('should pass through numbers', () => {
    expect(parseDuration(60_000)).toBe(60_000);
  });

  it('should throw on invalid format', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('')).toThrow('Invalid duration');
  });

  it('should throw on negative numbers', () => {
    expect(() => parseDuration(-100)).toThrow('must be positive');
  });
});
