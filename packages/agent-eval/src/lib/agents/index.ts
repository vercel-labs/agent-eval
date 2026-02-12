/**
 * Agent registry with built-in agents.
 */

import { registerAgent, getAgent, listAgents, hasAgent } from './registry.js';
import { createClaudeCodeAgent } from './claude-code.js';
import { createCodexAgent } from './codex.js';
import { createOpenCodeAgent } from './opencode.js';
import { createGeminiAgent } from './gemini.js';
import { createCursorAgent } from './cursor.js';

// Register all agent variants (Vercel AI Gateway + Direct API)
registerAgent(createClaudeCodeAgent({ useVercelAiGateway: true }));   // vercel-ai-gateway/claude-code
registerAgent(createClaudeCodeAgent({ useVercelAiGateway: false }));  // claude-code
registerAgent(createCodexAgent({ useVercelAiGateway: true }));        // vercel-ai-gateway/codex
registerAgent(createCodexAgent({ useVercelAiGateway: false }));       // codex
registerAgent(createOpenCodeAgent());                                 // vercel-ai-gateway/opencode
registerAgent(createGeminiAgent());                                   // gemini
registerAgent(createCursorAgent());                                   // cursor

// Re-export registry functions
export { registerAgent, getAgent, listAgents, hasAgent };

// Re-export agent types
export type { Agent, AgentRunOptions, AgentRunResult } from './types.js';
