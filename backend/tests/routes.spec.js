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

function seedAlterationInventory() {
  state.inventory.push(
    { id: 101, category: 'room', code: 'R101', name: 'Suite', capacity: 20, quantity: 2, metadata: {} },
    { id: 102, category: 'table', code: 'T102', name: 'Large table', capacity: 20, quantity: 2, metadata: {} },
    { id: 103, category: 'meeting', code: 'M103', name: 'Boardroom', capacity: 20, quantity: 2, metadata: {} },
  );
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

  if (normalized.startsWith('delete from conversations where session_id = $1')) {
    const removed = state.conversations.filter((item) => item.session_id === params[0]);
    state.conversations = state.conversations.filter((item) => item.session_id !== params[0]);
    return makeRows(removed);
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
    (normalized.startsWith('select * from bookings where session_id = $1 and status in') ||
      normalized.startsWith('select id, status from bookings where session_id = $1 and status in')) &&
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
    const row = state.bookings.find((item) => String(item.id) === String(params[0]) &&
      (!normalized.includes('status in') || ['pending', 'confirmed', 'modified'].includes(item.status))
    );
    return makeRows(row ? [row] : []);
  }

  if (normalized.startsWith('select * from bookings where status in') && normalized.includes('regexp_replace')) {
    const [serviceType, date, reservationName, originalPhone] = params;
    const rows = state.bookings.filter((item) =>
      ['pending', 'confirmed', 'modified'].includes(item.status) &&
      item.service_type === serviceType &&
      (!date || toDateKey(item.date) === toDateKey(date)) &&
      String(item.reservation_name || '').toLowerCase() === String(reservationName || '').toLowerCase() &&
      String(item.contact_phone || '').replace(/\D/g, '') === originalPhone
    );
    return makeRows(rows.slice().reverse().slice(0, normalized.includes('limit 11') ? 11 : 2));
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
    return makeRows(rows.slice().reverse().slice(0, normalized.includes('limit 11') ? 11 : 1));
  }

  if (normalized.startsWith('select * from bookings order by created_at desc limit $1')) {
    const limit = Number(params[0]) || 50;
    return makeRows([...state.bookings].slice().reverse().slice(0, limit));
  }

  if (normalized.startsWith('select * from bookings where status != \'cancelled\' order by updated_at desc')) {
    const rows = state.bookings.filter((item) => item.status !== 'cancelled')
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    return makeRows(rows.slice(0, Number(params[0])));
  }

  if (normalized.startsWith('select * from bookings where google_event_id is not null')) {
    const rows = state.bookings.filter((item) => item.google_event_id && item.status !== 'cancelled')
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    return makeRows(rows.slice(0, Number(params[0])));
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
    if (normalized.includes('google_event_id = null')) row.google_event_id = null;
    row.updated_at = new Date();
    return makeRows([row]);
  }

  if (normalized.startsWith('update bookings set')) {
    const row = state.bookings.find((item) => String(item.id) === String(params[params.length - 1]) &&
      (!normalized.includes('status in') || ['pending', 'confirmed', 'modified'].includes(item.status))
    );
    if (!row) return makeRows([]);
    applyAssignments(row, normalized, params);
    if (normalized.includes("status = case when status = 'confirmed'") && row.status === 'confirmed') {
      row.status = 'modified';
    }
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
const defaultChatResponse = {
    message: 'ok',
    speak: 'ok',
    intent: 'unknown',
    data: {},
    missing_fields: [],
    confidence: 1,
};
await jest.unstable_mockModule('../services/llm.js', () => ({
  chat: jest.fn(async () => defaultChatResponse),
}));
const upsertCalendarEvent = jest.fn(async () => null);
const calendarEnabled = jest.fn(() => true);
await jest.unstable_mockModule('../services/googleCalendar.js', () => ({
  upsertEvent: upsertCalendarEvent,
  cancelEvent: jest.fn(async () => undefined),
  getEventStatus: jest.fn(async () => ({ available: true, reason: 'found' })),
  isCalendarSyncEnabled: calendarEnabled,
}));
await jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  globalLimiter: (_req, _res, next) => next(),
  chatLimiter: (_req, _res, next) => next(),
  bookingsLimiter: (_req, _res, next) => next(),
  authLimiter: (_req, _res, next) => next(),
}));

const { default: app } = await import('../index.js');
const { createSessionToken } = await import('../middleware/auth.js');
const { chat: mockChat } = await import('../services/llm.js');
const { upsertEvent: mockUpsertEvent, isCalendarSyncEnabled: mockCalendarEnabled,
  getEventStatus: mockGetEventStatus } = await import('../services/googleCalendar.js');

const runRoutes = process.env.NO_LISTEN !== 'true';

(runRoutes ? describe : describe.skip)('route flows', () => {
  beforeEach(() => {
    resetState();
    mockChat.mockReset().mockResolvedValue(defaultChatResponse);
    mockUpsertEvent.mockReset().mockResolvedValue(null);
    mockCalendarEnabled.mockReset().mockReturnValue(true);
    mockGetEventStatus.mockReset().mockResolvedValue({ available: true, reason: 'found' });
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

  describe('manual Google Calendar repair', () => {
    beforeEach(() => {
      query.mockClear();
    });

    function sync(body = { mode: 'bookings' }) {
      return request(app).post('/api/bookings/sync-calendar')
        .set('X-Admin-Token', 'admin-secret').send(body);
    }

    function fixture(overrides) {
      return { ...makeInitialBookings()[1], ...overrides };
    }

    function bookingWrites() {
      return query.mock.calls.filter(([sql]) => normalizeSql(sql).startsWith('update bookings'));
    }

    it('exports missing events and repairs existing events while skipping unconfirmed and genuine waitlist reservations', async () => {
      const rawDate = new Date('2026-10-06T17:00:00Z');
      state.bookings = [
        fixture({ id: 20, google_event_id: null }),
        fixture({ id: 21, status: 'modified', date: rawDate, google_event_id: 'stale-event' }),
        fixture({ id: 22, status: 'pending', waitlisted: true, google_event_id: 'legacy-event' }),
        fixture({ id: 23, waitlisted: true, google_event_id: null }),
        fixture({ id: 24, status: 'pending', google_event_id: null }),
        fixture({ id: 25, status: 'cancelled', google_event_id: 'cancelled-event' }),
      ];
      mockUpsertEvent.mockImplementation(async (booking) => booking.google_event_id || `created-event-${booking.id}`);

      const response = await sync();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        enabled: true, checked: 5,
        synced: [{ id: 20, status: 'synced' }, { id: 21, status: 'synced' }, { id: 22, status: 'synced' }],
        skipped: [{ id: 23, reason: 'waitlisted' }, { id: 24, reason: 'not_confirmed' }],
        errors: [],
      });
      expect(mockUpsertEvent).toHaveBeenCalledTimes(3);
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 21, date: rawDate, google_event_id: 'stale-event' }));
      expect(state.bookings.find((booking) => booking.id === 20).google_event_id).toBe('created-event-20');
      expect(state.bookings.map((booking) => booking.status)).toEqual(['confirmed', 'modified', 'pending', 'confirmed', 'pending', 'cancelled']);
      expect(bookingWrites()).toHaveLength(1);
      expect(normalizeSql(bookingWrites()[0][0])).toBe('update bookings set google_event_id = $1 where id = $2');
      expect(mockGetEventStatus).not.toHaveBeenCalled();
    });

    it('persists the replacement event ID without cancelling a booking whose event was deleted', async () => {
      state.bookings = [fixture({ id: 20, status: 'modified', google_event_id: 'deleted-event' })];
      mockUpsertEvent.mockResolvedValue('replacement-event');

      const response = await sync();

      expect(response.body.synced).toEqual([{ id: 20, status: 'synced' }]);
      expect(state.bookings[0]).toEqual(expect.objectContaining({ status: 'modified', google_event_id: 'replacement-event' }));
      expect(bookingWrites()).toHaveLength(1);
      expect(mockGetEventStatus).not.toHaveBeenCalled();
    });

    it('reports Calendar failures and retains saved statuses and existing event IDs', async () => {
      state.bookings = [
        fixture({ id: 20, status: 'modified', google_event_id: 'existing-event' }),
        fixture({ id: 21, google_event_id: null }),
      ];
      mockUpsertEvent.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Permission denied'));

      const response = await sync();

      expect(response.status).toBe(200);
      expect(response.body.checked).toBe(2);
      expect(response.body.synced).toEqual([]);
      expect(response.body.errors).toEqual([
        { id: 20, error: 'Google Calendar could not be updated.' },
        { id: 21, error: 'Permission denied' },
      ]);
      expect(state.bookings[0]).toEqual(expect.objectContaining({ status: 'modified', google_event_id: 'existing-event' }));
      expect(state.bookings[1]).toEqual(expect.objectContaining({ status: 'confirmed', google_event_id: null }));
      expect(bookingWrites()).toHaveLength(0);
    });

    it('returns disabled without reading or changing bookings when Calendar credentials are missing', async () => {
      mockCalendarEnabled.mockReturnValue(false);

      const response = await sync();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ enabled: false, checked: 0, synced: [], skipped: [], errors: [] });
      expect(query).not.toHaveBeenCalled();
      expect(mockUpsertEvent).not.toHaveBeenCalled();
    });

    it('rejects unknown sync modes before any database or Calendar operations', async () => {
      const response = await sync({ mode: 'unknown' });

      expect(response.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      expect(mockGetEventStatus).not.toHaveBeenCalled();
    });

    it('preserves explicit deletion import for missing Calendar events', async () => {
      state.bookings = [fixture({ id: 20, google_event_id: 'missing-event' })];
      mockGetEventStatus.mockResolvedValue({ available: false, reason: 'missing' });

      const response = await sync({ mode: 'deletions' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ checked: 1, synced: [{ id: 20, status: 'cancelled', reason: 'missing' }], errors: [] });
      expect(state.bookings[0]).toEqual(expect.objectContaining({ status: 'cancelled', google_event_id: null }));
      expect(mockUpsertEvent).not.toHaveBeenCalled();
    });

    it('keeps deletion import as the legacy default and retains records when Calendar status is unavailable', async () => {
      state.bookings = [fixture({ id: 20, google_event_id: 'existing-event' })];
      mockGetEventStatus.mockResolvedValue({ available: null, reason: 'unavailable', error: 'Permission denied' });

      const response = await sync({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ checked: 1, synced: [], errors: [{ id: 20, google_event_id: 'existing-event', error: 'Permission denied' }] });
      expect(state.bookings[0]).toEqual(expect.objectContaining({ status: 'confirmed', google_event_id: 'existing-event' }));
      expect(bookingWrites()).toHaveLength(0);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
    });
  });

  describe('Google Calendar confirmation retries', () => {
    beforeEach(() => {
      query.mockClear();
    });

    function confirm() {
      return request(app).post('/api/chat/confirm')
        .set('X-Session-Id', 'sess-2').set('X-Session-Token', createSessionToken('sess-2'))
        .send({ session_id: 'sess-2', action: 'confirm' });
    }

    function statusWrites() {
      return query.mock.calls.filter(([sql]) => /^update bookings set status/.test(normalizeSql(sql)));
    }

    it('retries the same event for an already confirmed reservation without changing status or notifying twice', async () => {
      state.bookings[1].google_event_id = 'existing-event';
      mockUpsertEvent.mockResolvedValue('existing-event');

      const response = await confirm();

      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({ success: true, booking_id: 2, calendar_sync: { status: 'synced' } }));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 2, status: 'confirmed', google_event_id: 'existing-event' }));
      expect(statusWrites()).toHaveLength(0);
      expect(query.mock.calls.some(([sql]) => normalizeSql(sql).includes('from app_settings'))).toBe(false);
      expect(state.bookings[1].status).toBe('confirmed');
    });

    it('creates a missing event on retry without writing the confirmed status again', async () => {
      mockUpsertEvent.mockResolvedValue('created-on-retry');

      const response = await confirm();

      expect(response.body.calendar_sync).toEqual({ status: 'synced' });
      expect(state.bookings[1].google_event_id).toBe('created-on-retry');
      expect(state.bookings[1].status).toBe('confirmed');
      expect(statusWrites()).toHaveLength(0);
      expect(query.mock.calls.some(([sql]) => normalizeSql(sql).includes('from app_settings'))).toBe(false);
    });

    it.each(['existing-event', null])('retains the confirmed reservation and its %s event ID when a retry fails', async (eventId) => {
      state.bookings[1].google_event_id = eventId;
      mockUpsertEvent.mockResolvedValue(null);

      const response = await confirm();

      expect(response.body).toEqual(expect.objectContaining({ success: true, calendar_sync: { status: 'failed' } }));
      expect(response.body.message).toContain('could not be updated');
      expect(state.bookings[1]).toEqual(expect.objectContaining({ status: 'confirmed', google_event_id: eventId }));
      expect(statusWrites()).toHaveLength(0);
      expect(query.mock.calls.filter(([sql]) => normalizeSql(sql).startsWith('update bookings'))).toHaveLength(0);
    });
  });

  it('keeps reservation changes in edit mode instead of repeating the lookup', async () => {
    seedAlterationInventory();
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

    const lookupRes = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-modify',
        message: 'I want to change my meeting reservation',
      });

    expect(lookupRes.status).toBe(200);
    expect(lookupRes.body.message).toContain('To find your booking');
    expect(lookupRes.body.missing_fields).toEqual(['reservation name']);

    const fieldRes = await request(app)
      .post('/api/chat')
      .send({
        session_id: 'sess-modify',
        message: 'it\'s on 15-05-2026 and name is Talia',
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

  describe('booking lookup corrections', () => {
    let fixtureNumber = 0;
    let sessionId;
    let originalBookings;

    beforeEach(() => {
      sessionId = `sess-lookup-correction-${++fixtureNumber}`;
      state.bookings.push({
        id: 70,
        session_id: sessionId,
        service_type: 'meeting',
        date: '2026-10-14',
        start_time: '10:00:00',
        end_time: '11:00:00',
        reservation_name: 'Stewart',
        people: 6,
        notes: '',
        status: 'confirmed',
        waitlisted: false,
        contact_phone: '0801111111',
        google_event_id: 'existing-meeting-event',
        created_at: new Date('2026-10-01T00:00:00Z'),
        updated_at: new Date('2026-10-01T00:00:00Z'),
      });
      originalBookings = state.bookings.map(cloneRow);
      query.mockClear();
      // Simulate the stale model output that produced the screenshot's date/name drift.
      mockChat.mockResolvedValue({
        ...defaultChatResponse,
        intent: 'modify_booking',
        data: {
          service_type: 'hotel', date: '12-10-2026', reservation_name: 'Stuart',
          people: 99, phone_number: '0809999999',
        },
      });
    });

    async function send(message) {
      const response = await request(app).post('/api/chat').send({ session_id: sessionId, message });
      expect(response.status).toBe(200);
      return response;
    }

    async function startFailedLookup() {
      const response = await send('I want to change my meeting reservation on 14-10-2026 under the name Stuart');
      expect(response.body.message).toMatch(/phone/i);
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '14-10-2026', service_type: 'meeting', reservation_name: 'Stuart',
        modify_step: 'awaiting_verification',
      }));
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expectLookupDidNotMutateBookings();
    }

    function expectLookupDidNotMutateBookings() {
      expect(state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      const bookingWrites = query.mock.calls.filter(([sql]) =>
        /^(?:insert into|update|delete from) bookings\b/.test(normalizeSql(sql))
      );
      expect(bookingWrites).toEqual([]);
    }

    it.each(['Stewart', 'The name is Stewart'])(
      'corrects the name with "%s" without changing the date or service',
      async (correction) => {
        await startFailedLookup();
        const response = await send(correction);
        expect(response.body.message).toContain("I've found your meeting reservation for 14-10-2026");
        expect(response.body.data).toEqual(expect.objectContaining({
          date: '14-10-2026', service_type: 'meeting', reservation_name: 'Stewart',
          edit_booking_id: 70, modify_step: 'choose_field', people: 6,
        }));
        expect(mockChat).not.toHaveBeenCalled();
        expectLookupDidNotMutateBookings();
      }
    );

    it.each(['May', 'Friday'])('does not treat the explicit name "%s" as a date correction', async (name) => {
      await startFailedLookup();
      const response = await send(`The name is ${name}`);
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '14-10-2026', service_type: 'meeting', reservation_name: name,
        modify_step: 'awaiting_verification',
      }));
      expect(mockChat).not.toHaveBeenCalled();
      expectLookupDidNotMutateBookings();
    });

    it('changes only the explicitly corrected date while retaining the lookup name and service', async () => {
      await startFailedLookup();
      const response = await send('Actually, 12-10-2026');
      expect(response.body.message).toMatch(/phone/i);
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '12-10-2026', service_type: 'meeting', reservation_name: 'Stuart',
        modify_step: 'awaiting_verification',
      }));
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(mockChat).not.toHaveBeenCalled();
      expectLookupDidNotMutateBookings();
    });

    it('preserves the pending criteria when the user repeats a lookup without supplying new details', async () => {
      await startFailedLookup();
      const response = await send('Find my reservation');
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '14-10-2026', service_type: 'meeting', reservation_name: 'Stuart',
        modify_step: 'awaiting_verification',
      }));
      expect(response.body.message).toMatch(/phone/i);
      expect(mockChat).not.toHaveBeenCalled();
      expectLookupDidNotMutateBookings();
    });

    it('fills a missing reservation type without starting a new booking or losing the date/name', async () => {
      const incomplete = await send('I want to change my reservation on 14-10-2026 under the name Stewart');
      expect(incomplete.body.missing_fields).toEqual(['type of reservation']);
      expect(incomplete.body.data.modify_step).toBe('awaiting_lookup');
      expectLookupDidNotMutateBookings();

      const response = await send('meeting');
      expect(response.body.message).toContain("I've found your meeting reservation for 14-10-2026");
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '14-10-2026', service_type: 'meeting', reservation_name: 'Stewart',
        edit_booking_id: 70, modify_step: 'choose_field',
      }));
      expect(mockChat).not.toHaveBeenCalled();
      expectLookupDidNotMutateBookings();
    });
  });

  describe('reservation type understanding', () => {
    let fixtureNumber = 0;
    let sessionId;
    let originalBookings;
    const originalTimezone = process.env.CALENDAR_TIMEZONE;

    beforeEach(() => {
      process.env.CALENDAR_TIMEZONE = 'Asia/Bangkok';
      jest.useFakeTimers({
        now: new Date('2026-10-05T07:00:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'hrtime', 'performance', 'queueMicrotask'],
      });
      sessionId = `sess-service-understanding-${++fixtureNumber}`;
      state.bookings.push({
        id: 80,
        session_id: sessionId,
        service_type: 'meeting',
        date: '2026-10-14',
        start_time: '10:00:00',
        end_time: '11:00:00',
        reservation_name: 'Steward',
        people: 6,
        notes: '',
        status: 'confirmed',
        waitlisted: false,
        contact_phone: '0801111111',
        google_event_id: 'existing-meeting-event',
        created_at: new Date('2026-10-01T00:00:00Z'),
        updated_at: new Date('2026-10-01T00:00:00Z'),
      });
      originalBookings = state.bookings.map(cloneRow);
      query.mockClear();
      // An incorrect model reconstruction must not override explicit user criteria.
      mockChat.mockResolvedValue({
        ...defaultChatResponse,
        intent: 'book_restaurant',
        data: { service_type: 'restaurant', date: '12-10-2026', reservation_name: 'Stuart', people: 2 },
      });
    });

    afterEach(() => {
      jest.useRealTimers();
      if (originalTimezone === undefined) delete process.env.CALENDAR_TIMEZONE;
      else process.env.CALENDAR_TIMEZONE = originalTimezone;
    });

    async function send(message) {
      const response = await request(app).post('/api/chat').send({ session_id: sessionId, message });
      expect(response.status).toBe(200);
      return response;
    }

    function expectNoBookingChanges() {
      expect(state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      expect(query.mock.calls.filter(([sql]) =>
        /^(?:insert into|update|delete from) bookings\b/.test(normalizeSql(sql))
      )).toEqual([]);
    }

    function expectMeetingFound(response) {
      expect(response.body.intent).toBe('modify_booking');
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: 'meeting', date: '14-10-2026', reservation_name: 'Steward',
        edit_booking_id: 80, modify_step: 'choose_field',
      }));
      expect(mockChat).not.toHaveBeenCalled();
      expectNoBookingChanges();
    }

    it.each(['alter', 'amend'])(
      'starts an existing-reservation lookup for "%s a booking" without asking the model',
      async (verb) => {
        const response = await send(`I would like to ${verb} a booking`);
        expect(response.body.intent).toBe('modify_booking');
        expect(response.body.data.modify_step).toBe('awaiting_lookup');
        expect(response.body.missing_fields).toEqual(['type of reservation', 'reservation name']);
        expect(mockChat).not.toHaveBeenCalled();
        expectNoBookingChanges();
      }
    );

    it('uses the explicitly stated meeting type in the screenshot sentence, despite the word table', async () => {
      await send('I would like to alter a booking');
      const response = await send('The date is next Wednesday and the table reservation is meeting and the name is Steward');
      expectMeetingFound(response);
    });

    it.each(['meeting room', 'conference room', 'boardroom'])(
      'recognizes a %s reservation as a meeting rather than a hotel stay',
      async (service) => {
        const response = await send(`Find my ${service} reservation on 14-10-2026 under the name Steward`);
        expectMeetingFound(response);
      }
    );

    it.each([
      'the type of reservation is meeting, not booking',
      'meeting, not restaurant',
      'meeting, not a restaurant',
      'not restaurant, meeting',
    ])('corrects only the type with "%s" while keeping the date and name', async (correction) => {
      const failed = await send('I want to change my restaurant reservation on 14-10-2026 under the name Steward');
      expect(failed.body.data).toEqual(expect.objectContaining({
        service_type: 'restaurant', date: '14-10-2026', reservation_name: 'Steward',
        modify_step: 'awaiting_verification',
      }));
      expect(failed.body.data.edit_booking_id).toBeUndefined();
      const response = await send(correction);
      expectMeetingFound(response);
    });

    it('respects an explicit restaurant label when meeting is only incidental context', async () => {
      const restaurant = { ...state.bookings.find((booking) => booking.id === 80), id: 81, service_type: 'restaurant' };
      state.bookings.push(restaurant);
      originalBookings = state.bookings.map(cloneRow);
      const response = await send('I want to amend my booking on 14-10-2026 and the reservation type is restaurant for a meeting with colleagues and the name is Steward');
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: 'restaurant', date: '14-10-2026', reservation_name: 'Steward',
        edit_booking_id: 81, modify_step: 'choose_field',
      }));
      expect(mockChat).not.toHaveBeenCalled();
      expectNoBookingChanges();
    });

    it('asks for clarification when unlabelled reservation types conflict instead of choosing one', async () => {
      const response = await send('I want to alter my hotel or restaurant reservation on 14-10-2026 under the name Steward');
      expect(response.body.intent).toBe('modify_booking');
      expect(response.body.missing_fields).toEqual(['type of reservation']);
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: '', date: '14-10-2026', reservation_name: 'Steward', modify_step: 'awaiting_lookup',
      }));
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(mockChat).not.toHaveBeenCalled();
      expectNoBookingChanges();
      expectMeetingFound(await send('meeting'));
    });

    it('does not silently retain the previous type when a follow-up introduces conflicting types', async () => {
      await send('I want to change my restaurant reservation on 14-10-2026 under the name Steward');
      const response = await send('hotel or restaurant');
      expect(response.body.missing_fields).toEqual(['type of reservation']);
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: '', date: '14-10-2026', reservation_name: 'Steward', modify_step: 'awaiting_lookup',
      }));
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(mockChat).not.toHaveBeenCalled();
      expectNoBookingChanges();
      expectMeetingFound(await send('meeting'));
    });
  });

  describe('reservation recovery across conversations', () => {
    let fixtureNumber = 0;
    let sessionId;
    let originalBookings;

    beforeEach(() => {
      seedAlterationInventory();
      sessionId = `sess-recovery-${++fixtureNumber}`;
      state.bookings.push({
        id: 90,
        session_id: `sess-original-${fixtureNumber}`,
        service_type: 'meeting',
        date: '2026-10-14',
        start_time: '09:00:00',
        end_time: '10:00:00',
        reservation_name: 'Steward',
        people: 7,
        notes: 'Original customer note',
        status: 'confirmed',
        waitlisted: false,
        contact_phone: '080-111-1111',
        contact_email: 'steward@example.com',
        google_event_id: 'recovered-meeting-event',
        created_at: new Date('2026-10-01T00:00:00Z'),
        updated_at: new Date('2026-10-01T00:00:00Z'),
      }, {
        id: 91,
        session_id: sessionId,
        service_type: 'restaurant',
        date: '2026-10-12',
        start_time: '18:00:00',
        end_time: '19:00:00',
        reservation_name: 'Other guest',
        people: 2,
        status: 'pending',
        waitlisted: false,
        contact_phone: '0802222222',
        created_at: new Date('2026-10-05T00:00:00Z'),
        updated_at: new Date('2026-10-05T00:00:00Z'),
      });
      originalBookings = state.bookings.map(cloneRow);
      query.mockClear();
    });

    async function send(message) {
      const response = await request(app).post('/api/chat').send({ session_id: sessionId, message });
      expect(response.status).toBe(200);
      return response;
    }

    async function startRecovery(action = 'alter') {
      return send(`I want to ${action} my meeting reservation on 14-10-2026 under the name Steward`);
    }

    function expectUnverified(response) {
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: 'meeting', date: '14-10-2026', reservation_name: 'Steward',
        modify_step: 'awaiting_verification',
      }));
      expect(response.body.missing_fields).toEqual(['phone number']);
      expect(response.body.data.id).toBeUndefined();
      expect(response.body.data.booking_id).toBeUndefined();
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(response.body.show_cancel_confirm).not.toBe(true);
      expect(response.body.show_reservation_slip).not.toBe(true);
      expect(JSON.stringify(response.body)).not.toMatch(/080-111-1111|steward@example\.com|Original customer note|sess-original-/);
    }

    function expectNoBookingChanges() {
      expect(state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      expect(query.mock.calls.filter(([sql]) =>
        /^(?:insert into|update|delete from) bookings\b/.test(normalizeSql(sql))
      )).toEqual([]);
    }

    function expectRecovered(response) {
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: 'meeting', date: '14-10-2026', reservation_name: 'Steward',
        edit_booking_id: 90, modify_step: 'choose_field', people: 7,
      }));
      expect(response.body.data.session_id).toBeUndefined();
      expect(response.body.message).toContain("I've found your meeting reservation");
    }

    it('requests the original contact phone instead of denying a reservation from another conversation', async () => {
      expectUnverified(await startRecovery());
      expect(mockChat).not.toHaveBeenCalled();
      expect(query.mock.calls.filter(([sql]) => normalizeSql(sql).includes('regexp_replace'))).toEqual([]);
      expectNoBookingChanges();
    });

    it.each(['0801111111', '080 111 1111', 'The original phone number is 080-111-1111'])(
      'recovers exact criteria with the normalized original phone "%s"',
      async (phone) => {
        await startRecovery();
        expectRecovered(await send(phone));
        expect(mockChat).not.toHaveBeenCalled();
        expectNoBookingChanges();
      }
    );

    it('keeps the request unverified after the wrong phone without leaking customer details or changing bookings', async () => {
      await startRecovery();
      expectUnverified(await send('0809999999'));
      expect(mockChat).not.toHaveBeenCalled();
      expectNoBookingChanges();
      expectRecovered(await send('0801111111'));
    });

    it.each([
      ['meeting', '14-10-2026', 'Stuart', 'The name is Steward'],
      ['meeting', '12-10-2026', 'Steward', 'Actually, 14-10-2026'],
      ['restaurant', '14-10-2026', 'Steward', 'The reservation type is meeting'],
    ])('allows a %s/%s/%s criterion correction during verification', async (type, date, name, correction) => {
      await send(`I want to alter my ${type} reservation on ${date} under the name ${name}`);
      expectUnverified(await send(correction));
      expectRecovered(await send('0801111111'));
      expectNoBookingChanges();
    });

    it('offers a choice instead of silently choosing when verified details match multiple active reservations', async () => {
      state.bookings.push({ ...state.bookings.find((booking) => booking.id === 90), id: 92 });
      originalBookings = state.bookings.map(cloneRow);
      await startRecovery();
      const response = await send('0801111111');
      expect(response.body.data.modify_step).toBe('awaiting_selection');
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(response.body.data.reservation_options).toHaveLength(2);
      expect(response.body.message).toMatch(/which (?:one|.*reservation)/i);
      expectNoBookingChanges();
    });

    it('accepts an ISO date correction during verification without interpreting it as a phone number', async () => {
      await send('I want to alter my meeting reservation on 12-10-2026 under the name Steward');
      expectUnverified(await send('2026-10-14'));
      expect(query.mock.calls.filter(([sql]) => normalizeSql(sql).includes('regexp_replace'))).toEqual([]);
      expectRecovered(await send('0801111111'));
      expectNoBookingChanges();
    });

    it('does not parse a labelled date-shaped original phone as a lookup date correction', async () => {
      state.bookings.find((booking) => booking.id === 90).contact_phone = '2026-10-12';
      originalBookings = state.bookings.map(cloneRow);
      await startRecovery();
      expectRecovered(await send('The phone number is 2026-10-12'));
      expectNoBookingChanges();
    });

    it('updates the verified selected booking while preserving its original session and the newer current-session reservation', async () => {
      await startRecovery();
      expectRecovered(await send('0801111111'));
      const response = await send('Change the date to 15-10-2026 and the guests to eight');
      expect(response.body.data.date).toBe('15-10-2026');
      expect(response.body.data.people).toBe(8);
      expect(response.body.data.session_id).toBeUndefined();
      expect(state.bookings.find((booking) => booking.id === 90)).toEqual(expect.objectContaining({
        date: '2026-10-15', people: 8, status: 'modified', session_id: `sess-original-${fixtureNumber}`,
      }));
      expect(state.bookings.find((booking) => booking.id === 91)).toEqual(originalBookings.find((booking) => booking.id === 91));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 90, date: '2026-10-15', people: 8 }));
    });

    it('cancels the recovered selection rather than the newest booking from the current conversation', async () => {
      expectUnverified(await startRecovery('cancel'));
      const verified = await send('0801111111');
      expect(verified.body.intent).toBe('cancel_booking');
      expect(verified.body.show_cancel_confirm).toBe(true);
      expect(verified.body.data.edit_booking_id).toBe(90);
      expect(verified.body.data.session_id).toBeUndefined();
      expectNoBookingChanges();

      const response = await request(app).post('/api/chat/confirm')
        .set('X-Session-Token', verified.body.session_token)
        .send({ session_id: sessionId, action: 'cancel' });
      expect(response.status).toBe(200);
      expect(response.body.booking_id).toBe(90);
      expect(state.bookings.find((booking) => booking.id === 90).status).toBe('cancelled');
      expect(state.bookings.find((booking) => booking.id === 91)).toEqual(originalBookings.find((booking) => booking.id === 91));
    });

    it('uses the recovered selection for "cancel my meeting" and revokes edit access once cancelled', async () => {
      await startRecovery();
      await send('0801111111');
      const selected = await send('Cancel my meeting');
      expect(selected.body.intent).toBe('cancel_booking');
      expect(selected.body.show_cancel_confirm).toBe(true);
      expect(selected.body.data.edit_booking_id).toBe(90);
      expect(selected.body.missing_fields).toEqual([]);
      const cancelled = await request(app).post('/api/chat/confirm')
        .set('X-Session-Token', selected.body.session_token)
        .send({ session_id: sessionId, action: 'cancel' });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.booking_id).toBe(90);
      mockUpsertEvent.mockClear();
      originalBookings = state.bookings.map(cloneRow);
      const laterEdit = await send('Change the guests to eight');
      expect(laterEdit.body.data.edit_booking_id).toBeUndefined();
      expect(state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
    });

    it('does not edit or resync a selected reservation that has since been cancelled', async () => {
      await startRecovery();
      await send('0801111111');
      state.bookings.find((booking) => booking.id === 90).status = 'cancelled';
      originalBookings = state.bookings.map(cloneRow);
      const response = await send('Change the guests to eight');
      expect(response.body.message).not.toContain("updated your meeting reservation");
      expect(state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
    });

    it('does not cancel a different current-session booking while the requested reservation is still unverified', async () => {
      const pending = await startRecovery('cancel');
      const response = await request(app).post('/api/chat/confirm')
        .set('X-Session-Token', pending.body.session_token)
        .send({ session_id: sessionId, action: 'cancel' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expectNoBookingChanges();
    });

    it('confirms the modified recovered selection rather than the latest current-session reservation', async () => {
      await startRecovery();
      await send('0801111111');
      const updated = await send('Change the guests to eight');
      expect(state.bookings.find((booking) => booking.id === 90).status).toBe('modified');
      mockUpsertEvent.mockClear();
      const response = await request(app).post('/api/chat/confirm')
        .set('X-Session-Token', updated.body.session_token)
        .send({ session_id: sessionId, action: 'confirm' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.booking_id).toBe(90);
      expect(state.bookings.find((booking) => booking.id === 90).status).toBe('confirmed');
      expect(state.bookings.find((booking) => booking.id === 91)).toEqual(originalBookings.find((booking) => booking.id === 91));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 90, people: 8 }));
    });

    it('does not fall back to another booking if the recovered selection is no longer active', async () => {
      await startRecovery();
      const verified = await send('0801111111');
      state.bookings.find((booking) => booking.id === 90).status = 'cancelled';
      originalBookings = state.bookings.map(cloneRow);
      const response = await request(app).post('/api/chat/confirm')
        .set('X-Session-Token', verified.body.session_token)
        .send({ session_id: sessionId, action: 'cancel' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expectNoBookingChanges();
    });

    it('rejects a submitted booking ID that differs from the server-verified selection', async () => {
      await startRecovery();
      const verified = await send('0801111111');
      const response = await request(app).post('/api/chat/confirm')
        .set('X-Session-Token', verified.body.session_token)
        .send({ session_id: sessionId, booking_id: 91, action: 'cancel' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expectNoBookingChanges();
    });

    it('does not cancel the latest current-session booking when a recovered selection was lost during reset', async () => {
      await startRecovery();
      const verified = await send('0801111111');
      const reset = await request(app).post('/api/chat/reset')
        .set('X-Session-Token', verified.body.session_token)
        .send({ session_id: sessionId });
      expect(reset.status).toBe(200);
      const response = await request(app).post('/api/chat/confirm')
        .set('X-Session-Token', verified.body.session_token)
        .send({ session_id: sessionId, booking_id: 90, action: 'cancel' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expectNoBookingChanges();
    });

    it.each(['modify_booking', 'cancel_booking'])('applies phone verification to a model-inferred %s too', async (intent) => {
      mockChat.mockResolvedValue({
        ...defaultChatResponse,
        intent,
        data: { service_type: 'meeting', date: '14-10-2026', reservation_name: 'Steward' },
      });
      const response = await send('Please handle that request');
      expectUnverified(response);
      expect(mockChat).toHaveBeenCalledTimes(1);
      expectNoBookingChanges();
      const verified = await send('0801111111');
      expect(verified.body.data.edit_booking_id).toBe(90);
      expect(verified.body.data.session_id).toBeUndefined();
      if (intent === 'cancel_booking') expect(verified.body.show_cancel_confirm).toBe(true);
      else expectRecovered(verified);
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('requires a matching signed session token before clearing stored conversations', async () => {
      state.conversations.push({ session_id: sessionId, role: 'user', content: 'Keep until authorized' });
      const noToken = await request(app).post('/api/chat/reset').send({ session_id: sessionId });
      const anotherSessionToken = await request(app).post('/api/chat/reset')
        .set('X-Session-Token', createSessionToken('another-session'))
        .send({ session_id: sessionId });
      expect(noToken.status).toBe(401);
      expect(anotherSessionToken.status).toBe(401);
      expect(state.conversations).toHaveLength(1);
      expectNoBookingChanges();
    });

    it('returns the signed session token after the first chat fails so that conversation reset still works', async () => {
      mockChat.mockRejectedValueOnce(new Error('Upstream model unavailable'));
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const failed = await request(app).post('/api/chat').send({ session_id: sessionId, message: 'Hello there' });
        expect(failed.status).toBe(500);
        expect(failed.body.session_token).toBe(createSessionToken(sessionId));
        const reset = await request(app).post('/api/chat/reset')
          .set('X-Session-Token', failed.body.session_token)
          .send({ session_id: sessionId });
        expect(reset.status).toBe(200);
        expect(reset.body.success).toBe(true);
        expectNoBookingChanges();
      } finally {
        errorLog.mockRestore();
      }
    });

    it('clears only the signed session conversation and edit grant while preserving reservations', async () => {
      await startRecovery();
      const verified = await send('0801111111');
      state.conversations.push({ session_id: 'different-conversation', role: 'user', content: 'Keep this' });
      const response = await request(app).post('/api/chat/reset')
        .set('X-Session-Token', verified.body.session_token)
        .send({ session_id: sessionId });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(state.conversations).toEqual([{ session_id: 'different-conversation', role: 'user', content: 'Keep this' }]);
      expectNoBookingChanges();
      expectUnverified(await startRecovery());
      expectNoBookingChanges();
    });
  });

  describe('guided reservation alterations', () => {
    let fixtureNumber = 0;
    let sessionId;
    let originalBookings;
    const originalTimezone = process.env.CALENDAR_TIMEZONE;

    beforeEach(() => {
      process.env.CALENDAR_TIMEZONE = 'Asia/Bangkok';
      jest.useFakeTimers({
        now: new Date('2026-10-05T08:00:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'hrtime', 'performance', 'queueMicrotask'],
      });
      sessionId = `sess-guided-alteration-${++fixtureNumber}`;
      state.inventory.push({ id: 1, category: 'meeting', code: 'M1', name: 'Boardroom', capacity: 20, quantity: 1, metadata: {} });
      state.bookings.push({
        id: 200,
        session_id: sessionId,
        service_type: 'meeting',
        date: '2026-10-14',
        start_time: '09:00:00',
        end_time: '10:00:00',
        reservation_name: 'Steward',
        people: 7,
        meeting_room_id: 1001,
        notes: 'Keep this original note',
        status: 'confirmed',
        waitlisted: false,
        contact_phone: '0801111111',
        contact_email: 'steward@example.com',
        google_event_id: 'guided-meeting-event',
        created_at: new Date('2026-10-01T00:00:00Z'),
        updated_at: new Date('2026-10-01T00:00:00Z'),
      });
      originalBookings = state.bookings.map(cloneRow);
      query.mockClear();
      mockUpsertEvent.mockResolvedValue('guided-meeting-event');
      mockChat.mockResolvedValue({
        ...defaultChatResponse,
        intent: 'book_restaurant',
        data: { service_type: 'restaurant', date: '12-10-2026', reservation_name: 'Stuart', people: 99 },
      });
    });

    afterEach(() => {
      jest.useRealTimers();
      if (originalTimezone === undefined) delete process.env.CALENDAR_TIMEZONE;
      else process.env.CALENDAR_TIMEZONE = originalTimezone;
    });

    async function send(message) {
      const response = await request(app).post('/api/chat').send({ session_id: sessionId, message });
      expect(response.status).toBe(200);
      return response;
    }

    function expectNoBookingChanges() {
      expect(state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      expect(query.mock.calls.filter(([sql]) =>
        /^(?:insert into|update|delete from) bookings\b/.test(normalizeSql(sql))
      )).toEqual([]);
    }

    async function chooseUniqueReservation() {
      const opening = await send('I would like to alter a booking');
      expect(opening.body.missing_fields).toEqual(['type of reservation', 'reservation name']);
      expect(opening.body.message).not.toMatch(/need[^.]*date/i);
      expect(opening.body.data.modify_step).toBe('awaiting_lookup');
      expectNoBookingChanges();

      const found = await send('The reservation type is meeting and the name is Steward');
      expect(found.body.data).toEqual(expect.objectContaining({
        edit_booking_id: 200, service_type: 'meeting', reservation_name: 'Steward',
        date: '14-10-2026', modify_step: 'choose_field', people: 7,
      }));
      expect(found.body.message).toMatch(/what would you like to (?:change|alter)/i);
      expectNoBookingChanges();
      return found;
    }

    function addSecondReservation() {
      state.bookings.push({
        ...state.bookings.find((booking) => booking.id === 200),
        id: 201, date: '2026-10-21', start_time: '14:00:00', end_time: '15:00:00',
        google_event_id: 'second-guided-event', created_at: new Date('2026-10-02T00:00:00Z'),
      });
      originalBookings = state.bookings.map(cloneRow);
    }

    async function offerReservationChoices() {
      await send('alter a booking');
      const response = await send('Meeting, the name is Steward');
      expect(response.body.data.modify_step).toBe('awaiting_selection');
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(response.body.data.reservation_options).toHaveLength(2);
      expect(response.body.message).toMatch(/which (?:one|.*reservation)/i);
      expect(JSON.stringify(response.body.data.reservation_options)).not.toMatch(/0801111111|steward@example\.com|guided-meeting-event|sess-guided/);
      expectNoBookingChanges();
      return response;
    }

    it('completes the type/name-only alteration scenario and politely ends after No, Thank you', async () => {
      await chooseUniqueReservation();
      const updated = await send('Change the date to October 16 this year and the guests to eight');
      expect(updated.body.intent).toBe('modify_booking');
      expect(updated.body.message).toContain('updated your meeting reservation');
      expect(updated.body.message).toMatch(/anything else/i);
      expect(state.bookings.find((booking) => booking.id === 200)).toEqual(expect.objectContaining({
        date: '2026-10-16', start_time: '09:00:00', end_time: '10:00:00',
        people: 8, reservation_name: 'Steward', service_type: 'meeting',
        notes: 'Keep this original note', contact_phone: '0801111111', status: 'modified',
      }));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 200, date: '2026-10-16', people: 8 }));

      originalBookings = state.bookings.map(cloneRow);
      query.mockClear();
      mockUpsertEvent.mockClear();
      const goodbye = await send('No, Thank you');
      expect(goodbye.body.intent).toBe('farewell');
      expect(goodbye.body.message).toBe('Very well then, have a nice day.');
      expect(goodbye.body.data).toBeNull();
      expectNoBookingChanges();
      expect(mockChat).not.toHaveBeenCalled();

      const reopened = await send('I would like to alter a booking');
      expect(reopened.body.missing_fields).toEqual(['type of reservation', 'reservation name']);
      expect(reopened.body.data.edit_booking_id).toBeUndefined();
      expect(reopened.body.data.modify_step).toBe('awaiting_lookup');
      expectNoBookingChanges();
    });

    it.each(['Actually, change the guests to nine', 'Thank you, change the guests to nine', 'No, thank you, but change the guests to nine'])(
      'keeps the selected reservation available for a further edit: "%s"',
      async (continuation) => {
        await chooseUniqueReservation();
        await send('Change the guests to eight');
        const response = await send(continuation);
        expect(response.body.intent).toBe('modify_booking');
        expect(response.body.data.edit_booking_id).toBe(200);
        expect(response.body.message).toMatch(/anything else/i);
        expect(state.bookings.find((booking) => booking.id === 200).people).toBe(9);
        expect(state.bookings.find((booking) => booking.id === 200).date).toBe('2026-10-14');
        expect(mockChat).not.toHaveBeenCalled();
      }
    );

    it('reads the labelled 6pm time from a compound date/time amendment and preserves the one-hour duration', async () => {
      await chooseUniqueReservation();
      const response = await send('Change the date to 15-10-2026 and time to 6pm');
      expect(response.body.data.edit_booking_id).toBe(200);
      expect(response.body.data.date).toBe('15-10-2026');
      expect(response.body.data.start_time).toMatch(/^18:00(?::00)?$/);
      expect(response.body.data.end_time).toMatch(/^19:00(?::00)?$/);
      expect(state.bookings.find((booking) => booking.id === 200)).toEqual(expect.objectContaining({
        date: '2026-10-15', reservation_name: 'Steward', people: 7,
      }));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 200, date: '2026-10-15', start_time: expect.stringMatching(/^18:00(?::00)?$/),
        end_time: expect.stringMatching(/^19:00(?::00)?$/),
      }));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('changes an explicitly labelled end time without altering the start time', async () => {
      await chooseUniqueReservation();
      const response = await send('Change the end time to 11am');
      expect(response.body.data.start_time).toMatch(/^09:00(?::00)?$/);
      expect(response.body.data.end_time).toMatch(/^11:00(?::00)?$/);
      expect(response.body.data.date).toBe('14-10-2026');
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 200, start_time: expect.stringMatching(/^09:00(?::00)?$/),
        end_time: expect.stringMatching(/^11:00(?::00)?$/),
      }));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('applies both ends of an explicit spoken meeting time range', async () => {
      await chooseUniqueReservation();
      const response = await send('Change the time from 9am to 11am');
      expect(response.body.data.start_time).toMatch(/^09:00(?::00)?$/);
      expect(response.body.data.end_time).toMatch(/^11:00(?::00)?$/);
      expect(response.body.data.date).toBe('14-10-2026');
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 200, start_time: expect.stringMatching(/^09:00(?::00)?$/),
        end_time: expect.stringMatching(/^11:00(?::00)?$/),
      }));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('accepts second one from multiple reservations and alters only that selected record', async () => {
      addSecondReservation();
      const choices = await offerReservationChoices();
      const selectedId = choices.body.data.reservation_options[1].id;
      const selected = await send('the second one');
      expect(selected.body.data.edit_booking_id).toBe(selectedId);
      expect(selected.body.data.modify_step).toBe('choose_field');
      expectNoBookingChanges();
      const response = await send('Change the guests to eight');
      expect(response.body.data.edit_booking_id).toBe(selectedId);
      expect(state.bookings.find((booking) => booking.id === selectedId).people).toBe(8);
      const untouchedId = selectedId === 200 ? 201 : 200;
      expect(state.bookings.find((booking) => booking.id === untouchedId)).toEqual(originalBookings.find((booking) => booking.id === untouchedId));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('interprets reservation #2 as the authorized reservation ID even when it is the first option', async () => {
      const originalMeeting = state.bookings.find((booking) => booking.id === 200);
      state.bookings = state.bookings.filter((booking) => ![2, 200].includes(booking.id));
      state.bookings.push({
        ...originalMeeting, id: 201, date: '2026-10-21', start_time: '14:00:00', end_time: '15:00:00',
        google_event_id: 'second-guided-event',
      }, { ...originalMeeting, id: 2 });
      originalBookings = state.bookings.map(cloneRow);
      const choices = await offerReservationChoices();
      expect(choices.body.data.reservation_options.map((option) => option.id)).toEqual([2, 201]);
      const selected = await send('reservation #2');
      expect(selected.body.data.edit_booking_id).toBe(2);
      expectNoBookingChanges();
      const updated = await send('Change the guests to eight');
      expect(updated.body.data.edit_booking_id).toBe(2);
      expect(state.bookings.find((booking) => booking.id === 2).people).toBe(8);
      expect(state.bookings.find((booking) => booking.id === 201)).toEqual(originalBookings.find((booking) => booking.id === 201));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('rejects a reservation ID outside the offered authorized choices without selecting or changing a record', async () => {
      addSecondReservation();
      await offerReservationChoices();
      const response = await send('reservation #999');
      expect(response.body.data.modify_step).toBe('awaiting_selection');
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(response.body.data.reservation_options).toHaveLength(2);
      expectNoBookingChanges();
      expect(mockChat).not.toHaveBeenCalled();
    });

    it.each(['October 14', 'the one at 9am'])(
      'selects the correct reservation using plain English: "%s"',
      async (selection) => {
        addSecondReservation();
        await offerReservationChoices();
        const selected = await send(selection);
        expect(selected.body.data.edit_booking_id).toBe(200);
        expect(selected.body.data.date).toBe('14-10-2026');
        expect(selected.body.data.modify_step).toBe('choose_field');
        expectNoBookingChanges();
        expect(mockChat).not.toHaveBeenCalled();
      }
    );

    it('uses a volunteered date to narrow the type/name search to one reservation', async () => {
      addSecondReservation();
      const found = await send('I want to alter my meeting reservation on 21-10-2026 under the name Steward');
      expect(found.body.data.edit_booking_id).toBe(201);
      expect(found.body.data.date).toBe('21-10-2026');
      expect(found.body.data.modify_step).toBe('choose_field');
      expectNoBookingChanges();
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('leaves the selected reservation untouched when its meeting room is occupied at the requested date and time', async () => {
      state.bookings.push({
        ...state.bookings.find((booking) => booking.id === 200),
        id: 202, session_id: 'another-meeting-customer', reservation_name: 'Other guest',
        date: '2026-10-16', google_event_id: 'occupied-room-event',
      });
      originalBookings = state.bookings.map(cloneRow);
      await chooseUniqueReservation();
      const response = await send('Change the date to October 16 this year');
      expect(response.body.message).toMatch(/unavailable|no availability/i);
      expect(response.body.message).not.toContain('updated your meeting reservation');
      expectNoBookingChanges();
      expect(mockChat).not.toHaveBeenCalled();
    });

    it.each(['Change the name to May', 'May'])('changes the name with "%s" without treating it as a new date', async (message) => {
      await chooseUniqueReservation();
      if (message === 'May') await send('name');
      const response = await send(message);
      expect(response.body.data.reservation_name).toBe('May');
      expect(response.body.data.date).toBe('14-10-2026');
      expect(response.body.data.start_time).toMatch(/^09:00(?::00)?$/);
      expect(response.body.data.end_time).toMatch(/^10:00(?::00)?$/);
      expect(state.bookings.find((booking) => booking.id === 200)).toEqual(expect.objectContaining({
        reservation_name: 'May', date: '2026-10-14', start_time: '09:00:00', end_time: '10:00:00', people: 7,
      }));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 200, reservation_name: 'May', date: '2026-10-14', start_time: '09:00:00', end_time: '10:00:00',
      }));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it.each(['Change the notes to arriving on Friday at 6pm', 'arriving on Friday at 6pm'])(
      'keeps the weekday and time in notes "%s" without rescheduling',
      async (message) => {
        await chooseUniqueReservation();
        if (message === 'arriving on Friday at 6pm') await send('notes');
        const response = await send(message);
        expect(response.body.data.notes).toBe('arriving on Friday at 6pm');
        expect(response.body.data.date).toBe('14-10-2026');
        expect(response.body.data.start_time).toMatch(/^09:00(?::00)?$/);
        expect(response.body.data.end_time).toMatch(/^10:00(?::00)?$/);
        expect(state.bookings.find((booking) => booking.id === 200)).toEqual(expect.objectContaining({
          notes: 'arriving on Friday at 6pm', date: '2026-10-14', start_time: '09:00:00', end_time: '10:00:00', people: 7,
        }));
        expect(mockChat).not.toHaveBeenCalled();
      }
    );

    it('separates a labelled guest amendment from notes containing a weekday without changing the schedule', async () => {
      await chooseUniqueReservation();
      const response = await send('Change the notes to arriving Friday and change the guests to eight');
      expect(response.body.data.notes).toBe('arriving Friday');
      expect(response.body.data.people).toBe(8);
      expect(response.body.data.date).toBe('14-10-2026');
      expect(response.body.data.start_time).toMatch(/^09:00(?::00)?$/);
      expect(response.body.data.end_time).toMatch(/^10:00(?::00)?$/);
      expect(state.bookings.find((booking) => booking.id === 200)).toEqual(expect.objectContaining({
        notes: 'arriving Friday', people: 8, date: '2026-10-14', start_time: '09:00:00', end_time: '10:00:00',
      }));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 200, notes: 'arriving Friday', people: 8, date: '2026-10-14', start_time: '09:00:00', end_time: '10:00:00',
      }));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('requires a unique reservation choice before applying an alteration', async () => {
      addSecondReservation();
      await offerReservationChoices();
      const response = await send('Change the guests to eight');
      expect(response.body.data.modify_step).toBe('awaiting_selection');
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(response.body.message).toMatch(/which (?:one|.*reservation)/i);
      expectNoBookingChanges();
    });

    it('does not cancel an unrelated reservation while waiting for a selection', async () => {
      addSecondReservation();
      const choices = await offerReservationChoices();
      const response = await request(app).post('/api/chat/confirm')
        .set('X-Session-Token', choices.body.session_token)
        .send({ session_id: sessionId, action: 'cancel' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expectNoBookingChanges();
    });

    it('recovers reservations across conversations without requiring a date when type, name and original phone match', async () => {
      state.bookings.find((booking) => booking.id === 200).session_id = 'previous-guided-conversation';
      originalBookings = state.bookings.map(cloneRow);
      await send('alter a booking');
      const pending = await send('Meeting, the name is Steward');
      expect(pending.body.data.modify_step).toBe('awaiting_verification');
      expect(pending.body.missing_fields).toEqual(['phone number']);
      expectNoBookingChanges();
      const found = await send('0801111111');
      expect(found.body.data.edit_booking_id).toBe(200);
      expect(found.body.data.date).toBe('14-10-2026');
      expect(found.body.data.modify_step).toBe('choose_field');
      expectNoBookingChanges();
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  describe('new booking reservation types', () => {
    let fixtureNumber = 0;
    let sessionId;
    let originalBookings;

    beforeEach(() => {
      sessionId = `sess-new-service-${++fixtureNumber}`;
      originalBookings = state.bookings.map(cloneRow);
      query.mockClear();
      mockChat.mockResolvedValue({
        ...defaultChatResponse,
        intent: 'book_restaurant',
        data: {
          service_type: 'restaurant', date: '14-10-2026', reservation_name: 'Kai',
          start_time: '', end_time: '', people: null, phone_number: '',
        },
      });
    });

    async function send(message) {
      const response = await request(app).post('/api/chat').send({ session_id: sessionId, message });
      expect(response.status).toBe(200);
      return response;
    }

    function expectNoBookingChanges() {
      expect(state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      expect(query.mock.calls.filter(([sql]) =>
        /^(?:insert into|update|delete from) bookings\b/.test(normalizeSql(sql))
      )).toEqual([]);
    }

    it('keeps an explicit new meeting-room request as a meeting when the model incorrectly chooses restaurant', async () => {
      const response = await send('Book a meeting room on 14-10-2026 under the name Kai');
      expect(response.body.intent).toBe('book_meeting');
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: 'meeting', date: '14-10-2026', reservation_name: 'Kai',
      }));
      expect(response.body.missing_fields).toContain('start_time');
      expectNoBookingChanges();
    });

    it('asks for a reservation type before saving a new request with conflicting types', async () => {
      const response = await send('Book hotel or restaurant on 14-10-2026 under the name Kai');
      expect(response.body.missing_fields).toEqual(['type of reservation']);
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: '', booking_step: 'awaiting_service', service_candidates: ['hotel', 'restaurant'],
        date: '14-10-2026', reservation_name: 'Kai',
      }));
      expectNoBookingChanges();
    });

    it('accepts a bare meeting clarification without losing the saved new-booking date and name', async () => {
      await send('Book hotel or restaurant on 14-10-2026 under the name Kai');
      mockChat.mockResolvedValue({
        ...defaultChatResponse,
        intent: 'book_restaurant',
        data: { service_type: 'restaurant', date: '12-10-2026', reservation_name: 'Stuart' },
      });
      const response = await send('meeting');
      expect(response.body.intent).toBe('book_meeting');
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: 'meeting', date: '14-10-2026', reservation_name: 'Kai',
      }));
      expect(response.body.data.booking_step).not.toBe('awaiting_service');
      expectNoBookingChanges();
    });
  });

  describe('plain-English booking changes', () => {
    let fixtureNumber = 0;
    let sessionId;
    const originalTimezone = process.env.CALENDAR_TIMEZONE;

    beforeEach(() => {
      seedAlterationInventory();
      process.env.CALENDAR_TIMEZONE = 'Asia/Bangkok';
      jest.useFakeTimers({
        now: new Date('2026-10-04T18:30:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'hrtime', 'performance', 'queueMicrotask'],
      });
      sessionId = `sess-natural-modify-${++fixtureNumber}`;
      state.bookings.push({
        id: 50,
        session_id: sessionId,
        service_type: 'hotel',
        date: '2026-10-05',
        end_date: '2026-10-08',
        start_time: '14:00:00',
        end_time: '11:00:00',
        reservation_name: 'Brett',
        people: 4,
        notes: '',
        status: 'confirmed',
        waitlisted: false,
        contact_phone: '0801111111',
        google_event_id: 'existing-calendar-event',
        created_at: new Date(),
        updated_at: new Date(),
      });
      mockUpsertEvent.mockResolvedValue('existing-calendar-event');
    });

    afterEach(() => {
      jest.useRealTimers();
      if (originalTimezone === undefined) delete process.env.CALENDAR_TIMEZONE;
      else process.env.CALENDAR_TIMEZONE = originalTimezone;
    });

    async function openReservationSlip() {
      const response = await request(app).post('/api/chat').send({
        session_id: sessionId, message: 'show me the reservation slip',
      });
      expect(response.status).toBe(200);
      expect(response.body.show_reservation_slip).toBe(true);
      expect(response.body.data.phone_number).toBe('0801111111');
    }

    async function change(message) {
      return request(app).post('/api/chat').send({ session_id: sessionId, message });
    }

    it('applies date, spoken guest count and phone from one choose-field message', async () => {
      await openReservationSlip();
      const response = await change('Change my booking to day after tomorrow, not tomorrow, for five guests, phone number is 0807777777');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '07-10-2026', end_date: '10-10-2026', people: 5,
        contact_phone: '0807777777', phone_number: '0807777777', status: 'modified',
        calendar_sync: { status: 'synced' },
      }));
      expect(response.body.message).toContain('5 guests');
      expect(response.body.message).toContain('Google Calendar has been updated');
      expect(mockChat).not.toHaveBeenCalled();
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        date: '2026-10-07', end_date: '2026-10-10', people: 5, contact_phone: '0807777777',
      }));
      expect(state.bookings.find((item) => item.id === 50).date).toBe('2026-10-07');
    });

    it('accepts a written ordinal date after the ordinary date prompt', async () => {
      await openReservationSlip();
      expect((await change('date')).body.message).toContain('What date would you like instead?');
      const response = await change('seventh October this year');
      expect(response.body.data.date).toBe('07-10-2026');
      expect(response.body.data.end_date).toBe('10-10-2026');
    });

    it('applies the screenshot-shaped restaurant change without asking for values again', async () => {
      Object.assign(state.bookings.find((item) => item.id === 50), {
        service_type: 'restaurant', end_date: null, start_time: '18:00:00', end_time: '19:00:00',
      });
      await openReservationSlip();
      const response = await change("we'll come the day after tomorrow and. the guest is five change the phone number into 0807777777");
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '07-10-2026', people: 5, contact_phone: '0807777777', phone_number: '0807777777',
      }));
      expect(response.body.message).toContain('updated your restaurant reservation');
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        date: '2026-10-07', people: 5, contact_phone: '0807777777',
      }));
    });

    it('retains supplied guest and phone changes while an invalid date is corrected', async () => {
      await openReservationSlip();
      const invalid = await change('Change the date to 31-02-2026 for five guests, phone number 0807777777');
      expect(invalid.body.message).toContain('What date would you like instead?');
      expect(state.bookings.find((item) => item.id === 50).people).toBe(4);
      expect(mockUpsertEvent).not.toHaveBeenCalled();

      const response = await change('tomorrow');
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '06-10-2026', end_date: '09-10-2026', people: 5, phone_number: '0807777777',
      }));
    });

    it('honors an explicit new hotel checkout instead of preserving the old duration', async () => {
      await openReservationSlip();
      const response = await change('Change check-in to seventh October this year and check-out to twelfth October this year');
      expect(response.body.data.date).toBe('07-10-2026');
      expect(response.body.data.end_date).toBe('12-10-2026');
    });

    it('keeps the chosen arrival while correcting an invalid checkout', async () => {
      await openReservationSlip();
      const invalid = await change('Change check-in to seventh October this year and check-out to sixth October this year');
      expect(invalid.body.message).toContain('check-out date must be after');
      const response = await change('twelfth October this year');
      expect(response.body.data.date).toBe('07-10-2026');
      expect(response.body.data.end_date).toBe('12-10-2026');
    });

    it('keeps numeric date/time edits working and accepts a bare phone after its prompt', async () => {
      await openReservationSlip();
      const dated = await change('Change date to 09-10-2026 and time to 09:30');
      expect(dated.body.data.date).toBe('09-10-2026');
      expect(dated.body.data.start_time).toMatch(/^09:30(?::00)?$/);
      expect((await change('phone number')).body.message).toContain('What phone number');
      const response = await change('0808888888');
      expect(response.body.data.phone_number).toBe('0808888888');
    });

    it('reports saved booking changes when Calendar returns no event', async () => {
      await openReservationSlip();
      mockUpsertEvent.mockResolvedValue(null);
      const response = await change('Move the date to tomorrow');
      expect(response.body.data.date).toBe('06-10-2026');
      expect(response.body.data.calendar_sync).toEqual({ status: 'failed' });
      expect(response.body.message).toContain('Google Calendar could not be updated');
      expect(response.body.message).not.toContain('Google Calendar has been updated');
    });

    it.each(['confirmed', 'modified'])('updates an existing Calendar event when a legacy %s reservation retains its waitlist flag', async (status) => {
      Object.assign(state.bookings.find((booking) => booking.id === 50), { status, waitlisted: true });
      await openReservationSlip();

      const response = await change('Move the date to tomorrow');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '06-10-2026', waitlisted: true, status: 'modified', calendar_sync: { status: 'synced' },
      }));
      expect(response.body.message).toContain('Google Calendar has been updated');
      expect(response.body.message).not.toContain('remains on the waitlist');
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 50, date: '2026-10-06', google_event_id: 'existing-calendar-event', waitlisted: true,
      }));
    });

    it('saves a genuine waitlist change without creating a Calendar event or claiming a sync', async () => {
      Object.assign(state.bookings.find((booking) => booking.id === 50), {
        status: 'pending', waitlisted: true, google_event_id: null,
      });
      await openReservationSlip();

      const response = await change('Move the date to tomorrow');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '06-10-2026', waitlisted: true, status: 'pending', calendar_sync: { status: 'not_required' },
      }));
      expect(response.body.message).toContain('remains on the waitlist');
      expect(response.body.message).not.toContain('Google Calendar has been updated');
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      expect(state.bookings.find((booking) => booking.id === 50).google_event_id).toBeNull();
    });

    it('reports disabled Calendar sync without attempting an API call', async () => {
      await openReservationSlip();
      mockCalendarEnabled.mockReturnValue(false);
      const response = await change('five guests');
      expect(response.body.data.people).toBe(5);
      expect(response.body.data.calendar_sync).toEqual({ status: 'disabled' });
      expect(response.body.message).toContain('sync is disabled');
      expect(mockUpsertEvent).not.toHaveBeenCalled();
    });

    it('keeps the booking edit saved if the Calendar operation throws', async () => {
      await openReservationSlip();
      mockUpsertEvent.mockRejectedValue(new Error('Calendar unavailable'));
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const response = await change('Move the date to tomorrow');
        expect(response.status).toBe(200);
        expect(response.body.data.date).toBe('06-10-2026');
        expect(response.body.data.calendar_sync).toEqual({ status: 'failed' });
        expect(response.body.message).toContain('Google Calendar could not be updated');
      } finally {
        errorLog.mockRestore();
      }
    });
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
