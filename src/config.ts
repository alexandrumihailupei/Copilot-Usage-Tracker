import * as vscode from 'vscode';

export type CopilotPlan = 'free' | 'pro' | 'pro+' | 'business' | 'enterprise';
export type ClaudeCostBasis = 'api' | 'subscription';

export interface ExtensionConfig {
  logDirectories: string[];
  autoScanWorkspaceStorage: boolean;
  parseSubagentLogs: boolean;
  defaultGroupBy: 'date' | 'workspace' | 'model';
  plan: CopilotPlan;
  /** Root directory for Claude Code transcripts (default ~/.claude/projects). */
  claudeProjectsDirectory: string;
  /** How to frame Claude USD: 'api' = list-price spend; 'subscription' = API-equivalent. */
  claudeCostBasis: ClaudeCostBasis;
}

export function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('copilotUsageTracker');
  return {
    logDirectories: cfg.get<string[]>('logDirectories', []),
    autoScanWorkspaceStorage: cfg.get<boolean>('autoScanWorkspaceStorage', true),
    parseSubagentLogs: cfg.get<boolean>('parseSubagentLogs', true),
    defaultGroupBy: cfg.get<'date' | 'workspace' | 'model'>('defaultGroupBy', 'date'),
    plan: cfg.get<CopilotPlan>('plan', 'business'),
    claudeProjectsDirectory: cfg.get<string>('claudeProjectsDirectory', '~/.claude/projects'),
    claudeCostBasis: cfg.get<ClaudeCostBasis>('claudeCostBasis', 'api'),
  };
}
