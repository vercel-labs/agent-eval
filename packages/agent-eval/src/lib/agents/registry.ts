/**
 * Agent registry for managing available agents.
 */

import type { Agent } from './types.js';
import type { AgentType } from '../types.js';

const agents = new Map<string, Agent>();

/**
 * Register an agent in the registry.
 */
export function registerAgent(agent: Agent): void {
  if (!agent.name.trim()) {
    throw new Error('Agent name must be a non-empty string.');
  }

  // Preserve the registry's existing replacement behavior. This also makes
  // shared registration modules safe when config loading evaluates them more
  // than once (for example, across multiple experiment files).
  agents.set(agent.name, agent);
}

/**
 * Get an agent by name.
 * @throws Error if agent is not found
 */
export function getAgent(name: AgentType): Agent {
  const agent = agents.get(name);
  if (!agent) {
    const available = listAgents().join(', ');
    throw new Error(`Unknown agent: ${name}. Available agents: ${available}`);
  }
  return agent;
}

/**
 * List all registered agents.
 */
export function listAgents(): string[] {
  return Array.from(agents.keys());
}

/**
 * Check if an agent is registered.
 */
export function hasAgent(name: string): boolean {
  return agents.has(name);
}
