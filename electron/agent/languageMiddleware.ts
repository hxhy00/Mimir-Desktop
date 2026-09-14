/**
 * 交流语言约束中间件（每次模型调用时读取最新设置，保存即生效）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 实测反馈：Agent 的最终回答是中文，但**工具调用之间的过程叙述整段英文**
 * （"I'll help you..." / "Let me check..."）。原因是「使用中文回复」只写在静态
 * systemPrompt 里，对多轮 ReAct 循环中的中间消息约束力不足——模型在工具返回后的
 * 下一轮很容易滑回英文旁白。修法是把语言规则作为一条短 system 段**前置到每一次
 * 模型调用**（每轮在场，而不是只在会话开头说一次）。
 *
 * ── 为什么用 wrapModelCall 而不是拼进 systemPrompt 字符串 ──────────────────
 * Agent 实例的 systemPrompt 在构建期固化；用户改「设置 → 身份与默认值 → 交流语言」
 * 后若不重建 Agent 就不生效（而重建会丢进行中的轨迹归属等运行时状态）。本中间件在
 * **调用时**读 store，天然热生效，且不触碰任何既有构建路径。
 *
 * 口径与 buildIdentityBlock 一致：`interactLanguage === 'en'` 才显式声明英文；
 * zh / 未配置走系统默认（中文），零注入、零额外 token。
 */
import type { AgentMiddleware } from 'langchain'
import { getStoreValue } from '../library/store'

/**
 * 从 settings.identity 读交流语言；脏数据回落中文。
 *
 * `readOverride` 仅用于单测注入：vitest 的模块图会把本模块与测试模块解析成
 * store 的两个实例，注入读取器可让测试验证真实逻辑，而不必与模块解析细节搏斗。
 */
export function currentInteractLanguage(
  readOverride?: (key: string) => unknown
): 'zh' | 'en' {
  try {
    const read = readOverride ?? ((key: string) => getStoreValue<Record<string, unknown>>(key))
    const settings = (read('settings') ?? {}) as Record<string, unknown>
    const id = (settings.identity ?? {}) as Record<string, unknown>
    return id.interactLanguage === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

/** 生成语言约束文本（导出供单测断言口径）。 */
export function languageDirective(lang: 'zh' | 'en'): string {
  if (lang === 'en') {
    return '[语言模式] 本次会话的交流语言为 English。所有面向用户的文字——包括工具调用之间的过程叙述、计划说明、进度更新与错误解释——必须使用英文。这条规则对每一轮都生效：即便上一条消息或工具返回是中文，你接下来写给用户看的每一个字仍必须是英文。'
  }
  return [
    '[语言模式] 本次会话的交流语言为中文。用户用中文提问，你写给用户看的每一个字都必须是中文。',
    '所有面向用户的文字——包括工具调用之间的过程叙述、计划说明、进度更新与错误解释——必须使用中文，禁止中英混杂的旁白（如 "Let me check..." / "Now I\'ll..." / "Environment check:..."）。',
    '这条规则对 ReAct 循环的每一轮都生效：每次决定调用工具前写的那句话、拿到工具结果后写的过渡句，都要用中文。',
    '**最终总结同样受约束**：即使任务材料是英文（英文论文、英文代码、英文报错），总结正文也必须用中文书写，只在引用原文术语、标题、代码时保留英文；严禁整段用英文复述结论（如 "The paper turns out to already be in your library... Done — here\'s everything..."）。',
    '改写示例：把「Now let me verify the model runs」写成「现在验证模型能否跑通」；把「Environment check: torch is missing」写成「环境检查：缺少 torch」；把「One note below: the reproduction folder already exists from earlier work」写成「一点说明：复现目录在之前的工作中已存在」。',
    '专有名词、代码标识符、论文标题、命令行与报错原文保留原文即可。'
  ].join('\n')
}

/**
 * 构造语言中间件：把语言指令**前置**到 systemMessage 最顶部（最高注意力位）。
 * `request.systemMessage.concat(...)` 只能追加；这里克隆原消息后直接改写 content。
 *
 * 类型说明：deepagents 透传的 AgentMiddleware 泛型参数极深，这里用局部结构类型描述
 * 我们真正用到的两个成员（systemMessage / handler），避免把 langchain 内部泛型
 * 泄漏到调用方（agentService 侧只需一个 AgentMiddleware）。
 */
interface LanguageMiddleware {
  name: string
  wrapModelCall(
    request: { systemMessage: { content: unknown }; [k: string]: unknown },
    handler: (req: unknown) => Promise<unknown>
  ): Promise<unknown>
}

export function createLanguageMiddleware(): AgentMiddleware {
  const middleware: LanguageMiddleware = {
    name: 'mimir-language',
    async wrapModelCall(request, handler) {
      const text = languageDirective(currentInteractLanguage())
      const original = request.systemMessage.content
      const combined =
        typeof original === 'string' && original !== ''
          ? `${text}\n\n${original}`
          : [
              { type: 'text' as const, text },
              ...(Array.isArray(original) ? original : typeof original === 'string' ? [] : [{ type: 'text' as const, text: String(original) }])
            ]
      const patched = Object.assign(Object.create(Object.getPrototypeOf(request.systemMessage)), request.systemMessage, {
        content: combined
      })
      return await handler({ ...request, systemMessage: patched })
    }
  }
  return middleware as unknown as AgentMiddleware
}
