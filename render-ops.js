const RENDER_API = 'https://api.render.com/v1';

function buildRenderClientFromEnv(fetchImpl = fetch) {
  const token = process.env.RENDER_API_KEY || '';
  const serviceId = process.env.RENDER_SERVICE_ID || 'srv-da8pp1p5efls73e9beo0';
  const ownerId = process.env.RENDER_OWNER_ID || process.env.RENDER_WORKSPACE_ID || '';
  if (!token) return null;

  async function request(path, options = {}) {
    const response = await fetchImpl(`${RENDER_API}${path}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || data?.error || `Render API request failed (${response.status}).`);
    return data;
  }

  async function deployStatus() {
    const data = await request(`/services/${serviceId}/deploys?limit=10`);
    const deploys = (data || []).map(item => item.deploy || item).filter(Boolean);
    return { serviceId, latest: deploys[0] || null, deploys: deploys.slice(0, 10) };
  }

  async function logs(tail = 50) {
    if (!ownerId) throw new Error('RENDER_OWNER_ID is not configured; Render logs require the workspace owner ID.');
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    const params = new URLSearchParams({
      ownerId,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      direction: 'backward',
      limit: String(Math.min(Math.max(Number(tail) || 50, 1), 200))
    });
    params.append('resource', serviceId);
    const data = await request(`/logs?${params.toString()}`);
    return { serviceId, logs: data.logs || data };
  }

  async function redeploy() {
    return request(`/services/${serviceId}/deploys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deployMode: 'build_and_deploy' })
    });
  }

  return { serviceId, deployStatus, logs, redeploy };
}

function renderToolDefinitions() {
  return [
    {
      type: 'function',
      name: 'render_deploy_status',
      description: 'Read the latest deploy status for David’s Personal Agent Render service.',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
    },
    {
      type: 'function',
      name: 'render_logs',
      description: 'Read recent Render logs for David’s Personal Agent. Use for diagnosing failures.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { tail: { type: 'integer', description: 'Approximate number of recent log lines to return.' } },
        required: ['tail'],
        additionalProperties: false
      }
    },
    {
      type: 'function',
      name: 'render_redeploy',
      description: 'Trigger a new deploy of David’s Personal Agent Render service. This changes external state and requires David’s approval.',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
    }
  ];
}

async function executeRenderTool(name, args, client) {
  if (!client) return { ok: false, error: 'Render integration is not configured.' };
  if (name === 'render_deploy_status') return { ok: true, ...(await client.deployStatus()) };
  if (name === 'render_logs') return { ok: true, ...(await client.logs(args.tail)) };
  if (name === 'render_redeploy') return { ok: true, deployment: await client.redeploy() };
  return { ok: false, error: `Unknown Render tool: ${name}` };
}

module.exports = { buildRenderClientFromEnv, renderToolDefinitions, executeRenderTool };
