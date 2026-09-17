import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { BeaconBillableBilling } from "../src/billing.ts";
import {
  BEACON_BILLING_SQL,
  createBeaconBillingStore,
  createBeaconRequestFingerprint,
  runBillableBeaconRequest,
} from "../src/billing.ts";
import { migrateBeaconSchema } from "../src/schemaMigration.ts";
import { createSqliteTestDb } from "./sqliteTestDb.ts";

const fingerprint = "a".repeat(64);

function reservation(overrides: any = {}) {
  return {
    requestId: "req_test_1",
    userId: "11",
    apiKeyId: "22",
    idempotencyKey: "idem-1",
    requestFingerprint: fingerprint,
    publicModel: "beacon-test-model",
    pricingRevision: "pricing-v1",
    pricingSnapshot: { billing: { minimum_points: 1 } },
    reservedCostMicros: "8",
    expiresAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function billingFixture({
  userBalance = 1_000_000,
  spendLimit,
}: {
  userBalance?: number;
  spendLimit?: number | null;
} = {}) {
  const { query, insertUser } = createSqliteTestDb();
  await migrateBeaconSchema(query);
  const user = insertUser({ balance_usd_micros: userBalance });
  const key = await query(
    `INSERT INTO ai_api_keys (user_id, name, key_prefix, key_suffix, key_digest, spend_limit_usd_micros)
     VALUES (?, 'test key', 'test-prefix', 'ff', ?, ?) RETURNING id`,
    [user.id, "d".repeat(64), spendLimit],
  );
  return { query, user, apiKeyId: String(key.rows[0].id) };
}

test("request fingerprints are canonical across object key order", async () => {
  const left = await createBeaconRequestFingerprint({
    model: "beacon-test-model",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  });
  const right = await createBeaconRequestFingerprint({
    stream: false,
    messages: [{ content: "hello", role: "user" }],
    model: "beacon-test-model",
  });
  assert.equal(left, right);
  assert.match(left, /^[a-f0-9]{64}$/);
});

test("reservation contract: read/idempotency/dispatch SQL stays bound-parameter only", () => {
  assert.match(
    BEACON_BILLING_SQL.readIdempotency,
    /requests\.api_key_id = \? AND requests\.idempotency_key = \?/,
  );
  assert.match(BEACON_BILLING_SQL.dispatch, /WHERE request_id = \? AND status = 'reserved'/);
  assert.match(BEACON_BILLING_SQL.stale, /reservations\.expires_at <= \?/);
  assert.match(BEACON_BILLING_SQL.quarantinedStale, /reservations\.updated_at <= \?/);
  assert.doesNotMatch(JSON.stringify(BEACON_BILLING_SQL), /1000000000/);
  assert.doesNotMatch(JSON.stringify(BEACON_BILLING_SQL), /INTERVAL|CURRENT_TIMESTAMP/);
});

test("successful reservation inserts request, reservation and ledger atomically", async () => {
  const { query, user, apiKeyId } = await billingFixture();
  const store = createBeaconBillingStore(query);

  const result = await store.reserve(reservation({ userId: user.id, apiKeyId }));
  assert.equal(result.status, "reserved");
  assert.equal(result.reservationState, "reserved");
  assert.equal(result.reservedCostMicros, 8);

  const ledger = await query(`SELECT direction, amount, balance_before, balance_after FROM ledger_entries`);
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].direction, "debit");
  assert.equal(String(ledger.rows[0].amount), "8");

  const userRow = await query(`SELECT balance_usd_micros FROM users WHERE id = ?`, [user.id]);
  assert.equal(Number(userRow.rows[0].balance_usd_micros), user.balance_usd_micros - 8);

  const keyRow = await query(`SELECT spend_reserved_usd_micros FROM ai_api_keys WHERE id = ?`, [apiKeyId]);
  assert.equal(Number(keyRow.rows[0].spend_reserved_usd_micros), 8);
});

test("database insufficient-balance row remains a 402 billing error", async () => {
  const { query, user, apiKeyId } = await billingFixture({ userBalance: 0 });
  const store = createBeaconBillingStore(query);

  await assert.rejects(
    store.reserve(reservation({ userId: user.id, apiKeyId, idempotencyKey: null })),
    (error: any) => {
      assert.equal(error.status, 402);
      assert.equal(error.code, "insufficient_balance");
      assert.equal(error.requestId, "req_test_1");
      return true;
    },
  );

  // 拒絕的請求不留任何扣款/帳務痕跡。
  const ledger = await query(`SELECT * FROM ledger_entries`);
  assert.equal(ledger.rows.length, 0);
});

test("database spend-limit rejection remains a 402 key-budget error", async () => {
  const { query, user, apiKeyId } = await billingFixture({ spendLimit: 5 });
  const store = createBeaconBillingStore(query);

  await assert.rejects(
    store.reserve(reservation({ userId: user.id, apiKeyId, idempotencyKey: null })),
    (error: any) => error.status === 402 && error.code === "spend_limit_exceeded",
  );
});

test("same idempotency key with a different payload is rejected", async () => {
  const { query, user, apiKeyId } = await billingFixture();
  const store = createBeaconBillingStore(query);
  await store.reserve(reservation({ userId: user.id, apiKeyId }));
  await assert.rejects(
    store.reserve(reservation({ userId: user.id, apiKeyId, requestFingerprint: "b".repeat(64) })),
    (error: any) => error.status === 409 && error.code === "idempotency_conflict",
  );
});

test("same idempotency key replays the committed request without double charge", async () => {
  const { query, user, apiKeyId } = await billingFixture();
  const store = createBeaconBillingStore(query);
  const first = await store.reserve(reservation({ userId: user.id, apiKeyId }));
  const replay = await store.reserve(reservation({ userId: user.id, apiKeyId }));
  assert.equal(replay.aiRequestId, first.aiRequestId);
  assert.equal(replay.idempotentReplay, true);

  const ledger = await query(`SELECT * FROM ledger_entries`);
  assert.equal(ledger.rows.length, 1);
});

test("dispatch transitions reserved to dispatched", async () => {
  const { query, user, apiKeyId } = await billingFixture();
  const store = createBeaconBillingStore(query);
  const reserved = await store.reserve(reservation({ userId: user.id, apiKeyId }));
  const dispatched: any = await store.markDispatched(reserved.requestId);
  assert.equal(dispatched.status, "dispatched");
});

test("settle charges the key and refunds the unused reservation", async () => {
  const { query, user, apiKeyId } = await billingFixture();
  const store = createBeaconBillingStore(query);
  const reserved = await store.reserve(reservation({ userId: user.id, apiKeyId }));
  await store.markDispatched(reserved.requestId);

  const settled = await store.settle({
    requestId: reserved.requestId,
    actualCostMicros: 3,
    inputTokens: 4,
    outputTokens: 2,
    usageSource: "provider",
    totalLatencyMs: 25,
  });
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.chargedCostMicros, 3);
  assert.equal(settled.refundedCostMicros, 5);
  assert.equal(settled.reservationState, "settled");

  const keyRow = await query(
    `SELECT spend_reserved_usd_micros, spend_used_usd_micros FROM ai_api_keys WHERE id = ?`,
    [apiKeyId],
  );
  assert.equal(Number(keyRow.rows[0].spend_reserved_usd_micros), 0);
  assert.equal(Number(keyRow.rows[0].spend_used_usd_micros), 3);

  const userRow = await query(`SELECT balance_usd_micros FROM users WHERE id = ?`, [user.id]);
  assert.equal(Number(userRow.rows[0].balance_usd_micros), user.balance_usd_micros - 8 + 5);

  const refunds = await query(`SELECT amount FROM ledger_entries WHERE transaction_type = 'ai_usage_refund'`);
  assert.equal(String(refunds.rows[0].amount), "5");
});

test("zero-point settle requests keep their reserved-zero path", async () => {
  const { query, user, apiKeyId } = await billingFixture();
  const store = createBeaconBillingStore(query);
  await query(
    `INSERT INTO ai_requests (request_id, user_id, api_key_id, request_fingerprint, public_model, pricing_revision, pricing_snapshot)
     VALUES ('req_zero', ?, ?, ?, 'beacon-test-model', 'pricing-v1', '{}')`,
    [user.id, apiKeyId, fingerprint],
  );
  await query(
    `INSERT INTO ai_billing_reservations (ai_request_id, request_id, user_id, reserved_usd_micros, state, expires_at)
     VALUES (1, 'req_zero', ?, 0, 'reserved', '2030-01-01T00:00:00.000Z')`,
    [user.id],
  );

  const result = await store.settle({
    requestId: "req_zero",
    actualCostMicros: 0,
    inputTokens: 4,
    outputTokens: 2,
    usageSource: "provider",
    totalLatencyMs: 25,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.chargedCostMicros, 0);
  assert.equal(result.reservationState, "settled");
});

test("provider failure refunds the reservation before dispatch is refunded too", async () => {
  const { query, user, apiKeyId } = await billingFixture();
  const store = createBeaconBillingStore(query);
  const reserved = await store.reserve(reservation({ userId: user.id, apiKeyId }));

  const refunded = await store.refund({
    requestId: reserved.requestId,
    reason: "provider_failure",
    errorCode: "provider_failure",
    httpStatus: 502,
  });
  assert.equal(refunded.status, "refunded");
  assert.equal(refunded.reservationState, "refunded");

  const userRow = await query(`SELECT balance_usd_micros FROM users WHERE id = ?`, [user.id]);
  assert.equal(Number(userRow.rows[0].balance_usd_micros), user.balance_usd_micros);

  // 二次退款冪等:狀態已不是 reserved,回讀同一列。
  const again = await store.refund({
    requestId: reserved.requestId,
    reason: "provider_failure",
    errorCode: "provider_failure",
    httpStatus: 502,
  });
  assert.equal(again.reservationState, "refunded");
});

test("quarantined reservations are refunded by resolveQuarantined after the window", async () => {
  const { query, user, apiKeyId } = await billingFixture();
  const store = createBeaconBillingStore(query);
  const reserved = await store.reserve(reservation({ userId: user.id, apiKeyId }));
  await store.markDispatched(reserved.requestId);
  await store.markNeedsReconciliation({ requestId: reserved.requestId, errorCode: "usage_unknown" });
  // 回填隔離時間,讓 60 秒窗口判定成立。
  await query(
    `UPDATE ai_billing_reservations SET updated_at = '2020-01-01T00:00:00.000Z' WHERE request_id = ?`,
    [reserved.requestId],
  );

  const outcomes = await store.resolveQuarantined({ limit: 10, olderThanMs: 60_000 });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].reservationState, "refunded");
  assert.equal(outcomes[0].refundedCostMicros, 8);

  const userRow = await query(`SELECT balance_usd_micros FROM users WHERE id = ?`, [user.id]);
  assert.equal(Number(userRow.rows[0].balance_usd_micros), user.balance_usd_micros);
});

test("resolveQuarantined clamps its inputs to safe bounds", async () => {
  const { query } = await billingFixture();
  const store = createBeaconBillingStore(query);
  const outcomes = await store.resolveQuarantined({ limit: 10000, olderThanMs: 1 });
  assert.deepEqual(outcomes, []);
});

test("stale reservations are found by expiry", async () => {
  const { query, user, apiKeyId } = await billingFixture();
  // 用已過期的 expires_at 建立保留單。
  await query(
    `INSERT INTO ai_requests (request_id, user_id, api_key_id, request_fingerprint, public_model, pricing_revision, pricing_snapshot)
     VALUES ('req_stale', ?, ?, ?, 'beacon-test-model', 'pricing-v1', '{}')`,
    [user.id, apiKeyId, fingerprint],
  );
  await query(
    `INSERT INTO ai_billing_reservations (ai_request_id, request_id, user_id, reserved_usd_micros, state, expires_at)
     VALUES (1, 'req_stale', ?, 8, 'reserved', '2020-01-01T00:00:00.000Z')`,
    [user.id],
  );

  const stale = await query(BEACON_BILLING_SQL.stale, [new Date().toISOString(), 100]);
  assert.equal(stale.rows.length, 1);
  assert.equal(stale.rows[0].request_id, "req_stale");
});

test("insufficient points stop before provider dispatch", async () => {
  let providerCalls = 0;
  // 此場景 reserve 必然拋出,其餘計費方法不可達,以型別斷言標記部分替身。
  const billing = {
    reserve: async () => {
      const error = new Error("insufficient") as Error & { status?: number; code?: string };
      error.status = 402;
      error.code = "insufficient_balance";
      throw error;
    },
  } as unknown as BeaconBillableBilling;
  await assert.rejects(
    runBillableBeaconRequest({
      billing,
      reservation: reservation(),
      providerCall: async () => {
        providerCalls += 1;
        return { actualCostMicros: 0, inputTokens: 0, outputTokens: 0 };
      },
    }),
    (error: any) => error.code === "insufficient_balance",
  );
  assert.equal(providerCalls, 0);
});

test("idempotent replay skips provider and every billing mutation", async () => {
  const calls: any[] = [];
  const billing = {
    reserve: async () => ({
      requestId: "req_original",
      idempotentReplay: true,
      status: "succeeded",
    }),
    markDispatched: async () => calls.push("dispatch"),
    settle: async () => calls.push("settle"),
    refund: async () => calls.push("refund"),
    markNeedsReconciliation: async () => calls.push("reconcile"),
  };
  const result = await runBillableBeaconRequest({
    billing,
    reservation: reservation(),
    providerCall: async () => {
      calls.push("provider");
      return { actualCostMicros: 0, inputTokens: 0, outputTokens: 0 };
    },
  });
  assert.equal(result.kind, "idempotent_replay");
  assert.deepEqual(calls, []);
});

test("fake provider success dispatches once and settles once", async () => {
  const calls: any[] = [];
  const billing = {
    reserve: async () => ({ requestId: "req_test_1", idempotentReplay: false }),
    markDispatched: async () => calls.push("dispatch"),
    settle: async (input: any) => {
      calls.push(["settle", input.actualCostMicros]);
      return { requestId: input.requestId, status: "succeeded" };
    },
    refund: async () => calls.push("refund"),
    markNeedsReconciliation: async () => calls.push("reconcile"),
  };
  const result = await runBillableBeaconRequest({
    billing,
    reservation: reservation(),
    providerCall: async () => {
      calls.push("provider");
      return { actualCostMicros: 3, inputTokens: 10, outputTokens: 5 };
    },
  });
  assert.equal(result.kind, "succeeded");
  assert.deepEqual(calls, ["dispatch", "provider", ["settle", 3]]);
});

test("definitive fake-provider failure refunds, unknown usage reconciles", async () => {
  for (const usageUnknown of [false, true]) {
    const calls: any[] = [];
    const billing = {
      reserve: async () => ({ requestId: "req_test_1", idempotentReplay: false }),
      markDispatched: async () => calls.push("dispatch"),
      settle: async () => calls.push("settle"),
      refund: async () => calls.push("refund"),
      markNeedsReconciliation: async () => calls.push("reconcile"),
    };
    const providerError = Object.assign(new Error("fake failure"), {
      code: usageUnknown ? "provider_timeout" : "provider_rejected",
      usageUnknown,
    });
    await assert.rejects(
      runBillableBeaconRequest({
        billing,
        reservation: reservation(),
        providerCall: async () => {
          calls.push("provider");
          throw providerError;
        },
      }),
      providerError,
    );
    assert.deepEqual(
      calls,
      usageUnknown ? ["dispatch", "provider", "reconcile"] : ["dispatch", "provider", "refund"],
    );
  }
});

test("settlement failure is quarantined for reconciliation and never refunded", async () => {
  const calls: any[] = [];
  const settlementError = new Error("database response lost");
  const billing = {
    reserve: async () => ({ requestId: "req_test_1", idempotentReplay: false }),
    markDispatched: async () => calls.push("dispatch"),
    settle: async () => {
      calls.push("settle");
      throw settlementError;
    },
    refund: async () => calls.push("refund"),
    markNeedsReconciliation: async () => calls.push("reconcile"),
  };
  await assert.rejects(
    runBillableBeaconRequest({
      billing,
      reservation: reservation(),
      providerCall: async () => {
        calls.push("provider");
        return { actualCostMicros: 2, inputTokens: 4, outputTokens: 2 };
      },
    }),
    settlementError,
  );
  assert.deepEqual(calls, ["dispatch", "provider", "settle", "reconcile"]);
});

test("Hono billing adapter uses the shared billing core", () => {
  const worker = readFileSync(
    new URL("../../../apps/gateway/src/utils/aiBilling.ts", import.meta.url),
    "utf8",
  );
  assert.match(worker, /createBeaconBillingStore/);
  assert.match(worker, /ensureAiSchema/);
  assert.doesNotMatch(worker, /UPDATE users|INSERT INTO ledger_entries/);
});

test("reconcileStale quarantines stale reservations that already dispatched", async () => {
  const { query, user } = await billingFixture();
  const store = createBeaconBillingStore(query);
  await query(
    `INSERT INTO ai_requests (request_id, user_id, api_key_id, request_fingerprint, public_model,
                              pricing_revision, pricing_snapshot, dispatched_at)
     VALUES ('req_stale_dispatched', ?, ?, ?, 'beacon-test-model', 'pricing-v1', '{}', ?)`,
    [user.id, "22", fingerprint, new Date().toISOString()],
  );
  await query(
    `INSERT INTO ai_billing_reservations (ai_request_id, request_id, user_id, reserved_usd_micros, state, expires_at)
     VALUES (1, 'req_stale_dispatched', ?, 8, 'reserved', '2020-01-01T00:00:00.000Z')`,
    [user.id],
  );

  const outcomes = await store.reconcileStale();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].requestId, "req_stale_dispatched");
  assert.equal(outcomes[0].reservationState, "needs_reconciliation");
  assert.equal(outcomes[0].errorCode, "reservation_expired_after_dispatch");

  // 已派發的保留單進入隔離(而非直接退款):保留原狀以利人工調查,
  // 由 resolveQuarantined 提供自動退款出口;餘額不變。
  const reservation = await query(
    `SELECT state FROM ai_billing_reservations WHERE request_id = 'req_stale_dispatched'`,
  );
  assert.equal(reservation.rows[0].state, "needs_reconciliation");
  const account = await query(`SELECT balance_usd_micros FROM users WHERE id = ?`, [user.id]);
  assert.equal(Number(account.rows[0].balance_usd_micros), 1_000_000);
});

test("reconcileStale refunds stale reservations that never dispatched", async () => {
  const { query, user } = await billingFixture();
  const store = createBeaconBillingStore(query);
  await query(
    `INSERT INTO ai_requests (request_id, user_id, api_key_id, request_fingerprint, public_model,
                              pricing_revision, pricing_snapshot)
     VALUES ('req_stale_reserved', ?, ?, ?, 'beacon-test-model', 'pricing-v1', '{}')`,
    [user.id, "22", fingerprint],
  );
  await query(
    `INSERT INTO ai_billing_reservations (ai_request_id, request_id, user_id, reserved_usd_micros, state, expires_at)
     VALUES (1, 'req_stale_reserved', ?, 8, 'reserved', '2020-01-01T00:00:00.000Z')`,
    [user.id],
  );

  const outcomes = await store.reconcileStale();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].requestId, "req_stale_reserved");
  assert.equal(outcomes[0].reservationState, "refunded");
  assert.equal(outcomes[0].errorCode, "reservation_expired");
  assert.equal(outcomes[0].httpStatus, 504);

  const reservation = await query(
    `SELECT state FROM ai_billing_reservations WHERE request_id = 'req_stale_reserved'`,
  );
  assert.equal(reservation.rows[0].state, "refunded");
  // 未派發即過期:保留額全數退回使用者的消費上限(fixture 直接插入保留單,
  // 未經 reserve 扣款,故退款為餘額 +8)。
  const account = await query(`SELECT balance_usd_micros FROM users WHERE id = ?`, [user.id]);
  assert.equal(Number(account.rows[0].balance_usd_micros), 1_000_008);
  const ledger = await query(
    `SELECT transaction_type, amount FROM ledger_entries WHERE idempotency_key = 'req_stale_reserved'`,
  );
  assert.equal(ledger.rows[0].transaction_type, "ai_usage_refund");
  assert.equal(ledger.rows[0].amount, "8");
});
