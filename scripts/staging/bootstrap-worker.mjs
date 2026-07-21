const unavailable = () => new Response('T-025 staging bootstrap only; application deployment is not active.', {
  status: 503,
  headers: {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  },
});

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  fetch() {
    return unavailable();
  }
}

export class NotificationService {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  fetch() {
    return unavailable();
  }
}

export default {
  fetch() {
    return unavailable();
  },
};
