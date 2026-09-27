// SQL 方言抽離:core 的 store SQL 在 SQLite(node:sqlite、DO storage.sql)與
// PostgreSQL 之間共用。兩者的差異點集中在極值函式與 JSON 陣列展開:
// - 極值:PostgreSQL 的 MIN()/MAX() 只有聚合形式,雙參數純量比較必須用
//   LEAST()/GREATEST();SQLite 恰好相反——雙參數 MIN()/MAX() 是核心純量
//   函式,而 node:sqlite 未編入 SQLITE_ENABLE_MATH_FUNCTIONS,LEAST()/
//   GREATEST() 不可用(見 billing settle 的歷史註解)。
// - JSON 陣列參數(綁定 JSON.stringify 後的字串):SQLite 用 json_each(?),
//   PostgreSQL 用 json_array_elements_text(?::json)。
//
// dialect 由 query 契約攜帶(query.dialect,見 query.ts);未標註一律視為
// SQLite——現有 Node/DO adapter 與全部測試替身都不帶此欄位,行為不變。
export interface AkentrosSqlDialect {
  /** 兩參數極值函式名(SQLite: MIN,PostgreSQL: LEAST)。 */
  readonly min: "MIN" | "LEAST";
  /** 兩參數極值函式名(SQLite: MAX,PostgreSQL: GREATEST)。 */
  readonly max: "MAX" | "GREATEST";
  /** 把「綁定為 JSON 字串的陣列參數」展開成單欄(value)文字列的子查詢。 */
  readonly jsonValues: string;
  /** SELECT 尾端的悲觀行鎖子句。SQLite 以 BEGIN IMMEDIATE 單寫者序列化,
   * 不需要(也不支援)FOR UPDATE;PostgreSQL 在 READ COMMITTED 下必須對
   * 金錢路徑讀取的餘額/預算列加鎖,否則併發保留單會以過期讀值做拒絕判定。 */
  readonly rowLock: "" | "FOR UPDATE";
  /** 交易內對「每實體序列化」的 advisory 鎖語句(參數綁定實體 id);
   * SQLite 空字串(交易起點已獨佔寫鎖)。PostgreSQL 用 pg_advisory_xact_lock
   * 補齊 provider pool claim 與 key RPM/併發 acquire 的「讀—判—寫」原子性;
   * 實體 id 可能是非數字字串(credential pool id),統一以 hashtext 雜湊。 */
  readonly claimLock: string;
}

const SQLITE_DIALECT: AkentrosSqlDialect = Object.freeze({
  min: "MIN",
  max: "MAX",
  jsonValues: "SELECT value FROM json_each(?)",
  rowLock: "",
  claimLock: "",
});

const POSTGRES_DIALECT: AkentrosSqlDialect = Object.freeze({
  min: "LEAST",
  max: "GREATEST",
  jsonValues: "SELECT value::text FROM json_array_elements_text(?::json)",
  rowLock: "FOR UPDATE",
  claimLock: "SELECT pg_advisory_xact_lock(hashtext(?))",
});

export function sqlDialect(query?: { dialect?: "postgres" | "sqlite" }): AkentrosSqlDialect {
  return query?.dialect === "postgres" ? POSTGRES_DIALECT : SQLITE_DIALECT;
}
