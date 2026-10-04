import express from 'express';
import { z } from 'zod';
import { query } from '../services/db.js';
import { requireAdminToken } from '../middleware/auth.js';
import { recordAuditLog } from '../services/appSettings.js';

const router = express.Router();
router.use(requireAdminToken);

// ── Helper to find category by ID ────────────────────────────────────────

async function findCategoryById(id) {
  let res = await query('SELECT id FROM hotel_rooms WHERE id = $1', [id]);
  if (res.rows.length > 0) return 'room';
  res = await query('SELECT id FROM restaurant_tables WHERE id = $1', [id]);
  if (res.rows.length > 0) return 'table';
  res = await query('SELECT id FROM meeting_rooms WHERE id = $1', [id]);
  if (res.rows.length > 0) return 'meeting';
  return null;
}

// ============================================================
// UNIFIED INVENTORY ENDPOINTS
// ============================================================

// GET / — Unified list of all inventory items
router.get('/', async (_req, res) => {
  try {
    const rooms = await query('SELECT * FROM hotel_rooms ORDER BY room_number ASC');
    const tables = await query('SELECT * FROM restaurant_tables ORDER BY table_number ASC');
    const meetings = await query('SELECT * FROM meeting_rooms ORDER BY room_code ASC');

    const unified = [
      ...rooms.rows.map(r => ({
        id: r.id,
        category: 'room',
        code: r.room_number,
        name: r.room_type,
        capacity: r.capacity,
        quantity: 1,
        metadata: { floor: r.floor, price_per_night: r.price_per_night, amenities: r.amenities }
      })),
      ...tables.rows.map(t => ({
        id: t.id,
        category: 'table',
        code: t.table_number,
        name: t.location,
        capacity: t.capacity,
        quantity: 1,
        metadata: { location: t.location }
      })),
      ...meetings.rows.map(m => ({
        id: m.id,
        category: 'meeting',
        code: m.room_code,
        name: m.room_name,
        capacity: m.capacity,
        quantity: 1,
        metadata: m.equipment
      }))
    ];
    res.json(unified);
  } catch (err) {
    console.error('[GET /api/inventory]', err);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// POST / — Unified insert/upsert
router.post('/', async (req, res) => {
  const { category, code, name, capacity = 0, quantity = 1, metadata = {} } = req.body;
  if (!category || !code) {
    return res.status(400).json({ error: 'category and code are required' });
  }

  try {
    let insertedRow;
    if (category === 'room') {
      const result = await query(
        `INSERT INTO hotel_rooms (room_number, room_type, floor, capacity, price_per_night, amenities)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (room_number) DO UPDATE SET
           room_type = EXCLUDED.room_type,
           floor = EXCLUDED.floor,
           capacity = EXCLUDED.capacity,
           price_per_night = EXCLUDED.price_per_night,
           amenities = EXCLUDED.amenities,
           updated_at = NOW()
         RETURNING *`,
        [code, name || 'Standard', metadata.floor || null, capacity, metadata.price_per_night || null, metadata.amenities || {}]
      );
      insertedRow = result.rows[0];
    } else if (category === 'table') {
      const result = await query(
        `INSERT INTO restaurant_tables (table_number, capacity, location)
         VALUES ($1, $2, $3)
         ON CONFLICT (table_number) DO UPDATE SET
           capacity = EXCLUDED.capacity,
           location = EXCLUDED.location,
           updated_at = NOW()
         RETURNING *`,
        [code, capacity, metadata.location || 'indoor']
      );
      insertedRow = result.rows[0];
    } else if (category === 'meeting') {
      const result = await query(
        `INSERT INTO meeting_rooms (room_code, room_name, capacity, equipment)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_code) DO UPDATE SET
           room_name = EXCLUDED.room_name,
           capacity = EXCLUDED.capacity,
           equipment = EXCLUDED.equipment,
           updated_at = NOW()
         RETURNING *`,
        [code, name || 'Meeting Room', capacity, metadata]
      );
      insertedRow = result.rows[0];
    } else {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const responseItem = {
      id: insertedRow.id,
      category,
      code,
      name: category === 'room' ? insertedRow.room_type : (category === 'table' ? insertedRow.location : insertedRow.room_name),
      capacity: insertedRow.capacity,
      quantity: 1,
      metadata: category === 'room' ? { floor: insertedRow.floor, price_per_night: insertedRow.price_per_night, amenities: insertedRow.amenities } : (category === 'table' ? { location: insertedRow.location } : insertedRow.equipment)
    };

    await recordAuditLog({
      actorEmail: req.user?.email || 'admin',
      action: 'upsert',
      entity: 'inventory',
      beforeState: {},
      afterState: responseItem,
    });

    res.json(responseItem);
  } catch (err) {
    console.error('[POST /api/inventory]', err);
    res.status(500).json({ error: 'Failed to upsert inventory item' });
  }
});

// PATCH /:id — Unified update
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const category = await findCategoryById(id);
  if (!category) return res.status(404).json({ error: 'Item not found' });

  const { code, name, capacity, quantity, metadata } = req.body;

  try {
    let beforeState = {};
    let updatedRow;

    if (category === 'room') {
      const beforeRes = await query('SELECT * FROM hotel_rooms WHERE id = $1', [id]);
      beforeState = beforeRes.rows[0] || {};
      
      const updates = [];
      const values = [];
      let idx = 1;
      
      if (code !== undefined) { updates.push(`room_number = $${idx++}`); values.push(code); }
      if (name !== undefined) { updates.push(`room_type = $${idx++}`); values.push(name); }
      if (capacity !== undefined) { updates.push(`capacity = $${idx++}`); values.push(capacity); }
      if (metadata && metadata.floor !== undefined) { updates.push(`floor = $${idx++}`); values.push(metadata.floor); }
      if (metadata && metadata.price_per_night !== undefined) { updates.push(`price_per_night = $${idx++}`); values.push(metadata.price_per_night); }
      if (metadata && metadata.amenities !== undefined) { updates.push(`amenities = $${idx++}`); values.push(metadata.amenities); }

      if (updates.length > 0) {
        values.push(id);
        const result = await query(
          `UPDATE hotel_rooms SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
          values
        );
        updatedRow = result.rows[0];
      } else {
        updatedRow = beforeState;
      }
    } else if (category === 'table') {
      const beforeRes = await query('SELECT * FROM restaurant_tables WHERE id = $1', [id]);
      beforeState = beforeRes.rows[0] || {};

      const updates = [];
      const values = [];
      let idx = 1;

      if (code !== undefined) { updates.push(`table_number = $${idx++}`); values.push(code); }
      if (capacity !== undefined) { updates.push(`capacity = $${idx++}`); values.push(capacity); }
      if (name !== undefined) { updates.push(`location = $${idx++}`); values.push(name); }
      if (metadata && metadata.location !== undefined) { updates.push(`location = $${idx++}`); values.push(metadata.location); }

      if (updates.length > 0) {
        values.push(id);
        const result = await query(
          `UPDATE restaurant_tables SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
          values
        );
        updatedRow = result.rows[0];
      } else {
        updatedRow = beforeState;
      }
    } else if (category === 'meeting') {
      const beforeRes = await query('SELECT * FROM meeting_rooms WHERE id = $1', [id]);
      beforeState = beforeRes.rows[0] || {};

      const updates = [];
      const values = [];
      let idx = 1;

      if (code !== undefined) { updates.push(`room_code = $${idx++}`); values.push(code); }
      if (name !== undefined) { updates.push(`room_name = $${idx++}`); values.push(name); }
      if (capacity !== undefined) { updates.push(`capacity = $${idx++}`); values.push(capacity); }
      if (metadata !== undefined) { updates.push(`equipment = $${idx++}`); values.push(metadata); }

      if (updates.length > 0) {
        values.push(id);
        const result = await query(
          `UPDATE meeting_rooms SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
          values
        );
        updatedRow = result.rows[0];
      } else {
        updatedRow = beforeState;
      }
    }

    const responseItem = {
      id: updatedRow.id,
      category,
      code: category === 'room' ? updatedRow.room_number : (category === 'table' ? updatedRow.table_number : updatedRow.room_code),
      name: category === 'room' ? updatedRow.room_type : (category === 'table' ? updatedRow.location : updatedRow.room_name),
      capacity: updatedRow.capacity,
      quantity: 1,
      metadata: category === 'room' ? { floor: updatedRow.floor, price_per_night: updatedRow.price_per_night, amenities: updatedRow.amenities } : (category === 'table' ? { location: updatedRow.location } : updatedRow.equipment)
    };

    await recordAuditLog({
      actorEmail: req.user?.email || 'admin',
      action: 'update',
      entity: 'inventory',
      beforeState,
      afterState: responseItem,
    });

    res.json(responseItem);
  } catch (err) {
    console.error('[PATCH /api/inventory/:id]', err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// DELETE /:id — Unified delete
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const category = await findCategoryById(id);
  if (!category) return res.status(404).json({ error: 'Item not found' });

  try {
    let beforeState = {};
    if (category === 'room') {
      const beforeRes = await query('SELECT * FROM hotel_rooms WHERE id = $1', [id]);
      beforeState = beforeRes.rows[0] || {};
      await query('DELETE FROM hotel_rooms WHERE id = $1', [id]);
    } else if (category === 'table') {
      const beforeRes = await query('SELECT * FROM restaurant_tables WHERE id = $1', [id]);
      beforeState = beforeRes.rows[0] || {};
      await query('DELETE FROM restaurant_tables WHERE id = $1', [id]);
    } else if (category === 'meeting') {
      const beforeRes = await query('SELECT * FROM meeting_rooms WHERE id = $1', [id]);
      beforeState = beforeRes.rows[0] || {};
      await query('DELETE FROM meeting_rooms WHERE id = $1', [id]);
    }

    await recordAuditLog({
      actorEmail: req.user?.email || 'admin',
      action: 'delete',
      entity: 'inventory',
      beforeState,
      afterState: {},
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/inventory/:id]', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// ============================================================
// TYPED RESOURCE SUB-ROUTES (Optionally used by internal clients)
// ============================================================

router.get('/hotel-rooms', async (_req, res) => {
  try {
    const result = await query('SELECT * FROM hotel_rooms ORDER BY floor ASC, room_number ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/inventory/hotel-rooms]', err);
    res.status(500).json({ error: 'Failed to fetch hotel rooms' });
  }
});

router.get('/tables', async (_req, res) => {
  try {
    const result = await query('SELECT * FROM restaurant_tables ORDER BY table_number ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/inventory/tables]', err);
    res.status(500).json({ error: 'Failed to fetch tables' });
  }
});

router.get('/meeting-rooms', async (_req, res) => {
  try {
    const result = await query('SELECT * FROM meeting_rooms ORDER BY capacity ASC, room_code ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/inventory/meeting-rooms]', err);
    res.status(500).json({ error: 'Failed to fetch meeting rooms' });
  }
});

export default router;
