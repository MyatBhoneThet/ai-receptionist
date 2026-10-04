import 'dotenv/config';

const base = process.env.SMOKE_BASE_URL || 'http://localhost:4000';

async function main() {
  const health = await fetch(`${base}/health`).then((r) => r.json());
  console.log('Health:', health.status, health.uptime ? 'ok' : 'missing uptime');
  if (health.status !== 'ok') {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
