/**
 * Agent registry with built-in agents.
 */

import { registerAgent, getAgent, listAgents, hasAgent } from './registry.js';
import { createClaudeCodeAgent } from './claude-code/agent.js';
import { createCodexAgent } from './codex/agent.js';
import { createOpenCodeAgent } from './opencode/agent.js';
import { createFxAgent } from './fx/agent.js';
import { createGeminiAgent } from './gemini/agent.js';
import { createCursorAgent } from './cursor/agent.js';
import {
  assertBundledSkillsControl,
  assertCrossAgentJudgeSupport,
  assertWebResearchControl,
} from './plugin/contract.js';
import type { AgentType } from '../types.js';

// Register all agent variants (Vercel AI Gateway + Direct API)
registerAgent(createClaudeCodeAgent({ useVercelAiGateway: true }));   // vercel-ai-gateway/claude-code
registerAgent(createClaudeCodeAgent({ useVercelAiGateway: false }));  // claude-code
registerAgent(createCodexAgent({ useVercelAiGateway: true }));        // vercel-ai-gateway/codex
registerAgent(createCodexAgent({ useVercelAiGateway: false }));       // codex
registerAgent(createOpenCodeAgent());                                 // vercel-ai-gateway/opencode
registerAgent(createFxAgent());                                       // vercel-ai-gateway/fx
registerAgent(createGeminiAgent());                                   // gemini
registerAgent(createCursorAgent());                                   // cursor

/** Validate opt-in runtime controls for every agent used by a run. */
export function assertRunRuntimeControls(
  agentName: AgentType,
  controls: { disableBundledSkills?: boolean; webResearch?: boolean },
  judgeAgentName?: AgentType,
): void {
  const definition = getAgent(agentName).definition;
  assertBundledSkillsControl(definition, controls.disableBundledSkills);
  assertWebResearchControl(definition, controls.webResearch);

  if (judgeAgentName && judgeAgentName !== agentName) {
    const judgeDefinition = getAgent(judgeAgentName).definition;
    assertBundledSkillsControl(judgeDefinition, controls.disableBundledSkills);
    assertCrossAgentJudgeSupport(judgeDefinition);
  }
}

// Re-export registry functions
export { registerAgent, getAgent, listAgents, hasAgent };

// Re-export agent types
export type { Agent, AgentRunOptions, AgentRunResult } from './types.js';
