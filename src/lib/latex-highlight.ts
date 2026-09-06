/**
 * LaTeX 语法高亮 tokenizer（移植自 Mimir monorepo 的
 * packages/ui-mimir/src/client/latex-highlight.ts，MIT）。
 *
 * 供编辑器的高亮覆盖层使用。稳健性优先于完备性：无法识别的内容
 * 一律保持 `plain`——漏掉一处高亮没关系，错位则不能接受。规则：
 * 注释从非转义 `%` 到行尾；命令为 `\字母` 且可带 `*`；`\begin{env}` /
 * `\end{env}` 中的环境名是独立 token；`$...$`（仅同行）与 `$$...$$`
 * 各自是一个数学 token，未闭合的 `$` 回退为 plain；花括号与方括号是
 * 单字符 token；两个字符的反斜杠转义（`\%`、`\$`、`\\`…）保持 plain，
 * 因此永远不会开启注释或命令。
 */

/** 覆盖层着色的 token 类别。 */
export type LatexTokenType = 'plain' | 'comment' | 'command' | 'math' | 'brace' | 'bracket' | 'env'

/** 一个 token：其类别与原始源码切片（拼接后完整还原输入）。 */
export interface LatexToken {
  readonly type: LatexTokenType
  readonly text: string
}

/**
 * 源码长度超过该值编辑器直接跳过高亮——token 列表每次按键都会重建，
 * 病态长度的文件不能卡死面板。
 */
export const HIGHLIGHT_MAX_LENGTH = 200_000

/** LaTeX 命令名仅由 ASCII 字母组成。 */
function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))
}

/**
 * 将 LaTeX 源码 token 化以供高亮覆盖层使用。所有 token 文本的拼接
 * 恒等于输入，因此覆盖层永远不会与 textarea 的内容错位。
 * @param text - 完整 LaTeX 源码。
 * @returns token 列表；相邻的 `plain` 段会被合并。
 */
export function tokenizeLatex(text: string): LatexToken[] {
  const tokens: LatexToken[] = []
  let plainStart = 0
  let i = 0
  const flushPlain = (until: number): void => {
    if (until > plainStart) tokens.push({ type: 'plain', text: text.slice(plainStart, until) })
  }

  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      const next = text[i + 1]
      // 孤立的行尾反斜杠或转义非字母（\%, \$, \\）保持 plain——
      // 关键：转义的百分号绝不开启注释。
      if (!isLetter(next)) {
        i += next === undefined ? 1 : 2
        continue
      }
      flushPlain(i)
      let j = i + 1
      while (j < text.length && isLetter(text[j])) j += 1
      const name = text.slice(i + 1, j)
      if (text[j] === '*') j += 1
      tokens.push({ type: 'command', text: text.slice(i, j) })
      // \begin{env} / \end{env}：环境名获得独立 token；任何异常
      // （未闭合、嵌套花括号、内含换行）都退化为普通花括号/plain 路径。
      if ((name === 'begin' || name === 'end') && text[j] === '{') {
        const close = text.indexOf('}', j + 1)
        const env = close === -1 ? '' : text.slice(j + 1, close)
        if (close !== -1 && env !== '' && !/[\n{}\\%$]/.test(env)) {
          tokens.push({ type: 'brace', text: '{' })
          tokens.push({ type: 'env', text: env })
          tokens.push({ type: 'brace', text: '}' })
          i = close + 1
          plainStart = i
          continue
        }
      }
      i = j
      plainStart = i
      continue
    }
    if (ch === '%') {
      flushPlain(i)
      let j = i
      while (j < text.length && text[j] !== '\n') j += 1
      tokens.push({ type: 'comment', text: text.slice(i, j) })
      i = j
      plainStart = i
      continue
    }
    if (ch === '$') {
      const double = text[i + 1] === '$'
      const closer = double ? '$$' : '$'
      const searchFrom = i + (double ? 2 : 1)
      let end = text.indexOf(closer, searchFrom)
      // 行内数学不跨行；未闭合的 $ 视为普通文本。
      if (!double && end !== -1) {
        const newline = text.indexOf('\n', searchFrom)
        if (newline !== -1 && newline < end) end = -1
      }
      if (end === -1) {
        i += 1
        continue
      }
      flushPlain(i)
      tokens.push({ type: 'math', text: text.slice(i, end + closer.length) })
      i = end + closer.length
      plainStart = i
      continue
    }
    if (ch === '{' || ch === '}') {
      flushPlain(i)
      tokens.push({ type: 'brace', text: ch })
      i += 1
      plainStart = i
      continue
    }
    if (ch === '[' || ch === ']') {
      flushPlain(i)
      tokens.push({ type: 'bracket', text: ch })
      i += 1
      plainStart = i
      continue
    }
    i += 1
  }
  flushPlain(text.length)
  return tokens
}
