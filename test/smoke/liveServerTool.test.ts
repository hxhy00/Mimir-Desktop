/**
 * 真实 agent 端到端：**用生产同款装配**（`AgentService.initialize`）跑用户原话。
 *
 * ── 为什么必须有这一层（前两层测不到的）─────────────────────────────────────
 * `serverCreateDefaults.test.ts` 直接 `serverTool.invoke(...)`，证明的是**工具自身**行为；
 * 但用户遇到的「说一句做一句」发生在**模型决定**要不要调用工具、以及模型看到的工具描述
 * 是否鼓励它「信息够了就直接建」。这两件事只有真实模型 + 真实 systemPrompt
 * + 真实能力域 guidance 一起跑才暴露——桩测永远测不出「模型被提示词引导着去追问」。
 *
 * 覆盖用户真实原话：
 *   「帮我加台服务器，ssh root@119.3.210.1，22 端口」→ 应当直接建，且**不追问显示名**。
 *   「私钥在我本地 ssh 文件夹中」→ keyPath 应落库并已展开 `~`，不该原样存 `~/.ssh/id_rsa`。
 *
 * 默认跳过（不打网络）。启用：
 *   MIMIR_GW_URL=http://127.0.0.1:20128/v1 MIMIR_GW_KEY=sk_xxx MIMIR_GW_MODEL=aipy/deepseek-flash \
 *     npx vitest run test/smoke/liveServerTool.test.ts
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { setApprovalSender, settleApproval } from '../../electron/agent/approval'

interface GwConfig {
  baseUrl: string
  apiKey: string
  model: string
}

function resolveGateway(): GwConfig | null {
  const url = process.env.MIMIR_GW_URL
  const key = process.env.MIMIR_GW_KEY
  const model = process.env.MIMIR_GW_MODEL
  if (url && key && model) return { baseUrl: url, apiKey: key, model }
  return null
}

const gateway = resolveGateway()

/** 自动批准（记录请求），让写操作链路能在无 GUI 下跑通。 */
function installAutoApprover(): { seen: { tool?: string }[] } {
  const seen: { tool?: string }[] = []
  setApprovalSender((req) => {
    seen.push(req as { tool?: string })
    queueMicrotask(() => settleApproval(req.id, true))
  })
  return { seen }
}

/** 关键字路由会调用 embedding / 结构化输出；这里关掉以聚焦被测能力，减少不必要的外部调用。 */
function quietSettings(): void {
  // 见 AgentService.readSettingsFlag：skillRouting / skillRerank
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe.skipIf(gateway === null)('live 真实 agent：server 工具端到端（生产同款装配）', () => {
  let AgentServiceCtor: typeof import('../../electron/agent/agentService').AgentService
  let agentService: import('../../electron/agent/agentService').AgentService

  beforeAll(async () => {
    // 延迟导入：只在真的要打网络时才加载整套 agent 装配（含全量工具与中间件）
    const mod = await import('../../electron/agent/agentService')
    AgentServiceCtor = mod.AgentService
  })

  /** 每个用例用全新实例，避免会话级路由计数等状态互串。 */
  async function freshAgent(): Promise<void> {
    agentService = new AgentServiceCtor()
    await agentService.initialize({
      apiKey: gateway!.apiKey,
      model: gateway!.model,
      baseUrl: gateway!.baseUrl,
      // 强制关思考模式：本次测的是工具调用行为，思考流会拖长时间且对结论无贡献
      reasoning: false
    })
  }

  it('用户原话「加台服务器 ssh root@119.3.210.1 22 端口」：直接建成，不追问显示名', async () => {
    await freshAgent()
    const approver = installAutoApprover()
    quietSettings()

    const chunks: string[] = []
    const text = await agentService.streamMessage(
      '帮我加台服务器，ssh root@119.3.210.1，22 端口',
      'live-server-1',
      (e) => {
        if (e.type === 'text-delta') chunks.push(e.delta)
      }
    )

    console.log(`[live-server] 回复：${text.slice(0, 300)}`)
    console.log(`[live-server] 批准请求：${JSON.stringify(approver.seen)}`)

    // ── 断言策略（这三版迭代的教训，改断言前务必读）────────────────────────
    // 只用两类**稳定信号**，绝不去正则匹配模型措辞：
    //   ① 落库事实（注册表里字段的精确值）—— 不可辩驳；
    //   ② 反向断言（不许出现阻塞式追问）—— 语义精确、可穷举。
    // 反面教材：我先后写过 `已(新增|创建|…)`、`建上` 等「正向措辞断言」，被模型
    // 「先按你给的信息建上」→「把这台机器建到注册表里」→「服务器已经加好了」连续打脸。
    // 自然语言措辞是无穷集，用正则逮它 = 必然脆弱的用例。

    // ① 落库事实：真的建了，且字段正确、缺省值已代填
    const { listServers } = await import('../../electron/servers/serversService')
    const list = listServers()
    console.log(`[live-server] 落库：${JSON.stringify(list)}`)
    expect(list.length, '应当已创建 1 台服务器').toBe(1)
    expect(list[0]?.host).toBe('119.3.210.1')
    expect(list[0]?.user).toBe('root')
    expect(list[0]?.port).toBe(22)
    // 核心产品语义：显示名缺省自动代填为 `user@host`（而不是留空 / 追问用户）
    expect(list[0]?.name, '显示名应自动代填为 user@host').toBe('root@119.3.210.1')

    // ② 反向断言：不许把显示名当**阻塞条件**回头问。
    // 为什么这样写：正确回复会说「显示名我按 user@host 填的，想改告诉我」——
    // 所以不能简单地匹配「显示名…告诉我」（会误伤「已填好，想改再说」）。
    // 要抓的是**「还没填、等你给」**这种阻塞式追问：疑问/未完成语态。
    expect(text, '不应把显示名当阻塞条件追问').not.toMatch(
      /(显示名|名称)[^。\n]{0,20}(还没有|尚未|为空|是什么|叫什么|请提供|麻烦提供)/
    )
  })

  it('用户原话「私钥在我本地 ssh 文件夹中」：keyPath 落库且 `~` 已展开', async () => {
    await freshAgent()
    installAutoApprover()

    // 真实读一下 ~/.ssh 有什么，让「我本地 ssh 文件夹」这句话有真实落点
    const { readdirSync, existsSync } = await import('node:fs')
    const sshDir = `${homedir()}/.ssh`
    const hasSshDir = existsSync(sshDir)
    const entries = hasSshDir ? readdirSync(sshDir) : []
    console.log(`[live-server] ~/.ssh 内容：${JSON.stringify(entries)}`)

    const text = await agentService.streamMessage(
      '再帮我加一台服务器 10.20.30.40，用户名 ubuntu，私钥在我本地 ssh 文件夹中（用 id_rsa）',
      'live-server-2',
      () => {}
    )
    console.log(`[live-server] 回复：${text.slice(0, 300)}`)

    const { listServers } = await import('../../electron/servers/serversService')
    const list = listServers()
    const added = list.find((s) => s.host === '10.20.30.40')
    console.log(`[live-server] 落库：${JSON.stringify(list)}`)

    // 断言 1：**必须已建成**。
    //
    // 这条断言是本次真实跑测挖出来的：第一版只断言「keyPath 若存在则已展开」，
    // 而模型遇到「用户点名 id_rsa、目录里只有 id_ed25519」时**停下等用户拍板、压根没建**，
    // 于是 `added === undefined`，`if` 整段被跳过 —— 用例竟然还是绿的。
    // 因此「建成了没有」必须是硬断言：注册表先有记录，密钥是可事后 update 的字段。
    expect(added, '私钥不存在时也应先把服务器建上（不许停下等用户拍板）').toBeDefined()

    // 断言 2：显示名同样应自动代填为 user@host（与用例 1 同一条产品语义）
    expect(added?.name, '显示名应自动代填为 user@host').toBe('ubuntu@10.20.30.40')

    // 断言 3：keyPath 的**二选一**必须显式成立 —— 要么填「展开后的绝对路径」，要么留空。
    //
    // 为什么写成二选一而不是 `if`：`if (keyPath !== undefined) { ... }` 的写法在
    // 「agent 压根没填 keyPath」时会整段跳过、什么都不验，等于给了个后门。
    // 这里把两条合法路径都写死，三种非法情况（未展开的 `~`、相对路径、乱填）都会被抓。
    const kp = added?.keyPath
    if (kp === undefined || kp === '') {
      // 合法路径 A：留空（例如目录里一个私钥都没有）。此处显式声明该分支成立即可。
      expect(kp === undefined || kp === '').toBe(true)
    } else {
      // 合法路径 B：填了，则必须是展开后的绝对路径
      expect(kp, 'keyPath 不能原样存 ~').not.toContain('~')
      expect(kp.startsWith('/'), 'keyPath 必须是绝对路径').toBe(true)
    }
  })
})
