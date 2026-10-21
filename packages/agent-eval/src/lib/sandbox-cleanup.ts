/** Cleanup failure means the sandbox may still be running. Never retry or reuse its slot. */
export class SandboxCleanupError extends Error {
  constructor(sandboxId: string, cause: unknown, initializationError?: unknown) {
    const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
    super(
      `${initializationError === undefined ? '' : `Sandbox initialization failed: ${detail(initializationError)}; `}` +
      `Failed to stop sandbox ${sandboxId}: ${detail(cause instanceof SandboxCleanupError ? cause.cause : cause)}`,
      { cause },
    );
    this.name = 'SandboxCleanupError';
  }
}
