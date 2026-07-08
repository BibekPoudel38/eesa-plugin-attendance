// Fetch the tenant's user roster from the main Eesa backend — server-to-server,
// authed with the shared gateway secret — so the plugin's admin UI can list
// users to assign roles to. The main endpoint resolves the token's tenantId to
// the tenant and returns [{id, name, email, platformRole}].
const API_BASE = (process.env.EESA_API_BASE || 'https://eesa.ai/api/v1').replace(/\/+$/, '');
const GATEWAY_SECRET = process.env.PLUGIN_GATEWAY_SECRET || '';

export async function fetchRoster(tenantId) {
  if (!GATEWAY_SECRET || !tenantId) return [];
  const url = `${API_BASE}/gateway/tenant-roster/?tenant=${encodeURIComponent(tenantId)}`;
  const res = await fetch(url, {
    headers: { 'X-Eesa-Gateway-Secret': GATEWAY_SECRET, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`roster fetch failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data.users) ? data.users : [];
}

// Admin diagnostic: WHY is the roster empty? Reports booleans / counts / HTTP
// status and a plain-English reason — NEVER the secret value — so a tenant admin
// can see whether it's a config gap (secret unset/mismatched), a tenant-resolve
// miss, or an unreachable backend. Only run on the empty path (a 2nd fetch).
export async function rosterHealth(tenantId) {
  const diag = {
    apiBase: API_BASE,
    hasSecret: Boolean(GATEWAY_SECRET),
    tenantId: tenantId || null,
    ok: false,
    count: 0,
    status: null,
    error: null,
  };
  if (!GATEWAY_SECRET) {
    diag.error = 'PLUGIN_GATEWAY_SECRET is not set on the plugin service.';
    return diag;
  }
  if (!tenantId) {
    diag.error = 'No tenantId in the session token.';
    return diag;
  }
  try {
    const url = `${API_BASE}/gateway/tenant-roster/?tenant=${encodeURIComponent(tenantId)}`;
    const res = await fetch(url, {
      headers: { 'X-Eesa-Gateway-Secret': GATEWAY_SECRET, Accept: 'application/json' },
    });
    diag.status = res.status;
    if (!res.ok) {
      diag.error =
        res.status === 403
          ? 'The gateway secret was rejected by the backend — PLUGIN_GATEWAY_SECRET differs between the plugin and the backend (or is unset on the backend).'
          : res.status === 404
            ? 'The backend could not resolve this workspace from the token tenantId.'
            : `The backend returned HTTP ${res.status}.`;
      return diag;
    }
    const data = await res.json().catch(() => ({}));
    const users = Array.isArray(data.users) ? data.users : [];
    diag.ok = true;
    diag.count = users.length;
    if (users.length === 0) diag.error = 'The backend resolved the workspace but it has no users.';
    return diag;
  } catch (e) {
    diag.error = `Could not reach the backend at ${API_BASE} (${e.message}).`;
    return diag;
  }
}
