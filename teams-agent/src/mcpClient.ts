import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type TextContent = { type: 'text'; text: string };

let clientPromise: Promise<Client> | undefined;

async function createClient(): Promise<Client> {
  const url = process.env.MCP_URL ?? 'http://localhost:8080/mcp';
  const client = new Client({ name: 'teams-status-agent', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return client;
}

async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = createClient();
  }
  return clientPromise;
}

export async function callMcpTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    const client = await getClient();
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as TextContent[] | undefined)?.find((item) => item.type === 'text')?.text;
    if (!text) {
      throw new Error(`MCP tool ${name} returned no text content.`);
    }
    return JSON.parse(text) as T;
  } catch (error) {
    clientPromise = undefined;
    throw error;
  }
}

export async function closeMcpClient(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise;
  clientPromise = undefined;
  await client.close();
}
