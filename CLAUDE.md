# Agent Eval

## Development Guidelines

### No New Environment Variables

Configuration should be done through the experiment config file, not environment variables.

- All experiment settings belong in `ExperimentConfig` (see `src/lib/types.ts`)
- The only acceptable env vars are API keys (e.g., `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `VERCEL_TOKEN`)
- When adding new configuration options, add them to the config schema in `src/lib/config.ts`

### DRY & Colocation

- Don't duplicate logic across files. If the same check exists in multiple places, extract it into a single function and import it.
- Colocate shared helpers in the module that owns the concept (e.g. classification logic belongs in `classifier.ts`, not scattered across `housekeeping.ts` and `results.ts`).

### Testing

- Always use the existing integration test framework (`src/integration.test.ts`) for testing
- Do not create standalone test scripts in `/tmp` - they won't have proper module resolution
- Run integration tests with: `INTEGRATION_TEST=1 npx vitest run src/integration.test.ts --testNamePattern="<pattern>"`

### Adding a New Agent

When adding a new agent to the framework, follow this checklist:

- [ ] Agent implementation in `src/lib/agents/`
- [ ] Register in `src/lib/agents/index.ts`
- [ ] Add to `AgentType` in `src/lib/types.ts`
- [ ] Add to config schema in `src/lib/config.ts`
- [ ] Add API key config in `src/lib/agents/shared.ts`
- [ ] Add transcript parser in `src/lib/o11y/parsers/`
- [ ] Register parser in `src/lib/o11y/parsers/index.ts`
- [ ] Export parser from `src/lib/o11y/index.ts`
- [ ] Add parser tests in `src/lib/o11y/o11y.test.ts`
- [ ] Add integration tests in `src/integration.test.ts`
- [ ] Update README.md

### Pull Requests

- Every PR that changes user-facing behavior should update the README
- Every PR should include a changeset (`npx changeset`) for version management
