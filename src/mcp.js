// Attendance MCP surface — maps agent tools onto the same data layer the REST
// hot path uses. Pure JSON-RPC logic; the HTTP/envelope concerns live in server.js.
import * as db from './db.js';
import { dayReport, FLAG_WORDS } from './integrity.js';

const PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'mark_attendance',
    description: 'Mark the current user present or absent',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['present', 'absent'] } },
      required: ['status'],
    },
  },
  {
    name: 'who_is_present',
    description:
      'List the employees who are PRESENT today (checked in at least once), with their names. Use this to answer "who is present / here / in today".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'who_is_absent',
    description:
      'List the enrolled employees who are ABSENT today (no check-in), with their names. Use this to answer "who is absent / off / not in today".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'attendance_summary',
    description:
      'Today\'s full attendance in one call: present, absent, and late lists (each with names) plus counts. Use this for "attendance today", "who is in/out", or an overview.',
    inputSchema: {
      type: 'object',
      properties: { cutoff_hour: { type: 'integer', description: 'Late cutoff hour, default 9.' } },
    },
  },
  {
    name: 'who_is_late',
    description: 'List employees who checked in late today (after the cutoff hour), with their names.',
    inputSchema: { type: 'object', properties: { cutoff_hour: { type: 'integer' } } },
  },
  {
    name: 'list_nfc_tags',
    description:
      'List registered NFC tags — location stickers (each mapped to a zone) and employee badges — set up for this workspace.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'attendance_needs_a_look',
    description:
      "Shifts that need a manager's look before they are approved, each with the phone's evidence in words: away from the zone, phone switched off, stopped answering, Location off, a location made by software, a clock moved by hand, a broken log, a missing check-out. Hours are never cut for these; the manager decides. Default: yesterday and today. Use for \"who needs a look\", \"any attendance problems\", \"was anyone cheating\".",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, YYYY-MM-DD. Default yesterday.' },
        to: { type: 'string', description: 'Last day, YYYY-MM-DD. Default today.' },
      },
    },
  },
  {
    name: 'attendance_day_evidence',
    description:
      "One person's day in full: every check-in and check-out with where it was recorded, the hours, what needs a look, and the phone's evidence in words. Use to answer why a day was flagged, or what someone's phone saw.",
    inputSchema: {
      type: 'object',
      properties: {
        day: { type: 'string', description: 'The day, YYYY-MM-DD.' },
        employee_ref: { type: 'string', description: 'Their id, if known.' },
        name: { type: 'string', description: 'Or their name (or part of it).' },
      },
      required: ['day'],
    },
  },
  {
    name: 'get_my_status',
    description: "Get the current user's attendance status today",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_history',
    description:
      "Get the current user's own attendance history (per-day hours, first-in and last-out) for the last N days. Scoped to the caller only.",
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'How many days back, default 7 (max 90).' } },
    },
  },
];

// ---- Per-caller access (Eesa-owned "appRole" claim is the authority) --------
// The agent path carries appRole ('admin' | 'staff') + employeeRef on the MCP
// tool-call token. appRole decides which tools the caller may reach; the self
// tools are additionally SCOPED to employeeRef so a staff caller only ever
// touches their own records. A caller with no appRole gets nothing.
const STAFF_TOOLS = new Set(['get_my_status', 'get_my_history']);
const ADMIN_TOOLS = new Set([
  'who_is_present', 'who_is_absent', 'attendance_summary', 'who_is_late',
  'list_nfc_tags', 'get_my_status', 'get_my_history',
  'attendance_needs_a_look', 'attendance_day_evidence',
]);
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

function allowedToolsFor(ctx) {
  const role = String((ctx && ctx.appRole) || '').toLowerCase();
  if (role === 'admin') return ADMIN_TOOLS;
  if (role === 'staff') return STAFF_TOOLS;
  return new Set();
}

// The acting user's stable ref for self-scoped tools. Prefer the employeeRef
// claim; fall back to a real sub, but never the sentinel gateway sub.
function callerRef(ctx) {
  if (ctx && ctx.employeeRef) return String(ctx.employeeRef);
  if (ctx && ctx.sub && ctx.sub !== 'gateway') return String(ctx.sub);
  return null;
}

/// [helpers.names](tenantId) → Map(employeeRef → name), from the Eesa roster.
export async function handleRpc(body, ctx, serverInfo, helpers = {}) {
  const { method, params = {} } = body;
  if (method === 'initialize') {
    return { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') {
    // A real per-user call (appRole present) is shown only its role's tools.
    // The gateway/catalog-sync call carries NO appRole — it must see the FULL
    // agent-visible read surface (ADMIN_TOOLS), otherwise the platform's
    // tool-sync would discover zero tools and deactivate the whole plugin.
    // mark_attendance is in no set, so it never appears (agent write-safety).
    // runTool remains the hard per-caller gate regardless of what is listed.
    const visible = ctx && ctx.appRole ? allowedToolsFor(ctx) : ADMIN_TOOLS;
    // Everything listed here is a read (writes go through the REST hot path),
    // and says so. Eesa's tool sync turns readOnlyHint into GET, which is what
    // keeps its write-confirm gate out of the way: unhinted, every attendance
    // question in chat stopped at "type yes to fetch who is present".
    return { tools: TOOLS.filter((t) => visible.has(t.name)).map((t) => ({ ...t, annotations: { readOnlyHint: true } })) };
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    try {
      const result = await runTool(name, args, ctx, helpers);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text', text }], isError: false };
    } catch (e) {
      if (e.code === -32601) throw e;
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  }
  const err = new Error('Unknown method: ' + method);
  err.code = -32601;
  throw err;
}

async function runTool(name, args, ctx, { names = null } = {}) {
  // Unknown tool → JSON-RPC method-not-found (distinct from a permission denial).
  if (!TOOL_NAMES.has(name)) {
    const err = new Error('Unknown tool: ' + name);
    err.code = -32601;
    throw err;
  }
  // Per-caller gating: the appRole claim decides the tool set. Anything the
  // caller's role can't reach (including a caller with no appRole at all) is a
  // clear, non-leaky permission error rather than a silent failure.
  const allowed = allowedToolsFor(ctx);
  if (!allowed.has(name)) {
    throw new Error(`Tool "${name}" is not permitted for your role.`);
  }

  // ---- staff + admin: self-scoped reads (their OWN records via employeeRef) --
  if (name === 'get_my_status' || name === 'get_my_history') {
    const me = callerRef(ctx);
    if (!me) throw new Error('Cannot resolve your identity for this request.');
    if (name === 'get_my_status') return await db.myStatus(ctx.tenantId, me);
    return await db.myHistory(ctx.tenantId, me, Number(args.days) || 7);
  }

  // ---- admin only: tenant-wide reads ----------------------------------------
  if (name === 'who_is_present') {
    const t = await db.attendanceToday(ctx.tenantId);
    return { present: t.present, count: t.counts.present };
  }
  if (name === 'who_is_absent') {
    const t = await db.attendanceToday(ctx.tenantId);
    return { absent: t.absent, count: t.counts.absent };
  }
  if (name === 'attendance_summary') {
    return await db.attendanceToday(ctx.tenantId, args.cutoff_hour || 9);
  }
  if (name === 'who_is_late') {
    const t = await db.attendanceToday(ctx.tenantId, args.cutoff_hour || 9);
    return { late: t.late, count: t.counts.late };
  }
  if (name === 'list_nfc_tags') {
    return { tags: await db.listNfcTags(ctx.tenantId) };
  }
  if (name === 'attendance_needs_a_look' || name === 'attendance_day_evidence') {
    const tz = await db.getTenantTimezone(ctx.tenantId);
    const byRef = names ? await names(ctx.tenantId).catch(() => new Map()) : new Map();
    const report = (row) => dayReport(row, { name: byRef.get(String(row.employeeRef)), tz });
    if (name === 'attendance_needs_a_look') {
      const today = db.localDay(Date.now(), tz);
      const from = isDay(args.from) ? args.from : db.localDay(Date.now() - 864e5, tz);
      const to = isDay(args.to) ? args.to : today;
      const days = (await db.listApprovals(ctx.tenantId, { from, to })).filter((r) => r.needsFix).map(report);
      return { from, to, count: days.length, days };
    }
    if (!isDay(args.day)) throw new Error('day must be YYYY-MM-DD.');
    let ref = args.employee_ref ? String(args.employee_ref) : null;
    if (!ref && args.name) {
      const want = String(args.name).trim().toLowerCase();
      const hits = [...byRef.entries()].filter(([, n]) => String(n).toLowerCase().includes(want));
      if (hits.length !== 1) {
        return { found: false, matches: hits.map(([r, n]) => ({ employee_ref: r, name: n })),
          message: hits.length ? 'Several people match: say which.' : 'Nobody by that name.' };
      }
      ref = hits[0][0];
    }
    if (!ref) throw new Error('Give employee_ref or name.');
    const row = (await db.listApprovals(ctx.tenantId, { from: args.day, to: args.day }))
      .find((r) => String(r.employeeRef) === ref);
    const punches = (await db.eventLog(ctx.tenantId, { employeeRef: ref, from: args.day, to: args.day }))
      .sort((a, b) => new Date(a.at) - new Date(b.at))
      .map((e) => ({
        what: e.type === 'check_in' ? 'Checked in' : 'Checked out',
        at: new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }),
        where: e.zoneName || null,
        how: e.source,
        verified: e.verification,
      }));
    if (!row) return { found: false, employee_ref: ref, name: byRef.get(ref) || null, day: args.day, punches, message: 'Nothing recorded that day.' };
    return { found: true, ...report(row), punches, flagWords: FLAG_WORDS };
  }

  // Safety net: a tool that is defined and in an allowed set but has no handler
  // here (e.g. mark_attendance, which is intentionally kept out of every allowed
  // set so it never reaches this point — writes go through the REST hot path).
  throw new Error(`Tool "${name}" is not available on the agent surface.`);
}

const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
