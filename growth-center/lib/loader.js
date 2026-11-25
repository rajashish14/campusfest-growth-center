// Reads the attendee workbook into plain JS tables.
// Dates are kept as naive IST strings ("2025-04-12T10:00:00") so comparisons never depend
// on the timezone of the machine running the server.
const XLSX = require('xlsx');

const SHEETS = {
  event: 'Event',
  targets: 'Targets',
  campaigns: 'Campaigns',
  daily: 'Daily Marketing',
  people: 'People',
  interactions: 'Interest and Engagement',
  registrations: 'Registrations',
  regHistory: 'Registration History',
  checkins: 'Check-ins',
};

const DATE_FIELDS = new Set([
  'history_start', 'history_end', 'event_starts_at', 'event_ends_at', 'effective_at', 'created_at',
  'planned_start_at', 'planned_end_at', 'activity_date', 'first_seen_at', 'occurred_at', 'registered_at',
]);

function pad(n) { return String(n).padStart(2, '0'); }

// Excel serial (days since 1899-12-30) -> "YYYY-MM-DDTHH:mm:ss", using UTC math only.
function serialToIso(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function normaliseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return serialToIso(v);
  const s = String(v).trim();
  // ISO text, possibly with +05:30 offset (CSV copy). Drop the offset: everything is IST.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?/);
  if (!m) return s;
  const time = m[2] ? (m[2].length === 5 ? m[2] + ':00' : m[2]) : '00:00:00';
  return `${m[1]}T${time}`;
}

function normaliseRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (DATE_FIELDS.has(k)) {
      const iso = normaliseDate(v);
      out[k] = k === 'activity_date' && iso ? iso.slice(0, 10) : iso;
    } else if (v === '' || v === undefined) {
      out[k] = null;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function readWorkbook(bufferOrPath) {
  const wb = typeof bufferOrPath === 'string'
    ? XLSX.readFile(bufferOrPath, { cellDates: false })
    : XLSX.read(bufferOrPath, { type: 'buffer', cellDates: false });
  const raw = {};
  const missing = [];
  for (const [key, sheet] of Object.entries(SHEETS)) {
    const ws = wb.Sheets[sheet];
    if (!ws) { missing.push(sheet); raw[key] = []; continue; }
    const rows = XLSX.utils.sheet_to_json(ws, { raw: true, defval: null });
    raw[key] = rows.map(normaliseRow);
  }
  if (missing.length) {
    const err = new Error(`Workbook is missing sheets: ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }
  return raw;
}

module.exports = { readWorkbook, SHEETS };
