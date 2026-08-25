/** Which artifact a judge assertion evaluates. */
export type JudgeSubjectKind = 'environment' | 'transcript';

/**
 * Opaque sentinel you pass to `expect(...)`. The matcher routes on which subject
 * it receives; the path/cwd resolution is an internal detail. Import the
 * `environment` and `transcript` values rather than constructing this yourself.
 */
export interface JudgeSubject {
  readonly __judgeSubject: JudgeSubjectKind;
}

/** A parsed judge verdict. */
export interface JudgeVerdict {
  /** Whether the judge decided the criterion is satisfied. */
  pass: boolean;
  /** 0–1 score, present only for numeric judgments. */
  score?: number;
  /** 1–2 sentences citing concrete evidence. */
  reason: string;
}

/** Options for {@link buildJudgePrompt}. */
export interface BuildJudgePromptOptions {
  /** Ask the judge for a 0–1 score in addition to the pass/fail verdict. */
  numeric?: boolean;
}

export declare const environment: JudgeSubject;

export declare const transcript: JudgeSubject;

export declare function transcriptPath(): string;

export declare function buildJudgePrompt(
  subject: JudgeSubjectKind,
  criterion: string,
  verdictPath: string,
  opts?: BuildJudgePromptOptions
): string;

export declare function parseJudgeVerdict(raw: string | null | undefined): JudgeVerdict | null;

declare module 'vitest' {
  interface Assertion<T = any> {
    /**
     * Agentic LLM-judge matcher. Re-invokes the codegen agent in-sandbox to decide
     * whether `criterion` is satisfied for the `environment` or `transcript` subject.
     * Pass the subject to `expect(...)`:
     *
     *   await expect(environment).toSatisfyCriterion('uses Server Components');
     */
    toSatisfyCriterion(criterion: string): Promise<void>;
    /**
     * Agentic LLM-judge matcher. Passes when the judge's 0–1 score for `criterion`
     * is `>= threshold`:
     *
     *   await expect(environment).toScoreAtLeast('production-quality errors', 0.8);
     */
    toScoreAtLeast(criterion: string, threshold: number): Promise<void>;
  }

  interface AsymmetricMatchersContaining {
    toSatisfyCriterion(criterion: string): Promise<void>;
    toScoreAtLeast(criterion: string, threshold: number): Promise<void>;
  }
}
