import * as vscode from 'vscode';
import { TrackerDatabase } from './database';
import { discoverSessions } from '../core/logDiscovery';
import { buildSession } from '../core/sessionBuilder';
import { computeSessionStats } from '../stats/tokenStats';
import { getConfig } from '../config';
import { exportAndParsePromptLogs, buildMatchIndex } from '../core/promptExportReader';
import { exportAndReadOtelDB, mapOtelToParsedSession } from '../core/otelReader';

export interface SyncResult {
  totalDiscovered: number;
  newOrUpdated: number;
  skipped: number;
  errors: number;
  emptyCount: number;
  cachedTokensEnriched: number;
  // Hybrid source tracking
  otelSessions: number;
  jsonlSessions: number;
  otelAvailable: boolean;
}

let activeSync: Promise<SyncResult> | undefined;

/**
 * Three-tier hybrid sync:
 *   Tier 1: OTel Agent Traces DB (primary — richest data)
 *   Tier 2: JSONL logs (fallback — historical / when OTel unavailable)
 *   Tier 3: Prompt Export (supplemental — only for JSONL sessions missing cached tokens)
 */
export async function syncAll(
  db: TrackerDatabase,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  wasmPath?: string
): Promise<SyncResult> {
  if (activeSync) { return activeSync; }
  activeSync = syncAllInternal(db, progress, wasmPath).finally(() => {
    activeSync = undefined;
  });
  return activeSync;
}

async function syncAllInternal(
  db: TrackerDatabase,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  wasmPath?: string
): Promise<SyncResult> {
  const config = getConfig();

  const result: SyncResult = {
    totalDiscovered: 0,
    newOrUpdated: 0,
    skipped: 0,
    errors: 0,
    emptyCount: 0,
    cachedTokensEnriched: 0,
    otelSessions: 0,
    jsonlSessions: 0,
    otelAvailable: false,
  };

  // Track which session IDs were already ingested from OTel
  const otelSessionIds = new Set<string>();

  // ---- Tier 1: OTel Agent Traces DB ---------------------------------------
  if (wasmPath) {
    try {
      progress?.report({ message: 'Exporting OTel traces...' });
      const otelData = await exportAndReadOtelDB(wasmPath);
      result.otelAvailable = otelData.length > 0;

      if (otelData.length > 0) {
        progress?.report({ message: `Processing ${otelData.length} OTel sessions...` });
        for (const data of otelData) {
          try {
            const parsed = mapOtelToParsedSession(data);
            if (!parsed || parsed.llmRequests.length === 0) {
              result.emptyCount++;
              continue;
            }

            // Check if we already have this session with the same data source
            const existingSource = db.getSessionDataSource(parsed.session.id);
            if (existingSource === 'otel') {
              // Already ingested from OTel — skip unless data changed.
              // OTel DB is always re-exported fresh, so we re-ingest to get latest spans.
              db.deleteSessionData(parsed.session.id);
            }

            db.upsertSession(parsed.session, Date.now());
            db.insertLLMRequests(parsed.llmRequests);
            db.insertUserMessages(parsed.userMessages);
            db.insertToolCalls(parsed.toolCalls);

            for (const [, model] of parsed.models) {
              db.upsertModelBilling(
                model.id, model.name, model.vendor,
                model.billingMultiplier, model.isPremium,
                model.maxContextTokens, model.maxOutputTokens
              );
            }

            const stats = computeSessionStats(parsed);
            db.upsertSessionStats(stats);

            otelSessionIds.add(parsed.session.id);
            result.otelSessions++;
            result.newOrUpdated++;
          } catch (err) {
            result.errors++;
            console.error(`Error processing OTel session ${data.session.id}:`, err);
          }
        }
      }
    } catch (err) {
      // Non-fatal — fall through to JSONL
      console.warn('[CopilotTracker] OTel tier failed, falling back to JSONL:', err);
    }
  }

  // ---- Tier 2: JSONL logs (skip sessions already covered by OTel) ----------
  const discovered = discoverSessions(
    config.logDirectories,
    config.autoScanWorkspaceStorage
  );
  result.totalDiscovered = discovered.length + result.otelSessions;

  const incrementPer = discovered.length > 0 ? 80 / discovered.length : 80;

  for (const disc of discovered) {
    // Skip if already ingested from OTel (richer data wins)
    if (otelSessionIds.has(disc.sessionId)) {
      result.skipped++;
      continue;
    }

    progress?.report({ message: `Parsing ${disc.sessionId.substring(0, 8)}...`, increment: incrementPer });

    const existingMtime = db.getSessionMtime(disc.sessionId);
    if (existingMtime !== undefined && existingMtime >= disc.mtimeMs) {
      result.skipped++;
      continue;
    }

    try {
      const parsed = await buildSession(disc, config.parseSubagentLogs);
      if (!parsed || parsed.llmRequests.length === 0) {
        if (parsed?.session) {
          db.upsertSession(parsed.session, disc.mtimeMs);
        }
        result.emptyCount++;
        continue;
      }

      if (existingMtime !== undefined) {
        db.deleteSessionData(disc.sessionId);
      }

      db.upsertSession(parsed.session, disc.mtimeMs);
      db.insertLLMRequests(parsed.llmRequests);
      db.insertUserMessages(parsed.userMessages);
      db.insertToolCalls(parsed.toolCalls);

      for (const [, model] of parsed.models) {
        db.upsertModelBilling(
          model.id, model.name, model.vendor,
          model.billingMultiplier, model.isPremium,
          model.maxContextTokens, model.maxOutputTokens
        );
      }

      const stats = computeSessionStats(parsed);
      db.upsertSessionStats(stats);

      result.jsonlSessions++;
      result.newOrUpdated++;
    } catch (err) {
      result.errors++;
      console.error(`Error parsing session ${disc.sessionId}:`, err);
    }
  }

  // ---- Tier 3: Prompt Export enrichment (only for JSONL sessions) ----------
  // OTel sessions already have real cached_tokens — no enrichment needed.
  // Only enrich JSONL-sourced sessions that lack cached token data.
  try {
    progress?.report({ message: 'Enriching cached token data...' });

    // Step 1: Export fresh data from the current VS Code session.
    const freshEntries = await exportAndParsePromptLogs();
    if (freshEntries.length > 0) {
      // Step 2: Persist to DB so it survives restarts.
      db.storePromptExportEntries(freshEntries);
    }

    // Step 3: Build index from ALL stored entries (fresh + previously stored).
    const allStored = db.getStoredPromptExportEntries();
    if (allStored.length > 0) {
      const matchIndex = buildMatchIndex(allStored);
      const enrichedSessionIds = new Set<string>();

      // Step 4: Match against JSONL-sourced records that lack cached token data.
      const candidates = db.getRequestsWithoutCachedTokens(0, Date.now());

      for (const req of candidates) {
        const match = matchIndex.findMatch(
          req.model, req.inputTokens, req.outputTokens, req.timestamp
        );
        if (match) {
          db.updateCachedTokens(req.sessionId, req.spanId, match.cachedPromptTokens, {
            source: 'prompt_export',
            promptExportKey: match.entry.key,
            confidence: match.confidence,
            reasoningTokens: match.reasoningTokens,
            cacheWriteTokens: match.cacheWriteTokens > 0 ? match.cacheWriteTokens : undefined,
            auditFlags: match.auditFlags,
          });
          enrichedSessionIds.add(req.sessionId);
          result.cachedTokensEnriched++;
        }
      }

      for (const sessionId of enrichedSessionIds) {
        recomputeStoredSessionStats(db, sessionId);
      }
    }

    // Prune entries older than 30 days to keep the table bounded.
    db.prunePromptExportCache(30);
  } catch (err) {
    // Non-fatal — we still have estimated values as fallback.
    console.warn('[CopilotTracker] Cached token enrichment failed:', err);
  }

  db.flush();
  return result;
}

function recomputeStoredSessionStats(db: TrackerDatabase, sessionId: string): void {
  const detail = db.getSessionDetail(sessionId);
  if (!detail) { return; }
  const toolCalls = db.getSessionToolCalls(sessionId);
  const subagentNames = [...new Set(
    detail.requests
      .filter(r => r.isSubagent && r.subagentName)
      .map(r => r.subagentName!)
  )];
  const stats = computeSessionStats({
    session: detail.session,
    llmRequests: detail.requests,
    userMessages: detail.messages,
    toolCalls,
    turnCount: detail.stats.turnCount,
    subagentNames,
    childSessionFiles: [],
    models: new Map(),
  });
  db.upsertSessionStats(stats);
}
