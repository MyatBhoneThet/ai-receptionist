import rateLimit from 'express-rate-limit';

// Custom rate limit exceeded handler — returns JSON instead of HTML.
const rateLimitHandler = (req, res) => {
    res.status(429).json({
        error: 'Too many requests. Please slow down and try again later.',
        retryAfter: Math.ceil(req.rateLimit.resetTime / 1000 - Date.now() / 1000),
    });
};

// Global limiter — applied to all routes. 100 requests per 15 minutes per IP.
export const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,  // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false,   // Disable `X-RateLimit-*` headers
    message: 'Too many requests from this IP, please try again after 15 minutes.',
    handler: rateLimitHandler,
});

// Chat limiter — stricter limit on the LLM route to prevent token abuse. 20 requests per minute per IP.
export const chatLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many chat requests. Please wait a moment before sending another message.',
    handler: rateLimitHandler,
});

// Bookings limiter — moderate limit on CRUD booking operations. 30 requests per minute per IP.
export const bookingsLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many booking requests. Please try again in a moment.',
    handler: rateLimitHandler,
});
