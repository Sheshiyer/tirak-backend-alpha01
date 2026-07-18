import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('App Store release API surface', () => {
  it('does not mount legacy general-conversation or unscoped presence WebSocket routes', () => {
    const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

    expect(indexSource).not.toMatch(/conversationRoutes/);
    expect(indexSource).not.toMatch(/app\.route\('\/api\/conversations'/);
    expect(indexSource).not.toMatch(/app\.get\('\/ws'/);
    expect(indexSource).not.toMatch(/new WebSocketService/);
  });

  it('keeps bearer authentication at the chat route instead of URL query secrets', () => {
    const chatSource = readFileSync(new URL('../../src/routes/chat.ts', import.meta.url), 'utf8');
    const durableObjectSource = readFileSync(
      new URL('../../src/durable-objects/ChatRoom.ts', import.meta.url),
      'utf8'
    );

    expect(chatSource).toContain("chat.use('*', authMiddleware)");
    expect(chatSource).toContain("url.searchParams.set('userId', userId)");
    expect(chatSource).not.toMatch(/searchParams\.set\(['"]token['"]/);
    expect(durableObjectSource).not.toMatch(/searchParams\.get\(['"]token['"]/);
  });
});
