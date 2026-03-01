import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import chatRouter from './routes/chat.js';
import bookingsRouter from './routes/bookings.js';

const app = express();
const PORT = process.env.PORT || 4000;

// ✅ Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' })); // prevent huge payload abuse

// ✅ Routes
app.use('/api/chat', chatRouter);
app.use('/api/bookings', bookingsRouter);

// ✅ Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ❗ 404 handler (missing in your version)
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ❗ Global error handler (improved)
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.stack || err);

  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// ❗ Handle crashes (VERY important for production)
process.on('unhandledRejection', (err) => {
  console.error('[Unhandled Rejection]', err);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

app.listen(PORT, () => {
  console.log(`✅ AI Receptionist backend running on http://localhost:${PORT}`);
});