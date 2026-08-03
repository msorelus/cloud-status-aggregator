import express, { Response } from 'express';
import { CloudAdapter, authorizeJWT, loadAuthConfigFromEnv, Request } from '@microsoft/agents-hosting';
import { StatusBot } from './bot.js';

const port = Number(process.env.PORT || 3978);
const authConfig = loadAuthConfigFromEnv();
const adapter = new CloudAdapter(authConfig);
const bot = new StatusBot();
const app = express();

app.use(express.json());
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));
app.use(authorizeJWT(authConfig));
app.post('/api/messages', async (req: Request, res: Response) => {
  await adapter.process(req, res, async (context) => bot.run(context));
});

app.listen(port, () => {
  console.log(`Cloud Status Aggregator Teams agent listening on http://localhost:${port}/api/messages`);
  console.log(`MCP_URL=${process.env.MCP_URL ?? 'http://localhost:8080/mcp'}`);
});
