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

/// Fan a notification out to several people at once — the managers who want to
/// hear about a punch.
///
/// Sends run in parallel and every one of them is allowed to fail: this is
/// called from the check-in path, and a manager's push going missing must never
/// cost the employee their punch. Nothing is awaited by the caller either, so a
/// slow backend cannot hold up the response the phone is waiting on.
export function notifyUsers(tenantId, userIds, payload) {
  const seen = new Set();
  for (const id of userIds || []) {
    const key = String(id || '');
    if (!key || seen.has(key)) continue; // a manager listed twice is still one person
    seen.add(key);
    notifyUser(tenantId, key, payload);
  }
}
