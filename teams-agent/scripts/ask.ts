import { answer } from '../src/answer.js';
import { closeMcpClient } from '../src/mcpClient.js';

const defaults = [
  'Any of our regions degraded right now?',
  'Is there planned maintenance on East US 2?',
  'Is Storage healthy in East US?'
];

// Pass questions as CLI args to drive the agent ad hoc during a demo:
//   npm run ask -- "is Front Door down in Global?"
const questions = process.argv.slice(2).filter(Boolean);
const asked = questions.length > 0 ? questions : defaults;

for (const question of asked) {
  console.log(`Q: ${question}`);
  console.log(`A: ${await answer(question)}`);
  console.log('');
}

await closeMcpClient();
