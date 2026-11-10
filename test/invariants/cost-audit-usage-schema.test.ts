/**
 * cost-audit-usage-schema.test.ts
 * Pins scripts/cost-audit.mjs's parseMessagesUsageReport() against the Anthropic Usage API's own
 * documented example response (platform.claude.com/docs/en/api/admin/usage_report/retrieve_messages,
 * fetched 2026-10-28), independent of live credentials -- this repo's organization gets a 403
 * permission_error on this endpoint regardless of key/header fixes (see the PR this test shipped in),
 * so this is the only verification currently possible that the parsing logic is correct for the
 * confirmed schema. It does not and cannot prove the live request itself succeeds for this org.
 */

import { describe, it, expect } from 'vitest';
import { parseMessagesUsageReport } from '../../scripts/cost-audit.mjs';

// Verbatim from the documentation's "Response (200)" example, not fabricated or approximated.
const DOC_EXAMPLE_RESPONSE = {
  data: [
    {
      ending_at: '2025-08-02T00:00:00Z',
      results: [
        {
          account_id: 'user_01WCz1FkmYMm4gnmykNKUu3Q',
          api_key_id: 'apikey_01Rj2N8SVvo6BePZj99NhmiT',
          cache_creation: {
            ephemeral_1h_input_tokens: 0,
            ephemeral_5m_input_tokens: 0,
          },
          cache_read_input_tokens: 200,
          context_window: '0-200k',
          inference_geo: 'global',
          model: 'claude-opus-5-5',
          output_tokens: 500,
          server_tool_use: {
            web_search_requests: 10,
          },
          service_account_id: 'svac_01Hk3R9TWxq7CfQak00OiVw4',
          service_tier: 'standard',
          speed: 'standard',
          uncached_input_tokens: 1500,
          workspace_id: 'wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ',
        },
      ],
      starting_at: '2025-08-01T00:00:00Z',
    },
  ],
  has_more: true,
  next_page: 'page_MjAyNS0wNS0xNFQwMDowMDowMFo=',
};

describe('parseMessagesUsageReport: pinned to the documented Usage API response shape', () => {
  it('extracts every token-count field from the documentation example, attributed to its model', () => {
    const { byModelField, models, unattributed } = parseMessagesUsageReport([DOC_EXAMPLE_RESPONSE]);

    expect([...models]).toEqual(['claude-opus-5-5']);
    expect(unattributed).toBe(0);

    expect(byModelField.get('claude-opus-5-5 :: uncached_input_tokens')).toBe(1500);
    expect(byModelField.get('claude-opus-5-5 :: cache_read_input_tokens')).toBe(200);
    expect(byModelField.get('claude-opus-5-5 :: output_tokens')).toBe(500);
    expect(byModelField.get('claude-opus-5-5 :: cache_creation.ephemeral_1h_input_tokens')).toBe(0);
    expect(byModelField.get('claude-opus-5-5 :: cache_creation.ephemeral_5m_input_tokens')).toBe(0);

    // server_tool_use.web_search_requests is not a token count and must not leak into the token totals.
    expect([...byModelField.keys()].some((k) => k.includes('web_search'))).toBe(false);
  });

  it('sums across multiple time buckets and multiple pages for the same model', () => {
    const page1 = {
      data: [
        { starting_at: 't0', ending_at: 't1', results: [{ model: 'claude-fable-5-1', uncached_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }] },
        { starting_at: 't1', ending_at: 't2', results: [{ model: 'claude-fable-5-1', uncached_input_tokens: 50, cache_read_input_tokens: 5, output_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }] },
      ],
      has_more: true,
      next_page: 'p2',
    };
    const page2 = {
      data: [
        { starting_at: 't2', ending_at: 't3', results: [{ model: 'claude-fable-5-1', uncached_input_tokens: 25, cache_read_input_tokens: 0, output_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }] },
      ],
      has_more: false,
      next_page: null,
    };
    const { byModelField } = parseMessagesUsageReport([page1, page2]);
    expect(byModelField.get('claude-fable-5-1 :: uncached_input_tokens')).toBe(175); // 100 + 50 + 25
    expect(byModelField.get('claude-fable-5-1 :: cache_read_input_tokens')).toBe(5);
    expect(byModelField.get('claude-fable-5-1 :: output_tokens')).toBe(35);
  });

  it('counts (not attributes to a fabricated model) a result item with model: null', () => {
    const page = { data: [{ starting_at: 't0', ending_at: 't1', results: [{ model: null, uncached_input_tokens: 999 }] }] };
    const { byModelField, models, unattributed } = parseMessagesUsageReport([page]);
    expect(models.size).toBe(0);
    expect(byModelField.size).toBe(0);
    expect(unattributed).toBe(1);
  });

  it('handles an empty-usage bucket (results: []) without error', () => {
    const page = { data: [{ starting_at: 't0', ending_at: 't1', results: [] }], has_more: false, next_page: null };
    const { byModelField, models, unattributed } = parseMessagesUsageReport([page]);
    expect(byModelField.size).toBe(0);
    expect(models.size).toBe(0);
    expect(unattributed).toBe(0);
  });
});
