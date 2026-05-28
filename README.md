# Copilot Usage Tracker

A VS Code extension that analyzes GitHub Copilot Chat token usage, session statistics, and cost insights from local debug logs. Track how many tokens you consume, estimate costs against your plan quota, and identify usage patterns — all without sending data anywhere.

## Features

- **Token Usage Dashboard** — View input, output, cached, and reasoning tokens per session, model, or time period
- **Cost & Credit Estimation** — Calculates AI premium credits consumed based on your Copilot plan (Free, Pro, Pro+, Business, Enterprise)
- **Session Explorer** — Browse all Copilot Chat conversations in a sidebar tree view, grouped by date, workspace, or model
- **Multi-Source Data** — Combines OTel agent traces (high-fidelity cached/reasoning tokens), JSONL debug logs, and prompt export data for maximum accuracy
- **Subagent Tracking** — Rolls in token usage from spawned subagents (e.g., Explore) for true total cost per conversation
- **Offline & Private** — All data stays local. Reads existing VS Code log files; never intercepts traffic or phones home

## Prerequisites

### Required VS Code Settings

You **must** enable these two settings in your VS Code `settings.json` for the extension to access Copilot Chat debug data:

```jsonc
{
  "github.copilot.chat.agent.tracing": true,
  "chat.agent.enabled": true
}
```

| Setting | Purpose |
|---------|---------|
| `github.copilot.chat.agent.tracing` | Enables the OpenTelemetry agent traces database — the primary data source providing cached tokens, reasoning tokens, and full trace hierarchy |
| `chat.agent.enabled` | Enables agent mode in Copilot Chat, which generates the rich JSONL debug logs and agent traces this extension reads |

After enabling these settings, restart VS Code for them to take effect.

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
4. Press `F5` in VS Code to launch the Extension Development Host, or package it:
   ```bash
   npm run package
   ```

## Usage

1. Open the **Copilot Usage** view in the Activity Bar (left sidebar)
2. The extension automatically discovers debug logs from all your VS Code workspaces
3. Click **Refresh** to scan for new sessions
4. Open the **Dashboard** (command: `Copilot Usage: Open Copilot Usage Dashboard`) for detailed charts and breakdowns

### Commands

| Command | Description |
|---------|-------------|
| `Copilot Usage: Open Copilot Usage Dashboard` | Opens the webview dashboard with full statistics |
| `Copilot Usage: Refresh Copilot Usage Data` | Re-scans log directories for new sessions |
| `Copilot Usage: Add Log Directory` | Manually add a directory to scan for debug logs |
| `Copilot Usage: Clear Cache` | Clears the local SQLite cache |
| `Copilot Usage: Open Raw Log` | Opens the raw JSONL file for a selected session |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotUsageTracker.logDirectories` | `[]` | Additional directories to scan for Copilot Chat debug logs |
| `copilotUsageTracker.autoScanWorkspaceStorage` | `true` | Automatically discover logs in VS Code workspaceStorage folders |
| `copilotUsageTracker.parseSubagentLogs` | `true` | Recursively parse subagent JSONL files for full token accounting |
| `copilotUsageTracker.defaultGroupBy` | `"date"` | Default session grouping in the sidebar (`date`, `workspace`, or `model`) |
| `copilotUsageTracker.plan` | `"business"` | Your GitHub Copilot plan — determines monthly quota for billing display |

## How It Works

The extension reads **existing local files** that VS Code writes during Copilot Chat sessions:

1. **OTel Agent Traces DB** (Tier 1) — SQLite database with OpenTelemetry spans, providing cached tokens, reasoning tokens, and trace hierarchy
2. **JSONL Debug Logs** (Tier 2) — Line-delimited JSON event logs in `workspaceStorage/*/GitHub.copilot-chat/debug-logs/`
3. **Prompt Export** (Tier 3) — Cached token enrichment via Copilot's internal export command

See [DATA-COLLECTION.md](DATA-COLLECTION.md) for full details on what is read and how.  
See [COST-CALCULATION.md](COST-CALCULATION.md) for the billing/credit calculation methodology.

## Data Privacy

- **No network calls** — The extension never sends data to any server
- **Read-only** — It only reads existing log files; never modifies them
- **Local storage** — Session statistics are cached in a local SQLite database (`.db` file in extension storage)
- **Message previews** — Only the first 200 characters of your messages are stored for context; full content is never persisted

## Development

```bash
npm run watch    # Compile in watch mode (dev)
npm run compile  # Production build
npm run test     # Run unit tests
npm run lint     # Lint source files
```

## License

MIT
