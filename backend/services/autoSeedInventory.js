import { query } from './db.js';

// ============================================================
// Default seed data for the three resource tables.
// Only runs if all three tables are empty (fresh DB).
// ============================================================

const defaultHotelRooms = [
  // Floor 1 — Standard rooms
  { room_number: '101', room_type: 'Standard', floor: 1, capacity: 2, price_per_night: 89.00 },
  { room_number: '102', room_type: 'Standard', floor: 1, capacity: 2, price_per_night: 89.00 },
  { room_number: '103', room_type: 'Standard', floor: 1, capacity: 2, price_per_night: 89.00 },
  { room_number: '104', room_type: 'Twin',     floor: 1, capacity: 2, price_per_night: 95.00 },
  { room_number: '105', room_type: 'Twin',     floor: 1, capacity: 2, price_per_night: 95.00 },
  // Floor 2 — Deluxe rooms
  { room_number: '201', room_type: 'Deluxe',   floor: 2, capacity: 2, price_per_night: 129.00 },
  { room_number: '202', room_type: 'Deluxe',   floor: 2, capacity: 2, price_per_night: 129.00 },
  { room_number: '203', room_type: 'Deluxe',   floor: 2, capacity: 3, price_per_night: 139.00 },
  { room_number: '204', room_type: 'King',      floor: 2, capacity: 2, price_per_night: 149.00 },
  { room_number: '205', room_type: 'King',      floor: 2, capacity: 2, price_per_night: 149.00 },
  // Floor 3 — Suites
  { room_number: '301', room_type: 'Suite',    floor: 3, capacity: 4, price_per_night: 249.00 },
  { room_number: '302', room_type: 'Suite',    floor: 3, capacity: 4, price_per_night: 249.00 },
  { room_number: '303', room_type: 'Suite',    floor: 3, capacity: 4, price_per_night: 299.00 },
  { room_number: '304', room_type: 'Penthouse', floor: 3, capacity: 6, price_per_night: 499.00 },
];

const defaultRestaurantTables = [
  { table_number: 'T1', capacity: 2, location: 'window'  },
  { table_number: 'T2', capacity: 2, location: 'window'  },
  { table_number: 'T3', capacity: 4, location: 'indoor'  },
  { table_number: 'T4', capacity: 4, location: 'indoor'  },
  { table_number: 'T5', capacity: 4, location: 'indoor'  },
  { table_number: 'T6', capacity: 6, location: 'patio'   },
  { table_number: 'T7', capacity: 6, location: 'patio'   },
  { table_number: 'T8', capacity: 8, location: 'private' },
  { table_number: 'T9', capacity: 10, location: 'private' },
];

const defaultMeetingRooms = [
  { room_code: 'M1', room_name: 'Meeting Room A',      capacity: 4,  equipment: { projector: false, whiteboard: true } },
  { room_code: 'M2', room_name: 'Meeting Room B',      capacity: 8,  equipment: { projector: true,  whiteboard: true } },
  { room_code: 'M3', room_name: 'Conference Room',     capacity: 12, equipment: { projector: true,  whiteboard: true, video_conferencing: true } },
  { room_code: 'BOARD', room_name: 'Executive Boardroom', capacity: 20, equipment: { projector: true, whiteboard: true, video_conferencing: true, catering: true } },
];

export async function autoSeedInventory() {
  // Check if all three resource tables are empty
  const [hotelCount, tableCount, meetingCount] = await Promise.all([
    query('SELECT COUNT(*) FROM hotel_rooms'),
    query('SELECT COUNT(*) FROM restaurant_tables'),
    query('SELECT COUNT(*) FROM meeting_rooms'),
  ]);

  const alreadySeeded =
    Number(hotelCount.rows[0].count) > 0 ||
    Number(tableCount.rows[0].count) > 0 ||
    Number(meetingCount.rows[0].count) > 0;

  if (alreadySeeded) return;

  // Seed hotel rooms
  for (const room of defaultHotelRooms) {
    await query(
      `INSERT INTO hotel_rooms (room_number, room_type, floor, capacity, price_per_night)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (room_number) DO NOTHING`,
      [room.room_number, room.room_type, room.floor, room.capacity, room.price_per_night]
    );
  }

  // Seed restaurant tables
  for (const tbl of defaultRestaurantTables) {
    await query(
      `INSERT INTO restaurant_tables (table_number, capacity, location)
       VALUES ($1, $2, $3)
       ON CONFLICT (table_number) DO NOTHING`,
      [tbl.table_number, tbl.capacity, tbl.location]
    );
  }

  // Seed meeting rooms
  for (const room of defaultMeetingRooms) {
    await query(
      `INSERT INTO meeting_rooms (room_code, room_name, capacity, equipment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_code) DO NOTHING`,
      [room.room_code, room.room_name, room.capacity, JSON.stringify(room.equipment)]
    );
  }

  console.log('[autoSeedInventory] Seeded hotel_rooms, restaurant_tables, meeting_rooms');
}
