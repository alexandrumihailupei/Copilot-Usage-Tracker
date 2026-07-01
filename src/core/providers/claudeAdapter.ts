import { DiscoveredSession, ParsedSession } from '../types';
import { ExtensionConfig } from '../../config';
import { ProviderAdapter } from './types';
import { discoverClaudeSessions, CLAUDE_ID_PREFIX } from './claudeDiscovery';
import { buildClaudeModelMap } from './claudeModels';
import { parseClaudeFile } from './claudeCollect';

/** Derive a readable subagent label from a `subagents/agent-<hex>.jsonl` filename. */
function subagentNameFromPath(childPath: string): string {
  const file = childPath.split(/[\\/]/).pop() || '';
  return file.replace(/\.jsonl$/i, '');
}

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  displayName: 'Claude',

  discover(config: ExtensionConfig): DiscoveredSession[] {
    return discoverClaudeSessions(config.claudeProjectsDirectory);
  },

  async parse(disc: DiscoveredSession, parseSubagents: boolean): Promise<ParsedSession | null> {
    const models = buildClaudeModelMap();

    const main = parseClaudeFile(
      disc.mainJsonlPath, disc.sessionId, disc.workspaceId, disc.dirPath, models, false, undefined,
    );
    if (!main.session) { return null; }

    const llmRequests = main.llmRequests;
    const userMessages = main.userMessages;
    const toolCalls = main.toolCalls;
    let turnCount = main.turnCount;
    const subagentNames = new Set<string>();

    // Cross-file requestId dedup. Each file is parsed independently and dedups its
    // OWN lines by requestId (claudeCollect), but a resumed/forked session can replay
    // prior history into a new file, so the SAME requestId (identical usage) may recur
    // across files. Without a global guard, concatenating would double-count those
    // requests (and their tokens/cost). In the common case (no replay) this dedups
    // nothing. spanId === requestId for Claude records.
    const seenSpans = new Set<string>(llmRequests.map(r => r.spanId));

    if (parseSubagents) {
      for (const childPath of disc.childJsonlPaths) {
        const name = subagentNameFromPath(childPath);
        const child = parseClaudeFile(childPath, disc.sessionId, disc.workspaceId, disc.dirPath, models, true, name);
        // Roll subagent token usage up into the parent session (mirrors the
        // Copilot subagent accounting in sessionBuilder.buildSession).
        const freshChildRequests = child.llmRequests.filter(r => {
          if (seenSpans.has(r.spanId)) { return false; }
          seenSpans.add(r.spanId);
          return true;
        });
        llmRequests.push(...freshChildRequests);
        userMessages.push(...child.userMessages);
        toolCalls.push(...child.toolCalls);
        turnCount += child.turnCount;
        if (freshChildRequests.length > 0) { subagentNames.add(name); }
      }
    }

    return {
      session: main.session,
      llmRequests,
      userMessages,
      toolCalls,
      turnCount,
      subagentNames: Array.from(subagentNames),
      childSessionFiles: disc.childJsonlPaths,
      models,
    };
  },
};

export { CLAUDE_ID_PREFIX };
