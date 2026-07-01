# AI Usage Tracker

A VS Code extension that analyzes **GitHub Copilot** and **Claude Code** token usage, session statistics, and cost insights from local logs. Track how many tokens you consume, estimate costs against your plan quota, and drill into individual requests — all without sending data anywhere. Switch between providers with a single click.

## Features

- **Two providers, one view** — Track GitHub Copilot Chat and Claude Code side by side; toggle the active provider with the **Switch Provider** button (orange accent for Claude, blue for Copilot).
- **Token Usage Dashboard** — Input, output, cached (read), and cache-write tokens per session, model, or billing period, plus a "fresh in" figure that excludes the re-read cached prefix so it reads comparably to each tool's own usage panel.
- **Cost estimation** —
  - *Copilot:* AI premium credits / USD against your plan quota (Free, Pro, Pro+, Business, Enterprise), using API-reported credits when available and a per-token model otherwise.
  - *Claude:* USD at Anthropic list prices, with correct cache-read (0.1×) and cache-write pricing including the **1-hour vs 5-minute TTL** distinction.
- **Session Explorer** — Browse every conversation in a sidebar tree, grouped by date, workspace, or model, with an expandable per-request timeline (prompt, output, tool inputs/results).
- **Accurate request accounting** — For Claude, one API response is de-duplicated to a single request by `requestId`, and deeply-nested subagent/workflow transcripts are fully rolled into the parent session.
- **Billing-period navigation** — Step through months or view all-time totals; the current billing period is always selectable.
- **Offline & private** — All processing is local. The extension only reads existing log files; it never intercepts traffic or phones home.

## Supported providers

| Provider | Source it reads | Setup required |
|----------|-----------------|----------------|
| **GitHub Copilot** | OTel agent-traces DB + JSONL debug logs in VS Code `workspaceStorage`, plus prompt-export enrichment | Enable the two debug-log settings below |
| **Claude Code** | Session transcripts under `~/.claude/projects/<project>/<sessionId>.jsonl` (and nested subagent/workflow transcripts) | None — discovered automatically |

## Prerequisites (GitHub Copilot only)

To let the extension read Copilot Chat debug logs, enable these in your VS Code `settings.json`:

```jsonc
{
  "github.copilot.chat.agentDebugLog.enabled": true,
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
}
```

| Setting | Purpose |
|---------|---------|
| `github.copilot.chat.agentDebugLog.enabled` | Enables agent debug logs and the `/troubleshoot` command |
| `github.copilot.chat.agentDebugLog.fileLogging.enabled` | Writes debug events to JSONL files on disk — the files this extension reads |

Restart VS Code after enabling them. **Claude Code requires no setup** — it writes transcripts to `~/.claude/projects` automatically.

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the extension:
   ```bash
   npm run compile
   ```
4. Press `F5` in VS Code to launch the Extension Development Host, or package a `.vsix`:
   ```bash
   npm run package
   ```
   > `vsce package` requires the `repository` field in `package.json`.
5. Install the generated `.vsix`:
   - Open the **Extensions** tab (`Ctrl+Shift+X`)
   - Click the `...` menu → **Install from VSIX...** → choose the file

## Usage

1. Open the **AI Usage** view in the Activity Bar (left sidebar).
2. The extension automatically discovers Copilot logs (all workspaces) and Claude Code transcripts.
3. Use the **Switch Provider** button (view title bar) to toggle between Copilot and Claude.
4. Click **Refresh** to scan for new sessions.
5. Open the **Dashboard** (`AI Usage: Open AI Usage Dashboard`) for charts, per-model breakdowns, and the expandable request timeline.
6. Use the billing-period picker to view a specific month or all-time totals.

### Commands

| Command | Description |
|---------|-------------|
| `AI Usage: Open AI Usage Dashboard` | Opens the webview dashboard with full statistics |
| `AI Usage: Switch Provider (Copilot / Claude)` | Toggles the active provider |
| `AI Usage: Refresh Usage Data` | Re-scans logs/transcripts for new sessions |
| `AI Usage: Add Log Directory` | Manually add a directory to scan for Copilot debug logs |
| `AI Usage: Select Billing Period` | Pick a month or all-time |
| `AI Usage: Clear Cache` | Clears cached data for the active provider |
| `AI Usage: Open Raw Log` | Opens the raw JSONL file for a selected session |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotUsageTracker.logDirectories` | `[]` | Additional directories to scan for Copilot Chat debug logs |
| `copilotUsageTracker.autoScanWorkspaceStorage` | `true` | Automatically discover logs in VS Code workspaceStorage folders |
| `copilotUsageTracker.parseSubagentLogs` | `true` | Recursively parse subagent transcripts for full token accounting |
| `copilotUsageTracker.defaultGroupBy` | `"date"` | Default session grouping (`date`, `workspace`, or `model`) |
| `copilotUsageTracker.plan` | `"business"` | Your GitHub Copilot plan — determines monthly quota for billing display |
| `copilotUsageTracker.claudeProjectsDirectory` | `"~/.claude/projects"` | Root directory containing Claude Code transcripts |
| `copilotUsageTracker.claudeCostBasis` | `"api"` | How to present Claude cost: `api` = USD at Anthropic list prices; `subscription` = API-equivalent (included in your Claude plan) |

## How it works

The extension reads **existing local files** written by each tool:

**GitHub Copilot**
1. **OTel Agent Traces DB** (Tier 1) — SQLite spans with cached/reasoning tokens and trace hierarchy
2. **JSONL Debug Logs** (Tier 2) — event logs in `workspaceStorage/*/GitHub.copilot-chat/debug-logs/`
3. **Prompt Export** (Tier 3) — cached-token enrichment via Copilot's internal export

**Claude Code**
- Reads `~/.claude/projects/<project>/<sessionId>.jsonl` and its nested subagent/workflow transcripts. One API response spans several transcript lines sharing a `requestId`; these are de-duplicated to a single request so tokens are counted once. Cache-read, 5-minute cache-write, and 1-hour cache-write tokens are priced separately.

Costs are computed by a shared per-token engine keyed off the **provider** (not the model name), so a Claude model run *through* Copilot is still billed under Copilot's rules.

See [DATA-COLLECTION.md](DATA-COLLECTION.md) and [COST-CALCULATION.md](COST-CALCULATION.md) for the Copilot data-collection and billing methodology.

## Data privacy

- **No network calls** — The extension never sends data to any server.
- **Read-only sources** — It only reads existing log/transcript files; it never modifies them.
- **Local storage only** — All statistics are cached in a local SQLite database in the extension's storage folder.
- **Full content is stored locally** — To power the expandable request timeline, the local database persists full message text, assistant output, and tool inputs/results (capped at 16 KB per field). This data stays on your machine and is removed by **Clear Cache**. If you prefer not to store it, avoid enabling this build on shared machines.

## Development

```bash
npm run watch    # Compile in watch mode (dev)
npm run compile  # Production build
npm run test     # Run unit tests
npm run lint     # Lint source files
```

## License

MIT
