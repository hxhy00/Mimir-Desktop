/**
 * IPC 层的路径边界校验函数类型。
 *
 * 这些函数的**实现**留在 `ipc/index.ts`（它们依赖模块级的会话状态：
 * `pickedPaths` 白名单、`spaceRoot()` 等），但**类型**集中在这里，供各 `ipc/*.ts`
 * 子域模块通过依赖注入接收，避免子模块反向依赖主入口造成循环。
 */

/** 渲染层路径边界校验（唯一入口）。越界抛错。 */
export type AssertRendererPath = (input: unknown, mode?: 'read' | 'write') => string

/** 渲染层文件通道边界校验（比目录通道更严格）。越界抛错。 */
export type AssertRendererFilePath = (input: unknown, mode?: 'read' | 'write') => string

/** 项目目录数组校验（空数组合法）。越界抛错。 */
export type AssertProjectDirs = (input: unknown) => string[]
