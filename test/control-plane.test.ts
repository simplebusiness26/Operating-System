import { describe, expect, it } from 'vitest';
import { attentionLane, chooseExecutionSystem, classifyActionRisk } from '../src/control-plane';

describe('control-plane risk gates', () => {
  it('requires high risk for deploys', () => expect(classifyActionRisk('Deploy the app to production')).toBe('high'));
  it('marks spending and credentials critical', () => expect(classifyActionRisk('Change the payment credential and spend money')).toBe('critical'));
  it('keeps read-only analysis low risk', () => expect(classifyActionRisk('Analyse the latest project evidence')).toBe('low'));
});

describe('specialist routing', () => {
  it('routes UI work to DesignLab', () => expect(chooseExecutionSystem('Redesign the mobile UI and UX')).toBe('designlab'));
  it('routes software builds to AI Factory', () => expect(chooseExecutionSystem('Build the next app feature')).toBe('ai-factory'));
  it('routes content to GhostWriter', () => expect(chooseExecutionSystem('Write an X post about this milestone')).toBe('ghostwriter'));
  it('keeps generic analysis internal', () => expect(chooseExecutionSystem('Review what happened today')).toBe('operating-system'));
});

describe('attention lanes', () => {
  it('puts approvals in now', () => expect(attentionLane(60, 'waiting_approval', 'high')).toBe('now'));
  it('puts blocked work in waiting', () => expect(attentionLane(90, 'blocked')).toBe('waiting'));
  it('puts low priority work in ignore', () => expect(attentionLane(20, 'open')).toBe('ignore'));
});
