import type {
  CompletedTurnResult,
  EvalFixture,
  InteractionConfig,
  InteractionTurn,
} from '../types.js';

export interface RunNaturalInteractionOptions<
  TResult extends CompletedTurnResult = CompletedTurnResult,
> {
  initialPrompt: string;
  interaction?: InteractionConfig<TResult>;
  fixture: EvalFixture;
  runIndex: number;
  generate(prompt: string): Promise<TResult>;
}

/**
 * Drive natural completed assistant turns. The supplied `generate` function is
 * responsible for retaining one native agent session across calls.
 */
export async function runNaturalInteraction<
  TResult extends CompletedTurnResult = CompletedTurnResult,
>(options: RunNaturalInteractionOptions<TResult>): Promise<{
  result: TResult;
  turns: InteractionTurn<TResult>[];
}> {
  const maxTurns = options.interaction?.maxTurns ?? 3;
  const turns: InteractionTurn<TResult>[] = [];
  let prompt = options.initialPrompt;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const result = await options.generate(prompt);
    const completed: InteractionTurn<TResult> = { turn, result };
    turns.push(completed);

    if (!options.interaction) return { result, turns };

    const response = await options.interaction.respond({
      turn,
      result,
      history: turns,
      fixture: options.fixture,
      runIndex: options.runIndex,
    });
    if (response === null) return { result, turns };
    if (!response.trim()) {
      throw new Error('Interaction respond() must return a non-empty prompt or null.');
    }

    completed.userResponse = response;
    if (turn === maxTurns) {
      throw new Error(`Interaction exceeded maxTurns (${maxTurns}).`);
    }
    prompt = response;
  }

  throw new Error(`Interaction exceeded maxTurns (${maxTurns}).`);
}
