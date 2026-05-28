import * as vscode from 'vscode';
import { TrackerDatabase } from '../../db/database';
import { SessionInfo, SessionStats } from '../../core/types';
import { formatTokens, formatDateTime, getDateGroup, formatDuration } from '../../util/dateUtils';
import { computeBillingStatus, getMultiplier, computeCostUSD } from '../../stats/billingCalculator';
import { getConfig } from '../../config';

type TreeItemData =
  | { kind: 'group'; label: string; sessions: (SessionInfo & SessionStats)[] }
  | { kind: 'session'; data: SessionInfo & SessionStats }
  | { kind: 'stat'; label: string; value: string }
  | { kind: 'action'; label: string; command: string };

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeItemData> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItemData | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private db: TrackerDatabase) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItemData): vscode.TreeItem {
    switch (element.kind) {
      case 'group': {
        const item = new vscode.TreeItem(
          `${element.label} (${element.sessions.length})`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon('calendar');
        return item;
      }

      case 'session': {
        const s = element.data;
        const time = new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const tokens = s.totalTokens > 0 ? `${formatTokens(s.totalTokens)} tokens` : 'empty';
        const model = s.dominantModel ? ` (${shortModelName(s.dominantModel)})` : '';
        const ds = s.dataSource || '';
        const dsBadge = ds === 'otel' ? ' [OTel]' : ds === 'hybrid' ? ' [Hyb]' : '';
        const audit = s.costAuditState && s.costAuditState !== 'measured' ? ` [${s.costAuditState}]` : '';
        const label = `${time} - ${tokens}${model}${dsBadge}${audit}`;

        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = 'session';
        const tooltipLines = [
          `**Session** ${s.id.substring(0, 8)}`,
          `**Started** ${formatDateTime(s.startTime)}`,
          `**Duration** ${formatDuration(s.durationMs)}`,
          `**Tokens** ${formatTokens(s.totalTokens)} (in: ${formatTokens(s.totalInputTokens)}, out: ${formatTokens(s.totalOutputTokens)})`,
          `**Cost (Jun 2026)** $${(s.costUSD ?? 0).toFixed(3)}${s.costAuditState ? ` (${s.costAuditState})` : ''}`,
          `**Requests** ${s.llmRequestCount} | **Messages** ${s.userMessageCount} | **Tools** ${s.toolCallCount}`,
          `**Model** ${s.dominantModel}`,
          `**Errors** ${s.errorCount}`,
        ];
        if (s.repository) {
          tooltipLines.push(`**Repository** ${s.repository}${s.branch ? `:${s.branch}` : ''}`);
        }
        if (s.dataSource) {
          tooltipLines.push(`**Data source** ${s.dataSource === 'otel' ? 'OTel (measured)' : s.dataSource === 'hybrid' ? 'Hybrid' : 'JSONL (estimated)'}`);
        }
        if (s.totalReasoningTokens && s.totalReasoningTokens > 0) {
          tooltipLines.push(`**Reasoning** ${formatTokens(s.totalReasoningTokens)} tokens`);
        }
        if (s.totalCachedTokens && s.totalCachedTokens > 0) {
          tooltipLines.push(`**Cached** ${formatTokens(s.totalCachedTokens)} tokens`);
        }
        if (s.totalCacheWriteTokens && s.totalCacheWriteTokens > 0) {
          tooltipLines.push(`**Cache write** ${formatTokens(s.totalCacheWriteTokens)} tokens`);
        }
        if (s.costAuditFlags && s.costAuditFlags.length > 0) {
          tooltipLines.push(`**Audit flags** ${s.costAuditFlags.slice(0, 5).join(', ')}`);
        }
        item.tooltip = new vscode.MarkdownString(tooltipLines.join('\n\n'));
        item.iconPath = s.totalTokens > 0
          ? new vscode.ThemeIcon('comment-discussion')
          : new vscode.ThemeIcon('circle-outline');
        // Store session id for commands
        item.id = s.id;
        return item;
      }

      case 'stat': {
        const item = new vscode.TreeItem(`${element.label}: ${element.value}`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('graph');
        return item;
      }

      case 'action': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.command = { command: element.command, title: element.label };
        item.iconPath = new vscode.ThemeIcon('link-external');
        return item;
      }
    }
  }

  getChildren(element?: TreeItemData): TreeItemData[] {
    if (!element) {
      return this.getRootChildren();
    }

    if (element.kind === 'group') {
      return element.sessions.map(s => ({ kind: 'session' as const, data: s }));
    }

    if (element.kind === 'session') {
      return this.getSessionChildren(element.data);
    }

    return [];
  }

  private getRootChildren(): TreeItemData[] {
    const sessions = this.db.getSessionsWithStats();

    // Group by date
    const groups = new Map<string, (SessionInfo & SessionStats)[]>();
    for (const s of sessions) {
      const group = getDateGroup(s.startTime);
      if (!groups.has(group)) { groups.set(group, []); }
      groups.get(group)!.push(s);
    }

    const items: TreeItemData[] = [];
    for (const [label, groupSessions] of groups) {
      items.push({ kind: 'group', label, sessions: groupSessions });
    }

    if (items.length === 0) {
      items.push({ kind: 'stat', label: 'No sessions found', value: 'Click refresh to scan logs' });
    }

    return items;
  }

  private getSessionChildren(s: SessionInfo & SessionStats): TreeItemData[] {
    const config = getConfig();
    // Current plan: each user message counts as 1 premium request x model multiplier.
    const multiplier = getMultiplier(s.dominantModel, config.plan);
    const currentReqs = Math.round(s.userMessageCount * multiplier * 10) / 10;

    // New plan: USD computed from per-token rates (incl. cached, when available).
    const costUSD = s.costUSD ?? 0;
    const credits = Math.round(costUSD * 100 * 10) / 10; // 1 credit = $0.01

    const items: TreeItemData[] = [
        { kind: 'stat', label: 'Premium reqs (current)', value: `${currentReqs} x${multiplier}` },
        { kind: 'stat', label: 'Cost (Jun 2026)', value: `$${costUSD.toFixed(3)} (${credits} cr)` },
      { kind: 'stat', label: 'Audit state', value: s.costAuditState || 'unknown' },
      { kind: 'stat', label: 'Tokens', value: `${formatTokens(s.totalInputTokens)} in / ${formatTokens(s.totalOutputTokens)} out` },
      { kind: 'stat', label: 'Requests', value: String(s.llmRequestCount) },
      { kind: 'stat', label: 'Messages', value: String(s.userMessageCount) },
      { kind: 'stat', label: 'Tool calls', value: String(s.toolCallCount) },
      { kind: 'stat', label: 'Turns', value: String(s.turnCount) },
      { kind: 'stat', label: 'Duration', value: formatDuration(s.durationMs) },
    ];
    if (s.totalReasoningTokens && s.totalReasoningTokens > 0) {
      items.push({ kind: 'stat', label: 'Reasoning', value: `${formatTokens(s.totalReasoningTokens)} tokens` });
    }
    if (s.totalCachedTokens && s.totalCachedTokens > 0) {
      const hitRate = s.totalInputTokens > 0 ? Math.round((s.totalCachedTokens / s.totalInputTokens) * 100) : 0;
      items.push({ kind: 'stat', label: 'Cached', value: `${formatTokens(s.totalCachedTokens)} (${hitRate}% hit)` });
    }
    if (s.totalCacheWriteTokens && s.totalCacheWriteTokens > 0) {
      items.push({ kind: 'stat', label: 'Cache write', value: `${formatTokens(s.totalCacheWriteTokens)} tokens` });
    }
    if (s.errorCount > 0) {
      items.push({ kind: 'stat', label: 'Errors', value: String(s.errorCount) });
    }
    return items;
  }
}

export class QuickStatsTreeProvider implements vscode.TreeDataProvider<TreeItemData> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItemData | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private db: TrackerDatabase) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItemData): vscode.TreeItem {
    if (element.kind === 'stat') {
      const text = element.value ? `${element.label}: ${element.value}` : element.label;
      const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = element.label.startsWith('--') ? undefined : new vscode.ThemeIcon('pulse');
      return item;
    }
    if (element.kind === 'action') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.command = { command: element.command, title: element.label };
      item.iconPath = new vscode.ThemeIcon('dashboard');
      return item;
    }
    return new vscode.TreeItem('');
  }

  getChildren(): TreeItemData[] {
    const config = getConfig();
    const billing = computeBillingStatus(this.db, config.plan);
    const agg = this.db.getAggregateStats();
    const wf = this.db.getWorkflowSummary();

    const items: TreeItemData[] = [];

    // Billing header
    items.push({ kind: 'stat', label: `-- ${config.plan.toUpperCase()} (${billing.daysRemaining}d left) --`, value: '' });

    // Current plan - one line
    const curBar = bar(billing.current.percentUsed);
    items.push({ kind: 'stat', label: 'Premium reqs (current)', value: `${billing.current.premiumRequestsUsed} / ${billing.current.premiumRequestsQuota} ${curBar}` });

    // New plan - one line
    const quotaStr = billing.new.aiCreditsQuota === null ? 'n/a' : String(billing.new.aiCreditsQuota);
    const promo = billing.new.quotaIsPromotional ? ' (promo)' : '';
    const newBar = billing.new.percentUsed === null ? '' : bar(billing.new.percentUsed);
    items.push({ kind: 'stat', label: 'Credits (Jun 2026)', value: `${billing.new.aiCreditsUsed.toFixed(1)} / ${quotaStr}${promo} ${newBar}` });
    items.push({ kind: 'stat', label: '  Est. cost', value: `$${billing.new.estimatedCostUSD.toFixed(2)}` });

    // Comparison removed: % of credit-quota and % of request-quota are not
    // mathematically comparable (different units, different scales).

    // Workflow - compact
    if (wf.totalTurns > 0) {
      items.push({ kind: 'stat', label: '-- Workflow --', value: '' });
      items.push({ kind: 'stat', label: 'Turns/msg', value: `${wf.avgTurnsPerMessage} | Tools/turn: ${wf.avgToolsPerTurn}` });
      items.push({ kind: 'stat', label: 'Calls', value: `${wf.totalToolCalls} tools, ${wf.totalSubagents} subagents` });
      if (wf.totalErrors > 0) {
        items.push({ kind: 'stat', label: 'Errors', value: `${wf.totalErrors} (${Math.round((wf.totalErrors / wf.totalToolCalls) * 100)}% rate)` });
      }
    }

    // Tips - max 2, only if actionable
    const tips: string[] = [];
    if (billing.new.percentUsed !== null && billing.new.percentUsed > billing.current.percentUsed * 1.5) {
      tips.push('Tool/subagent calls are FREE now but cost in June');
    }
    if (wf.avgTurnsPerMessage > 8) {
      tips.push('High turns/msg - be more specific to save tokens');
    }
    if (agg.totalCostUSD > 0 && agg.totalTokens > 0 && (agg.totalCostUSD * 1_000_000 / agg.totalTokens) > 5) {
      tips.push('Heavy premium model use - try Sonnet for simple tasks');
    }
    if (tips.length > 0) {
      items.push({ kind: 'stat', label: '-- Tips --', value: '' });
      for (const tip of tips.slice(0, 2)) {
        items.push({ kind: 'stat', label: `[!] ${tip}`, value: '' });
      }
    }

    items.push({ kind: 'action', label: 'Open Dashboard', command: 'copilotUsageTracker.openDashboard' });
    return items;
  }
}

function bar(pct: number): string {
  const filled = Math.min(Math.round(pct / 10), 10);
  return '[' + '#'.repeat(filled) + '-'.repeat(10 - filled) + '] ' + pct + '%';
}

function shortModelName(model: string): string {
  if (model.startsWith('claude-')) {
    const parts = model.replace('claude-', '').split('-');
    return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }
  return model;
}
