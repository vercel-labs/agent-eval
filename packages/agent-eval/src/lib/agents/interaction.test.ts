import { describe, expect, it, vi } from 'vitest';
import { runNaturalInteraction } from './interaction.js';
import type { EvalFixture } from '../types.js';

const fixture: EvalFixture = {
  name: 'deploy',
  path: '/fixture',
  prompt: 'Deploy this',
  isModule: true,
};

describe('runNaturalInteraction', () => {
  it('runs one turn when interaction is omitted', async () => {
    const generate = vi.fn(async (prompt: string) => ({ text: `answer: ${prompt}` }));

    const outcome = await runNaturalInteraction({
      initialPrompt: fixture.prompt,
      fixture,
      runIndex: 0,
      generate,
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(outcome.result.text).toBe('answer: Deploy this');
    expect(outcome.turns).toHaveLength(1);
  });

  it('sends returned responses as new turns using the same generator', async () => {
    const generate = vi
      .fn<(prompt: string) => Promise<{ text: string }>>()
      .mockResolvedValueOnce({ text: 'Which region?' })
      .mockResolvedValueOnce({ text: 'Deployed to iad1.' });
    const respond = vi.fn(async ({ turn }: { turn: number }) =>
      turn === 1 ? 'Use iad1.' : null
    );

    const outcome = await runNaturalInteraction({
      initialPrompt: fixture.prompt,
      fixture,
      runIndex: 2,
      interaction: { maxTurns: 2, respond },
      generate,
    });

    expect(generate).toHaveBeenNthCalledWith(1, 'Deploy this');
    expect(generate).toHaveBeenNthCalledWith(2, 'Use iad1.');
    expect(outcome.turns[0].userResponse).toBe('Use iad1.');
    expect(outcome.result.text).toBe('Deployed to iad1.');
  });

  it('passes completed-turn history and run context to respond', async () => {
    const respond = vi.fn(() => null);

    await runNaturalInteraction({
      initialPrompt: fixture.prompt,
      fixture,
      runIndex: 4,
      interaction: { respond },
      generate: async () => ({ text: 'done', native: true }),
    });

    expect(respond).toHaveBeenCalledWith({
      turn: 1,
      result: { text: 'done', native: true },
      history: [{ turn: 1, result: { text: 'done', native: true } }],
      fixture,
      runIndex: 4,
    });
  });

  it('fails instead of starting a turn beyond maxTurns', async () => {
    const generate = vi.fn(async () => ({ text: 'more?' }));

    await expect(
      runNaturalInteraction({
        initialPrompt: fixture.prompt,
        fixture,
        runIndex: 0,
        interaction: { maxTurns: 1, respond: () => 'continue' },
        generate,
      })
    ).rejects.toThrow('Interaction exceeded maxTurns (1).');
    expect(generate).toHaveBeenCalledOnce();
  });

  it('rejects empty simulated user prompts', async () => {
    await expect(
      runNaturalInteraction({
        initialPrompt: fixture.prompt,
        fixture,
        runIndex: 0,
        interaction: { respond: () => '  ' },
        generate: async () => ({ text: 'question' }),
      })
    ).rejects.toThrow('Interaction respond() must return a non-empty prompt or null.');
  });
});
