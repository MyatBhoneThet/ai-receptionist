import { jest } from '@jest/globals';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SESSION_SIGNING_SECRET = 'test-session-secret';
process.env.ADMIN_TOKEN = 'admin-secret';
process.env.USE_APP_SETTINGS_QUERY_IN_TEST = 'true';
process.env.ENABLE_LEGACY_ADMIN_TOKEN_FALLBACK = 'true';
process.env.NEXT_PUBLIC_ENABLE_LOCALSTORAGE_AUTH_FALLBACK = 'true';

function makeInitialBookings() {
  return [
    {
      id: 1,
      session_id: 'sess-1',
      service_type: 'hotel',
      date: '2026-04-07',
      start_time: '14:00:00',
      end_time: '11:00:00',
      reservation_name: 'Avery',
      people: 2,
      location: 'Suite 3',
      notes: '',
      status: 'pending',
      waitlisted: false,
      contact_email: 'avery@example.com',
      contact_phone: '0800123456',
      created_at: new Date('2026-04-01T00:00:00Z'),
      updated_at: new Date('2026-04-01T00:00:00Z'),
    },
    {
      id: 2,
      session_id: 'sess-2',
      service_type: 'restaurant',
      date: '2026-04-08',
      start_time: '18:30:00',
      end_time: '19:30:00',
      reservation_name: 'Jordan',
      people: 4,
      location: 'Patio',
      notes: '',
      status: 'confirmed',
      waitlisted: false,
      contact_email: 'jordan@example.com',
      contact_phone: '0800111222',
      created_at: new Date('2026-04-02T00:00:00Z'),
      updated_at: new Date('2026-04-02T00:00:00Z'),
    },
  ];
}

const state = {
  users: [],
  bookings: makeInitialBookings(),
  inventory: [],
  customers: [],
  conversations: [],
  appSettings: {
    notification_provider: { value: 'slack' },
    staff_webhook_url: { value: '' },
    staff_alert_email: { value: '' },
  },
  auditLogs: [],
};

let nextIds = {
  user: 1,
  inventory: 1,
  audit: 1,
  customer: 1,
  booking: 10,
};

function resetState() {
  state.users = [];
  state.bookings = makeInitialBookings();
  state.inventory = [];
  state.customers = [];
  state.conversations = [];
  state.auditLogs = [];
  state.appSettings = {
    notification_provider: { value: 'slack' },
    staff_webhook_url: { value: '' },
    staff_alert_email: { value: '' },
  };
  nextIds = { user: 1, inventory: 1, audit: 1, customer: 1, booking: 10 };
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function toDateKey(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (typeof value === 'string' && /^\d{2}-\d{2}-\d{4}$/.test(value)) {
    const [dd, mm, yyyy] = value.split('-');
    return `${yyyy}-${mm}-${dd}`;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  return String(value);
}

function cloneRow(row) {
  if (!row || typeof row !== 'object') return row;
  return { ...row };
}

function makeRows(rows) {
  return { rows: rows.map(cloneRow), rowCount: rows.length };
}

function applyAssignments(record, sql, params) {
  const match = sql.match(/set (.*) where/i);
  if (!match) return record;

  const assignments = match[1].split(',').map((part) => part.trim());
  assignments.forEach((assignment) => {
    if (assignment.includes('updated_at = now()')) return;
    const fieldMatch = assignment.match(/^([a-z_]+)\s*=\s*\$(\d+)$/i);
    if (!fieldMatch) return;
    const [, field, indexStr] = fieldMatch;
    const idx = Number(indexStr) - 1;
    record[field] = params[idx];
  });

  return record;
}

const query = jest.fn(async (sql, params = []) => {
  const normalized = normalizeSql(sql);

  if (normalized.includes('from users where email = $1') && normalized.includes('password_hash')) {
    const email = params[0]?.toLowerCase();
    const user = state.users.find((item) => item.email === email);
    return makeRows(user ? [user] : []);
  }

  if (normalized.startsWith('insert into users')) {
    const email = params[0].toLowerCase();
    const existing = state.users.find((item) => item.email === email);
    if (existing && normalized.includes('on conflict (email) do nothing')) {
      return makeRows([]);
    }
    const user = existing || {
      id: nextIds.user++,
      created_at: new Date(),
    };
    Object.assign(user, {
      email,
      password_hash: params[1],
      name: params[2] ?? null,
      phone_number: params[3] ?? null,
      role: params[4] ?? 'customer',
      preferences: user.preferences || {},
      updated_at: new Date(),
    });
    if (!existing) state.users.push(user);
    return makeRows([{ id: user.id, email: user.email, name: user.name, phone_number: user.phone_number, role: user.role, created_at: user.created_at }]);
  }

  if (normalized.includes('update users set preferences')) {
    const email = params[1].toLowerCase();
    const user = state.users.find((item) => item.email === email);
    if (!user) return makeRows([]);
    user.preferences = { ...(user.preferences || {}), ...JSON.parse(params[0]) };
    user.updated_at = new Date();
    return makeRows([{ id: user.id, email: user.email, name: user.name, phone_number: user.phone_number, role: user.role, preferences: user.preferences }]);
  }

  if (normalized.includes('from users where email = $1') && !normalized.includes('password_hash')) {
    const email = params[0].toLowerCase();
    const user = state.users.find((item) => item.email === email);
    return makeRows(user ? [user] : []);
  }

  if (normalized.startsWith('insert into app_settings')) {
    const key = params[0];
    const value = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
    state.appSettings[key] = value;
    return makeRows([{ key, value }]);
  }

  if (normalized.includes('from app_settings where key = any')) {
    const keys = params[0];
    return makeRows(
      keys
        .filter((key) => state.appSettings[key])
        .map((key) => ({ key, value: state.appSettings[key] }))
    );
  }

  if (normalized.startsWith('insert into audit_logs')) {
    const log = {
      id: nextIds.audit++,
      actor_email: params[0],
      action: params[1],
      entity: params[2],
      before_state: JSON.parse(params[3]),
      after_state: JSON.parse(params[4]),
      created_at: new Date().toISOString(),
    };
    state.auditLogs.unshift(log);
    return makeRows([log]);
  }

  if (normalized.includes('from audit_logs')) {
    const limit = Number(params[0]) || 20;
    const entityFilter = params[1];
    let rows = [...state.auditLogs];
    if (normalized.includes('where entity = $2')) {
      rows = rows.filter((row) => row.entity === entityFilter);
    }
    return makeRows(rows.slice(0, limit));
  }

  if (normalized.startsWith('select role, content from conversations where session_id = $1')) {
    const rows = state.conversations.filter((item) => item.session_id === params[0]);
    return makeRows(rows);
  }

  if (normalized.startsWith('insert into conversations')) {
    state.conversations.push({
      session_id: params[0],
      role: params[1],
      content: params[2],
      created_at: new Date(),
    });
    return makeRows([]);
  }

  if (normalized.startsWith('select name, preferences from customers where phone_number = $1')) {
    const row = state.customers.find((item) => item.phone_number === params[0]);
    return makeRows(row ? [row] : []);
  }

  if (normalized.startsWith('insert into customers')) {
    const [phone_number, name] = params;
    const existing = state.customers.find((item) => item.phone_number === phone_number);
    const customer = existing || { id: nextIds.customer++, preferences: {}, created_at: new Date() };
    customer.phone_number = phone_number;
    customer.name = customer.name || name;
    customer.updated_at = new Date();
    if (!existing) state.customers.push(customer);
    return makeRows([{ id: customer.id }]);
  }

  if (normalized.startsWith('select * from inventory order by')) {
    return makeRows([...state.inventory].sort((a, b) => `${a.category}${a.code}`.localeCompare(`${b.category}${b.code}`)));
  }

  if (normalized.startsWith('select id, room_number as code, room_type as name, capacity, floor, price_per_night, amenities as metadata from hotel_rooms')) {
    const minCapacity = params[0] || 0;
    const rooms = state.inventory.filter((item) => item.category === 'room' && item.capacity >= minCapacity);
    const expanded = [];
    rooms.forEach((r) => {
      const qty = r.quantity || 1;
      for (let i = 1; i <= qty; i++) {
        expanded.push({
          id: r.id * 1000 + i,
          code: qty > 1 ? `${r.code}-${i}` : r.code,
          name: r.name,
          capacity: r.capacity,
          floor: r.metadata?.floor || 1,
          price_per_night: r.metadata?.price_per_night || 100,
          metadata: r.metadata || {},
        });
      }
    });
    return makeRows(expanded);
  }

  if (normalized.startsWith('select id, table_number as code, location as name, capacity, null::numeric as price_per_night, \'{}\'::jsonb as metadata from restaurant_tables')) {
    const minCapacity = params[0] || 0;
    const tables = state.inventory.filter((item) => item.category === 'table' && item.capacity >= minCapacity);
    const expanded = [];
    tables.forEach((t) => {
      const qty = t.quantity || 1;
      for (let i = 1; i <= qty; i++) {
        expanded.push({
          id: t.id * 1000 + i,
          code: qty > 1 ? `${t.code}-${i}` : t.code,
          name: t.metadata?.location || 'indoor',
          capacity: t.capacity,
          price_per_night: null,
          metadata: t.metadata || {},
        });
      }
    });
    return makeRows(expanded);
  }

  if (normalized.startsWith('select id, room_code as code, room_name as name, capacity, null::numeric as price_per_night, equipment as metadata from meeting_rooms')) {
    const minCapacity = params[0] || 0;
    const meetings = state.inventory.filter((item) => item.category === 'meeting' && item.capacity >= minCapacity);
    const expanded = [];
    meetings.forEach((m) => {
      const qty = m.quantity || 1;
      for (let i = 1; i <= qty; i++) {
        expanded.push({
          id: m.id * 1000 + i,
          code: qty > 1 ? `${m.code}-${i}` : m.code,
          name: m.name,
          capacity: m.capacity,
          price_per_night: null,
          metadata: m.metadata || {},
        });
      }
    });
    return makeRows(expanded);
  }

  if (normalized.startsWith('select id, category, code, name, capacity, quantity, metadata from inventory where category = $1')) {
    const category = params[0];
    const rows = state.inventory
      .filter((item) => item.category === category && Number(item.quantity || 0) > 0)
      .sort((a, b) => Number(a.capacity || 0) - Number(b.capacity || 0) || String(a.code).localeCompare(String(b.code)));
    return makeRows(rows);
  }

  if (normalized.startsWith('select coalesce(sum(quantity),0) as total from inventory')) {
    const category = params[0];
    const total = state.inventory
      .filter((item) => item.category === category)
      .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    return makeRows([{ total: String(total) }]);
  }

  if (normalized.startsWith('insert into hotel_rooms')) {
    const [room_number, room_type, floor, capacity, price_per_night, amenities] = params;
    const existing = state.inventory.find((item) => item.category === 'room' && item.code === room_number);
    const row = existing || { id: nextIds.inventory++, created_at: new Date() };
    Object.assign(row, {
      category: 'room',
      code: room_number,
      name: room_type,
      capacity: capacity ?? 2,
      quantity: 1,
      metadata: { floor, price_per_night, amenities },
      updated_at: new Date(),
    });
    if (!existing) state.inventory.push(row);
    return makeRows([{
      id: row.id,
      room_number: row.code,
      room_type: row.name,
      floor: row.metadata.floor,
      capacity: row.capacity,
      price_per_night: row.metadata.price_per_night,
      amenities: row.metadata.amenities,
      created_at: row.created_at,
      updated_at: row.updated_at
    }]);
  }

  if (normalized.startsWith('insert into restaurant_tables')) {
    const [table_number, capacity, location] = params;
    const existing = state.inventory.find((item) => item.category === 'table' && item.code === table_number);
    const row = existing || { id: nextIds.inventory++, created_at: new Date() };
    Object.assign(row, {
      category: 'table',
      code: table_number,
      name: `Table ${table_number}`,
      capacity: capacity ?? 4,
      quantity: 1,
      metadata: { location },
      updated_at: new Date(),
    });
    if (!existing) state.inventory.push(row);
    return makeRows([{
      id: row.id,
      table_number: row.code,
      capacity: row.capacity,
      location: row.metadata.location,
      created_at: row.created_at,
      updated_at: row.updated_at
    }]);
  }

  if (normalized.startsWith('insert into meeting_rooms')) {
    const [room_code, room_name, capacity, equipment] = params;
    const existing = state.inventory.find((item) => item.category === 'meeting' && item.code === room_code);
    const row = existing || { id: nextIds.inventory++, created_at: new Date() };
    Object.assign(row, {
      category: 'meeting',
      code: room_code,
      name: room_name,
      capacity: capacity ?? 10,
      quantity: 1,
      metadata: equipment || {},
      updated_at: new Date(),
    });
    if (!existing) state.inventory.push(row);
    return makeRows([{
      id: row.id,
      room_code: row.code,
      room_name: row.name,
      capacity: row.capacity,
      equipment: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at
    }]);
  }

  if (normalized.startsWith('insert into inventory')) {
    const [category, code, name, capacity, quantity, metadata] = params;
    const existing = state.inventory.find((item) => item.category === category && item.code === code);
    const row = existing || { id: nextIds.inventory++, created_at: new Date() };
    Object.assign(row, {
      category,
      code,
      name: name ?? null,
      capacity: capacity ?? 0,
      quantity: quantity ?? 1,
      metadata: metadata ?? {},
      updated_at: new Date(),
    });
    if (!existing) state.inventory.push(row);
    return makeRows([row]);
  }

  if (normalized.startsWith('select id from hotel_rooms where id = $1') || normalized.startsWith('select * from hotel_rooms where id = $1')) {
    const row = state.inventory.find((item) => String(item.id) === String(params[0]) && item.category === 'room');
    return makeRows(row ? [row] : []);
  }

  if (normalized.startsWith('select id from restaurant_tables where id = $1') || normalized.startsWith('select * from restaurant_tables where id = $1')) {
    const row = state.inventory.find((item) => String(item.id) === String(params[0]) && item.category === 'table');
    return makeRows(row ? [row] : []);
  }

  if (normalized.startsWith('select id from meeting_rooms where id = $1') || normalized.startsWith('select * from meeting_rooms where id = $1')) {
    const row = state.inventory.find((item) => String(item.id) === String(params[0]) && item.category === 'meeting');
    return makeRows(row ? [row] : []);
  }

  if (normalized.startsWith('select * from inventory where id = $1')) {
    const row = state.inventory.find((item) => String(item.id) === String(params[0]));
    return makeRows(row ? [row] : []);
  }

  if (
    normalized.startsWith('update inventory set') ||
    normalized.startsWith('update hotel_rooms set') ||
    normalized.startsWith('update restaurant_tables set') ||
    normalized.startsWith('update meeting_rooms set')
  ) {
    const id = params[params.length - 1];
    const row = state.inventory.find((item) => String(item.id) === String(id));
    if (!row) return makeRows([]);
    applyAssignments(row, normalized, params);
    row.updated_at = new Date();
    return makeRows([row]);
  }

  if (
    normalized.startsWith('delete from inventory where id = $1') ||
    normalized.startsWith('delete from hotel_rooms where id = $1') ||
    normalized.startsWith('delete from restaurant_tables where id = $1') ||
    normalized.startsWith('delete from meeting_rooms where id = $1')
  ) {
    const idx = state.inventory.findIndex((item) => String(item.id) === String(params[0]));
    if (idx < 0) return makeRows([]);
    const [removed] = state.inventory.splice(idx, 1);
    return makeRows([removed]);
  }

  if (normalized.includes('hr.room_number') || normalized.includes('table_location') || normalized.includes('room_code')) {
    let rows = state.bookings;
    if (normalized.includes('where b.session_id = $1')) {
      rows = rows.filter((b) => b.session_id === params[0]);
    } else {
      const statusIdx = normalized.indexOf('b.status = $1') !== -1 ? 0 : -1;
      const serviceIdx = normalized.indexOf('b.service_type = $') !== -1 ? (statusIdx !== -1 ? 1 : 0) : -1;
      if (statusIdx !== -1) {
        rows = rows.filter((b) => b.status === params[statusIdx]);
      }
      if (serviceIdx !== -1) {
        rows = rows.filter((b) => b.service_type === params[serviceIdx]);
      }
    }
    rows = [...rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const joined = rows.map((b) => {
      const resId = b.hotel_room_id || b.table_id || b.meeting_room_id || b.inventory_id;
      const resource = state.inventory.find((item) => item.id === resId || item.id === Math.floor(resId / 1000));
      return {
        ...b,
        room_number: b.service_type === 'hotel' ? (resource?.code || '101') : null,
        room_type: b.service_type === 'hotel' ? (resource?.name || 'Standard') : null,
        room_floor: b.service_type === 'hotel' ? (resource?.metadata?.floor || 1) : null,
        price_per_night: b.service_type === 'hotel' ? (resource?.metadata?.price_per_night || 100) : null,
        table_number: b.service_type === 'restaurant' ? (resource?.code || 'T1') : null,
        table_location: b.service_type === 'restaurant' ? (resource?.metadata?.location || 'indoor') : null,
        room_name: b.service_type === 'meeting' ? (resource?.name || 'Meeting Room') : null,
        room_code: b.service_type === 'meeting' ? (resource?.code || 'M1') : null,
      };
    });
    return makeRows(joined);
  }

  if (normalized.startsWith('select * from bookings where session_id = $1 order by created_at desc')) {
    const rows = state.bookings.filter((item) => item.session_id === params[0]).slice().reverse();
    return makeRows(rows);
  }

  if (
    normalized.startsWith('select * from bookings where session_id = $1 and status in') &&
    !normalized.includes('($2 =')
  ) {
    const rows = state.bookings
      .filter((item) => item.session_id === params[0] && ['pending', 'confirmed', 'modified'].includes(item.status))
      .slice()
      .reverse();
    return makeRows(rows.slice(0, 1));
  }

  if (normalized.startsWith('select id, google_event_id, status, service_type, date, start_time')) {
    const rows = state.bookings
      .filter((item) => item.session_id === params[0] && item.status === 'pending')
      .slice()
      .reverse();
    return makeRows(rows.slice(0, 1));
  }

  if (normalized.includes('as resource_id, people, date, end_date, start_time, end_time from bookings where service_type = $1')) {
    const [serviceType, excludeId] = params;
    const rows = state.bookings.filter((item) =>
      item.service_type === serviceType &&
      !['cancelled', 'no_show'].includes(item.status) &&
      item.waitlisted === false &&
      (!excludeId || String(item.id) !== String(excludeId))
    );
    const mapped = rows.map((b) => ({
      id: b.id,
      resource_id: b.hotel_room_id || b.table_id || b.meeting_room_id || b.inventory_id || null,
      people: b.people,
      date: b.date,
      end_date: b.end_date,
      start_time: b.start_time,
      end_time: b.end_time,
    }));
    return makeRows(mapped);
  }

  if (normalized.includes('hotel_room_id, table_id, meeting_room_id, status from bookings where service_type = $1')) {
    const [serviceType, excludeId] = params;
    const rows = state.bookings.filter((item) =>
      item.service_type === serviceType &&
      ['pending', 'confirmed', 'modified'].includes(item.status) &&
      (!excludeId || String(item.id) !== String(excludeId))
    );
    const mapped = rows.map((b) => ({
      ...b,
      hotel_room_id: b.hotel_room_id || (b.service_type === 'hotel' ? b.inventory_id : null),
      table_id: b.table_id || (b.service_type === 'restaurant' ? b.inventory_id : null),
      meeting_room_id: b.meeting_room_id || (b.service_type === 'meeting' ? b.inventory_id : null),
    }));
    return makeRows(mapped);
  }

  if (normalized.startsWith('select * from bookings where id = $1')) {
    const row = state.bookings.find((item) => String(item.id) === String(params[0]));
    return makeRows(row ? [row] : []);
  }

  if (
    normalized.startsWith('select * from bookings where date = $1 and service_type = $2 and lower(reservation_name) = $3')
  ) {
    const dateKey = toDateKey(params[0]);
    const serviceType = params[1];
    const reservationName = String(params[2] || '').toLowerCase();
    const rows = state.bookings.filter(
      (item) =>
        toDateKey(item.date) === dateKey &&
        item.service_type === serviceType &&
        String(item.reservation_name || '').toLowerCase() === reservationName &&
        ['pending', 'confirmed', 'modified'].includes(item.status)
    );
    return makeRows(rows.slice(0, 1));
  }

  if (normalized.startsWith('select * from bookings where session_id = $1 and status in')) {
    const sessionId = params[0];
    const serviceType = params[1];
    const date = params[2];
    const reservationName = String(params[3] || '').toLowerCase();
    const rows = state.bookings.filter((item) => {
      if (item.session_id !== sessionId || !['pending', 'confirmed', 'modified'].includes(item.status)) return false;
      if (serviceType && item.service_type !== serviceType) return false;
      if (date && toDateKey(item.date) !== toDateKey(date)) return false;
      if (reservationName && String(item.reservation_name || '').toLowerCase() !== reservationName) return false;
      return true;
    });
    return makeRows(rows.slice().reverse().slice(0, 1));
  }

  if (normalized.startsWith('select * from bookings order by created_at desc limit $1')) {
    const limit = Number(params[0]) || 50;
    return makeRows([...state.bookings].slice().reverse().slice(0, limit));
  }

  if (normalized.startsWith('update bookings set status = $1, updated_at = now() where id = $2 returning *')) {
    const row = state.bookings.find((item) => String(item.id) === String(params[1]));
    if (!row) return makeRows([]);
    row.status = params[0];
    row.updated_at = new Date();
    return makeRows([row]);
  }

  if (normalized.startsWith("update bookings set status = 'cancelled'")) {
    const row = state.bookings.find((item) => String(item.id) === String(params[0]));
    if (!row) return makeRows([]);
    row.status = 'cancelled';
    row.updated_at = new Date();
    return makeRows([row]);
  }

  if (normalized.startsWith('update bookings set')) {
    const row = state.bookings.find((item) => String(item.id) === String(params[params.length - 1]));
    if (!row) return makeRows([]);
    applyAssignments(row, normalized, params);
    row.updated_at = new Date();
    return makeRows([row]);
  }

  if (normalized.startsWith('insert into bookings')) {
    const [
      session_id,
      service_type,
      date,
      end_date,
      start_time,
      end_time,
      people,
      notes,
      reservation_name,
      customer_id,
      contact_phone,
      contact_email,
      waitlisted,
      inventory_id,
    ] = params;
    const row = {
      id: nextIds.booking++,
      session_id,
      service_type,
      date,
      end_date,
      start_time,
      end_time,
      people,
      notes,
      reservation_name,
      status: 'pending',
      customer_id,
      contact_phone,
      contact_email,
      waitlisted,
      inventory_id,
      created_at: new Date(),
      updated_at: new Date(),
    };
    state.bookings.push(row);
    return makeRows([row]);
  }

  if (normalized.startsWith('select * from bookings where service_type = $1 and date = $2 and waitlisted = true')) {
    const rows = state.bookings.filter((item) => item.service_type === params[0] && item.date === params[1] && item.waitlisted);
    return makeRows(rows.slice(0, 1));
  }

  if (normalized.startsWith('select count(*) from inventory')) {
    return makeRows([{ count: String(state.inventory.length) }]);
  }

  if (normalized.startsWith('select count(*) as count from bookings')) {
    const [serviceType, date] = params;
    const count = state.bookings.filter(
      (item) =>
        item.service_type === serviceType &&
        toDateKey(item.date) === toDateKey(date) &&
        !['cancelled', 'no_show'].includes(item.status) &&
        item.waitlisted === false
    ).length;
    return makeRows([{ count: String(count) }]);
  }

  return makeRows([]);
});

await jest.unstable_mockModule('../services/db.js', () => ({ query }));
await jest.unstable_mockModule('../services/llm.js', () => ({
  chat: jest.fn(async () => ({
    message: 'ok',
    speak: 'ok',
    intent: 'unknown',
    data: {},
    missing_fields: [],
    confidence: 1,
  })),
}));
await jest.unstable_mockModule('../services/googleCalendar.js', () => ({
  upsertEvent: jest.fn(async () => null),
  cancelEvent: jest.fn(async () => undefined),
  getEventStatus: jest.fn(async () => ({ available: true, reason: 'found' })),
}));

const { default: app } = await import('../index.js');
const { createSessionToken } = await import('../middleware/auth.js');
const { chat: mockChat } = await import('../services/llm.js');
const { upsertEvent: mockUpsertEvent } = await import('../services/googleCalendar.js');

const runRoutes = process.env.NO_LISTEN !== 'true';

(runRoutes ? describe : describe.skip)('route flows', () => {
  beforeEach(() => {
    resetState();
    mockChat.mockClear();
    mockUpsertEvent.mockClear();
    process.env.STAFF_WEBHOOK_URL = '';
    process.env.STAFF_ALERT_EMAIL = '';
    process.env.STAFF_WEBHOOK_PROVIDER = 'slack';
  });

  it('registers, logs in, and returns the current user', async () => {
    const registerRes = await request(app)
      .post('/api/users/register')
      .send({
        email: 'guest@example.com',
        password: 'supersecret',
        name: 'Guest',
        phone_number: '0800000000',
      });

    expect(registerRes.status).toBe(200);
    expect(registerRes.body.user.email).toBe('guest@example.com');
    expect(registerRes.headers['set-cookie']).toBeDefined();

    const loginRes = await request(app)
      .post('/api/users/login')
      .send({
        email: 'guest@example.com',
        password: 'supersecret',
      });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeTruthy();

    const meRes = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${loginRes.body.token}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.email).toBe('guest@example.com');
  });

  it('supports inventory CRUD with audit logging', async () => {
    const createRes = await request(app)
      .post('/api/inventory')
      .set('X-Admin-Token', 'admin-secret')
      .send({
        category: 'table',
        code: 'WINDOW-2',
        name: 'Window Table',
        capacity: 2,
        quantity: 3,
      });

    expect(createRes.status).toBe(200);
    expect(createRes.body.code).toBe('WINDOW-2');

    const updateRes = await request(app)
      .patch(`/api/inventory/${createRes.body.id}`)
      .set('X-Admin-Token', 'admin-secret')
      .send({
        name: 'Window Table A',
        quantity: 4,
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.name).toBe('Window Table A');

    const auditRes = await request(app)
      .get('/api/settings/audit?entity=inventory')
      .set('X-Admin-Token', 'admin-secret');

    expect(auditRes.status).toBe(200);
    expect(auditRes.body.length).toBeGreaterThan(0);
    expect(auditRes.body[0].change_summary.some((row) => row.field === 'name')).toBe(true);

    const deleteRes = await request(app)
      .delete(`/api/inventory/${createRes.body.id}`)
      .set('X-Admin-Token', 'admin-secret');

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);
  });

  it('recommends another place when the requested meeting room is occupied', async () => {
    state.inventory.push(
      { id: 101, category: 'meeting', code: 'BOARDROOM', name: 'Executive Boardroom', capacity: 12, quantity: 1, metadata: {} },
      { id: 102, category: 'meeting', code: 'MEET-10', name: 'Meeting Room 10p', capacity: 10, quantity: 1, metadata: {} }
    );
    state.bookings.push({
      id: 101,
      session_id: 'sess-occupied',
      service_type: 'meeting',
      date: '2026-06-12',
      start_time: '10:00:00',
      end_time: '11:00:00',
      reservation_name: 'Existing',
      people: 6,
      status: 'confirmed',
      waitlisted: false,
      inventory_id: 101,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const sessionToken = createSessionToken('sess-availability');
    const res = await request(app)
      .post('/api/availability/check')
      .set('X-Session-Id', 'sess-availability')
      .set('X-Session-Token', sessionToken)
      .send({
        service_type: 'meeting',
        date: '12-06-2026',
        start_time: '10:00',
        end_time: '11:00',
        people: 6,
        preferred_inventory: 'boardroom',
      });

    expect(res.status).toBe(200);
    expect(res.body.waitlist).toBe(true);
    expect(res.body.occupied_option.name).toBe('Executive Boardroom');
    expect(res.body.place_recommendation.name).toBe('Meeting Room 10p');
  });

  it('recommends the nearest available hotel day when all 100 rooms are booked for a week', async () => {
    for (let floor = 1; floor <= 10; floor += 1) {
      state.inventory.push({
        id: floor,
        category: 'room',
        code: `FLOOR-${String(floor).padStart(2, '0')}`,
        name: `Floor ${floor} Rooms`,
        capacity: 4,
        quantity: 10,
        metadata: { floor, rooms_per_floor: 10 },
      });
    }

    for (let i = 0; i < 100; i += 1) {
      state.bookings.push({
        id: 3000 + i,
        session_id: `sess-full-hotel-${i}`,
        service_type: 'hotel',
        date: '2026-07-13',
        end_date: '2026-07-20',
        start_time: '14:00:00',
        end_time: '11:00:00',
        reservation_name: `Guest ${i}`,
        people: 2,
        status: 'confirmed',
        waitlisted: false,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    mockChat.mockResolvedValueOnce({
      message: 'I can help with that hotel booking.',
      speak: 'I can help with that hotel booking.',
      intent: 'book_hotel',
      data: {
        service_type: 'hotel',
        date: '13-07-2026',
        end_date: '20-07-2026',
        start_time: '',
        end_time: '',
        people: 2,
        notes: '',
        reservation_name: 'Alex',
        phone_number: '0800100200',
      },
      missing_fields: [],
      confidence: 1,
    });

    const res = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-hotel-overflow',
        message: 'Book a room for Alex next week',
      });

    expect(res.status).toBe(200);
    expect(res.body.availability.waitlist).toBe(true);
    expect(res.body.availability.alternative.recommendation_type).toBe('date');
    expect(res.body.availability.alternative.date).toBe('20-07-2026');
    expect(res.body.availability.alternative.available).toBeGreaterThan(0);
  });

  it('recommends the nearest restaurant time when every suitable table is booked at the requested time', async () => {
    const tables = [
      { id: 401, code: 'T01', name: 'Table 1 - two guests', capacity: 2 },
      { id: 402, code: 'T02', name: 'Table 2 - two guests', capacity: 2 },
      { id: 403, code: 'T03', name: 'Table 3 - four guests', capacity: 4 },
      { id: 404, code: 'T04', name: 'Table 4 - four guests', capacity: 4 },
      { id: 405, code: 'T05', name: 'Table 5 - four guests', capacity: 4 },
      { id: 406, code: 'T06', name: 'Table 6 - six guests', capacity: 6 },
      { id: 407, code: 'T07', name: 'Table 7 - six guests', capacity: 6 },
      { id: 408, code: 'T08', name: 'Table 8 - eight guests', capacity: 8 },
      { id: 409, code: 'T09', name: 'Table 9 - ten guests', capacity: 10 },
    ];
    state.inventory.push(
      ...tables.map((table) => ({
        ...table,
        category: 'table',
        quantity: 1,
        metadata: { table_number: table.code },
      }))
    );

    tables
      .filter((table) => table.capacity >= 5)
      .forEach((table, index) => {
        state.bookings.push({
          id: 4000 + index,
          session_id: `sess-table-full-${index}`,
          service_type: 'restaurant',
          date: '2026-07-14',
          start_time: '18:00:00',
          end_time: '19:00:00',
          reservation_name: `Dinner ${index}`,
          people: 5,
          status: 'confirmed',
          waitlisted: false,
          inventory_id: table.id,
          created_at: new Date(),
          updated_at: new Date(),
        });
      });

    mockChat.mockResolvedValueOnce({
      message: 'I can help with that dinner booking.',
      speak: 'I can help with that dinner booking.',
      intent: 'book_restaurant',
      data: {
        service_type: 'restaurant',
        date: '14-07-2026',
        start_time: '18:00',
        end_time: '19:00',
        people: 5,
        notes: '',
        reservation_name: 'Family Lee',
        phone_number: '0800100300',
      },
      missing_fields: [],
      confidence: 1,
    });

    const res = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-restaurant-overflow',
        message: 'Book dinner for a family of 5 at 6pm',
      });

    expect(res.status).toBe(200);
    expect(res.body.availability.waitlist).toBe(true);
    expect(res.body.availability.alternative.recommendation_type).toBe('time');
    expect(res.body.availability.alternative.start_time).toBe('19:00');
    expect(res.body.availability.alternative.available).toBeGreaterThan(0);
  });

  it('blocks exact duplicate bookings from chat', async () => {
    state.inventory.push({
      id: 201,
      category: 'table',
      code: 'TABLE-4',
      name: 'Table for 4',
      capacity: 4,
      quantity: 4,
      metadata: {},
    });
    state.bookings.push({
      id: 201,
      session_id: 'sess-original',
      service_type: 'restaurant',
      date: '2026-06-20',
      start_time: '19:00:00',
      end_time: '20:00:00',
      reservation_name: 'Nora',
      people: 4,
      status: 'confirmed',
      waitlisted: false,
      contact_phone: '0800123000',
      inventory_id: 201,
      created_at: new Date(),
      updated_at: new Date(),
    });

    mockChat.mockResolvedValueOnce({
      message: 'I can book that.',
      speak: 'I can book that.',
      intent: 'book_restaurant',
      data: {
        service_type: 'restaurant',
        date: '20-06-2026',
        start_time: '19:00',
        end_time: '20:00',
        people: 4,
        notes: '',
        reservation_name: 'Nora',
        phone_number: '0800123000',
      },
      missing_fields: [],
      confidence: 1,
    });

    const beforeCount = state.bookings.length;
    const res = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-duplicate',
        message: 'Book the same table again for Nora',
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("won't create a duplicate");
    expect(state.bookings).toHaveLength(beforeCount);
  });

  it('supports booking reads and admin status changes with audit logging', async () => {
    const sessionToken = createSessionToken('sess-1');

    const listRes = await request(app)
      .get('/api/bookings/sess-1')
      .set('X-Session-Id', 'sess-1')
      .set('X-Session-Token', sessionToken);

    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);

    const statusRes = await request(app)
      .post('/api/bookings/1/status')
      .set('X-Admin-Token', 'admin-secret')
      .send({ status: 'confirmed' });

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('confirmed');

    const deleteRes = await request(app)
      .delete('/api/bookings/2')
      .set('X-Admin-Token', 'admin-secret');

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.booking.status).toBe('cancelled');

    const auditRes = await request(app)
      .get('/api/settings/audit?entity=booking')
      .set('X-Admin-Token', 'admin-secret');

    expect(auditRes.status).toBe(200);
    expect(auditRes.body.length).toBeGreaterThan(0);
    expect(auditRes.body.every((row) => row.entity === 'booking')).toBe(true);
  });

  it('keeps reservation changes in edit mode instead of repeating the lookup', async () => {
    state.bookings.push({
      id: 3,
      session_id: 'sess-modify',
      service_type: 'meeting',
      date: '2026-05-15',
      start_time: '10:00:00',
      end_time: '11:00:00',
      reservation_name: 'Talia',
      people: 6,
      location: 'Room 4',
      notes: '',
      status: 'confirmed',
      waitlisted: false,
      contact_email: 'talia@example.com',
      contact_phone: '0800999000',
      created_at: new Date('2026-05-01T00:00:00Z'),
      updated_at: new Date('2026-05-01T00:00:00Z'),
    });

    const foundBookingResponse = {
      message: 'I found your meeting reservation.',
      speak: 'I found your meeting reservation.',
      intent: 'modify_booking',
      data: {
        service_type: 'meeting',
        date: '15-05-2026',
        start_time: '10:00',
        end_time: '11:00',
        people: 6,
        location: 'Room 4',
        notes: '',
        reservation_name: 'Talia',
        phone_number: '',
      },
      missing_fields: [],
      confidence: 1,
    };

    const lookupRes = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-modify',
        message: 'I want to change my meeting reservation',
      });

    expect(lookupRes.status).toBe(200);
    expect(lookupRes.body.message).toContain('To find your booking');
    expect(lookupRes.body.missing_fields).toEqual(['date', 'reservation name']);

    mockChat.mockResolvedValueOnce(foundBookingResponse);

    const fieldRes = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-modify',
        message: 'it\'s on 15th next month and name is Talia',
      });

    expect(fieldRes.status).toBe(200);
    expect(fieldRes.body.message).toContain('I\'ve found your meeting reservation');
    expect(fieldRes.body.intent).toBe('modify_booking');

    const chooseFieldRes = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-modify',
        message: 'date',
      });

    expect(chooseFieldRes.status).toBe(200);
    expect(chooseFieldRes.body.message).toContain('What date would you like instead?');

    const updateRes = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-modify',
        message: '18-05-2026',
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.message).toContain('updated your meeting reservation');
    expect(state.bookings.find((item) => item.id === 3).date).toBe('2026-05-18');

    const slipRes = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-modify',
        message: 'show me the reservation slip',
      });

    expect(slipRes.status).toBe(200);
    expect(slipRes.body.show_reservation_slip).toBe(true);
    expect(slipRes.body.data.people).toBe(6);
    expect(slipRes.body.message).toContain('You booked 6 guests');
  });

  it('treats a fresh dinner request as a new booking instead of reusing old modify state', async () => {
    state.bookings.push({
      id: 4,
      session_id: 'sess-fresh',
      service_type: 'meeting',
      date: '2026-05-15',
      start_time: '10:00:00',
      end_time: '11:00:00',
      reservation_name: 'Steve',
      people: 3,
      location: 'Room 1',
      notes: '',
      status: 'confirmed',
      waitlisted: false,
      contact_email: 'steve@example.com',
      contact_phone: '0800777000',
      created_at: new Date('2026-05-01T00:00:00Z'),
      updated_at: new Date('2026-05-01T00:00:00Z'),
    });

    mockChat.mockResolvedValueOnce({
      message: 'Certainly, I can help with a new dinner reservation.',
      speak: 'Certainly, I can help with a new dinner reservation.',
      intent: 'book_restaurant',
      data: {
        service_type: 'restaurant',
        date: '12-04-2026',
        start_time: '',
        end_time: '',
        people: 3,
        location: '',
        notes: '',
        reservation_name: '',
        phone_number: '',
      },
      missing_fields: ['start_time', 'reservation_name', 'phone_number'],
      confidence: 1,
    });

    const res = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-fresh',
        message: 'Dinner for three tonight',
      });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('book_restaurant');
    expect(res.body.message).toContain('I need a bit more info');
    expect(res.body.message).not.toContain("couldn't find");
  });

  it('prefers the explicit booking date from the user message over the model guess', async () => {
    mockChat.mockResolvedValueOnce({
      message: 'Perfect, I have everything I need.',
      speak: 'Perfect, I have everything I need.',
      intent: 'book_restaurant',
      data: {
        service_type: 'restaurant',
        date: '17-04-2026',
        start_time: '21:00:00',
        end_time: '',
        people: 3,
        location: '',
        notes: '',
        reservation_name: 'Kay',
        phone_number: '0805658109',
      },
      missing_fields: [],
      confidence: 1,
    });

    const res = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-booking-date',
        message: 'Dinner for three on 18-05-2026 9pm. reservation name is Kay. phone number is 0805658109',
      });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('book_restaurant');
    expect(res.body.data.date).toBe('18-05-2026');
    const created = state.bookings.find((item) => item.session_id === 'sess-booking-date');
    expect(created?.date).toBe('2026-05-18');
  });

  it('shows a reserved booking slip when the user asks to view an existing booking', async () => {
    state.bookings.push({
      id: 5,
      session_id: 'sess-slip',
      service_type: 'restaurant',
      date: '2026-05-15',
      start_time: '19:00:00',
      end_time: '20:00:00',
      reservation_name: 'John',
      people: 3,
      location: 'Patio',
      notes: '',
      status: 'confirmed',
      waitlisted: false,
      contact_email: 'john@example.com',
      contact_phone: '0800568109',
      created_at: new Date('2026-04-10T00:00:00Z'),
      updated_at: new Date('2026-04-10T00:00:00Z'),
    });

    const res = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-slip',
        message: 'I want to see my already reserved booking on 15-05-2026 name John and type is dinner',
      });

    expect(res.status).toBe(200);
    expect(res.body.show_reservation_slip).toBe(true);
    expect(res.body.data.reservation_name).toBe('John');
    expect(res.body.data.people).toBe(3);
    expect(res.body.data.service_type).toBe('restaurant');
    expect(res.body.message).toContain('reservation slip');
  });

  it('saves notification settings and surfaces the diff summary', async () => {
    const saveRes = await request(app)
      .patch('/api/settings/notifications')
      .set('X-Admin-Token', 'admin-secret')
      .send({
        provider: 'teams',
        webhook_url: 'https://example.com/hook',
        alert_email: 'staff@example.com',
      });

    expect(saveRes.status).toBe(200);
    expect(saveRes.body.provider).toBe('teams');

    const auditRes = await request(app)
      .get('/api/settings/audit?entity=notification_settings')
      .set('X-Admin-Token', 'admin-secret');

    expect(auditRes.status).toBe(200);
    expect(auditRes.body[0].change_summary.some((row) => row.field === 'provider')).toBe(true);
  });
});
