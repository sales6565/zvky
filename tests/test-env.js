/* Loaded before every test file (npm test: node --test --require) and by tests/helpers.js.
 *
 * App modules a test loads in its own process (src/db, through src/permissions and
 * many others) read DB_* when first required, and db.js exits when they are missing.
 * Point them at the test server named by TEST_DB_* (falling back to DB_*), so a test
 * never picks up a developer's .env or a real database; without a test database, set
 * harmless names, so a file whose tests are skipped still loads instead of exiting.
 * Servers a test starts get their own settings from startServer() in helpers.js.
 */
const base = process.env.TEST_DB_NAME;
if (base) {
  Object.assign(process.env, {
    DB_HOST: process.env.TEST_DB_HOST || process.env.DB_HOST || '127.0.0.1',
    DB_PORT: String(process.env.TEST_DB_PORT || process.env.DB_PORT || 3306),
    DB_USER: process.env.TEST_DB_USER || process.env.DB_USER || '',
    DB_PASSWORD: process.env.TEST_DB_PASSWORD || process.env.DB_PASSWORD || '',
    DB_NAME: base,
  });
} else {
  for (const k of ['DB_NAME', 'DB_USER']) if (!process.env[k]) process.env[k] = 'zvky_test_not_configured';
}
delete process.env.DATABASE_URL;
