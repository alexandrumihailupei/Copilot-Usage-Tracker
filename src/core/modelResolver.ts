import * as fs from 'fs';
import {
  ModelInfo,
} from './types';

/**
 * Parse models.json to extract billing multipliers and model metadata.
 */
export function parseModelsJson(filePath: string): Map<string, ModelInfo> {
  const models = new Map<string, ModelInfo>();

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const raw: unknown[] = JSON.parse(content);

    for (const entry of raw) {
      const m = entry as Record<string, unknown>;
      const id = m.id as string;
      if (!id) { continue; }

      const billing = m.billing as Record<string, unknown> | undefined;
      const capabilities = m.capabilities as Record<string, unknown> | undefined;
      const limits = capabilities?.limits as Record<string, unknown> | undefined;

      models.set(id, {
        id,
        name: (m.name as string) || id,
        vendor: (m.vendor as string) || 'unknown',
        billingMultiplier: (billing?.multiplier as number) ?? 1,
        isPremium: (billing?.is_premium as boolean) ?? false,
        maxContextTokens: (limits?.max_context_window_tokens as number) ?? 0,
        maxOutputTokens: (limits?.max_output_tokens as number) ?? 0,
      });
    }
  } catch {
    // Return empty map if models.json is missing or malformed
  }

  return models;
}

/**
 * Look up the billing multiplier for a model. Falls back to 1.0 for unknown models.
 */
export function getBillingMultiplier(models: Map<string, ModelInfo>, modelId: string): number {
  return models.get(modelId)?.billingMultiplier ?? 1;
}
