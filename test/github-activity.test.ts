import { describe, expect, it } from 'vitest';
import { githubActivityToEventInput } from '../src/github-activity';

describe('GitHub activity mapping', () => {
  it('turns a push event into a project-scoped code event', () => {
    const input = githubActivityToEventInput({
      id: 'evt-1',
      type: 'PushEvent',
      repo: { name: 'simplebusiness26/The-App' },
      public: true,
      created_at: '2026-08-19T02:00:00Z',
      payload: {
        ref: 'refs/heads/main',
        distinct_size: 2,
        commits: [
          { message: 'Fix map layout' },
          { message: 'Polish profile screen' },
        ],
      },
    });

    expect(input).not.toBeNull();
    expect(input?.projectName).toBe('The-App');
    expect(input?.type).toBe('code');
    expect(input?.source).toBe('github-activity');
    expect(input?.title).toContain('2 commits');
    expect(input?.body).toContain('Fix map layout');
    expect(input?.rawRef).toBe('github-event:evt-1');
  });

  it('treats a merged pull request as a milestone', () => {
    const input = githubActivityToEventInput({
      id: 'evt-2',
      type: 'PullRequestEvent',
      repo: { name: 'simplebusiness26/DesignLabV2' },
      public: true,
      created_at: '2026-08-19T02:05:00Z',
      payload: {
        action: 'closed',
        pull_request: {
          title: 'Ship tournament runner',
          body: 'Completes the tournament execution path.',
          html_url: 'https://github.com/simplebusiness26/DesignLabV2/pull/10',
          merged: true,
        },
      },
    });

    expect(input?.projectName).toBe('DesignLabV2');
    expect(input?.type).toBe('milestone');
    expect(input?.importance).toBeGreaterThanOrEqual(75);
  });

  it('ignores activity that is not a useful build signal', () => {
    const input = githubActivityToEventInput({
      id: 'evt-3',
      type: 'WatchEvent',
      repo: { name: 'simplebusiness26/Operating-System' },
      public: true,
      created_at: '2026-08-19T02:10:00Z',
      payload: { action: 'started' },
    });

    expect(input).toBeNull();
  });
});
