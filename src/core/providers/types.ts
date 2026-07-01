import { DiscoveredSession, ParsedSession, ProviderId } from '../types';
import { ExtensionConfig } from '../../config';

/**
 * A telemetry provider owns exactly the two provider-specific stages of the
 * pipeline: discovery (find sessions on disk) and parse-to-ParsedSession.
 * Everything downstream (ingest, stats, analytics, UI) is shared and operates
 * on the provider-neutral ParsedSession shape. See CLAUDE-PROVIDER-PLAN.md §2.
 */
export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  /** Synchronous, read-only filesystem walk. Must not throw on a missing root. */
  discover(config: ExtensionConfig): DiscoveredSession[];
  /** Parse one discovered session (and its subagents) into a ParsedSession. */
  parse(disc: DiscoveredSession, parseSubagents: boolean): Promise<ParsedSession | null>;
}

export { ProviderId };
