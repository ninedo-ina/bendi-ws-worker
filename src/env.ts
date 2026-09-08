/**
 * ============================================================
 * 文件：apps/ws-worker/src/env.ts
 * 描述：环境变量绑定类型与配置解析（Workers 版）
 * 作者：fntp
 * 创建时间：2026-09-08
 * 关联文档：docs/requirements-v3.md R4 实时通信
 * ------------------------------------------------------------
 * 说明：
 *  1. 机密（WS_AUTH_TOKEN / JWT_ACCESS_SECRET / INTERNAL_TOKEN）
 *     只通过 wrangler secret 注入，不写进 wrangler.toml；
 *  2. vars 中的数值统一以字符串传入，在此处做整数化与范围收敛；
 *  3. 鉴权默认 fail-closed：
 *     - WS_AUTH_TOKEN 与 JWT_ACCESS_SECRET 都未配置 → 拒绝全部连接；
 *     - INTERNAL_TOKEN 未配置 → POST /internal/publish 返回 503。
 *
 * 为什么要有两套连接凭据：
 *  JWT（主站 access token）能带出 userId，是**定向推送**的寻址依据；
 *  静态令牌用于联调脚本（无 JWT 签发能力），userId 只能从 query 显式传入，
 *  因此这类连接只能收房间广播，收不到按 userId 的定向推送。
 * ============================================================
 */

/** Durable Object 命名空间（由 wrangler 注入） */
export interface HubNamespace {
  /** 按名称定位单例 DO */
  idFromName(name: string): DurableObjectId;
  /** 获取 DO 存根 */
  get(id: DurableObjectId): DurableObjectStub;
}

/** Worker / Durable Object 的环境绑定 */
export interface Env {
  /** WebSocket 状态中枢（单例 Durable Object） */
  WS_HUB: HubNamespace;
  /** 连接鉴权令牌（机密） */
  WS_AUTH_TOKEN?: string;
  /** 主站 Access Token 验签密钥（机密，须与 node-functions 的 JWT_ACCESS_SECRET 完全一致） */
  JWT_ACCESS_SECRET?: string;
  /** 内部发布端点调用令牌（机密） */
  INTERNAL_TOKEN?: string;
  /** WebSocket 路径 */
  WS_PATH?: string;
  /** 允许的来源白名单（逗号分隔） */
  ALLOWED_ORIGINS?: string;
  /** 心跳间隔（毫秒，字符串） */
  HEARTBEAT_INTERVAL_MS?: string;
  /** 死亡判定宽限期（毫秒，字符串） */
  HEARTBEAT_GRACE_MS?: string;
  /** 会话保留时长（毫秒，字符串） */
  SESSION_TTL_MS?: string;
}

/** 解析后的配置（数值已收敛） */
export interface Config {
  /** WebSocket 路径 */
  wsPath: string;
  /** 静态鉴权令牌（空串表示不启用该凭据） */
  authToken: string;
  /** JWT 验签密钥（空串表示不启用 JWT） */
  jwtSecret: string;
  /** 内部端点令牌（空串表示内部端点不可用） */
  internalToken: string;
  /** 来源白名单 */
  allowedOrigins: string[];
  /** 心跳间隔（毫秒） */
  heartbeatIntervalMs: number;
  /** 死亡判定宽限期（毫秒） */
  heartbeatGraceMs: number;
  /** 会话保留时长（毫秒） */
  sessionTtlMs: number;
}

/**
 * 读取并收敛数值型配置。
 *
 * @param raw 原始字符串
 * @param def 缺省值
 * @param min 下界
 * @param max 上界
 * @returns 收敛后的整数
 */
function num(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * 解析配置。
 *
 * @param env 环境绑定
 * @returns 收敛后的配置
 */
export function readConfig(env: Env): Config {
  return {
    wsPath: (env.WS_PATH || '/ws').trim() || '/ws',
    authToken: (env.WS_AUTH_TOKEN || '').trim(),
    jwtSecret: (env.JWT_ACCESS_SECRET || '').trim(),
    internalToken: (env.INTERNAL_TOKEN || '').trim(),
    allowedOrigins: (env.ALLOWED_ORIGINS || '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    heartbeatIntervalMs: num(env.HEARTBEAT_INTERVAL_MS, 30_000, 5_000, 120_000),
    heartbeatGraceMs: num(env.HEARTBEAT_GRACE_MS, 65_000, 10_000, 300_000),
    sessionTtlMs: num(env.SESSION_TTL_MS, 60_000, 0, 600_000),
  };
}
