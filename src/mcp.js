// Attendance MCP surface — maps agent tools onto the same data layer the REST
// hot path uses. Pure JSON-RPC logic; the HTTP/envelope concerns live in server.js.
import * as db from './db.js';

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
    name: 'get_my_status',
    description: "Get the current user's attendance status today",
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function handleRpc(body, ctx, serverInfo) {
  const { method, params = {} } = body;
  if (method === 'initialize') {
    return { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    try {
      const result = await runTool(name, args, ctx);
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

async function runTool(name, args, ctx) {
  if (name === 'mark_attendance') {
    const type = args.status === 'absent' ? 'check_out' : 'check_in';
    const ev = await db.recordEvent(ctx.tenantId, ctx.sub, type, {});
    return { marked: args.status, at: ev.at };
  }
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
  if (name === 'get_my_status') {
    return await db.myStatus(ctx.tenantId, ctx.sub);
  }
  const err = new Error('Unknown tool: ' + name);
  err.code = -32601;
  throw err;
}
