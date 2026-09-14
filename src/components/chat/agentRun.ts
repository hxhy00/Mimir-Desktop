/**
 * 一次回复的「执行过程」数据模型（气泡内时间线的唯一数据源）。
 *
 * ── 为什么从「树」改成「扁平的步骤序列」────────────────────────────────────
 * 旧模型是 `SwarmTreeNodeItem`（根 → 任务/阶段容器 → 工具行），来自 Supervisor 多子代理时代：
 * 层级表达「哪个子代理在做」，而单 Agent 架构下容器永远只有一个（`taskId='main'`），
 * 多出来的那层没有信息量，工具行还被迫按"调用行 / 返回行"拆成两行。
 *
 * 现在改成**按发生顺序排列的步骤序列**（时间线）：一次工具调用就是一个步骤，
 * 由 `step.callId` 把「调用 / 返回 / 出错」三次事件合并到同一行。
 *
 * ── 语义只从结构化字段读 ──────────────────────────────────────────────────
 * 判断"这行是调用还是返回"必须用 `event.step.stage`，**不要解析 text 文案**
 * （历史上用 `text.startsWith('调用')`，改一句文案就静默失效）。
 * 唯一解析文案的地方是 {@link fromLegacyTrace}，它只为读取改造前落盘的历史数据而存在。
 */

/** 时间线里的一行。 */
export interface AgentStep {
  /** 稳定 id：工具步骤 = `step.callId`；思考步骤 = 生成序号。 */
  id: string
  kind: 'tool' | 'think' | 'phase'
  /** 展示标题：工具名（如 `write_file`）/「思考」/ 阶段名。 */
  title: string
  /** 能力域标签（如「文献」），工具步骤可能有。 */
  label?: string
  status: 'running' | 'done' | 'error' | 'canceled'
  /** 工具入参摘要（已由主进程截断）。 */
  argsSummary?: string
  /** 工具返回摘要 / 出错文案。 */
  resultSummary?: string
  /** 思考全文（think 步骤）。 */
  text?: string
  /** 思考耗时（ms）：由后续首个非思考事件回填，用于折叠行的「思考 3.2s」。 */
  thinkMs?: number
  /** 工具执行耗时（主进程实测）。 */
  durationMs?: number
  /** 该步落盘的产物路径（来自事件 artifacts）。 */
  artifacts?: string[]
  /**
   * 文件动作（内置文件工具的步骤才有）。时间线据此显示「写入 model.py +387」，
   * 而不是把一大坨 JSON 入参糊在行上。
   */
  file?: { path: string; action: 'read' | 'write' | 'edit' | 'delete'; added?: number; removed?: number }
  /** 命令行（execute 步骤才有）：时间线显示「运行 <命令>」并可展开完整命令。 */
  command?: string
  /** edit 步骤的具体改动内容（old_string / new_string），供展开区渲染红绿 diff。 */
  editDiff?: { old: string; new: string }
  /**
   * 执行者归属：`subagent` 表示这一步发生在**被委派的子代理内部**（不是主 Agent 亲手做的）。
   *
   * 时间线据此把子代理的步骤收拢到「委派给 X」这一行之下（视觉上缩进 + 弱化），
   * 让用户一眼分清「Agent 自己干了什么」与「它派出去的活」。
   */
  origin?: 'main' | 'subagent'
  /** 子代理标识（能力域 id，如 `literature`）。 */
  subagentId?: string
  /** 子代理展示名（能力域 label，如「文献」）。 */
  subagentLabel?: string
  /** 委派容器行：它是 `subagent:*` 的 task 事件，只表示这次委派的起止。 */
  isDelegation?: boolean
  /**
   * 内部步骤 → 时间线默认隐藏（技能路由 / 上下文治理 / **模型思考**）。
   *
   * 思考之所以算「内部」：它是模型的自述草稿而非实际动作，逐字铺在时间线上
   * 会淹掉真正有信息量的工具行。默认收起、按需展开，与其它内部阶段共用
   * 底部同一个开关（见 `visibleSteps`）。
   */
  internal?: boolean
}

/** 一次回复的执行记录。 */
export interface AgentRun {
  status: 'running' | 'done' | 'error' | 'canceled'
  /** 开始时刻（ms），用于标题行的总耗时。 */
  startedAt: number
  steps: AgentStep[]
}

/** 主进程事件（与 `electron/agent/agentService.ts` 的 AgentWorkerEvent 对齐的子集）。 */
export interface RunEvent {
  taskId: string
  title: string
  status: 'running' | 'done' | 'error'
  text?: string
  durationMs?: number
  kind?: 'phase' | 'task' | 'tool' | 'think' | 'think-token'
  artifacts?: { path?: string; name?: string; ext?: string; sizeBytes?: number }[]
  step?: {
    callId: string
    name: string
    label?: string
    stage: 'call' | 'result' | 'error'
    argsSummary?: string
    resultSummary?: string
    command?: string
    file?: {
      path: string
      action: 'read' | 'write' | 'edit' | 'delete'
      added?: number
      removed?: number
      oldString?: string
      newString?: string
    }
    /** 执行者归属（主进程填充）：subagent = 子代理内部调用。 */
    origin?: 'main' | 'subagent'
    subagentId?: string
    subagentLabel?: string
  }
  phase?: 'context' | 'routing' | 'main' | 'ultra'
}

/** 新建一个运行记录。 */
export function createRun(now: number = Date.now()): AgentRun {
  return { status: 'running', startedAt: now, steps: [] }
}

/** 该步骤是否属于「内部工程阶段」（默认隐藏在时间线之外）。 */
export function isInternalEvent(event: RunEvent): boolean {
  return event.phase === 'context' || event.phase === 'routing' || event.phase === 'ultra'
}

/** 主流程容器事件（`taskId === 'main'` 的 task）只表示整轮的起止，不产生时间线行。 */
function isRunContainerEvent(event: RunEvent): boolean {
  return event.kind === 'task' || event.kind === undefined
}

/**
 * 把一个事件应用到运行记录上（纯函数，返回新对象）。
 *
 * @param nextId 生成思考步骤 id 的序号函数（调用方维护，保证同一次运行内唯一）
 */
export function applyRunEvent(run: AgentRun, event: RunEvent, nextId: () => number): AgentRun {
  // 0) 思考边界（先于一切分支）：主进程只在整轮结束才统一收尾思考步骤，而「某段思考结束」
  //    的一手事实是**它之后的第一个动作事件**——工具调用、或本轮最终正文开始流出。
  //    此前这些事件都不关闭运行中的 think 行，导致时间线里出现「幽灵思考行永远转圈」
  //    （现象：思考明明完了，底下还挂着 Loader2 + 「正在思考…」）。
  //    只关 kind==='think'，不碰 tool / 委派行（各有自己的 result/done 事件负责收尾）。
  const closeStalledThink = (base: AgentRun): AgentRun => {
    const last = base.steps[base.steps.length - 1]
    if (last === undefined || last.kind !== 'think' || last.status !== 'running') return base
    // thinkMs：该段思考的近似耗时（步骤创建时刻 → 现在），兑现字段注释里「由后续
    // 首个非思考事件回填」的设计——此前从未实现，折叠行一直显示不出思考时长。
    // id 格式：think:<epochMs>#<seq>。epochMs 供关闭该行时回填 thinkMs（见 closeStalledThink）。
    const startedAt = Number(last.id.slice('think:'.length).split('#')[0])
    return {
      ...base,
      steps: [
        ...base.steps.slice(0, -1),
        { ...last, status: 'done', ...(Number.isFinite(startedAt) ? { thinkMs: Date.now() - startedAt } : {}) }
      ]
    }
  }
  if (event.kind === 'tool' || event.taskId === 'content-start') {
    run = closeStalledThink(run)
  }
  if (event.taskId === 'content-start') return run

  // 1) 思考逐字（主进程已按 ~200ms 合批）：追加到末尾那条运行中的思考步骤。
  if (event.kind === 'think-token' || (event.kind === 'think' && event.text !== undefined)) {
    const piece = event.text ?? ''
    const last = run.steps[run.steps.length - 1]
    if (last !== undefined && last.kind === 'think' && last.status === 'running') {
      const merged: AgentStep = { ...last, text: (last.text ?? '') + piece }
      return { ...run, steps: [...run.steps.slice(0, -1), merged] }
    }
    return {
      ...run,
      steps: [
        ...run.steps,
        {
          // id 里带上创建时刻（epoch ms）：后续非思考事件关闭该行时据此回填 thinkMs。
          id: `think:${Date.now()}#${nextId()}`,
          kind: 'think',
          title: '思考',
          status: 'running',
          // 默认隐藏：与技能路由 / 上下文治理共用底部「显示内部步骤」开关。
          internal: true,
          text: piece
        }
      ]
    }
  }

  // 2) 工具步骤：按 callId 把 调用/返回/出错 合并成同一行。
  if (event.kind === 'tool') {
    const info = event.step
    if (info !== undefined) {
      // 子代理归属：主进程在 step 里标了 origin='subagent' 时，把标识带进时间线行。
      const ownership: Partial<AgentStep> =
        info.origin === 'subagent'
          ? {
              origin: 'subagent',
              ...(info.subagentId !== undefined ? { subagentId: info.subagentId } : {}),
              ...(info.subagentLabel !== undefined ? { subagentLabel: info.subagentLabel } : {})
            }
          : {}
      const at = run.steps.findIndex((s) => s.id === info.callId)
      if (info.stage === 'call') {
        const step: AgentStep = {
          id: info.callId,
          kind: 'tool',
          title: info.name,
          ...(info.label !== undefined ? { label: info.label } : {}),
          status: 'running',
          ...(info.argsSummary !== undefined ? { argsSummary: info.argsSummary } : {}),
          ...(info.file !== undefined ? { file: info.file } : {}),
          ...(info.command !== undefined ? { command: info.command } : {}),
          ...(info.file?.action === 'edit' && info.file.oldString !== undefined && info.file.newString !== undefined
            ? { editDiff: { old: info.file.oldString, new: info.file.newString } }
            : {}),
          ...ownership
        }
        return { ...run, steps: [...run.steps, step] }
      }
      if (at === -1) return run // 缺调用事件（不该发生）；不凭空造行
      const updated: AgentStep = {
        ...run.steps[at],
        status: info.stage === 'result' ? 'done' : 'error',
        ...(info.resultSummary !== undefined ? { resultSummary: info.resultSummary } : {}),
        ...(info.file !== undefined ? { file: info.file } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.artifacts !== undefined && event.artifacts.length > 0
          ? { artifacts: event.artifacts.map((a) => a.path ?? '').filter((p) => p !== '') }
          : {})
      }
      return { ...run, steps: run.steps.map((s, i) => (i === at ? updated : s)) }
    }
    // 无结构化字段（非本项目主进程产出的事件）：降级为一条内部备注，不猜语义。
    return {
      ...run,
      steps: [
        ...run.steps,
        {
          id: `phase:${nextId()}`,
          kind: 'phase',
          title: event.title || '步骤',
          status: event.status === 'error' ? 'error' : event.status === 'done' ? 'done' : 'running',
          ...(event.text !== undefined ? { resultSummary: event.text } : {}),
          internal: true
        }
      ]
    }
  }

  // 3) 容器/阶段事件：main 只驱动整轮状态；其余内部阶段各成一行（默认隐藏）。
  const isError = event.status === 'error'
  if (isRunContainerEvent(event) && event.taskId === 'main') {
    const status: AgentRun['status'] = isError ? 'error' : event.status === 'done' ? 'done' : 'running'
    // 整轮收尾：把仍在运行的思考步骤置为完成，避免时间线里永远转圈。
    if (status !== 'running') {
      return {
        ...run,
        status,
        steps: run.steps.map((s) =>
          s.status === 'running' && (s.kind === 'think' || s.isDelegation === true)
            ? { ...s, status: 'done' }
            : s
        )
      }
    }
    return { ...run, status }
  }

  // 3b) 委派容器（taskId = `subagent:<域id>` 的 task 事件）：时间线上一行「委派给 X」，
  //     在它之后的子代理步骤靠 origin='subagent' 归拢到它下面。
  if (isRunContainerEvent(event) && event.taskId.startsWith('subagent:')) {
    const callId = event.step?.callId ?? `delegate:${event.taskId}`
    const at = run.steps.findIndex((s) => s.id === callId)
    const label = event.step?.subagentLabel
    const status: AgentStep['status'] = isError
      ? 'error'
      : event.status === 'done'
        ? 'done'
        : 'running'
    if (at !== -1) {
      return {
        ...run,
        steps: run.steps.map((s, i) =>
          i === at
            ? { ...s, status, ...(event.text !== undefined ? { resultSummary: event.text } : {}) }
            : s
        )
      }
    }
    const step: AgentStep = {
      id: callId,
      kind: 'tool',
      title: 'task',
      status,
      origin: 'subagent',
      isDelegation: true,
      ...(label !== undefined ? { label } : {}),
      ...(event.step?.subagentId !== undefined ? { subagentId: event.step.subagentId } : {}),
      ...(label !== undefined ? { subagentLabel: label } : {}),
      ...(event.text !== undefined ? { resultSummary: event.text } : {})
    }
    return { ...run, steps: [...run.steps, step] }
  }

  // 用 phase 而非 taskId 做 id：技能路由同时存在 `phase:routing` 与 `router` 两种 taskId，
  // 按 taskId 去重会在时间线里出现两行「技能路由」。
  const id = `phase:${event.phase ?? event.taskId}`
  const at = run.steps.findIndex((s) => s.id === id)
  const step: AgentStep = {
    id,
    kind: 'phase',
    title: event.title || '阶段',
    status: isError ? 'error' : event.status === 'done' ? 'done' : 'running',
    internal: isInternalEvent(event) || event.taskId !== 'main',
    ...(event.text !== undefined && event.text !== '' ? { resultSummary: event.text } : {})
  }
  return {
    ...run,
    steps: at === -1 ? [...run.steps, step] : run.steps.map((s, i) => (i === at ? { ...step, id: s.id } : s))
  }
}

/** 用户主动停止：把运行中的步骤标为已取消，整轮置为 canceled。 */
export function cancelRun(run: AgentRun): AgentRun {
  return {
    status: 'canceled',
    startedAt: run.startedAt,
    steps: run.steps.map((s) => (s.status === 'running' ? { ...s, status: 'canceled' } : s))
  }
}

/** 时间线收据（标题行摘要 + 折叠时的信息量）。 */
export interface RunReceipt {
  /** 工具调用次数（含出错）。 */
  tools: number
  /** 出错步数。 */
  failed: number
  /** 落盘产物去重后的数量。 */
  artifacts: number
  /** 总耗时（ms）：已完成时取各步耗时之和，运行中则取当前时间差。 */
  durationMs: number
  /** 被隐藏的内部工程阶段数（技能路由 / 上下文治理）。 */
  internal: number
  /** 被隐藏的思考段数（同样是内部步骤，但用户能理解，单独报数）。 */
  thoughts: number
}

/** 计算收据。 */
export function summarizeRun(run: AgentRun, now: number = Date.now()): RunReceipt {
  const toolSteps = run.steps.filter((s) => s.kind === 'tool')
  const paths = new Set<string>()
  for (const s of run.steps) for (const p of s.artifacts ?? []) paths.add(p)
  const measured = run.steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
  return {
    tools: toolSteps.length,
    failed: run.steps.filter((s) => s.status === 'error').length,
    artifacts: paths.size,
    durationMs: run.status === 'running' ? Math.max(0, now - run.startedAt) : measured,
    // 思考与工程阶段都是 internal，但分开展示：前者用户看得懂，后者是噪音。
    internal: run.steps.filter((s) => s.internal === true && s.kind !== 'think').length,
    thoughts: run.steps.filter((s) => s.internal === true && s.kind === 'think').length
  }
}

/** 时间线要展示的步骤（默认滤掉内部阶段）。 */
export function visibleSteps(run: AgentRun, showInternal: boolean): AgentStep[] {
  return showInternal ? run.steps : run.steps.filter((s) => s.internal !== true)
}

/**
 * 「当前在干什么」——底部活动行的文案。
 *
 * 为什么必须有：模型写一个大文件、或工具执行几十秒时，**这段时间没有任何事件**，
 * 界面看起来就是"卡死了"。只报**真实状态**，不编随机语录。
 */
export function activityOf(
  run: AgentRun,
  pendingApprovalTool?: string
): { text: string; waiting: boolean } {
  if (pendingApprovalTool !== undefined && pendingApprovalTool !== '') {
    return { text: `等待你的批准：${pendingApprovalTool}`, waiting: true }
  }
  const runningTool = [...run.steps].reverse().find((s) => s.status === 'running' && s.kind === 'tool')
  if (runningTool !== undefined) {
    // 委派进行中：说明「谁在干活」，否则用户会以为主 Agent 卡住了（其实是子代理在跑）。
    if (runningTool.isDelegation === true) {
      const who = runningTool.subagentLabel ?? runningTool.subagentId ?? '子代理'
      return { text: `已委派给「${who}」，正在等待它完成…`, waiting: false }
    }
    // 子代理内部步骤：标出归属，避免与主 Agent 的步骤混淆。
    if (runningTool.origin === 'subagent') {
      const who = runningTool.subagentLabel ?? runningTool.subagentId
      const prefix = who !== undefined ? `「${who}」子代理：` : '子代理：'
      return { text: `${prefix}正在执行 ${runningTool.title}…`, waiting: false }
    }
    return { text: `正在执行 ${runningTool.title}…`, waiting: false }
  }
  const thinking = [...run.steps].reverse().find((s) => s.status === 'running' && s.kind === 'think')
  if (thinking !== undefined) return { text: '正在思考…', waiting: false }
  // 还没有任何步骤：模型在第一轮生成中（写大文件时这一段可能很长）
  return { text: '正在思考…', waiting: false }
}

// ─────────────────────────── 旧数据适配（只读） ───────────────────────────

/** 改造前落盘的树节点（`message.trace`）。 */
export interface LegacyTraceNode {
  node: { key: string; kind?: string; title?: string; status?: string; text?: string; durationMs?: number }
  children: LegacyTraceNode[]
}

/**
 * 把改造前落盘的「事件树」转换为时间线步骤。
 *
 * 这是**唯一**允许解析文案的地方：它只服务于「读旧数据」，新数据一律走结构化字段。
 * 转换是尽力而为的 —— 旧的调用/返回行本来就是两条独立文本，这里按顺序配对；
 * 配不上的返回行单独成行，不会丢信息。
 */
export function fromLegacyTrace(tree: LegacyTraceNode, now: number = Date.now()): AgentRun {
  const run = createRun(now)
  const toolByCall = new Map<string, AgentStep>()
  let seq = 0

  const walk = (item: LegacyTraceNode, depth: number): void => {
    const n = item.node
    const text = n.text ?? ''
    const status = n.status
    if (depth > 0) {
      if (n.kind === 'tool') {
        // 能力域前缀（`[文献] `）必须先剥掉再判类型：实测旧文案带前缀，
        // 直接用 startsWith('调用') 会把**调用行误判成返回行**（本函数早期版本的 bug，
        // 由 test/unit/agentRun.test.ts 的同名用例抓出）。
        const labelMatch = /^\[([^\]]*)\]\s*/.exec(text)
        const body = text.replace(/^\[[^\]]*\]\s*/, '')
        const isCall = body.startsWith('调用')
        if (isCall) {
          seq += 1
          const id = `legacy:${seq}`
          const name = body.replace(/^调用\s*/, '').split('：')[0].trim()
          const step: AgentStep = {
            id,
            kind: 'tool',
            title: name || '工具',
            ...(labelMatch !== null ? { label: labelMatch[1] } : {}),
            status: 'running',
            ...(body.includes('：') ? { argsSummary: body.slice(body.indexOf('：') + 1) } : {})
          }
          run.steps.push(step)
          toolByCall.set(name, step)
        } else {
          const name = body.split(' 返回：')[0].split(' 出错：')[0].trim()
          const prev = toolByCall.get(name)
          const isError = body.includes('出错')
          const summary = body.includes(' 返回：')
            ? body.slice(body.indexOf(' 返回：') + 4)
            : body.includes(' 出错：')
              ? body.slice(body.indexOf(' 出错：') + 4)
              : body
          if (prev !== undefined) {
            prev.status = isError ? 'error' : 'done'
            prev.resultSummary = summary
            if (n.durationMs !== undefined) prev.durationMs = n.durationMs
          } else {
            run.steps.push({
              id: `legacy:${seq++}`,
              kind: 'tool',
              title: name || '工具',
              status: isError ? 'error' : 'done',
              resultSummary: summary,
              ...(n.durationMs !== undefined ? { durationMs: n.durationMs } : {})
            })
          }
        }
      } else if (n.kind === 'think') {
        run.steps.push({
          id: `legacy-think:${seq++}`,
          kind: 'think',
          title: n.title ?? '思考',
          status: 'done',
          // 与实时链路一致：旧记录的思考同样默认隐藏（历史回看不该比新会话更吵）。
          internal: true,
          text
        })
      } else if (n.kind === 'phase' || n.kind === 'task') {
        run.steps.push({
          id: `legacy-phase:${n.key}`,
          kind: 'phase',
          title: n.title ?? '阶段',
          status: status === 'error' ? 'error' : status === 'running' ? 'running' : 'done',
          internal: true,
          ...(text !== '' ? { resultSummary: text } : {})
        })
      }
    }
    for (const child of item.children) walk(child, depth + 1)
  }

  walk(tree, 0)
  const last = tree.node.status
  return {
    ...run,
    status: last === 'error' ? 'error' : last === 'canceled' ? 'canceled' : 'done'
  }
}
