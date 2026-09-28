// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { server } from '../server.ts';

/**
 * The server (plan.md §25.4 H4) over an in-memory transport pair, exactly the shape a real MCP client/server
 * connection has minus the process boundary — the fastest honest way to check its tools actually run the real
 * engine rather than trusting the schema alone.
 */
async function connectedClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = result && typeof result === 'object' && 'content' in result ? result.content : undefined;
  if (!Array.isArray(content)) throw new Error('tool result has no content array');
  const block = (content as { type: string; text?: string }[]).find((c) => c.type === 'text');
  if (!block?.text) throw new Error('tool result has no text content');
  return block.text;
}

interface RunQueryResult {
  error?: { message: string };
  rowCount?: number;
  rows?: Row[];
  narration?: string[];
}
type Row = Record<string, string | number | boolean | null>;
interface ComparePoliciesResult {
  lru: { rowCount: number; evictions: number };
  clock: { rowCount: number; evictions: number };
}

describe('the MCP server', () => {
  afterEach(async () => {
    await server.close();
  });

  it('lists exactly the three tools plan.md §25.4 H4 names', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['compare_policies', 'explain_trace', 'run_query']);
  });

  it('run_query runs a real query against the users dataset and narrates it', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'run_query', arguments: { sql: 'SELECT * FROM users WHERE id = 3' } });
    const body = JSON.parse(textOf(result)) as RunQueryResult;
    expect(body.rowCount).toBe(1);
    expect(body.rows?.[0]?.id).toBe(3);
    expect(body.narration?.some((line) => line.includes('B+Tree'))).toBe(true);
  });

  it('run_query reports a parse error as data, not a thrown tool failure', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'run_query', arguments: { sql: 'SELECT FROM WHERE' } });
    const body = JSON.parse(textOf(result)) as RunQueryResult;
    expect(body.error?.message).toBeTruthy();
  });

  it('run_query reaches every preset dataset by name', async () => {
    const client = await connectedClient();
    for (const [dataset, table] of [['orders', 'orders'], ['logins', 'logins']] as const) {
      const result = await client.callTool({ name: 'run_query', arguments: { sql: `SELECT * FROM ${table}`, dataset } });
      const body = JSON.parse(textOf(result)) as RunQueryResult;
      expect(body.error, `${dataset}: ${JSON.stringify(body)}`).toBeUndefined();
      expect(body.rowCount).toBeGreaterThan(0);
    }
  });

  it('explain_trace with analyze shows the real row count beside the estimate', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'explain_trace', arguments: { sql: 'SELECT * FROM users WHERE id = 3' } });
    const text = textOf(result);
    expect(text).toContain('IndexScan');
    expect(text).toContain('actual 1 rows');
    expect(text).toContain('Buffer pool:');
  });

  it('explain_trace without analyze reads nothing — no buffer-pool line', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'explain_trace', arguments: { sql: 'SELECT * FROM users WHERE id = 3', analyze: false } });
    const text = textOf(result);
    expect(text).toContain('IndexScan');
    expect(text).not.toContain('Buffer pool:');
    expect(text).not.toContain('actual');
  });

  it('compare_policies runs the same query under both policies and returns both real counts', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'compare_policies', arguments: { sql: 'SELECT * FROM users WHERE age > 30' } });
    const body = JSON.parse(textOf(result)) as ComparePoliciesResult;
    expect(body.lru.rowCount).toBe(body.clock.rowCount);
    expect(body.lru.rowCount).toBeGreaterThan(0);
    // The seed table (48 rows, 4/page, 8 frames) is the one plan.md §9 picked specifically because it evicts.
    expect(body.lru.evictions).toBeGreaterThan(0);
    expect(body.clock.evictions).toBeGreaterThan(0);
  });
});
