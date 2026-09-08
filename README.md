# bendi-ws-worker · Cloudflare Workers 版 WebSocket 服务

将实时长连接服务跑在 **Cloudflare Workers + Durable Objects** 上：无需绑卡、全球边缘节点、按请求计费（免费额度足够个人项目）。

与同仓库的 `apps/ws-service`（Node.js + `ws` 库版）是**同一套协议的两种运行形态**，可按需二选一：

| | `apps/ws-worker`（本目录） | `apps/ws-service` |
|---|---|---|
| 运行时 | Cloudflare Workers + Durable Objects | Node.js 20+ |
| 状态 | DO 单例（全局唯一） | 进程内存 |
| 心跳 | 应用层 `ping`/`pong`（DO alarm 驱动） | 协议级 Ping 帧 |
| 部署 | `wrangler deploy` | Render / SnapDeploy / VPS / Docker |

## 一、本地开发

```bash
cd apps/ws-worker
npm install
cp .dev.vars.example .dev.vars   # 填入 WS_AUTH_TOKEN
npm run dev                      # http://localhost:8787
```

冒烟：

```bash
curl http://localhost:8787/health
node client-example.mjs --url ws://localhost:8787/ws --token dev-token-change-me --room demo
```

## 二、部署到 Cloudflare

```bash
# 1. 登录（会打开浏览器授权，或使用 API Token）
npx wrangler login
# 或在 CI 中用环境变量：CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<id>

# 2. 注入鉴权令牌（机密，不写进代码）
npx wrangler secret put WS_AUTH_TOKEN

# 3. 部署
npm run deploy
```

部署完成后会输出 `https://bendi-ws-worker.<你的子域>.workers.dev`。

**注意**：`new_sqlite_classes` 迁移在首次部署时会创建 Durable Object 类，之后不要删除 `[[migrations]]` 段。

## 三、自动部署的触发规则（重要）

CI 配置了**路径过滤**：只有会影响线上产物的改动才触发部署，避免浪费 Cloudflare 免费额度。

| 改动类型 | 是否自动部署 |
|---|---|
| `src/**`（服务源码） | ✅ 部署 |
| `wrangler.toml`（配置） | ✅ 部署 |
| `package.json` / `package-lock.json`（依赖） | ✅ 部署 |
| `tsconfig.json` | ✅ 部署 |
| `.github/workflows/deploy.yml` | ✅ 部署 |
| `*.md` / `docs/**`（文档） | ❌ **不部署** |
| `client-example.mjs`（示例脚本） | ❌ 不部署 |
| `.gitignore` / `.dev.vars.example` / `LICENSE` | ❌ 不部署 |

文档改动后如果确实需要重新部署（例如改了 README 里的说明且想同步版本号），到 GitHub **Actions → Deploy to Cloudflare Workers → Run workflow** 手动触发。

## 四、环境变量 / Secrets

| 名称 | 类型 | 说明 |
|---|---|---|
| `WS_AUTH_TOKEN` | **Secret**（`wrangler secret put`） | 连接鉴权令牌；**未配置则拒绝全部连接** |
| `WS_PATH` | var | WebSocket 路径，默认 `/ws` |
| `ALLOWED_ORIGINS` | var | 来源白名单，默认 `*` |
| `HEARTBEAT_INTERVAL_MS` | var | 心跳间隔，默认 `30000` |
| `HEARTBEAT_GRACE_MS` | var | 死亡宽限期，默认 `65000` |
| `SESSION_TTL_MS` | var | 断线会话保留时长，默认 `60000` |

## 五、连接与协议

```
wss://<worker 域名>/ws?token=<WS_AUTH_TOKEN>&clientId=<稳定的客户端标识>
```

客户端 → 服务端：`{"t":"ping"}`、`{"t":"pong"}`、`{"t":"join","room":"x"}`、`{"t":"leave","room":"x"}`、`{"t":"publish","room":"x","data":{}}`

服务端 → 客户端：`welcome`（含 `clientId` 与已恢复的 `rooms`）、`joined`、`left`、`message`、`pong`、`ack`、`error`

**心跳约定**：Workers 无法主动发协议级 Ping 帧，所以服务端每 30s 发一次 `{"t":"ping"}`，客户端**必须回** `{"t":"pong"}`，否则超宽限期会被断开。浏览器端请在 `onmessage` 里处理。

**断线重连**：保持 `clientId` 不变，服务端在 `SESSION_TTL_MS` 内自动恢复该会话的房间订阅。

## 六、健康检查与防休眠

```
GET https://<worker 域名>/health
```

```json
{"status":"ok","service":"bendi-ws-worker","runtime":"cloudflare-workers",
 "connections":2,"sessions":3,"rooms":1,"wsPath":"/ws","authRequired":true}
```

Workers 不像免费容器那样休眠，**不需要外部探针保活**；但保留 `/health` 便于接入监控（UptimeRobot / Better Stack 等）。

## 七、容量与扩展

当前用**单例 DO**（`idFromName('hub')`）承载全部连接与房间，适合中小规模：

- 优点：房间广播与会话恢复都在一处，实现简单；
- 上限：单个 DO 是单线程，消息吞吐有上限（约数千连接、每秒数千条消息量级）。
- 扩展方向：改为「**一个房间一个 DO**」（`idFromName(room)`），广播走 DO 内部扇出，房间数不再受单 DO 限制；跨房间的会话恢复可用 Durable Object 的 `storage` 或 KV 记录 `clientId → rooms`。

## 八、安全提示

- `WS_AUTH_TOKEN` 会出现在连接 URL 上，生产建议使用**短期令牌**（由主站签发一次性票据，客户端换取后连接），避免长期令牌进入浏览器历史与日志；
- 令牌比对使用常量时间比较（见 `src/auth.ts` 的 `safeEqual`），防止计时侧信道；
- 生产请把 `ALLOWED_ORIGINS` 从 `*` 改成主项目域名。
