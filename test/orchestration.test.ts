import { describe, expect, it } from 'vitest';
import { nativeRadarEnvelope } from '../src/radar-compatible-index';

describe('nativeRadarEnvelope', () => {
  it('promotes Radar execution-brief fields into the OS contract', () => {
    const mapped = nativeRadarEnvelope({
      handoffId: 'handoff_1',
      opportunityId: 'opp_1',
      brief: {
        headline: 'Benchmark the new processing path',
        readiness: { reason: 'Keep the existing pipeline available as rollback.' },
        input: {
          title: 'Faster ClipMine processing',
          thesis: 'A new processing path may cut runtime without reducing quality.',
          confidence: 0.82,
          criticalUnknowns: ['Quality parity is not yet proven.'],
          assumptions: ['The library remains maintained.'],
          validation: { successThreshold: 'At least 20% faster with no quality regression.' }
        }
      }
    });

    expect(mapped.title).toBe('Benchmark the new processing path');
    expect(mapped.objective).toBe('Benchmark the new processing path');
    expect(mapped.summary).toBe('A new processing path may cut runtime without reducing quality.');
    expect(mapped.confidence).toBe(0.82);
    expect(mapped.constraints).toEqual([
      'Quality parity is not yet proven.',
      'The library remains maintained.',
      'Keep the existing pipeline available as rollback.'
    ]);
    expect(mapped.successCriteria).toEqual(['At least 20% faster with no quality regression.']);
    expect(mapped.handoffId).toBe('handoff_1');
  });
});
