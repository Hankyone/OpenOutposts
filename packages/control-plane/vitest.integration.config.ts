import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "path";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";

const migrationsPath = path.resolve(__dirname, "../../terraform/d1/migrations");

// Pin luxon to its CommonJS build. vite 8 resolves luxon via the "import"
// condition to its ESM build, but cron-parser (a CJS transitive dep of
// @open-inspect/shared, used by the scheduler's nextCronOccurrence) reads it as
// `require("luxon").DateTime`. Under @cloudflare/vitest-pool-workers that
// CJS->ESM interop yields `undefined`, so the scheduler tick throws "Cannot read
// properties of undefined (reading 'DateTime')" and silently skips every overdue
// automation (see scheduler.test.ts /internal/tick). vite 7 used the CJS build,
// which interops correctly. Test-only — production bundles via esbuild/wrangler.
const luxonCjsEntry = createRequire(__filename).resolve("luxon");

/** Generate a random base64-encoded 32-byte AES key for tests. */
function generateTestEncryptionKey(): string {
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(key).toString("base64");
}

// vitest 4 / @cloudflare/vitest-pool-workers v0.16 replaced the
// `defineWorkersConfig` + `test.poolOptions.workers` setup with the
// `cloudflareTest()` Vite plugin, configured via `defineConfig` from
// "vitest/config". The old `singleWorker`/`isolatedStorage` poolOptions are not
// configured here; pool-workers isolates D1 storage per test FILE, so files run
// in parallel without cross-file interference. Within a file, tests share one D1
// instance and rely on explicit `cleanD1Tables()` cleanup (see
// test/integration/cleanup.ts) for isolation.
export default defineConfig({
  resolve: {
    alias: {
      luxon: luxonCjsEntry,
    },
  },
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(migrationsPath);

      return {
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          bindings: {
            // Still used by the outpost/homestead WebSocket handshakes, which sign
            // internal tokens with it.
            INTERNAL_CALLBACK_SECRET: "test-hmac-secret-for-integration-tests",
            OUTPOST_ENROLLMENT_TOKEN: "test-outpost-enrollment-token",
            // Pin the execution backend so a developer's .dev.vars (which
            // wrangler merges into the test env) cannot flip session tests
            // onto something else. There is only one backend.
            SANDBOX_PROVIDER: "outpost",
            OUTPOST_TARGET_ID: "integration-outpost",
            OUTPOST_TARGET_WORKSPACE_ROOT: "/srv/workspaces",
            WORKER_URL: "",
            SERVICE_AUTH_SECRET_WEB: "test-service-secret-web",
            SERVICE_AUTH_SECRET_SLACK_BOT: "test-service-secret-slack-bot",
            SERVICE_AUTH_SECRET_GITHUB_BOT: "test-service-secret-github-bot",
            SERVICE_AUTH_SECRET_LINEAR_BOT: "test-service-secret-linear-bot",
            SERVICE_AUTH_SECRET_HOMESTEAD: "test-service-secret-homestead",
            SERVICE_AUTH_SECRET_MODAL: "test-service-secret-modal",
            // Must be valid base64 for 32 bytes — the exchange route's SCM
            // capture encrypts with it inline (fail-closed) rather than
            // inside a swallowed waitUntil.
            TOKEN_ENCRYPTION_KEY: generateTestEncryptionKey(),
            REPO_SECRETS_ENCRYPTION_KEY: generateTestEncryptionKey(),
            DEPLOYMENT_NAME: "integration-test",
            SLACK_BOT_TOKEN: "xoxb-test-integration",
            WEB_APP_URL: "https://app.test.local",
            APP_NAME: "OpenOutposts",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    include: ["test/integration/**/*.test.ts"],
    setupFiles: ["test/integration/apply-migrations.ts"],
  },
});
