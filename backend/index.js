import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { globalLimiter } from './middleware/rateLimiter.js';

import chatRouter from './routes/chat.js';
import bookingsRouter from './routes/bookings.js';

const app = express();
const PORT = process.env.PORT || 4000;

// Security headers (Helmet sets X-Frame-Options, X-Content-Type-Options,
// Strict-Transport-Security, Content-Security-Policy, Referrer-Policy, etc.)
app.use(helmet());

// ── CORS — only allow requests from the configured frontend origin
const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:3000';
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// Global rate limiter (100 req / 15 min per IP) — applied before all routes
app.use(globalLimiter);

// Body size guard
app.use(express.json({ limit: '1mb' }));

// Routes
app.use('/api/chat', chatRouter);
app.use('/api/bookings', bookingsRouter);

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

app.listen(PORT, () => {
  console.log(`✅ AI Receptionist backend running on http://localhost:${PORT}`);
});