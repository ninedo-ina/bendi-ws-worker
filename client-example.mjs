/**
 * ============================================================
 * 文件：apps/ws-worker/client-example.mjs
 * 描述：WebSocket 客户端示例（Workers 版：应用层心跳 + 指数退避重连）
 * 作者：fntp
 * 创建时间：2026-09-08
 * 关联文档：docs/requirements-v3.md R4 实时通信
 * ------------------------------------------------------------
 * 用法（Node 22+，或 npm i ws 后用 Node 20）：
 *   node apps/ws-worker/client-example.mjs \
 *     --url wss://bendi-ws-worker.<subdomain>.workers.dev/ws \
 *     --token <WS_AUTH_TOKEN> \
 *     --room demo
 *
 * 与 Node 版的差异（适配 Cloudflare Workers）：
 *  1. Workers 的 WebSocket **不支持服务端主动发协议级 Ping 帧**，
 *     因此心跳走**应用层**：服务端发 {"t":"ping"}，客户端必须回
 *     {"t":"pong"} —— 否则超过宽限期会被服务端断开；
 *  2. 其余（clientId 持久化、指数退避、重连恢复订阅）与 Node 版一致。
 * ============================================================
 */

// 生成持久化 clientId
import { randomUUID } from 'node:crypto';
// WebSocket 客户端（Node 22 内置；低版本请先 npm i ws）
import WebSocket from 'ws';

/** 解析命令行参数 */
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

/** 服务地址（wss://<worker 域名>/ws） */
const url = getArg('url', 'ws://localhost:8787/ws');
/** 鉴权令牌 */
const token = getArg('token', '');
/** 要加入的房间 */
const room = getArg('room', 'demo');

/**
 * 持久化的客户端标识。
 * 生产请存 localStorage（Web）或本地文件（Node）——
 * 保持同一个 clientId 是「重连自动恢复房间订阅」的前提。
 */
const clientId = `node_${randomUUID().slice(0, 8)}`;

/** 当前连接 */
let socket = null;
/** 重连次数 */
let retries = 0;
/** 是否主动关闭 */
let closedByUser = false;

/** 退避上限（毫秒） */
const MAX_BACKOFF = 30_000;

/**
 * 指数退避 + ±20% 抖动（避免大量客户端同时重连造成惊群）。
 *
 * @returns 等待毫秒数
 */
function backoff() {
  const base = Math.min(1000 * 2 ** retries, MAX_BACKOFF);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * 建立连接（断开后自动重连）。
 */
function connect() {
  const target = new URL(url);
  if (token) target.searchParams.set('token', token);
  target.searchParams.set('clientId', clientId);

  console.log(`[client] connecting ${target.origin}${target.pathname} (retry=${retries})`);
  socket = new WebSocket(target.toString());

  socket.on('open', () => {
    retries = 0;
    console.log('[client] connected');
    // 重连后重新加入房间（服务端若在会话保留期内会自动恢复，重复 join 幂等）
    socket.send(JSON.stringify({ t: 'join', room }));
  });

  socket.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(String(buf));
    } catch {
      return;
    }
    // 关键：回应服务端的应用层 ping，否则会被判定为死连接
    if (msg.t === 'ping') {
      socket.send(JSON.stringify({ t: 'pong' }));
      return;
    }
    if (msg.t === 'welcome') {
      console.log(`[client] welcome: clientId=${msg.clientId}, rooms=${JSON.stringify(msg.rooms)}`);
      return;
    }
    console.log('[client] message:', JSON.stringify(msg));
  });

  socket.on('close', (code, reason) => {
    console.log(`[client] closed: code=${code} reason=${reason || '-'}`);
    if (closedByUser) return;
    // 鉴权失败（Worker 返回 401，连接被拒）不重连
    if (code === 1006 || code === 1008 || code === 401) {
      console.error('[client] 连接被拒绝，请检查 token 是否与服务端 WS_AUTH_TOKEN 一致');
      return;
    }
    const wait = backoff();
    retries += 1;
    console.log(`[client] reconnect in ${wait}ms …`);
    setTimeout(connect, wait);
  });

  socket.on('error', (err) => {
    console.error('[client] error:', err.message);
  });
}

// 启动
connect();

// Ctrl+C：主动关闭，不再重连
process.on('SIGINT', () => {
  closedByUser = true;
  socket?.close(1000, 'client shutdown');
  process.exit(0);
});
