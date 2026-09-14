/**
 * 对话内「产物」识别：从工具返回文本里解析落盘文件路径，供渲染层在气泡下方
 * 渲染验收卡（文件名 + 打开 / 打开所在文件夹）。
 *
 * 现状：各模块工具的返回是自然语言文本（如 `路径：/x/y.pptx`、`笔记已保存到 /a/b.md`），
 * 没有结构化的产物字段。这里做一层**只读解析**，不改变任何工具的返回契约——
 * 命中则额外把结构化产物列表随事件外发，未命中则行为与之前完全一致。
 *
 * 安全约束：只识别绝对路径且扩展名在白名单内，绝不 `existsSync` 之外的探测；
 * 渲染层点击打开时仍走既有 shell:openPath 通道（不新增无校验入口）。
 */
import { existsSync, statSync } from 'fs'
import { basename, extname, isAbsolute } from 'path'

/** 可验收的产物扩展名（与 Mimir 各模块实际落盘类型对应）。 */
const ARTIFACT_EXTENSIONS = new Set([
  '.pptx', '.ppt', // 组会演示文稿
  '.pdf', '.tex', '.md', '.txt', // 论文 / 笔记 / 文本
  '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', // 配图
  '.csv', '.json', '.xlsx', '.ipynb', // 数据 / 实验记录
  '.zip', '.tar', '.gz', // 打包产物
  // 代码产出：复现/建模任务会落 .py/.sh/.yaml 等，此前不在白名单导致「写了 6 个文件、
  // 验收卡只显示 README+requirements」——用户以为其余没生成。补全常见脚本/配置扩展名。
  '.py', '.sh', '.bash', '.js', '.ts', '.r', '.jl', '.m', '.cpp', '.c', '.h', '.hpp',
  '.yaml', '.yml', '.toml', '.ini', '.cfg'
])

/** 产物行常见前缀（工具返回里「路径」的书写习惯）。 */
const PATH_HINT_PREFIXES = ['路径：', '路径:', '保存到', '已保存到', '输出到', '已输出到', '生成到', '已生成到', '文件：', '文件:', '写入到', '已写入']

export interface ArtifactRef {
  /** 绝对路径。 */
  path: string
  /** 展示用文件名。 */
  name: string
  /** 扩展名（小写，含点）。 */
  ext: string
  /** 文件大小（字节）；无法读取时为 undefined。 */
  sizeBytes?: number
}

/**
 * 从一段工具返回文本中解析产物路径。
 *
 * 识别策略（保守，宁少勿错）：
 * 1. 按行扫描，优先取带「路径：/ 保存到」等提示前缀的行；
 * 2. 其次取该行内任意「看起来是绝对路径 + 白名单扩展名」的片段；
 * 3. 仅保留磁盘上真实存在的文件（避免把示例路径、文档里的路径误判为产物）。
 */
export function extractArtifacts(input: unknown): ArtifactRef[] {
  const text = normalizeInput(input)
  if (text === '') return []
  const found = new Map<string, ArtifactRef>()

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue

    const candidates: string[] = []
    const hasHint = PATH_HINT_PREFIXES.some((p) => line.includes(p))
    if (hasHint) {
      // 提示前缀后的整段作为首选候选（去除行尾标点与反引号）
      const afterHint = stripWrapping(line.replace(/^.*?(路径[:：]|保存到|已保存到|输出到|已输出到|生成到|已生成到|写入到|已写入|文件[:：])/, ''))
      if (afterHint !== '') candidates.push(afterHint)
    }
    // 兜底：行内出现的绝对路径片段（含空格时以「扩展名后」为界）
    for (const m of line.matchAll(/(\/[^\s"'`）)，,；;]+?\.[A-Za-z0-9]{1,8})/g)) {
      candidates.push(m[1])
    }

    for (const candidateRaw of candidates) {
      const candidate = stripWrapping(candidateRaw)
      if (!isAbsolute(candidate)) continue
      const ext = extname(candidate).toLowerCase()
      if (!ARTIFACT_EXTENSIONS.has(ext)) continue
      if (found.has(candidate)) continue
      const ref = toArtifactRef(candidate, ext)
      if (ref !== null) found.set(candidate, ref)
      break // 每行最多认一个产物，避免同段落重复路径噪声
    }
  }

  return [...found.values()]
}

/** 把工具返回归一为待扫描文本：字符串原样；对象/数组序列化为 JSON（路径值同样可被匹配）。 */
function normalizeInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (input === null || input === undefined) return ''
  if (typeof input === 'object') {
    try {
      return JSON.stringify(input)
    } catch {
      return ''
    }
  }
  return String(input)
}

/** 去掉包裹字符（反引号、引号、成对括号）与行尾标点。 */
function stripWrapping(s: string): string {
  let out = s.trim()
  out = out.replace(/^[`"'(（【\[]+/, '').replace(/[`"')）】\]]+$/, '')
  out = out.replace(/[。，,；;、]+$/, '')
  return out.trim()
}

/** 校验存在性并收集大小元数据；不存在则返回 null（不把误判路径当产物）。 */
function toArtifactRef(path: string, ext: string): ArtifactRef | null {
  try {
    if (!existsSync(path)) return null
    const stat = statSync(path)
    if (!stat.isFile()) return null
    return { path, name: basename(path), ext, sizeBytes: stat.size }
  } catch {
    return null
  }
}
