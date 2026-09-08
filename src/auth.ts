/**
 * ============================================================
 * 文件：apps/ws-worker/src/auth.ts
 * 描述：连接鉴权与跨域校验（Workers 版）
 * 作者：fntp
 * 创建时间：2026-09-08
 * 关联文档：docs/security-review-v3.md
 * ------------------------------------------------------------
 * 与 Node 版的差异：
 *  1. Workers 运行时没有 node:crypto 的 timingSafeEqual，这里用
 *     **手写常量时间比较**（逐字符异或累加），同样避免计时侧信道；
 *  2. 浏览器 WebSocket 无法自定义请求头，因此 `?token=` 是 Web 端
 *     唯一可行的携带方式，服务端按 query → Authorization → 子协议
 *     的顺序解析。
 * ============================================================
 */

// 环境类型
import type { Env } from './env';

/** 鉴权结果 */
export type AuthResult = { ok: true; clientId: string } | { ok: false; code: number; reason: string };

/**
 * 常量时间比较字符串。
 *
 * 为什么不用 `a === b`：JS 引擎的字符串比较会在首个不同字符处返回，
 * 比较耗时与「前缀匹配长度」相关，可被计时侧信道逐字符爆破令牌。
 * 这里对全部字符做异或累加，耗时只与长度有关。
 *
 * @param a 字符串一
 * @param b 字符串二
 * @returns 是否相等
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 从请求中解析令牌。
 *
 * @param request 原始请求
 * @param url 已解析的 URL
 * @returns 令牌；未携带返回空串
 */
export function resolveToken(request: Request, url: URL): string {
  // 方式一：query ?token=（浏览器唯一可行）
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) return fromQuery.trim();
  // 方式二：Authorization: Bearer <token>
  const auth = request.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  // 方式三：子协议（部分客户端用 Sec-WebSocket-Protocol 携带）
  const proto = request.headers.get('sec-websocket-protocol');
  if (proto && proto.trim()) return proto.split(',')[0]?.trim() ?? '';
  return '';
}

/**
 * 校验来源是否在白名单内。
 *
 * @param origin 来源（可为空，服务端客户端通常不带）
 * @param allowed 白名单
 * @returns 是否允许
 */
export function originAllowed(origin: string | null, allowed: string[]): boolean {
  if (allowed.includes('*')) return true;
  if (!origin) return true;
  return allowed.some((o) => o.toLowerCase() === origin.toLowerCase());
}

/**
 * 校验 WebSocket 连接是否允许建立。
 *
 * @param request 原始请求
 * @param url 已解析的 URL
 * @param cfg 已解析的配置
 * @returns 鉴权结果
 */
export function authorize(request: Request, url: URL, cfg: { authToken: string; allowedOrigins: string[] }): AuthResult {
  // 来源校验
  if (!originAllowed(request.headers.get('origin'), cfg.allowedOrigins)) {
    return { ok: false, code: 1008, reason: 'origin not allowed' };
  }
  // 令牌校验
  const token = resolveToken(request, url);
  if (!cfg.authToken) {
    // 未配置令牌：fail-closed，拒绝全部连接
    return { ok: false, code: 1008, reason: 'server auth token not configured' };
  }
  if (!token || !safeEqual(token, cfg.authToken)) {
    return { ok: false, code: 1008, reason: 'unauthorized' };
  }
  // 客户端标识（断线重连恢复订阅用）
  const clientId = (url.searchParams.get('clientId') || '').trim().slice(0, 64);
  return { ok: true, clientId };
}

/**
 * 生成 CORS 响应头。
 *
 * @param request 原始请求（读取 Origin）
 * @param allowed 白名单
 * @returns 响应头
 */
export function corsHeaders(request: Request, allowed: string[]): Headers {
  const headers = new Headers();
  const origin = request.headers.get('origin');
  // 白名单含 '*' 时回 '*'；否则仅回匹配的来源（便于携带凭证）
  if (allowed.includes('*')) {
    headers.set('Access-Control-Allow-Origin', '*');
  } else if (origin && originAllowed(origin, allowed)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  headers.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  headers.set('Access-Control-Max-Age', '86400');
  return headers;
}
