/**
 * OpenAI (Plus/Pro) provider wrapper.
 */

import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import {
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
  hasOpenAIOAuthCached,
  queryOpenAIQuota,
  resolveOpenAIOAuth,
} from "../lib/openai.js";
import { readAuthFileCached } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import {
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

export const openaiProvider: QuotaProvider = {
  id: "openai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Best-effort: if provider lookup errors, preserve current permissive fallback.
    const availableByProviderId = await isCanonicalProviderAvailable({
      ctx,
      providerId: "openai",
      fallbackOnError: true,
    });

    if (availableByProviderId) {
      return true;
    }

    return hasOpenAIOAuthCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS });
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["openai", "chatgpt", "codex"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const auth = resolveOpenAIOAuth(await readAuthFileCached({ maxAgeMs: 5_000 }));
    const result = await queryOpenAIQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
    const providerResult = mapNullableProviderResult(result, {
      errorLabel: "OpenAI",
      onSuccess: (result) => {
        const accounting = {
          resultType: "rate_limit",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
        } as const;
        const entries = groupedPercentWindowEntries({
          group: result.label,
          accounting,
          windows: [
            { window: result.windows.hourly, suffix: "5h", label: "5h:" },
            { window: result.windows.weekly, suffix: "Weekly", label: "Weekly:" },
            { window: result.windows.monthly, suffix: "Monthly", label: "Monthly:" },
            { window: result.windows.codeReview, suffix: "Code Review", label: "Code Review:" },
          ],
        });
        if (result.manualResetCount !== undefined) {
          const manualResetEntry = {
            accounting,
            kind: "value",
            name: `${result.label} Manual resets`,
            group: result.label,
            label: "Manual resets:",
            value: String(result.manualResetCount),
          } as const;
          const weeklyIndex = entries.findIndex((entry) => entry.label === "Weekly:");
          entries.splice(weeklyIndex >= 0 ? weeklyIndex + 1 : entries.length, 0, manualResetEntry);
        }
        return attemptedResult(entries, [], {
          singleWindowDisplayName: result.label,
        });
      },
    });
    const configured = auth.state === "configured";
    const expiresAt = configured ? auth.expiresAt : undefined;
    return withStatusDetails(
      providerResult,
      statusDetailsFromRecord({
        auth_configured: configured ? "true" : "false",
        auth_source: configured ? auth.sourceKey : "(none)",
        token_status: !configured
          ? "(none)"
          : expiresAt && expiresAt < Date.now()
            ? "expired"
            : "valid",
        token_expires_at: expiresAt ? new Date(expiresAt).toISOString() : "(none)",
        account_email: configured && auth.email ? sanitizeDisplayText(auth.email) : "(none)",
        account_id: configured && auth.accountId ? sanitizeDisplayText(auth.accountId) : "(none)",
        manual_reset_count:
          result?.success && result.manualResetCount !== undefined
            ? String(result.manualResetCount)
            : undefined,
      }),
    );
  },
};
