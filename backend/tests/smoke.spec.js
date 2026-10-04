import 'dotenv/config';
import request from 'supertest';
import app from '../index.js';

const skipNet = process.env.NO_LISTEN === 'true';

(skipNet ? describe.skip : describe)('Smoke', () => {
  it('health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
