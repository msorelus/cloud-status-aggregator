import { ActivityHandler, MessageFactory } from '@microsoft/agents-hosting';
import { answer } from './answer.js';

export class StatusBot extends ActivityHandler {
  constructor() {
    super();
    this.onMembersAdded(async (context, next) => {
      await context.sendActivity('Ask me Azure status questions like: “Any of our regions degraded right now?”');
      await next();
    });
    this.onMessage(async (context, next) => {
      const question = context.activity.text?.trim() ?? '';
      if (!question) {
        await context.sendActivity('Please ask an Azure status question.');
      } else {
        const reply = await answer(question);
        await context.sendActivity(MessageFactory.text(reply));
      }
      await next();
    });
  }
}
