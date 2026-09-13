import { dbQuery } from "../utils/db.ts";

// 限流分兩層:
// 1. 預設路徑:PostgreSQL 固定窗口計數,跨 Worker isolate 全域生效。
// 2. 降級路徑:環境未設定 DATABASE_URL,或資料庫查詢失敗時,退回 in-isolate
//    記憶體窗口。記憶體桶滿時只淘汰過期桶,新身份直接 429——不再整表清除,
//    避免攻擊者藉桶上限把既有計數一次歸零。
//
// 資料庫失敗時選擇 fail-open:登入/註冊本身仍需資料庫才能成功,限流器降級
// 不會額外放大攻擊面,卻能避免一次 DB 抖動把所有真實使用者擋在門外。

interface WindowBucket {
  hits: number[];
}

const MAX_TRACKED_KEYS = 10_000;

const memoryBuckets = new Map<string, WindowBucket>();

// 資料表 `beacon_ip_rate_limit_windows` 由 schema migration v7 建立(schema
// 只進不退的治理規則),limiter 本身不做 DDL。

export const BEACON_IP_RATE_LIMIT_SQL = Object.freeze({
  // 同一窗口內累加;窗口滾動後歸零重計。RETURNING 的 hit_count 即本窗口
  // 已含本次請求的總數,由呼叫端與 max 比較。
  increment: `
    INSERT INTO beacon_ip_rate_limit_windows (identity, window_start, hit_count)
    VALUES (?, ?, 1)
    ON CONFLICT (identity) DO UPDATE
    SET window_start = EXCLUDED.window_start,
        hit_count = CASE
          WHEN beacon_ip_rate_limit_windows.window_start = EXCLUDED.window_start
          THEN beacon_ip_rate_limit_windows.hit_count + 1
          ELSE 1
        END
    RETURNING hit_count
  `,
  // 淘汰已滾出窗口的舊身份;在計數恰好歸零重計時觸發,頻率隨流量自適應。
  sweep: `
    DELETE FROM beacon_ip_rate_limit_windows
    WHERE window_start < ?
  `,
});

// 純 DB 計數器,抽出以便測試注入假 query。
export function createDbWindowStore(query: any) {
  return {
    async increment(identity: string, windowStartIso: string, sweepBeforeIso: string): Promise<number> {
      const result = await query(BEACON_IP_RATE_LIMIT_SQL.increment, [identity, windowStartIso]);
      const hitCount = Number(result?.rows?.[0]?.hit_count || 0);
      if (hitCount === 1) {
        try {
          await query(BEACON_IP_RATE_LIMIT_SQL.sweep, [sweepBeforeIso]);
        } catch {
          // 掃描失敗不影響本次計數判斷。
        }
      }
      return hitCount;
    },
  };
}

function windowStartIso(now: number, windowMs: number): string {
  return new Date(Math.floor(now / windowMs) * windowMs).toISOString();
}

function databaseConfigured(env: any): boolean {
  return Boolean(String(env?.POSTGRES_DB_URL || env?.DATABASE_URL || "").trim());
}

function identityKey(prefix: string, identity: string): string {
  return `${prefix}:${identity}`;
}

const dbStores = new Map<string, ReturnType<typeof createDbWindowStore>>();

function memoryReject(bucket: WindowBucket, now: number, windowMs: number, max: number): number | null {
  bucket.hits = bucket.hits.filter((timestamp) => now - timestamp < windowMs);
  if (bucket.hits.length >= max) {
    return Math.max(1, Math.ceil((bucket.hits[0] + windowMs - now) / 1000));
  }
  return null;
}

export function createRateLimit(options: {
  keyPrefix: string;
  windowMs: number;
  max: number;
  distributed?: boolean;
  keyGenerator?: (c: any) => string;
}) {
  const windowMs = Math.max(1000, options.windowMs);
  const max = Math.max(1, options.max);

  return async (c: any, next: any) => {
    const identity = options.keyGenerator ? String(options.keyGenerator(c) || "anonymous") : "global";
    const key = identityKey(options.keyPrefix, identity);
    const now = Date.now();

    if (databaseConfigured(c.env)) {
      try {
        // limiter 在模組載入期建構,env 要等請求才有;以資料庫 URL 為鍵快取 store。
        const dbUrl = String(c.env?.POSTGRES_DB_URL || c.env?.DATABASE_URL).trim();
        let dbStore = dbStores.get(dbUrl);
        if (!dbStore) {
          dbStore = createDbWindowStore((sql: string, params: any[] = []) => dbQuery(c.env, sql, params));
          dbStores.set(dbUrl, dbStore);
        }
        const start = windowStartIso(now, windowMs);
        const hitCount = await dbStore.increment(
          key,
          start,
          new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        );
        if (hitCount > max) {
          c.header(
            "Retry-After",
            String(Math.max(1, Math.ceil((Math.floor(now / windowMs) * windowMs + windowMs - now) / 1000))),
          );
          return c.json(
            {
              error: "Too many requests. Please try again later.",
              code: "rate_limit_exceeded",
            },
            429,
          );
        }
        await next();
        return;
      } catch (error: any) {
        console.error(
          "Distributed rate limit unavailable, falling back to in-isolate window:",
          error?.code || error?.name || "unknown",
        );
        // 落到下面的記憶體降級路徑。
      }
    }

    let bucket = memoryBuckets.get(key);
    if (!bucket) {
      // 避免無界成長:超過追蹤上限時清掉過期 bucket;仍滿時對「新」身份
      // 直接 429,既有計數保持不變。
      if (memoryBuckets.size >= MAX_TRACKED_KEYS) {
        for (const [existingKey, existingBucket] of memoryBuckets) {
          if (existingBucket.hits.length === 0 || now - existingBucket.hits[0] > windowMs) {
            memoryBuckets.delete(existingKey);
          }
        }
        if (memoryBuckets.size >= MAX_TRACKED_KEYS) {
          c.header("Retry-After", String(Math.ceil(windowMs / 1000)));
          return c.json(
            {
              error: "Too many requests. Please try again later.",
              code: "rate_limit_exceeded",
            },
            429,
          );
        }
      }
      bucket = { hits: [] };
      memoryBuckets.set(key, bucket);
    }

    const retryAfterSeconds = memoryReject(bucket, now, windowMs, max);
    if (retryAfterSeconds !== null) {
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json(
        {
          error: "Too many requests. Please try again later.",
          code: "rate_limit_exceeded",
        },
        429,
      );
    }

    bucket.hits.push(now);
    await next();
  };
}

export function resetRateLimitsForTests(): void {
  memoryBuckets.clear();
}
