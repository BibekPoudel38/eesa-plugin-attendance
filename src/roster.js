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
