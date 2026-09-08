/**
 * ============================================================
 * 文件：apps/ws-worker/src/index.ts
 * 描述：Worker 入口（健康检查 / 内部发布 / WebSocket 鉴权转发）
 * 作者：fntp
 * 创建时间：2026-09-08
 * 关联文档：docs/requirements-v3.md R4 实时通信
 * ------------------------------------------------------------
 * 职责划分：
 *  - 本文件（Worker）：无状态，负责健康检查、CORS、鉴权、内部端点；
 *  - WsHub（Durable Object）：有状态，负责连接、房间、定向推送与心跳。
 *
 * 鉴权放在 Worker 层的好处：非法请求在进入 DO 之前就被拦下，
 *  不消耗 DO 资源，也不污染 DO 里的会话表。
 *
 * 内部发布端点（v3.7 业务接入）：
 *  主站（node-functions）在消息落库后调用 POST /internal/publish，
 *  带上 X-Internal-Token 与 {to:[userId], event}，由 Worker 转发给
 *  DO，DO 再把 {"t":"event", event} 下发给目标用户的全部在线设备。
 *  这是「主站无长连接、Worker 无数据库」架构下的最小耦合方案。
 * ============================================================
 */

// 配置与鉴权
import { readConfig, type Env } from './env';
import { authorize, corsHeaders, safeEqual } from './auth';
// Durable Object 导出（wrangler 需要在此处导出类）
export { WsHub } from './hub';

/** 服务版本 */
const VERSION = '1.0.0';
/** Worker 冷启动时刻 */
const BOOT_AT = Date.now();

/**
 * 构造带 CORS 头的 JSON 响应。
 *
 * @param body 响应体
 * @param headers CORS 头
 * @param status 状态码
 * @returns 响应
 */
function json(body: unknown, headers: Headers, status = 200): Response {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: h });
}

/** DO 统计的默认形状 */
type Stats = { connections: number; sessions: number; rooms: number; users: number };

export default {
  /**
   * 请求入口。
   *
   * @param request 请求
   * @param env 环境绑定
   * @returns 响应
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    // 解析配置与 CORS 头
    const cfg = readConfig(env);
    const cors = corsHeaders(request, cfg.allowedOrigins);
    const url = new URL(request.url);

    // 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // 健康检查（防休眠探针 / 监控用）：顺带向 DO 取一次在线统计
    if (url.pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
      const stats: Stats = { connections: 0, sessions: 0, rooms: 0, users: 0 };
      try {
        const stub = env.WS_HUB.get(env.WS_HUB.idFromName('hub'));
        const res = await stub.fetch('https://hub.internal/__stats');
        const got = (await res.json()) as Stats;
        stats.connections = got.connections ?? 0;
        stats.sessions = got.sessions ?? 0;
        stats.rooms = got.rooms ?? 0;
        stats.users = got.users ?? 0;
      } catch {
        // DO 不可用不影响健康检查返回 200（避免探针误判整个服务挂掉）
      }
      return json(
        {
          status: 'ok',
          service: 'bendi-ws-worker',
          runtime: 'cloudflare-workers',
          version: VERSION,
          uptimeSec: Math.floor((Date.now() - BOOT_AT) / 1000),
          connections: stats.connections,
          sessions: stats.sessions,
          rooms: stats.rooms,
          users: stats.users,
          wsPath: cfg.wsPath,
          // 业务接入后：JWT 与静态令牌任一可用即允许连接
          authRequired: true,
          jwtEnabled: Boolean(cfg.jwtSecret),
          internalEnabled: Boolean(cfg.internalToken),
          ts: Date.now(),
        },
        cors,
      );
    }

    // 根路径：最小说明，便于人工确认服务已就绪
    if (url.pathname === '/' && request.method === 'GET') {
      return json(
        {
          service: 'bendi-ws-worker',
          ws: `wss://${url.host}${cfg.wsPath}?token=<主站 access token 或 WS_AUTH_TOKEN>&clientId=<stable-id>`,
          health: '/health',
        },
        cors,
      );
    }

    // 内部发布：主站把业务事件推给在线用户
    if (url.pathname === '/internal/publish') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, cors, 405);
      // 未配置内部令牌：直接 503（fail-closed，绝不放行未鉴权的发布）
      if (!cfg.internalToken) {
        return json({ error: 'internal endpoint not configured' }, cors, 503);
      }
      const provided = request.headers.get('x-internal-token') || '';
      if (!provided || !safeEqual(provided, cfg.internalToken)) {
        return json({ error: 'unauthorized' }, cors, 401);
      }
      // 读取并转发给 DO（不解析 event 内容，保持透传，Worker 不耦合业务协议）
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, cors, 400);
      }
      const stub = env.WS_HUB.get(env.WS_HUB.idFromName('hub'));
      const res = await stub.fetch('https://hub.internal/__publish', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const result = (await res.json()) as { delivered?: number };
      return json({ ok: true, delivered: result.delivered ?? 0 }, cors);
    }

    // WebSocket 接入
    if (url.pathname === cfg.wsPath) {
      // 鉴权（失败直接 401，不进入 DO）
      const auth = await authorize(request, url, cfg);
      if (!auth.ok) {
        return json({ error: auth.reason }, cors, 401);
      }
      // 转发给单例 DO：已校验的 clientId / userId 放进内部头，避免 DO 重复解析
      const headers = new Headers(request.headers);
      headers.set('x-client-id', auth.clientId);
      headers.set('x-user-id', auth.userId);
      const stub = env.WS_HUB.get(env.WS_HUB.idFromName('hub'));
      return stub.fetch(new Request(request.url, { method: request.method, headers }));
    }

    // 其余路径
    return json({ error: 'not found' }, cors, 404);
  },
} satisfies ExportedHandler<Env>;
