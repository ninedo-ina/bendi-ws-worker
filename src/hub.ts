/**
 * ============================================================
 * 文件：apps/ws-worker/src/hub.ts
 * 描述：WebSocket 状态中枢（Durable Object，单例）
 * 作者：fntp
 * 创建时间：2026-09-08
 * 关联文档：docs/requirements-v3.md R4 实时通信
 * ------------------------------------------------------------
 * 为什么状态必须放在 Durable Object：
 *  Worker 本身无状态且可能在任意节点运行，连接与订阅这类**内存状态**
 *  只能落在 DO 里 —— 它保证同一 key 的实例全局唯一，并天然提供
 *  单线程语义（无需处理并发写 Map 的竞态）。
 *
 * 心跳为什么是「应用层 ping」而不是协议帧：
 *  Workers 的 WebSocket 不支持服务端主动发送协议级 Ping 帧，
 *  因此用 DO 的 **alarm** 定时向每条连接发 `{"t":"ping"}`，
 *  客户端回 `{"t":"pong"}`（或任意消息）刷新 lastSeenAt；
 *  超过宽限期未活跃的连接由 alarm 主动关闭，促客户端重连。
 *
 * 业务寻址（v3.7 接入）：
 *  除 clientId 外，每个会话还记录 **userId**（来自 JWT 的 sub）。
 *  维护 userId → 会话集合 的反向索引，主站即可通过内部端点把
 *  业务事件（消息 / 回执 / 撤回 / 通知 / 通话信令）**定向推送**
 *  给指定用户的全部在线设备（多端同时收到）。
 * ============================================================
 */

// Durable Object 基类（新版 API）
import { DurableObject } from 'cloudflare:workers';
// 环境类型
import type { Env } from './env';

/** 会话（按 clientId 维系，支持断线重连恢复） */
interface Session {
  /** 会话标识 */
  clientId: string;
  /** 所属用户（定向推送寻址用；静态令牌连接可能为空） */
  userId: string;
  /** 当前连接（断开后为 null） */
  ws: WebSocket | null;
  /** 已加入的房间 */
  rooms: Set<string>;
  /** 最近活跃时刻（epoch 毫秒） */
  lastSeenAt: number;
  /** 断开时刻（未断开为 null） */
  disconnectedAt: number | null;
}

/** 客户端消息形状 */
interface ClientMessage {
  /** 消息类型 */
  t?: string;
  /** 房间名 */
  room?: string;
  /** 负载 */
  data?: unknown;
  /** 业务事件（上行转发用） */
  event?: unknown;
}

/** 内部发布请求体 */
interface PublishRequest {
  /** 目标用户 ID 列表（定向推送） */
  to?: string[];
  /** 目标房间（房间广播，与 to 二选一） */
  room?: string;
  /** 业务事件负载 */
  event?: unknown;
  /** 需要排除的会话（通常是发起方自己的设备） */
  exceptClientId?: string;
}

/** 服务版本（与 package.json 保持一致） */
const VERSION = '1.0.0';

/**
 * WebSocket 状态中枢。
 *
 * 单例运行：Worker 通过 `idFromName('hub')` 定位，保证全局唯一。
 */
export class WsHub extends DurableObject<Env> {
  /** clientId → 会话 */
  private sessions: Map<string, Session>;
  /** 房间名 → 会话 ID 集合 */
  private rooms: Map<string, Set<string>>;
  /** userId → 会话 ID 集合（定向推送的反向索引） */
  private userSockets: Map<string, Set<string>>;

  /**
   * 构造：初始化状态并安排首次心跳。
   *
   * 环境绑定 env 由基类统一持有（this.env），子类不再重复声明。
   *
   * @param ctx DO 状态
   * @param env 环境绑定
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessions = new Map();
    this.rooms = new Map();
    this.userSockets = new Map();
    // 首次访问时安排心跳 alarm（已有 alarm 则不重复安排）
    ctx.blockConcurrencyWhile(async () => {
      const current = await ctx.storage.getAlarm();
      if (current === null) {
        await ctx.storage.setAlarm(Date.now() + this.interval());
      }
    });
  }

  /** 心跳间隔（毫秒） */
  private interval(): number {
    const raw = Number(this.env.HEARTBEAT_INTERVAL_MS);
    return Number.isFinite(raw) && raw >= 5000 ? raw : 30_000;
  }

  /** 死亡宽限期（毫秒） */
  private grace(): number {
    const raw = Number(this.env.HEARTBEAT_GRACE_MS);
    return Number.isFinite(raw) && raw >= 10_000 ? raw : 65_000;
  }

  /** 会话保留时长（毫秒） */
  private sessionTtl(): number {
    const raw = Number(this.env.SESSION_TTL_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
  }

  /**
   * 处理来自 Worker 的请求。
   *
   * @param request 请求（WS 升级 / 内部发布 / 统计）
   * @returns 响应
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 内部统计端点：供 /health 取在线数
    if (url.pathname === '/__stats') {
      return Response.json({
        connections: this.onlineCount(),
        sessions: this.sessions.size,
        rooms: this.rooms.size,
        users: this.userSockets.size,
      });
    }

    // 内部发布端点：主站把业务事件推给在线用户（由 Worker 校验令牌后转发）
    if (url.pathname === '/__publish' && request.method === 'POST') {
      let body: PublishRequest;
      try {
        body = (await request.json()) as PublishRequest;
      } catch {
        return Response.json({ error: 'invalid json' }, { status: 400 });
      }
      const delivered = this.deliver(body);
      return Response.json({ delivered });
    }

    // 非 WebSocket 请求：拒绝
    const upgrade = request.headers.get('upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    // 客户端标识与用户标识（Worker 已鉴权，这里取用）
    const clientId = request.headers.get('x-client-id') || `c_${crypto.randomUUID()}`;
    const userId = request.headers.get('x-user-id') || '';

    // 建立 WebSocket 对：client 返回给浏览器，server 留在 DO 内
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.handleSession(server, clientId, userId);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 绑定并接管一条连接。
   *
   * @param ws 服务端侧的 WebSocket
   * @param clientId 会话标识
   * @param userId 用户标识（可为空）
   */
  private handleSession(ws: WebSocket, clientId: string, userId: string): void {
    ws.accept();

    // 取（或新建）会话：命中旧会话即实现重连恢复
    let session = this.sessions.get(clientId);
    if (!session) {
      session = { clientId, userId, ws: null, rooms: new Set<string>(), lastSeenAt: Date.now(), disconnectedAt: null };
      this.sessions.set(clientId, session);
    }
    // 重连后 userId 以最新凭据为准
    session.userId = userId;

    // 顶掉同一 clientId 的旧连接，避免一个会话挂多条连接导致重复收消息
    if (session.ws && session.ws !== ws) {
      try {
        session.ws.close(4002, 'replaced by new connection');
      } catch {
        // 旧连接可能已处于关闭中，忽略
      }
    }
    session.ws = ws;
    session.disconnectedAt = null;
    session.lastSeenAt = Date.now();
    this.indexUser(session);

    // 欢迎消息：回传 clientId、userId 与已恢复的房间
    this.send(ws, {
      t: 'welcome',
      clientId,
      userId,
      rooms: [...session.rooms],
      heartbeatIntervalMs: this.interval(),
    });

    // 收到消息
    ws.addEventListener('message', (event: MessageEvent) => {
      session.lastSeenAt = Date.now();
      // 二进制消息不处理（本服务只走 JSON 文本）
      if (typeof event.data !== 'string') return;
      this.onMessage(ws, session, event.data);
    });

    // 连接关闭：保留会话（供短时重连恢复）
    ws.addEventListener('close', () => {
      if (session.ws === ws) {
        session.ws = null;
        session.disconnectedAt = Date.now();
      }
    });

    // 连接异常：直接清理，避免半死连接占用会话
    ws.addEventListener('error', () => {
      try {
        ws.close(4000, 'connection error');
      } catch {
        // 已关闭则忽略
      }
      if (session.ws === ws) {
        session.ws = null;
        session.disconnectedAt = Date.now();
      }
    });
  }

  /**
   * 维护 userId → 会话 的反向索引。
   *
   * @param session 会话
   */
  private indexUser(session: Session): void {
    if (!session.userId) return;
    const set = this.userSockets.get(session.userId) ?? new Set<string>();
    set.add(session.clientId);
    this.userSockets.set(session.userId, set);
  }

  /**
   * 从反向索引中移除会话（房间为空时清理 key，避免 Map 无限增长）。
   *
   * @param session 会话
   */
  private unindexUser(session: Session): void {
    if (!session.userId) return;
    const set = this.userSockets.get(session.userId);
    if (!set) return;
    set.delete(session.clientId);
    if (set.size === 0) this.userSockets.delete(session.userId);
  }

  /**
   * 处理一条客户端消息。
   *
   * @param ws 来源连接
   * @param session 所属会话
   * @param raw 原始文本
   */
  private onMessage(ws: WebSocket, session: Session, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(ws, { t: 'error', message: 'invalid json' });
      return;
    }
    const type = msg.t || '';
    const room = typeof msg.room === 'string' ? msg.room.trim().slice(0, 64) : '';

    switch (type) {
      case 'pong':
        // 应用层心跳回应：lastSeenAt 已在外层刷新，无需额外处理
        return;
      case 'ping':
        this.send(ws, { t: 'pong', ts: Date.now() });
        return;
      case 'join':
        if (!room) return this.send(ws, { t: 'error', message: 'room required' });
        this.joinRoom(session, room);
        this.send(ws, { t: 'joined', room });
        return;
      case 'leave':
        if (!room) return this.send(ws, { t: 'error', message: 'room required' });
        this.leaveRoom(session, room);
        this.send(ws, { t: 'left', room });
        return;
      case 'publish': {
        if (!room) return this.send(ws, { t: 'error', message: 'room required' });
        const delivered = this.broadcast(
          room,
          { t: 'message', room, data: msg.data ?? null, from: session.clientId, ts: Date.now() },
          session.clientId,
        );
        this.send(ws, { t: 'ack', room, delivered });
        return;
      }
      case 'event': {
        // 上行业务事件：转发给指定房间（不含自己）
        if (!room) return this.send(ws, { t: 'error', message: 'room required' });
        const delivered = this.broadcast(
          room,
          { t: 'event', event: msg.event ?? null, from: session.clientId, ts: Date.now() },
          session.clientId,
        );
        this.send(ws, { t: 'ack', room, delivered });
        return;
      }
      default:
        this.send(ws, { t: 'error', message: `unknown type: ${type}` });
    }
  }

  /**
   * 内部发布：把业务事件下发给目标用户（多端全量）或房间。
   *
   * @param body 发布请求
   * @returns 送达连接数
   */
  private deliver(body: PublishRequest): number {
    const payload = { t: 'event', event: body.event ?? null, ts: Date.now() };
    // 定向推送：按 userId 找到该用户的全部在线设备
    if (Array.isArray(body.to) && body.to.length > 0) {
      let sent = 0;
      for (const uid of body.to) {
        const ids = this.userSockets.get(uid);
        if (!ids) continue;
        for (const cid of ids) {
          if (cid === body.exceptClientId) continue;
          const s = this.sessions.get(cid);
          if (!s?.ws) continue;
          this.send(s.ws, payload);
          sent += 1;
        }
      }
      return sent;
    }
    // 房间广播
    if (body.room) {
      return this.broadcast(body.room, payload, body.exceptClientId);
    }
    return 0;
  }

  /**
   * 加入房间（幂等）。
   *
   * @param session 会话
   * @param room 房间名
   */
  private joinRoom(session: Session, room: string): void {
    session.rooms.add(room);
    const set = this.rooms.get(room) ?? new Set<string>();
    set.add(session.clientId);
    this.rooms.set(room, set);
  }

  /**
   * 离开房间（房间空了则清理索引）。
   *
   * @param session 会话
   * @param room 房间名
   */
  private leaveRoom(session: Session, room: string): void {
    session.rooms.delete(room);
    const set = this.rooms.get(room);
    if (!set) return;
    set.delete(session.clientId);
    if (set.size === 0) this.rooms.delete(room);
  }

  /**
   * 向房间广播（不含排除的会话）。
   *
   * @param room 房间名
   * @param payload 消息体
   * @param exceptClientId 排除的会话
   * @returns 送达连接数
   */
  private broadcast(room: string, payload: unknown, exceptClientId?: string): number {
    const set = this.rooms.get(room);
    if (!set || set.size === 0) return 0;
    const data = JSON.stringify(payload);
    let sent = 0;
    for (const id of set) {
      if (id === exceptClientId) continue;
      const s = this.sessions.get(id);
      if (!s?.ws) continue;
      try {
        s.ws.send(data);
        sent += 1;
      } catch {
        // 发送失败（连接已半死）：交给 alarm 清理
      }
    }
    return sent;
  }

  /** 当前在线连接数 */
  private onlineCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.ws) n += 1;
    return n;
  }

  /**
   * 发送 JSON 消息（连接已关闭时静默失败）。
   *
   * @param ws 目标连接
   * @param payload 消息体
   */
  private send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // 连接已断开：忽略（alarm 会清理）
    }
  }

  /**
   * 心跳周期（由 alarm 驱动）：
   * 1) 向每条连接发应用层 ping；
   * 2) 关闭超过宽限期未活跃的连接；
   * 3) 清理超期未重连的会话并释放其房间与用户索引；
   * 4) 仍有会话时续订下一次 alarm（无会话则停止，省资源）。
   */
  async alarm(): Promise<void> {
    const now = Date.now();

    for (const session of this.sessions.values()) {
      const ws = session.ws;
      if (!ws) continue;
      // 超过宽限期未活跃：判定死亡，主动关闭以触发客户端重连
      if (now - session.lastSeenAt > this.grace()) {
        try {
          ws.close(4000, 'heartbeat timeout');
        } catch {
          // 已关闭则忽略
        }
        session.ws = null;
        session.disconnectedAt = now;
        continue;
      }
      // 正常连接：发应用层 ping
      this.send(ws, { t: 'ping', ts: now });
    }

    // 清理超期未重连的会话
    for (const [id, session] of this.sessions) {
      if (session.ws) continue;
      const leftAt = session.disconnectedAt ?? now;
      if (now - leftAt > this.sessionTtl()) {
        for (const room of [...session.rooms]) this.leaveRoom(session, room);
        this.unindexUser(session);
        this.sessions.delete(id);
      }
    }

    // 仍有会话则续订 alarm；全部清空则停止，下次有新连接时再启动
    if (this.sessions.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + this.interval());
    }
  }
}

/** 供外部（README / 文档）参考的版本常量 */
export const HUB_VERSION = VERSION;
