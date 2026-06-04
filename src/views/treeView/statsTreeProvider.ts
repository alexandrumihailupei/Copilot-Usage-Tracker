import * as vscode from 'vscode';
import { TrackerDatabase } from '../../db/database';
import { SessionInfo, SessionStats } from '../../core/types';
import { formatTokens, formatDateTime, getDateGroup, formatDuration } from '../../util/dateUtils';
import { computeBillingStatus, getMultiplier, computeCostUSD, getBillingPeriodBounds } from '../../stats/billingCalculator';
import { getConfig } from '../../config';

type TreeItemData =
  | { kind: 'group'; label: string; sessions: (SessionInfo & SessionStats)[] }
  | { kind: 'session'; data: SessionInfo & SessionStats }
  | { kind: 'stat'; label: string; value: string }                              // kept for SessionTreeProvider
  | { kind: 'section'; label: string }                                          // non-interactive section divider
  | { kind: 'metric'; label: string; value: string; icon: string; tooltip?: string } // icon + label + grey description
  | { kind: 'picker'; label: string; description: string; tooltip: string }    // month QuickPick trigger
  | { kind: 'tip'; label: string }                                              // lightbulb tip row
  | { kind: 'action'; label: string; command: string; icon?: string };         // primary action row

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
      default:
        return new vscode.TreeItem('');
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

  /** -1 = All Time; 0..N = index into availableMonths (0 = most recent). */
  private selectedMonthIdx = 0;
  private availableMonths: { year: number; month: number; label: string; start: number; end: number }[] = [];

  constructor(private db: TrackerDatabase) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  navOlder(): void {
    if (this.selectedMonthIdx === -1) { return; }
    this.selectedMonthIdx = Math.min(this.selectedMonthIdx + 1, Math.max(0, this.availableMonths.length - 1));
    this.refresh();
  }

  navNewer(): void {
    if (this.selectedMonthIdx > 0) { this.selectedMonthIdx--; }
    else if (this.selectedMonthIdx === -1) { this.selectedMonthIdx = 0; }
    this.refresh();
  }

  navAllTime(): void {
    this.selectedMonthIdx = -1;
    this.refresh();
  }

  navCurrentMonth(): void {
    this.selectedMonthIdx = 0;
    this.refresh();
  }

  async showMonthPicker(): Promise<void> {
    const months = this.db.getAvailableMonths();
    type QPI = vscode.QuickPickItem & { idx: number };
    const qpItems: QPI[] = [
      ...months.map((m, i): QPI => ({
        label: m.label,
        description: i === 0 ? 'current billing period' : 'historical',
        iconPath: new vscode.ThemeIcon(i === 0 ? 'calendar' : 'history'),
        picked: this.selectedMonthIdx === i,
        idx: i,
      })),
      {
        label: 'All Time',
        description: 'cumulative totals across all months',
        iconPath: new vscode.ThemeIcon('list-flat'),
        picked: this.selectedMonthIdx === -1,
        idx: -1,
      },
    ];
    const picked = await vscode.window.showQuickPick(qpItems, {
      title: 'Select Billing Period',
      placeHolder: 'Choose a month to view stats for\u2026',
      matchOnDescription: true,
    }) as QPI | undefined;
    if (!picked) { return; }
    this.selectedMonthIdx = picked.idx;
    this.refresh();
  }

  getTreeItem(element: TreeItemData): vscode.TreeItem {
    switch (element.kind) {
      case 'section': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('dash');
        item.contextValue = 'quickStatsSection';
        return item;
      }
      case 'metric': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.value;
        item.iconPath = new vscode.ThemeIcon(element.icon);
        if (element.tooltip) { item.tooltip = element.tooltip; }
        return item;
      }
      case 'picker': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.description;
        item.iconPath = new vscode.ThemeIcon('calendar');
        item.tooltip = new vscode.MarkdownString(element.tooltip);
        item.command = { command: 'copilotUsageTracker.stats.selectMonth', title: 'Select Period' };
        item.contextValue = 'quickStatsPicker';
        return item;
      }
      case 'tip': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('lightbulb');
        return item;
      }
      case 'action': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.command  = { command: element.command, title: element.label };
        item.iconPath = new vscode.ThemeIcon(element.icon ?? 'dashboard');
        return item;
      }
      default: {
        // 'stat' — kept for SessionTreeProvider children.
        const e = element as { label: string; value: string };
        const text = e.value ? `${e.label}: ${e.value}` : e.label;
        const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('pulse');
        return item;
      }
    }
  }

  getChildren(): TreeItemData[] {
    const config = getConfig();
    this.availableMonths = this.db.getAvailableMonths();

    // Clamp index to valid range after a refresh.
    if (this.selectedMonthIdx >= 0 && this.availableMonths.length > 0) {
      this.selectedMonthIdx = Math.min(this.selectedMonthIdx, this.availableMonths.length - 1);
    }

    const isAllTime     = this.selectedMonthIdx === -1;
    // Current month = index 0.  Do NOT pass periodOverride for index 0 so that
    // computeBillingStatus uses getBillingPeriodBounds() internally and returns
    // the correct daysRemaining and aiCreditsQuota for the live billing period.
    const isCurrentMonth = !isAllTime && this.selectedMonthIdx === 0;

    let periodOverride: { start: number; end: number } | undefined;
    if (isAllTime) {
      periodOverride = { start: 0, end: 253402300800000 };       // epoch 0 ? year 9999
    } else if (!isCurrentMonth && this.availableMonths.length > 0) {
      const m = this.availableMonths[this.selectedMonthIdx];
      periodOverride = { start: m.start, end: m.end };
    }
    // isCurrentMonth: no override ? billing uses current UTC month automatically

    const billing = computeBillingStatus(this.db, config.plan, Date.now(), periodOverride);

    // Resolve concrete period bounds for workflow stats (always a real range, never unbounded).
    const wfBounds = isAllTime
      ? { start: 0, end: 253402300800000 }
      : isCurrentMonth
        ? getBillingPeriodBounds()
        : this.availableMonths[this.selectedMonthIdx];
    const wf = this.db.getWorkflowSummary(wfBounds.start, wfBounds.end);

    const periodLabel = isAllTime
      ? 'All Time'
      : this.availableMonths.length > 0
        ? this.availableMonths[this.selectedMonthIdx].label
        : new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    const items: TreeItemData[] = [];

    // ?? Period picker (single row at top — click opens QuickPick) ?????????????
    const monthListMd = this.availableMonths.length === 0
      ? '_No data yet_'
      : this.availableMonths
          .map((m, i) => `- ${m.label}${i === 0 ? '  _(current)_' : ''}`)
          .join('\n') + '\n- All Time';
    const pickerDesc = isAllTime
      ? `${config.plan.toUpperCase()}  \u00b7  all months combined`
      : isCurrentMonth
        ? `${config.plan.toUpperCase()}  \u00b7  ${billing.daysRemaining}d remaining`
        : `${config.plan.toUpperCase()}  \u00b7  historical`;
    const pickerTooltip = `**Billing Period** \u2014 click to change\n\n${monthListMd}`;
    items.push({ kind: 'picker', label: periodLabel, description: pickerDesc, tooltip: pickerTooltip });

    // ?? BILLING section ???????????????????????????????????????????????????????

    const premUsed  = billing.current.premiumRequestsUsed;
    const premQuota = billing.current.premiumRequestsQuota;
    if (isCurrentMonth) {
      const pct = billing.current.percentUsed;
      items.push({ kind: 'metric', label: 'Premium Requests', value: `${qFmt(premUsed)} / ${qFmt(premQuota)}  ${uBar(pct)} ${pct.toFixed(1)}%`, icon: 'graph-line' });
    } else {
      items.push({ kind: 'metric', label: 'Premium Requests', value: `${qFmt(premUsed)} total`, icon: 'graph-line' });
    }

    const credUsed  = billing.new.aiCreditsUsed;
    const credQuota = billing.new.aiCreditsQuota;
    const promo = billing.new.quotaIsPromotional ? ' (promo)' : '';
    if (isCurrentMonth && credQuota !== null) {
      const pct = billing.new.percentUsed ?? 0;
      items.push({ kind: 'metric', label: 'AI Credits (Jun plan)', value: `${dFmt(credUsed)} / ${qFmt(credQuota)}${promo}  ${uBar(pct)} ${pct.toFixed(1)}%`, icon: 'credit-card' });
    } else if (isCurrentMonth) {
      items.push({ kind: 'metric', label: 'AI Credits (Jun plan)', value: `${dFmt(credUsed)} (no quota published)`, icon: 'credit-card' });
    } else {
      items.push({ kind: 'metric', label: 'AI Credits (Jun plan)', value: `${dFmt(credUsed)} total`, icon: 'credit-card' });
    }

    items.push({ kind: 'metric', label: 'Est. Cost', value: `$${billing.new.estimatedCostUSD.toFixed(2)} USD`, icon: 'symbol-numeric' });

    // ?? WORKFLOW section ??????????????????????????????????????????????????????
    if (wf.totalTurns > 0) {
      items.push({ kind: 'section', label: 'WORKFLOW' });
      items.push({ kind: 'metric', label: 'Efficiency', value: `${wf.avgTurnsPerMessage} turns/msg  \u00b7  ${wf.avgToolsPerTurn} tools/turn`, icon: 'pulse' });
      items.push({ kind: 'metric', label: 'Tool Calls', value: `${qFmt(wf.totalToolCalls)}  \u00b7  ${qFmt(wf.totalSubagents)} subagents`, icon: 'tools' });
      if (wf.totalErrors > 0) {
        const errPct = wf.totalToolCalls > 0 ? Math.round((wf.totalErrors / wf.totalToolCalls) * 100) : 0;
        items.push({ kind: 'metric', label: 'Errors', value: `${qFmt(wf.totalErrors)} (${errPct}% rate)`, icon: 'warning' });
      }
    }

    // ?? TIPS section ?????????????????????????????????????????????????????????
    if (isCurrentMonth) {
      const tips: string[] = [];
      if (billing.new.percentUsed !== null && billing.new.percentUsed > billing.current.percentUsed * 1.5) {
        tips.push('Tool/subagent calls are FREE now but cost from June 1');
      }
      if (wf.avgTurnsPerMessage > 8) {
        tips.push('High turns/msg \u2014 be more specific to save tokens');
      }
      if (tips.length > 0) {
        items.push({ kind: 'section', label: 'TIPS' });
        for (const tip of tips.slice(0, 2)) {
          items.push({ kind: 'tip', label: tip });
        }
      }
    }

    // ?? Dashboard action ??????????????????????????????????????????????????????
    items.push({ kind: 'action', label: 'Open Dashboard', command: 'copilotUsageTracker.openDashboard', icon: 'dashboard' });
    return items;
  }
}

/** Unicode block progress bar, 10 chars wide. */
function uBar(pct: number): string {
  const filled = Math.min(Math.round(pct / 10), 10);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
}

/** Format integer with thousands separators. */
function qFmt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Format decimal (1 dp) with thousands separators. */
function dFmt(n: number): string {
  return n.toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function shortModelName(model: string): string {
  if (model.startsWith('claude-')) {
    const parts = model.replace('claude-', '').split('-');
    return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }
  return model;
}
