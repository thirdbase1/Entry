/**
 * Replaces packages/backend/server/src/base/websocket/{adapter,config,options}.ts
 * (the NestJS + socket.io + @nestjs/platform-socket.io realtime layer).
 *
 * Confirmed real & current (vercel.com/changelog/websocket-support-is-now-in-public-beta,
 * 22 Jun 2026, public beta): Vercel Functions can now serve WebSocket
 * connections using standard Node.js libraries — no special config, and
 * "Higher-level libraries like Socket.IO are also supported." The
 * confirmed shape is a Function file that does the Express + http.Server +
 * `new WebSocketServer/Server(server)` dance and does `export default server`.
 * This file follows that exact pattern with socket.io instead of raw `ws`
 * (the original used socket.io, so this keeps the same client-side
 * protocol/reconnection semantics — no client changes needed).
 *
 * Redis adapter: kept `@socket.io/redis-adapter` + ioredis exactly like the
 * original (multiple warm Function instances need pub/sub to broadcast to
 * each other's connected sockets) — just pointed at Upstash's Redis
 * connection string instead of a self-hosted Redis, since Upstash speaks
 * the real Redis TCP protocol (see packages/cache's header comment for the
 * verification).
 *
 * Auth: the original's `canActivate` hook (checked per-connection before
 * accepting the socket) is preserved as a pluggable `authenticate` function.
 * Now wired to the real session check via `@entry/auth`'s `getUserSession()`
 * — reads the session + user cookies from the socket handshake headers,
 * looks up the session in the DB, rejects if invalid or expired.
 *
 * Event contract (doc sync awareness/update messages, notification pushes,
 * etc.): the original repo has no dedicated `@WebSocketGateway` classes with
 * `@SubscribeMessage` handlers for this — the doc-sync protocol is driven by
 * BlockSuite's y-provider client library talking a generic message shape.
 * That contract will be wired here once Phase 3 (frontend/BlockSuite
 * integration) defines exactly what it expects; this file provides the
 * transport + auth + horizontal-scaling plumbing that layer needs.
 */
import { createServer } from 'node:http';

import { createAdapter } from '@socket.io/redis-adapter';
import express from 'express';
import { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';

import { auth } from '@entry/auth';

export type SocketAuthenticator = (socket: Socket) => Promise<boolean>;

/**
 * Real session-based authentication for WebSocket connections.
 * Reads the session + user cookies from the socket handshake,
 * looks up the session in the DB via getUserSession(), rejects if
 * invalid or expired.
 */
const defaultAuthenticate: SocketAuthenticator = async (socket) => {
  const cookies = socket.handshake.headers.cookie;
  if (!cookies) return false;

  // Better Auth stores the session token in a cookie named 'better-auth.session_token'
  // Validate it by constructing a fake Request with the cookie header and calling
  // auth.api.getSession() — the canonical way to check a Better Auth session.
  const headers = new Headers();
  headers.set('cookie', cookies);

  try {
    const session = await auth.api.getSession({ headers });
    if (!session) return false;

    // Attach user info to socket for downstream use
    (socket as any).userId = session.user.id;
    return true;
  } catch {
    return false;
  }
};

function redisClient(url: string | undefined): Redis {
  if (!url) throw new Error('UPSTASH_REDIS_URL is not set (required for the socket.io Redis pub/sub adapter)');
  return new Redis(url, { tls: url.startsWith('rediss://') ? {} : undefined, maxRetriesPerRequest: 3 });
}

export function createRealtimeServer(authenticate: SocketAuthenticator = defaultAuthenticate) {
  const app = express();
  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST'],
    },
  });

  io.use((socket, next) => {
    authenticate(socket)
      .then(ok => (ok ? next() : next(new Error('Authentication required'))))
      .catch(next);
  });

  const pubClient = redisClient(process.env.UPSTASH_REDIS_URL ?? process.env.REDIS_URL ?? process.env.KV_URL);
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));

  const originalClose = io.close.bind(io);
  io.close = (fn?: (err?: Error) => void) => {
    subClient.disconnect();
    return originalClose(fn);
  };

  return { app, httpServer, io };
}

const { httpServer } = createRealtimeServer();

// Vercel Functions convention confirmed live in the changelog example:
// `export default server;` where `server` is the http.Server instance.
export default httpServer;
