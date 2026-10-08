// Runs before every test file. Tests ALWAYS use the disposable test database,
// whatever DATABASE_URL the developer's .env points at.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/ai_receptionist_test';
const databaseName = new URL(TEST_DATABASE_URL).pathname.slice(1);
if (!/test/i.test(databaseName)) {
  throw new Error(`Refusing to run tests against "${databaseName}". TEST_DATABASE_URL must name a database containing "test".`);
}
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
// The older customer-phone migration test runs in its own rolled-back schema.
process.env.CUSTOMER_PHONE_MIGRATION_TEST_DATABASE_URL = process.env.CUSTOMER_PHONE_MIGRATION_TEST_DATABASE_URL || TEST_DATABASE_URL;
process.env.SESSION_SIGNING_SECRET = 'test-session-secret';
process.env.INTEGRATION_ENCRYPTION_KEY = 'test-integration-encryption-key-0123456789';
process.env.USE_APP_SETTINGS_QUERY_IN_TEST = 'true';
// Tests never reach real customers or real calendars.
for (const key of ['SMTP_HOST', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'STAFF_WEBHOOK_URL', 'STAFF_ALERT_EMAIL',
  'GOOGLE_CALENDAR_ID', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'ALLOW_PUBLIC_ADMIN_ACCESS', 'ADMIN_TOKEN', 'DEFAULT_BUSINESS_SLUG']) {
  process.env[key] = '';
}
