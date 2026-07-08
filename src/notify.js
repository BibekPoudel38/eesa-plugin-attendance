// Notify a tenant user (in-app inbox + FCM push) via the main Eesa backend,
// server-to-server with the shared gateway secret. Best-effort — a notification
// failure never blocks the action that triggered it.
const API_BASE = (process.env.EESA_API_BASE || 'https://eesa.ai/api/v1').replace(/\/+$/, '');
const GATEWAY_SECRET = process.env.PLUGIN_GATEWAY_SECRET || '';

export async function notifyUser(tenantId, userId, { title, body = '', type = 'attendance', data = {} }) {
  if (!GATEWAY_SECRET || !tenantId || !userId || !title) return;
  try {
    await fetch(`${API_BASE}/gateway/notify/`, {
      method: 'POST',
      headers: { 'X-Eesa-Gateway-Secret': GATEWAY_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant: tenantId, userId, title, body, type, data }),
    });
  } catch {
    /* best-effort */
  }
}
