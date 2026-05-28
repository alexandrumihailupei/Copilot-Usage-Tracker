# How Costs Are Calculated

This document explains exactly how the Copilot Usage Tracker computes costs for every LLM request, converts them to AI credits, and aggregates them into billing-period totals.

---

## Table of Contents

- [Overview](#overview)
- [Token Buckets](#token-buckets)
- [The Cost Formula](#the-cost-formula)
- [Per-Model Pricing Table](#per-model-pricing-table)
- [Model Resolution](#model-resolution)
- [Cache Token Sources](#cache-token-sources)
  - [Source A: Estimation (cacheEstimator)](#source-a-estimation-cacheestimator)
  - [Source B: Real Data (promptExportReader)](#source-b-real-data-promptexportreader)
  - [How the Two Sources Merge](#how-the-two-sources-merge)
- [Anthropic Cache-Write Surcharge](#anthropic-cache-write-surcharge)
- [Non-Anthropic Providers](#non-anthropic-providers)
- [AI Credits Conversion](#ai-credits-conversion)
- [Billing Period Aggregation](#billing-period-aggregation)
- [Premium Request Multipliers (Legacy)](#premium-request-multipliers-legacy)
- [Worked Examples](#worked-examples)
- [Edge Cases and Limitations](#edge-cases-and-limitations)

---

## Overview

GitHub Copilot's usage-based billing (effective June 1, 2026) charges per token. Every LLM request has:

- **Input tokens** — what gets sent to the model (conversation history, system prompt, tool results, etc.)
- **Output tokens** — what the model generates back
- **Cached input tokens** — a subset of input tokens that were served from the provider's cache (cheaper)
- **Cache-write tokens** — a subset of input tokens that were written into the cache for the first time (Anthropic charges a surcharge for this)

The extension computes a USD cost for each request, then converts to **AI credits** (1 credit = $0.01 USD).

The implementation now tracks whether each cost is **measured**, **estimated**, **mixed**, or **incomplete**. Measured token buckets come from OTel or prompt-export usage metadata. Heuristic cache values are still useful for projections, but they are flagged and should not be treated as an audit-final bill.

---

## Token Buckets

Every LLM request's input tokens are decomposed into **three mutually exclusive buckets**:

```
inputTokens = uncachedInput + cachedInput + cacheWriteTokens
```

| Bucket | What it means | Rate applied |
|--------|---------------|--------------|
| **Uncached input** | Tokens that were neither cached nor written to cache | Base input rate |
| **Cached input** | Tokens served from a previous cache entry (cache hit) | Discounted cached rate |
| **Cache-write** | Tokens written to cache for the first time | Surcharge rate (Anthropic) or base rate (others) |

The uncached bucket is computed as:

```
uncachedInput = max(0, inputTokens ? cachedInputTokens ? cacheWriteTokens)
```

The `max(0, ...)` clamp prevents negative values if the data is inconsistent.

---

## The Cost Formula

For a single request:

```
costUSD =
    (uncachedInput / 1,000,000) × inputRate
  + (cachedInput   / 1,000,000) × cachedInputRate
  + (cacheWrite    / 1,000,000) × cacheWriteRate
  + (outputTokens  / 1,000,000) × outputRate
```

Where:
- All rates are **per 1 million tokens** and come from the pricing table
- `cacheWriteRate` = the model's `cacheWrite` field if defined (Anthropic), otherwise falls back to the base `inputRate`
- Output tokens are always charged at the output rate regardless of caching

---

## Per-Model Pricing Table

All prices are per 1 million tokens. Source: [GitHub Docs — Models and Pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing).

### Anthropic

Anthropic models have a **cache-write** column. Other providers do not.

| Model | Input | Cached Input | Cache Write | Output |
|-------|------:|-------------:|------------:|-------:|
| Claude Haiku 4.5 | $1.00 | $0.10 | $1.25 | $5.00 |
| Claude Sonnet 4 | $3.00 | $0.30 | $3.75 | $15.00 |
| Claude Sonnet 4.5 | $3.00 | $0.30 | $3.75 | $15.00 |
| Claude Sonnet 4.6 | $3.00 | $0.30 | $3.75 | $15.00 |
| Claude Opus 4.5 | $5.00 | $0.50 | $6.25 | $25.00 |
| Claude Opus 4.6 | $5.00 | $0.50 | $6.25 | $25.00 |
| Claude Opus 4.6 (fast) | $5.00 | $0.50 | $6.25 | $25.00 |
| Claude Opus 4.7 | $5.00 | $0.50 | $6.25 | $25.00 |

Cache-write rate = 1.25× the base input rate for all Anthropic models.

### OpenAI

| Model | Input | Cached Input | Output |
|-------|------:|-------------:|-------:|
| GPT-4.1 | $2.00 | $0.50 | $8.00 |
| GPT-4o | $2.50 | $1.25 | $10.00 |
| GPT-4o mini | $0.15 | $0.075 | $0.60 |
| GPT-5 mini | $0.25 | $0.025 | $2.00 |
| GPT-5.2 | $1.75 | $0.175 | $14.00 |
| GPT-5.2-Codex | $1.75 | $0.175 | $14.00 |
| GPT-5.3-Codex | $1.75 | $0.175 | $14.00 |
| GPT-5.4 | $2.50 | $0.25 | $15.00 |
| GPT-5.4 mini | $0.75 | $0.075 | $4.50 |
| GPT-5.4 nano | $0.20 | $0.02 | $1.25 |
| GPT-5.5 | $5.00 | $0.50 | $30.00 |

### Google

| Model | Input | Cached Input | Output |
|-------|------:|-------------:|-------:|
| Gemini 2.5 Pro | $1.25 | $0.125 | $10.00 |
| Gemini 3 Flash | $0.50 | $0.05 | $3.00 |
| Gemini 3.1 Pro | $2.00 | $0.20 | $12.00 |

### xAI

| Model | Input | Cached Input | Output |
|-------|------:|-------------:|-------:|
| Grok Code Fast 1 | $0.20 | $0.02 | $1.50 |

### Fine-tuned (GitHub)

| Model | Input | Cached Input | Output |
|-------|------:|-------------:|-------:|
| Raptor mini | $0.25 | $0.025 | $2.00 |
| Goldeneye | $1.25 | $0.125 | $10.00 |

### Unknown Models

If a model name cannot be matched to any table entry, a conservative **default** is applied:

| Input | Cached Input | Cache Write | Output |
|------:|-------------:|------------:|-------:|
| $3.00 | $0.30 | $3.75 | $15.00 |

This mirrors Claude Sonnet pricing and ensures costs are not underestimated for unrecognized models.

---

## Model Resolution

Model names from the debug logs can come in many forms. The resolver normalizes and matches them:

1. **Vendor prefix stripping** — prefixes like `openai/`, `anthropic/`, `google/`, `xai/`, `github/` are removed  
2. **Underscore normalization** — underscores become hyphens  
3. **Case insensitive** — all matching is lowercase  
4. **Longest-match-first** — aliases are sorted by descending length before matching, so `gpt-5.4-mini` always matches before `gpt-5.4`, and `claude-sonnet-4.5` before `claude-sonnet-4`
5. **Date-suffix handling** — names like `gpt-4o-mini-2024-07-18` match via substring inclusion against the `gpt-4o-mini` alias

Examples:

| Log value | Resolves to |
|-----------|-------------|
| `claude-opus-4.6` | claude-opus-4.6 |
| `openai/gpt-5.4` | gpt-5.4 |
| `gpt-4o-mini-2024-07-18` | gpt-4o-mini (explicit alias) |
| `CLAUDE-SONNET-4` | claude-sonnet-4 |
| `some_unknown_model` | unknown (default pricing) |

---

## Cache Token Sources

The debug JSONL logs produced by Copilot Chat **do not include cached token counts**. The extension obtains cache data from two sources, in order of preference:

### Source A: Estimation (cacheEstimator)

When no real data is available, the extension estimates cached tokens using the same rules the LLM providers use for automatic prefix caching.

#### How estimation works

Requests within a session are grouped by `(model, subagent scope)` and processed chronologically. For each request in a group:

**Step 1 — Is this the first request in its scope?**
- Yes ? **Cache miss.** The entire input is being seen for the first time.
  - Anthropic: all input tokens are `cacheWriteTokens` (billed at 1.25× base)
  - Others: all input tokens are regular uncached input (no surcharge)

**Step 2 — Is the input below the minimum cacheable threshold?**
- Yes ? No caching applies. All tokens are uncached input.

Minimum thresholds per model:

| Model | Min tokens |
|-------|-----------|
| Claude Opus 4.5–4.7, Haiku 4.5 | 4,096 |
| Claude Sonnet 4.6, Haiku 3.5 | 2,048 |
| Claude Sonnet 4/4.5, Opus 4/4.1 | 1,024 |
| All OpenAI models | 1,024 |
| Gemini Pro models | 4,096 |
| Gemini Flash | 1,024 |
| Others | 1,024 |

**Step 3 — Has the cache TTL expired?**
- Yes (gap since previous request exceeds TTL) ? Cache miss (same as Step 1).

TTLs used:

| Provider | TTL |
|----------|-----|
| Anthropic | 5 minutes |
| OpenAI | 10 minutes |
| Google | 5 minutes |
| xAI | 5 minutes |

**Step 4 — Was the context compacted?**
- If `inputTokens < previousInputTokens × 0.7` (a 30%+ drop), the conversation was summarized/compacted ? the prefix hash changed entirely ? cache miss.

**Step 5 — Estimate the cache hit**
- In multi-turn conversations, each request re-sends the full prior context plus new content. The cached portion is approximated as:
  ```
  cachedTokens = min(previousRequestInputTokens, currentRequestInputTokens)
  newDelta     = max(0, currentInputTokens ? cachedTokens)
  ```
- For Anthropic: `cacheWriteTokens = newDelta` (the new content, billed at 1.25× base)
- For others: `cacheWriteTokens = 0` (no surcharge; new content billed at base rate)

#### Subagent scoping

Subagent requests (e.g., Explore agent invocations) get their **own cache scope**. A subagent's context does not overlap with the parent conversation, so cache state never bleeds between them.

### Source B: Real Data (promptExportReader)

The Copilot extension exposes a hidden command (`github.copilot.chat.debug.exportAllPromptLogsAsJson`) that exports prompt logs with full `usage.prompt_tokens_details.cached_tokens` data.

The extension:
1. Calls this command during sync to get fresh data
2. Persists the entries in an internal `prompt_export_cache` database table (survives VS Code restarts)
3. Builds a match index from all stored entries (fresh + historical)
4. Matches entries to database records by `(resolvedModel, inputTokens, outputTokens)` plus timestamp proximity
5. Updates the database record's `cached_input_tokens` with the real value and records match provenance/confidence

When real cached-token data is available, measured zeroes are preserved as measured zeroes. The estimator does not reinterpret them as missing values.

### How the Two Sources Merge

During billing aggregation (`computeBillingStatus`):

1. All LLM requests for the billing period are fetched from the database
2. `estimateSessionCaching()` is called on the full set
3. For each request:
   - If it already has real cached data (`cachedInputTokens > 0` or `cacheWriteTokens > 0`): use the real values, flag as **measured**
   - Otherwise: apply the estimation algorithm, flag as **estimated**
4. The billing status reports whether values are measured, estimated, or a mix

The UI shows notes like:
- _"Cached token values are estimated based on provider caching rules"_ — all estimated
- _"Some cached token values are measured from logs; others are estimated"_ — mixed

---

## Anthropic Cache-Write Surcharge

This is the most nuanced part of the cost model. Anthropic charges **1.25× the base input rate** when tokens are written to cache for the first time. Other providers have no such surcharge.

### When cache-write tokens are generated

There are three paths:

#### Path 1: Estimation — cache miss (first request or TTL expired)

```
Anthropic:     cacheWriteTokens = inputTokens     (all input is cache-write)
Non-Anthropic: cacheWriteTokens = 0                (no surcharge concept)
```

#### Path 2: Estimation — cache hit (subsequent request within TTL)

```
Anthropic:     cacheWriteTokens = inputTokens ? cachedTokens   (only the new delta)
Non-Anthropic: cacheWriteTokens = 0
```

#### Path 3: Enrichment - real data from prompt export

The prompt export provides `cached_tokens`. If it does not also expose an authoritative cache-write bucket, the extension records cached input as measured and marks Anthropic cache-write as missing/incomplete rather than silently inferring a billable value.

Projected views may still estimate cache-write tokens, but audited totals must be traceable to measured fields or clearly flagged as incomplete.

### Cost impact

For a 100K-token Anthropic request where 80K tokens are cached:

| Without surcharge | With surcharge (actual) |
|-------------------|------------------------|
| 100K × base rate | 80K × cached rate + 20K × 1.25× base rate |
| Higher overall | Lower overall (cache savings outweigh surcharge) |

The surcharge only matters because it makes the **first request in a session** more expensive than base rate, since every input token is a cache-write.

---

## Non-Anthropic Providers

For OpenAI, Google, xAI, and GitHub fine-tuned models:

- There is **no cache-write surcharge** — tokens written to cache cost the same as regular uncached input
- `cacheWriteTokens` is always 0 in both estimation and enrichment
- The cost formula's fallback `cacheWrite ?? input` ensures these tokens (if somehow present) would be charged at the base input rate
- The only discount comes from **cached input tokens**, which are billed at the model's `cachedInput` rate (typically 10-50% of base)

---

## AI Credits Conversion

```
credits = costUSD × 100
```

Since 1 AI credit = $0.01 USD, a request costing $0.2325 = 23.25 credits.

For display purposes, credits are rounded to 1 decimal place. When converting back to USD for the billing summary, credits are rounded to the nearest integer first:

```
displayUSD = Math.round(totalCredits) / 100
```

---

## Billing Period Aggregation

The billing period runs from the **1st of each month (00:00 UTC)** to the **1st of the next month (00:00 UTC)**.

### What gets counted

- **Premium requests (legacy)**: Only user-initiated prompts (not tool calls or subagent requests). Each prompt is multiplied by the model's multiplier.
- **AI credits (new)**: ALL LLM requests in the period, including tool-use loops and subagent calls. Token-level cost is computed for each request individually, then summed.

### Quota

| Plan | AI Credits/month | Notes |
|------|----------------:|-------|
| Free | Not published | Omitted from display |
| Pro | 1,500 | 1,000 base + 500 flex |
| Pro+ | 7,000 | 3,900 base + 3,100 flex |
| Business | 1,900 (3,000 promo) | Pooled across org; promo Jun 1–Sep 1, 2026 |
| Enterprise | 3,900 (7,000 promo) | Pooled across org; promo Jun 1–Sep 1, 2026 |

### Aggregation flow

```
1. Fetch all LLM requests in [periodStart, periodEnd)
2. Run estimateSessionCaching() ? annotate with cached/cache-write tokens
3. For each request: credits = computeCostUSD(model, usage) × 100
4. Sum all credits ? aiCreditsUsed
5. Compare against quota ? percentUsed
```

---

## Premium Request Multipliers (Legacy)

Before June 1, 2026, billing was request-based. Each user prompt consumes `multiplier` premium requests.

| Model | Paid plan multiplier | Free plan multiplier |
|-------|--------------------:|---------------------:|
| GPT-4.1, GPT-4o, GPT-5 mini | 0 (included) | 1 |
| GPT-4o mini | 0 (included) | 1 |
| Raptor mini | 0 (included) | 1 |
| Grok Code Fast 1 | 0.25 | 1 |
| GPT-5.4 nano | 0.25 | — |
| Claude Haiku 4.5 | 0.33 | 1 |
| GPT-5.4 mini, Gemini 3 Flash | 0.33 | — |
| Most premium models | 1 | — |
| Claude Opus 4.5/4.6 | 3 | — |
| GPT-5.5 | 7.5 | — |
| Claude Opus 4.7 | 15 | — |
| Claude Opus 4.6 (fast) | 30 | — |

---

## Worked Examples

### Example 1: Claude Opus 4.6 with heavy caching

**Scenario**: 100,000 input tokens (90,000 cached, 10,000 cache-write) + 5,000 output tokens.

| Bucket | Tokens | Rate (per 1M) | Cost |
|--------|-------:|:-------------:|-----:|
| Uncached input | max(0, 100K?90K?10K) = **0** | $5.00 | **$0.0000** |
| Cached input | **90,000** | $0.50 | **$0.0450** |
| Cache write | **10,000** | $6.25 | **$0.0625** |
| Output | **5,000** | $25.00 | **$0.1250** |
| **Total** | | | **$0.2325** |

AI credits = 0.2325 × 100 = **23.25 credits** (displayed as 23.3)

### Example 2: GPT-5.4 with partial caching

**Scenario**: 50,000 input tokens (30,000 cached, 0 cache-write) + 10,000 output tokens.

| Bucket | Tokens | Rate (per 1M) | Cost |
|--------|-------:|:-------------:|-----:|
| Uncached input | 50K?30K?0 = **20,000** | $2.50 | **$0.0500** |
| Cached input | **30,000** | $0.25 | **$0.0075** |
| Cache write | **0** | $2.50 (fallback) | **$0.0000** |
| Output | **10,000** | $15.00 | **$0.1500** |
| **Total** | | | **$0.2075** |

AI credits = **20.75 credits** (displayed as 20.8)

### Example 3: Claude Sonnet 4 — first request (cache miss)

**Scenario**: 80,000 input tokens + 3,000 output tokens. First request in session ? estimator assigns all input as cache-write.

| Bucket | Tokens | Rate (per 1M) | Cost |
|--------|-------:|:-------------:|-----:|
| Uncached input | 80K?0?80K = **0** | $3.00 | **$0.0000** |
| Cached input | **0** | $0.30 | **$0.0000** |
| Cache write | **80,000** | $3.75 | **$0.3000** |
| Output | **3,000** | $15.00 | **$0.0450** |
| **Total** | | | **$0.3450** |

Compared to if there were no caching at all (all at base rate): 80K×$3.00/1M + 3K×$15.00/1M = $0.285. The cache-write surcharge adds $0.06 (25% of the input cost) to the first request.

### Example 4: Claude Sonnet 4 — second request (cache hit, same session)

**Scenario**: Follow-up request with 95,000 input tokens + 2,000 output. Previous request had 80,000 input.

Estimator computes:
- `cachedTokens = min(80K, 95K) = 80,000`
- `cacheWriteTokens = 95K ? 80K = 15,000` (the new delta)

| Bucket | Tokens | Rate (per 1M) | Cost |
|--------|-------:|:-------------:|-----:|
| Uncached input | 95K?80K?15K = **0** | $3.00 | **$0.0000** |
| Cached input | **80,000** | $0.30 | **$0.0240** |
| Cache write | **15,000** | $3.75 | **$0.0563** |
| Output | **2,000** | $15.00 | **$0.0300** |
| **Total** | | | **$0.1103** |

Savings vs. no caching: 95K×$3.00/1M = $0.285 input alone ? actual input cost is $0.0803 ? **72% savings on input** thanks to the 80K cached portion.

### Example 5: GPT-5 mini — no caching (below threshold)

**Scenario**: 500 input tokens + 200 output tokens. Below the 1,024 minimum cacheable threshold.

| Bucket | Tokens | Rate (per 1M) | Cost |
|--------|-------:|:-------------:|-----:|
| Uncached input | **500** | $0.25 | **$0.000125** |
| Output | **200** | $2.00 | **$0.000400** |
| **Total** | | | **$0.000525** |

AI credits = **0.0525 credits**

---

## Edge Cases and Limitations

### No cached data available

When neither real data nor estimation is possible (e.g., isolated requests with no session context), the cost shown is an **upper bound** — all input tokens are charged at the full base rate with no cache discount. The UI shows: _"Cached/cache-write token counts are not present in the logs; cost shown is an upper bound."_

### Long-context surcharges not modeled

GPT-5.4 (>272K tokens) and Gemini 2.5 Pro / 3.1 Pro (>200K tokens) have higher rates for long prompts. The extension uses the standard (shorter prompt) rates for all input lengths. This means costs for very long prompts may be **underestimated**.

### Context compaction

When Copilot compacts a conversation (summarizing history to fit in the context window), input tokens can drop significantly. The estimator detects a 30%+ drop from the previous request and treats it as a cache miss, since the compacted summary is entirely new content that won't match any cached prefix.

### Subagent isolation

Each subagent invocation (e.g., the Explore agent) starts a fresh cache scope. The subagent's requests don't benefit from cached content in the parent conversation, and vice versa. Different subagents within the same session also have separate scopes.

### Unknown models

Any model not in the pricing table is charged at default rates ($3.00/$0.30/$3.75/$15.00 per 1M tokens — equivalent to Claude Sonnet). This is a conservative estimate that avoids undercharging.

### Rounding

- Individual request costs are computed at full floating-point precision
- AI credits are rounded to 1 decimal place for display
- USD totals are rounded to the nearest cent: `Math.round(totalCredits) / 100`
- This means the sum of individually displayed credits may differ slightly from the displayed total (due to rounding at different levels)

### Prompt export data coverage

The real cached token data from the prompt export command only covers prompts from the current or recent VS Code sessions. Historical sessions where the export was never run will rely entirely on estimated values. Once exported, the data is persisted in the database and survives VS Code restarts.
