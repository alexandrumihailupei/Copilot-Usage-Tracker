import { DiscoveredSession, ParsedSession } from '../types';
import { ExtensionConfig } from '../../config';
import { ProviderAdapter } from './types';
import { discoverSessions } from '../logDiscovery';
import { buildSession } from '../sessionBuilder';

/**
 * Thin wrapper around the existing Copilot discovery + parse. Moves NO logic —
 * it only stamps provider='copilot' on the resulting session so downstream
 * provider-scoped queries classify it correctly. (OTel Tier-1 remains a
 * sync.ts special case outside the adapter registry.)
 */
export const copilotAdapter: ProviderAdapter = {
  id: 'copilot',
  displayName: 'GitHub Copilot',

  discover(config: ExtensionConfig): DiscoveredSession[] {
    return discoverSessions(config.logDirectories, config.autoScanWorkspaceStorage)
      .map(d => ({ ...d, provider: 'copilot' as const }));
  },

  async parse(disc: DiscoveredSession, parseSubagents: boolean): Promise<ParsedSession | null> {
    const parsed = await buildSession(disc, parseSubagents);
    if (!parsed) { return null; }
    parsed.session.provider = 'copilot';
    for (const r of parsed.llmRequests) { r.provider = 'copilot'; }
    return parsed;
  },
};
