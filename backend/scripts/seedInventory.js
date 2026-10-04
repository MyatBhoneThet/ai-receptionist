import 'dotenv/config';
import { query } from '../services/db.js';

const seedItems = [
  ...Array.from({ length: 10 }, (_, index) => {
    const floor = index + 1;
    return {
      category: 'room',
      code: `FLOOR-${String(floor).padStart(2, '0')}`,
      name: `Floor ${floor} Rooms`,
      capacity: 4,
      quantity: 10,
      metadata: { floor, rooms_per_floor: 10 },
    };
  }),
  { category: 'table', code: 'T01', name: 'Table 1 - two guests', capacity: 2, quantity: 1, metadata: { table_number: 1 } },
  { category: 'table', code: 'T02', name: 'Table 2 - two guests', capacity: 2, quantity: 1, metadata: { table_number: 2 } },
  { category: 'table', code: 'T03', name: 'Table 3 - four guests', capacity: 4, quantity: 1, metadata: { table_number: 3 } },
  { category: 'table', code: 'T04', name: 'Table 4 - four guests', capacity: 4, quantity: 1, metadata: { table_number: 4 } },
  { category: 'table', code: 'T05', name: 'Table 5 - four guests', capacity: 4, quantity: 1, metadata: { table_number: 5 } },
  { category: 'table', code: 'T06', name: 'Table 6 - six guests', capacity: 6, quantity: 1, metadata: { table_number: 6 } },
  { category: 'table', code: 'T07', name: 'Table 7 - six guests', capacity: 6, quantity: 1, metadata: { table_number: 7 } },
  { category: 'table', code: 'T08', name: 'Table 8 - eight guests', capacity: 8, quantity: 1, metadata: { table_number: 8 } },
  { category: 'table', code: 'T09', name: 'Table 9 - ten guests', capacity: 10, quantity: 1, metadata: { table_number: 9 } },
  { category: 'meeting', code: 'MEET-04', name: 'Meeting Room 4p', capacity: 4, quantity: 1, metadata: { room_number: 'M1' } },
  { category: 'meeting', code: 'MEET-08', name: 'Meeting Room 8p', capacity: 8, quantity: 1, metadata: { room_number: 'M2' } },
  { category: 'meeting', code: 'MEET-12', name: 'Meeting Room 12p', capacity: 12, quantity: 1, metadata: { room_number: 'M3' } },
  { category: 'meeting', code: 'BOARDROOM', name: 'Executive Boardroom', capacity: 16, quantity: 1, metadata: { room_number: 'M4' } },
];

async function seed() {
  for (const item of seedItems) {
    await query(
      `INSERT INTO inventory (category, code, name, capacity, quantity, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (category, code) DO UPDATE SET
         name = EXCLUDED.name,
         capacity = EXCLUDED.capacity,
         quantity = EXCLUDED.quantity,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [item.category, item.code, item.name, item.capacity, item.quantity, item.metadata || {}]
    );
    console.log(`Seeded ${item.category}:${item.code}`);
  }
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
