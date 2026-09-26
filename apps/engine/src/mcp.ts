// MCP server: lets Claude (or any MCP client) operate MIDAS as tools.
// A thin stdio wrapper over the engine's authenticated control API, so it runs
// anywhere and inherits the same permissions and audit trail.
//
//   claude mcp add midas -e MIDAS_ENGINE_URL=https://… -e MIDAS_CONTROL_TOKEN=… \
//     -- npx tsx apps/engine/src/mcp.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ENGINE = (process.env.MIDAS_ENGINE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const TOKEN = process.env.MIDAS_CONTROL_TOKEN ?? '';

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${ENGINE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

const asText = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const server = new McpServer({ name: 'midas', version: '0.1.0' });

server.registerTool(
  'midas_status',
  {
    title: 'MIDAS status',
    description: 'Sessions (equity, PnL, status), task queue, LLM spend today, System-1 provider, global halt, and live-trading readiness.',
    annotations: { readOnlyHint: true },
  },
  async () => asText(await call('GET', '/api/status'))
);

server.registerTool(
  'midas_push_news',
  {
    title: 'Push a headline',
    description: 'Inject a news item into the pipeline (triage → reflexes → swarm → decisions). Duplicates are ignored.',
    inputSchema: {
      title: z.string().min(4).describe('headline'),
      summary: z.string().optional().describe('one-paragraph summary or body'),
      url: z.string().optional(),
      source: z.string().optional().describe('who reported it'),
    },
  },
  async args => asText(await call('POST', '/api/news', args))
);

server.registerTool(
  'midas_set_session_status',
  {
    title: 'Change a session status',
    description: 'Pause, resume, stop (close positions) or kill a trading session.',
    inputSchema: {
      sessionId: z.string().regex(/^\d+$/),
      status: z.enum(['running', 'paused', 'stopped', 'killed']),
      reason: z.string().optional(),
    },
    annotations: { destructiveHint: true },
  },
  async ({ sessionId, status, reason }) =>
    asText(await call('POST', `/api/sessions/${sessionId}/status`, { status, reason: reason ?? 'via MCP' }))
);

server.registerTool(
  'midas_halt',
  {
    title: 'Global halt',
    description: 'Turn the global kill switch on (no orders anywhere) or off.',
    inputSchema: { on: z.boolean() },
    annotations: { destructiveHint: true },
  },
  async ({ on }) => asText(await call('POST', '/api/halt', { on }))
);

await server.connect(new StdioServerTransport());
