import { Database } from "bun:sqlite";
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import worker from "../../src/index";
import { hashPassword } from "../../src/utils/auth";
const dir = resolve(homedir(), ".codex/attachments/tirak-local-support-20261020");
mkdirSync(dir, { recursive: true, mode: 448 });
const dbPath = resolve(dir, "support.sqlite");
const credentialsPath = resolve(dir, "operator.json");
const fresh = !existsSync(dbPath);
const sqlite = new Database(dbPath);
chmodSync(dbPath, 384);
if (fresh) {
  const migrations = ["baseline/canonical-baseline.sql", "010_booking_chat_expansion.sql", "012_supplier_onboarding.sql", "013_supplier_onboarding_review.sql", "015_account_trust.sql", "017_core_guide_management.sql", "019_password_reset_consumptions.sql", "020_core_onboarding_lifecycle.sql", "021_evidence_interest_cohort.sql", "022_core_booking_idempotency.sql", "023_core_customer_registration_fields.sql", "024_core_api_repairs.sql", "025_core_booking_mobile_fields.sql", "026_core_notification_prerequisites.sql", "027_core_support_requests.sql", "028_core_acquisition.sql"];
  for (const name of migrations)
    sqlite.exec(readFileSync(resolve("migrations", name), "utf8"));
  const credentials = { email: "launch-admin@example.invalid", password: crypto.randomUUID() + "Aa!9" };
  const hash = await hashPassword(credentials.password);
  sqlite.query("INSERT INTO users (id,email,phone,password_hash,user_type,status,email_verified,phone_verified) VALUES (?,?,?,?,?,?,1,1)").run("123e4567-e89b-12d3-a456-426614174088", credentials.email, "+66000000088", hash, "admin", "active");
  writeFileSync(credentialsPath, JSON.stringify(credentials), { mode: 384 });
}
// Local additive migration; safe for the existing synthetic database, never a remote target.
sqlite.exec(readFileSync(resolve("migrations/028_core_acquisition.sql"), "utf8"));
if (!sqlite.query("PRAGMA table_info(core_support_requests)").all().some(column => column.name === 'revision')) {
  sqlite.exec(readFileSync(resolve("migrations/029_core_support_review.sql"), "utf8"));
}
if (!sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='core_support_notification_outbox'").get()) {
  sqlite.exec(readFileSync(resolve("migrations/030_core_support_notifications.sql"), "utf8"));
}
const db = {
  prepare(sql) {
    const statement = (values = []) => ({
      bind: (...params) => statement(params),
      first: async (column) => {
        const row = sqlite.query(sql).get(...values);
        return column ? row?.[column] ?? null : row;
      },
      all: async () => ({ success: true, results: sqlite.query(sql).all(...values) }),
      run: async () => ({ success: true, meta: { changes: sqlite.query(sql).run(...values).changes } })
    });
    return statement();
  },
  exec: async (sql) => {
    sqlite.exec(sql);
    return { success: true };
  },
  async batch(statements) {
    sqlite.exec("BEGIN");
    try {
      const rows = [];
      for (const statement of statements)
        rows.push(await statement.run());
      sqlite.exec("COMMIT");
      return rows;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
};
function kv() {
  const values = new Map;
  return { get: async (key) => values.get(key) ?? null, put: async (key, value) => {
    values.set(key, value);
  }, delete: async (key) => {
    values.delete(key);
  } };
}
const queue = { send: async () => {}, sendBatch: async () => {} };
const env = {
  DB: db,
  CACHE: kv(),
  SESSIONS: kv(),
  ENVIRONMENT: "local-support-verification",
  JWT_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  FRONTEND_URLS: "http://127.0.0.1:4341,http://127.0.0.1:4342",
  EMAIL_PROVIDER: "disabled",
  PAYMENT_MODE: "disabled",
  PROMPTPAY_ENABLED: "false",
  PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED: "false",
  ANALYTICS_QUEUE: queue,
  NOTIFICATION_QUEUE: queue,
  MODERATION_QUEUE: queue
};
Bun.serve({
  hostname: "127.0.0.1",
  port: 4340,
  fetch(request) {
    return worker.fetch(request, env, { waitUntil(promise) {
      promise.catch(() => {});
    } });
  }
});
console.log(JSON.stringify({ environment: env.ENVIRONMENT, port: 4340, database: dbPath, credentialFile: credentialsPath, remoteProviders: "disabled" }));
