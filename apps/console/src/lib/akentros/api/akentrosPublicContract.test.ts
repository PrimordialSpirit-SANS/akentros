import { describe, expect, it } from "vitest";
import {
  hasAkentrosErrorEnvelope,
  normalizeAkentrosError,
  normalizeAkentrosLogsPage,
  normalizeAkentrosRequestDetail,
  normalizeAkentrosStreamChunk,
  normalizeAkentrosUsageErrorCode,
  normalizeAkentrosUsageSummary,
} from "./akentrosPublicContract";

describe("normalizeAkentrosError", () => {
  it("prefers a known code from an OpenAI-style error envelope", () => {
    const error = normalizeAkentrosError(
      { error: { message: "ignored", code: "insufficient_balance" } },
      { status: 500 },
    );
    expect(error.code).toBe("insufficient_balance");
    expect(error.message).toContain("餘額不足");
  });

  it("reads a flat code field as well", () => {
    expect(normalizeAkentrosError({ code: "rate_limit_exceeded" }).code).toBe("rate_limit_exceeded");
  });

  it("ignores unknown codes and falls back to status mapping", () => {
    const error = normalizeAkentrosError({ code: "mystery_code" }, { status: 429 });
    expect(error.code).toBe("rate_limit_exceeded");
  });

  it("maps 401 by context", () => {
    expect(normalizeAkentrosError(null, { status: 401, context: "developer" }).code).toBe(
      "authentication_required",
    );
    expect(normalizeAkentrosError(null, { status: 401, context: "inference" }).code).toBe("invalid_api_key");
  });

  it("maps 402 to insufficient balance and 5xx to service unavailable", () => {
    expect(normalizeAkentrosError(null, { status: 402 }).code).toBe("insufficient_balance");
    expect(normalizeAkentrosError(null, { status: 503 }).code).toBe("service_unavailable");
  });

  it("uses fallbackCode before status mapping", () => {
    const error = normalizeAkentrosError(null, { status: 500, fallbackCode: "stream_interrupted" });
    expect(error.code).toBe("stream_interrupted");
  });

  it("defaults to request_failed without any signal", () => {
    expect(normalizeAkentrosError("garbage").code).toBe("request_failed");
  });
});

describe("normalizeAkentrosUsageErrorCode", () => {
  it("returns null for empty values", () => {
    expect(normalizeAkentrosUsageErrorCode(null)).toBeNull();
    expect(normalizeAkentrosUsageErrorCode(undefined)).toBeNull();
    expect(normalizeAkentrosUsageErrorCode("")).toBeNull();
  });

  it("keeps known codes and coerces unknown ones", () => {
    expect(normalizeAkentrosUsageErrorCode("rate_limit_exceeded")).toBe("rate_limit_exceeded");
    expect(normalizeAkentrosUsageErrorCode("refunded")).toBe("request_failed");
    expect(normalizeAkentrosUsageErrorCode("nonsense")).toBe("request_failed");
  });
});

describe("hasAkentrosErrorEnvelope", () => {
  it("detects error objects and message+code envelopes", () => {
    expect(hasAkentrosErrorEnvelope({ error: { code: "x" } })).toBe(true);
    expect(hasAkentrosErrorEnvelope({ message: "boom", code: "request_failed" })).toBe(true);
    expect(hasAkentrosErrorEnvelope({ choices: [] })).toBe(false);
    expect(hasAkentrosErrorEnvelope(null)).toBe(false);
  });
});

describe("normalizeAkentrosUsageSummary", () => {
  it("coerces missing fields to zero and filters malformed quotas", () => {
    const summary = normalizeAkentrosUsageSummary({
      balance_usd: "12.5",
      requests: 3,
      free_model_quotas: {
        "akentros-mini": { used: 2, limit: 10 },
        broken: "not-a-record",
      },
    });
    expect(summary.balance_usd).toBe("12.5");
    expect(summary.requests).toBe(3);
    expect(summary.succeeded).toBe(0);
    expect(summary.free_model_quotas).toEqual({ "akentros-mini": { used: 2, limit: 10 } });
  });

  it("never produces negative numbers", () => {
    const summary = normalizeAkentrosUsageSummary({ balance_usd: -5, charged_usd: "-1" });
    expect(summary.balance_usd).toBe("0");
    expect(summary.charged_usd).toBe("0");
  });

  it("handles completely invalid input", () => {
    const summary = normalizeAkentrosUsageSummary("garbage");
    expect(summary.balance_usd).toBe("0");
    expect(summary.free_model_quotas).toEqual({});
  });
});

describe("normalizeAkentrosLogsPage", () => {
  it("normalizes log rows and pagination", () => {
    const page = normalizeAkentrosLogsPage({
      logs: [
        {
          request_id: "req_1",
          created_at: "2026-01-01T00:00:00Z",
          requested_model: "akentros-mini",
          status: "succeeded",
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
          charged_points: 1.5,
        },
      ],
      pagination: { next_cursor: "abc", has_more: true },
    });
    expect(page.pagination).toEqual({ next_cursor: "abc", has_more: true });
    expect(page.logs).toHaveLength(1);
    const log = page.logs[0];
    expect(log.request_id).toBe("req_1");
    expect(log.status).toBe("succeeded");
    expect(log.actual_model).toBe("akentros-mini");
    expect(log.total_tokens).toBe(30);
    expect(log.error_code).toBeNull();
  });

  it("marks unknown statuses as rejected", () => {
    const page = normalizeAkentrosLogsPage({ logs: [{ status: "weird" }] });
    expect(page.logs[0].status).toBe("rejected");
  });

  it("returns empty page for invalid input", () => {
    expect(normalizeAkentrosLogsPage(undefined)).toEqual({
      logs: [],
      pagination: { next_cursor: null, has_more: false },
    });
  });
});

describe("normalizeAkentrosRequestDetail", () => {
  it("extends the usage log with completion metadata", () => {
    const detail = normalizeAkentrosRequestDetail({
      request_id: "req_9",
      status: "refunded",
      completed_at: "2026-01-01T00:00:05Z",
      pricing_revision: "rev-1",
      first_token_latency_ms: "250",
    });
    expect(detail.completed_at).toBe("2026-01-01T00:00:05Z");
    expect(detail.pricing_revision).toBe("rev-1");
    expect(detail.first_token_latency_ms).toBe(250);
    expect(detail.fallback_count).toBe(0);
    expect(detail.status).toBe("refunded");
  });
});

describe("normalizeAkentrosStreamChunk", () => {
  it("preserves valid reasoning token details without leaking metadata or adding them to totals", () => {
    const usage = { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 };
    const chunk = normalizeAkentrosStreamChunk({
      usage: { ...usage, completion_tokens_details: { reasoning_tokens: 80, vendor_metadata: "private" } },
    });
    expect(chunk.usage).toEqual({ ...usage, completion_tokens_details: { reasoning_tokens: 80 } });
    for (const reasoningTokens of [-1, 101, 1.5, "80", null]) {
      expect(
        normalizeAkentrosStreamChunk({
          usage: { ...usage, completion_tokens_details: { reasoning_tokens: reasoningTokens } },
        }).usage,
      ).toEqual(usage);
    }
  });

  it("keeps valid choices and usage", () => {
    const chunk = normalizeAkentrosStreamChunk({
      choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    });
    expect(chunk.choices).toHaveLength(1);
    expect(chunk.choices[0].delta).toEqual({ role: "assistant", content: "hi" });
    expect(chunk.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
  });

  it("coerces unknown finish reasons to stop and drops non-record choices", () => {
    const chunk = normalizeAkentrosStreamChunk({
      choices: [{ finish_reason: "weird", delta: {} }, "not-a-record"],
    });
    expect(chunk.choices).toHaveLength(1);
    expect(chunk.choices[0].finish_reason).toBe("stop");
    expect(chunk.usage).toBeNull();
  });

  it("requires all usage fields to expose usage", () => {
    const chunk = normalizeAkentrosStreamChunk({
      usage: { prompt_tokens: 5, completion_tokens: null, total_tokens: 5 },
    });
    expect(chunk.usage).toBeNull();
  });

  it("handles empty input", () => {
    expect(normalizeAkentrosStreamChunk(null)).toEqual({ choices: [], usage: null });
  });
});
