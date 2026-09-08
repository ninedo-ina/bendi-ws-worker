/**
 * ============================================================
 * 文件：apps/ws-worker/src/auth.ts
 * 描述：连接鉴权与跨域校验（Workers 版，支持 JWT + 静态令牌）
 * 作者：fntp
 * 创建时间：2026-09-08
 * 关联文档：docs/security-review-v3.md
 * ------------------------------------------------------------
 * 与 Node 版的差异：
 *  1. Workers 运行时没有 node:crypto 的 timingSafeEqual，这里用
 *     **手写常量时间比较**（逐字符异或累加），同样避免计时侧信道；
 *  2. 浏览器 WebSocket 无法自定义请求头，因此 `?token=` 是 Web 端唯一
 *     可行的携带方式，服务端按 query → Authorization → 子协议解析；
 *  3. 业务接入后新增 **JWT 校验**：直接用主站签发的 access token，
 *     从而拿到 userId 作为定向推送的寻址依据（对齐 node-functions 的
 *     signAccessToken：HS256 / iss=bendi / aud=bendi-client /
 *     sub=userId / did=deviceId / typ=access）。
 * ============================================================
 */

// JWT 校验（Workers 走 Web Crypto，jose 可用）
import { jwtVerify } from 'jose';

/** JWT 签发者（须与 node-functions 一致） */
const ISSUER = 'bendi';
/** JWT 受众（须与 node-functions 一致） */
const AUDIENCE = 'bendi-client';

/** 鉴权结果 */
export type AuthResult =
  | { ok: true; clientId: string; userId: string }
  | { ok: false; code: number; reason: string };

/**
 * 常量时间比较字符串。
 *
 * 为什么不用 `a === b`：JS 引擎的字符串比较会在首个不同字符处返回，
 * 耗时与「前缀匹配长度」相关，可被计时侧信道逐字符爆破令牌。
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
 * 校验主站签发的 Access Token。
 *
 * 必须显式固定算法为 HS256（杜绝 alg=none / 算法混淆），
 * 并校验签发者与受众，与 node-functions 的 verifyAccessToken 口径一致。
 *
 * @param token JWT 字符串
 * @param secret 验签密钥（JWT_ACCESS_SECRET）
 * @returns 解析出的用户与设备标识；无效返回 null
 */
export async function verifyJwt(
  token: string,
  secret: string,
): Promise<{ userId: string; deviceId: string } | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      clockTolerance: 5,
    });
    // 只接受 access token（refresh token 不得用于建立连接）
    if (payload.typ !== 'access') return null;
    // 主体即用户 ID，缺失则拒绝
    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    if (!userId) return null;
    const deviceId = typeof payload.did === 'string' ? payload.did : '';
    return { userId, deviceId };
  } catch {
    // 过期 / 签名不符 / 受众错误一律视为无效，不区分原因（避免信息泄漏）
    return null;
  }
}

/**
 * 校验主站签发的**服务票据**（typ='service'）。
 *
 * 用途：主站（node-functions）调用内部发布端点时的凭据。
 * 之所以复用 JWT_ACCESS_SECRET 而不是再配一把共享密钥：
 *  少一个需要同步维护的机密，且这把密钥主站本来就有。
 * 票据只认 typ='service'，与登录用的 typ='access' 严格区分，
 * 即便用户拿到自己的 access token 也调不通内部端点。
 *
 * @param token JWT 字符串
 * @param secret 验签密钥（JWT_ACCESS_SECRET）
 * @returns 是否为有效的服务票据
 */
export async function verifyServiceToken(token: string, secret: string): Promise<boolean> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      clockTolerance: 5,
    });
    // 仅接受服务票据
    return payload.typ === 'service';
  } catch {
    return false;
  }
}

/**
 * 校验连接是否允许建立。
 *
 * 凭据优先级：JWT（能带出 userId，业务推送必需）→ 静态令牌（联调用）。
 * 两者都未配置时拒绝全部连接（fail-closed）。
 *
 * @param request 原始请求
 * @param url 已解析的 URL
 * @param cfg 已解析的配置
 * @returns 鉴权结果（含 clientId 与 userId）
 */
export async function authorize(
  request: Request,
  url: URL,
  cfg: { authToken: string; jwtSecret: string; allowedOrigins: string[] },
): Promise<AuthResult> {
  // 来源校验
  if (!originAllowed(request.headers.get('origin'), cfg.allowedOrigins)) {
    return { ok: false, code: 1008, reason: 'origin not allowed' };
  }
  const token = resolveToken(request, url);

  // 方式一：JWT（主站 access token）
  if (cfg.jwtSecret && token) {
    const claims = await verifyJwt(token, cfg.jwtSecret);
    if (claims) {
      // 未显式传 clientId 时按「用户 + 设备」生成，保证多端互不顶替
      const clientId =
        (url.searchParams.get('clientId') || '').trim().slice(0, 64) ||
        `u_${claims.userId}_${claims.deviceId || 'web'}`;
      return { ok: true, clientId, userId: claims.userId };
    }
  }

  // 方式二：静态令牌（联调 / 内部脚本）
  if (cfg.authToken && token && safeEqual(token, cfg.authToken)) {
    const clientId = (url.searchParams.get('clientId') || '').trim().slice(0, 64);
    const userId = (url.searchParams.get('userId') || '').trim().slice(0, 64);
    return {
      ok: true,
      clientId: clientId || `c_${crypto.randomUUID()}`,
      // 静态令牌带不出可信 userId，只能从 query 取（可为空 → 收不到定向推送）
      userId,
    };
  }

  // 无任何有效凭据
  return { ok: false, code: 1008, reason: cfg.jwtSecret || cfg.authToken ? 'unauthorized' : 'server auth not configured' };
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
  headers.set('Access-Control-Allow-Methods', 'GET,POST,HEAD,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Internal-Token');
  headers.set('Access-Control-Max-Age', '86400');
  return headers;
}
