import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { globalLimiter } from './middleware/rateLimiter.js';

import chatRouter from './routes/chat.js';
import bookingsRouter from './routes/bookings.js';
import analyticsRouter from './routes/analytics.js';
import usersRouter from './routes/users.js';
import availabilityRouter from './routes/availability.js';
import inventoryRouter from './routes/inventory.js';
import settingsRouter from './routes/settings.js';
import { autoSeedInventory } from './services/autoSeedInventory.js';

const app = express();
const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || null;

function formatListenUrl(listenHost, port) {
  if (!listenHost || listenHost === '::' || listenHost === '0.0.0.0') {
    return `http://localhost:${port}`;
  }
  return `http://${listenHost}:${port}`;
}

app.disable('x-powered-by');

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Security headers (Helmet sets X-Frame-Options, X-Content-Type-Options,
// Strict-Transport-Security, Content-Security-Policy, Referrer-Policy, etc.)
app.use(helmet());

// ── CORS — only allow requests from the configured frontend origin
const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:3000';
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Session-Id',
      'X-Session-Token',
      'X-Admin-Token',
    ],
    credentials: true,
  })
);
app.use(cookieParser());

// Global rate limiter (100 req / 15 min per IP) — applied before all routes
app.use(globalLimiter);

// Body size guard
app.use(express.json({ limit: '1mb' }));

// Routes
app.use('/api/chat', chatRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/users', usersRouter);
app.use('/api/availability', availabilityRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/settings', settingsRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// 404 handler (missing in your version)
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler (improved)
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.stack || err);

  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// Handle crashes (VERY important for production)
process.on('unhandledRejection', (err) => {
  console.error('[Unhandled Rejection]', err);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

if (process.env.NODE_ENV !== 'test') {
  const bindCandidates = Array.from(
    new Set([
      HOST,
      process.env.NODE_ENV === 'production' ? '0.0.0.0' : '::',
      '127.0.0.1',
    ].filter(Boolean))
  );

  const startServer = (hostIndex = 0) => {
    const listenHost = bindCandidates[hostIndex];
    const server = app.listen(PORT, listenHost, () => {
      console.log(`✅ AI Receptionist backend running on ${formatListenUrl(listenHost, PORT)}`);
      console.log(`   FRONTEND_URL=${ALLOWED_ORIGIN}`);
      if (process.env.AUTO_SEED_INVENTORY === 'true' && process.env.NODE_ENV !== 'production') {
        autoSeedInventory().catch((err) => console.error('[autoSeedInventory]', err));
      }
    });

    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        if (hostIndex < bindCandidates.length - 1) {
          console.warn(`⚠️  Port ${PORT} is busy on ${listenHost || 'default bind'}, trying next host...`);
          return startServer(hostIndex + 1);
        }
        console.error(`❌ Port ${PORT} is already in use. Stop the existing process or set a different PORT in backend/.env.`);
        process.exit(1);
      }

      if (err && err.code === 'EPERM') {
        if (hostIndex < bindCandidates.length - 1) {
          console.warn(`⚠️  Cannot bind to ${listenHost || 'default bind'}:${PORT} here, trying next host...`);
          return startServer(hostIndex + 1);
        }
        console.error(`❌ Cannot bind to any fallback host on port ${PORT}. Check local security/firewall settings.`);
        process.exit(1);
      }

      console.error('[Server Listen Error]', err);
      process.exit(1);
    });
  };

  startServer();
}

export default app;
