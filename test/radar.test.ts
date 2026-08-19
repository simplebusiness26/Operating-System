import { describe, expect, it } from 'vitest';
import { buildRadarSnapshot } from '../src/radar';

function fakeDb() {
  return {
    prepare(sql: string) {
      return {
        async all<T>() {
          if (sql.includes('FROM projects')) {
            return {
              results: [
                {
                  id: 'project_1',
                  name: 'Explorer',
                  status: 'active',
                  summary: 'Mobile-first discovery product',
                  goal: 'Reach a working Brighton pilot',
                  updated_at: '2026-08-19T00:00:00.000Z',
                },
              ] as T[],
            };
          }
          if (sql.includes('FROM events e')) {
            return {
              results: [
                {
                  id: 'evt_auth',
                  project_id: 'project_1',
                  project_name: 'Explorer',
                  type: 'code',
                  source: 'github',
                  title: 'Add login auth and sessions',
                  body: 'Implemented authentication for user accounts.',
                  tags_json: '["github","code"]',
                  importance: 60,
                },
                {
                  id: 'evt_maps',
                  project_id: 'project_1',
                  project_name: 'Explorer',
                  type: 'code',
                  source: 'github',
                  title: 'Switch map rendering to MapLibre',
                  body: 'MapLibre and OpenStreetMap rendering now works.',
                  tags_json: '["github","code"]',
                  importance: 65,
                },
                {
                  id: 'evt_deploy',
                  project_id: 'project_1',
                  project_name: 'Explorer',
                  type: 'milestone',
                  source: 'github',
                  title: 'Deployed web app to Vercel',
                  body: 'Production deployment is live.',
                  tags_json: '["github","deploy"]',
                  importance: 80,
                },
                {
                  id: 'evt_payment_idea',
                  project_id: 'project_1',
                  project_name: 'Explorer',
                  type: 'decision',
                  source: 'manual',
                  title: 'Maybe use Stripe later',
                  body: 'Payments are a future possibility, not implemented.',
                  tags_json: '["decision"]',
                  importance: 50,
                },
              ] as T[],
            };
          }
          if (sql.includes('FROM settings')) return { results: [] as T[] };
          throw new Error(`Unexpected SQL in fake D1: ${sql}`);
        },
      };
    },
  } as unknown as D1Database;
}

describe('Operating System -> Radar snapshot', () => {
  it('infers capabilities only from demonstrated code/milestone evidence', async () => {
    const snapshot = await buildRadarSnapshot(fakeDb());
    const capabilities = snapshot.capabilities.map((item) => item.capability);

    expect(capabilities).toEqual(expect.arrayContaining(['authentication', 'maps', 'deployment']));
    expect(capabilities).not.toContain('payments');
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.goals[0]?.name).toContain('Reach a working Brighton pilot');

    const auth = snapshot.capabilities.find((item) => item.capability === 'authentication');
    expect(auth?.providedBy).toEqual(['Explorer']);
    expect(auth?.evidenceRefs).toContain('os-event:evt_auth');
    expect(auth?.maturity).toBe('experimental');
  });
});
