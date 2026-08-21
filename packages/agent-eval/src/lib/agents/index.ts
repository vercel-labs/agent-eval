/**
 * Agent registry with built-in agents.
 */

import { registerAgent, getAgent, listAgents, hasAgent } from './registry.js';
import { createClaudeCodeAgent } from './claude-code/agent.js';
import { createCodexAgent } from './codex/agent.js';
import { createOpenCodeAgent } from './opencode/agent.js';
import { createGeminiAgent } from './gemini/agent.js';
import { createCursorAgent } from './cursor/agent.js';
import { assertBundledSkillsControl } from './plugin/contract.js';
import type { AgentType } from '../types.js';

// Register all agent variants (Vercel AI Gateway + Direct API)
registerAgent(createClaudeCodeAgent({ useVercelAiGateway: true }));   // vercel-ai-gateway/claude-code
registerAgent(createClaudeCodeAgent({ useVercelAiGateway: false }));  // claude-code
registerAgent(createCodexAgent({ useVercelAiGateway: true }));        // vercel-ai-gateway/codex
registerAgent(createCodexAgent({ useVercelAiGateway: false }));       // codex
registerAgent(createOpenCodeAgent());                                 // vercel-ai-gateway/opencode
registerAgent(createGeminiAgent());                                   // gemini
registerAgent(createCursorAgent());                                   // cursor

/** Validate bundled-skill isolation for every agent used by a run. */
export function assertRunBundledSkillsControl(
  agentName: AgentType,
  requested?: boolean,
  judgeAgentName?: AgentType,
): void {
  const agentNames = new Set([agentName, judgeAgentName ?? agentName]);
  for (const name of agentNames) {
    assertBundledSkillsControl(getAgent(name).definition, requested);
  }
}

// Re-export registry functions
export { registerAgent, getAgent, listAgents, hasAgent };

// Re-export agent types
export type { Agent, AgentRunOptions, AgentRunResult } from './types.js';
