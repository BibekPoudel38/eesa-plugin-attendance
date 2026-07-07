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
    name: 'who_is_late',
    description: 'List employees who checked in late today',
    inputSchema: { type: 'object', properties: { cutoff_hour: { type: 'integer' } } },
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
  if (name === 'who_is_late') {
    return { late: await db.whoIsLate(ctx.tenantId, args.cutoff_hour || 9) };
  }
  if (name === 'get_my_status') {
    return await db.myStatus(ctx.tenantId, ctx.sub);
  }
  const err = new Error('Unknown tool: ' + name);
  err.code = -32601;
  throw err;
}
