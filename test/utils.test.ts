import { describe, expect, it } from 'vitest';
import { inferEventType, inferImportance, parseTags, slugify, firstSentence } from '../src/utils';

describe('signal inference', () => {
  it('classifies decisions', () => expect(inferEventType('We decided to use D1')).toBe('decision'));
  it('classifies problems', () => expect(inferEventType('App crashed on launch')).toBe('problem'));
  it('classifies wins', () => expect(inferEventType('Shipped the working build')).toBe('milestone'));
  it('scores launches above ordinary notes', () => expect(inferImportance('Launched the major product')).toBeGreaterThan(inferImportance('Wrote a note')));
  it('extracts known tags', () => expect(parseTags('AI agent deployment on Cloudflare')).toEqual(expect.arrayContaining(['ai','agent','deploy','cloudflare'])));
});

describe('text helpers', () => {
  it('creates stable slugs', () => expect(slugify('Operating System V1')).toBe('operating-system-v1'));
  it('clips long first sentences', () => expect(firstSentence('A'.repeat(250), 20)).toHaveLength(20));
});
