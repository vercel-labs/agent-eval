# Agent Eval

## Development Guidelines

### No New Environment Variables

Configuration should be done through the experiment config file, not environment variables.

- All experiment settings belong in `ExperimentConfig` (see `src/lib/types.ts`)
- The only acceptable env vars are API keys (e.g., `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `VERCEL_TOKEN`)
- When adding new configuration options, add them to the config schema in `src/lib/config.ts`
