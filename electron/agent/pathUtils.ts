/**
 * Agent 工具共用的路径规范化。
 *
 * 为什么必须抽出来共享（真实事故）：`read_dir` 与 `server` 工具都接受用户口述的路径，
 * 而用户与模型都习惯写 `~/.ssh`。`resolve('~/.ssh')` 会得到「当前工作目录 + /~/.ssh」，
 * 必然 ENOENT —— agent 随后把这次失败误判为「路径不精确」，转而向用户索要绝对路径，
 * 交互退化成「说一句做一句」。
 *
 * 此前只有 `read_dir` 做了展开，`server` 的 keyPath 没做：用户说「私钥在我本地 ssh
 * 文件夹」，agent 填 `~/.ssh/id_rsa` 会原样落库，之后 probeServer 读私钥必然失败，
 * 且失败会**延迟到探测时**才暴露（更难定位）。因此展开必须收敛到一处，两个工具共用。
 */
import { homedir } from 'os'
import { resolve } from 'path'

/**
 * 展开路径里的 `~` / `~/` 为真实主目录；其它输入原样返回。
 *
 * 刻意**不做** `resolve()`：本函数只负责「把那一个字符换成家目录」这一件事，
 * 相对路径该如何解析（按 cwd？按空间根？）由各调用点自己决定，避免这里越权
 * 改变既有语义。
 */
export function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2))
  return input
}
