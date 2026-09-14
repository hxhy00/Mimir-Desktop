/**
 * 兼容转发层（deprecated）。
 *
 * 当前形态：**单 Agent + 可选委派（双轨）**。原「子代理注册表」的职责全部迁入
 * {@link ./capabilityDomains}（能力域既是工具分组素材，也是委派子代理的定义来源），
 * 本文件仅保留旧导出名的转发，避免一次性改动扩散到所有引用点。
 * **新代码请直接 import capabilityDomains**。
 *
 * 命名说明：`subagent` → `capabilityDomain`。能力域不是独立决策体（不能互相协商），
 * 新名字更准确地描述了它们是什么；「委派子代理」是能力域的**一种消费形态**，
 * 由 {@link buildDomainSubagents} 编译而来。
 */
export {
  SUBAGENT_STORE_KEY,
  WORKER_TOOL_CATALOG,
  resolveWorkerTools,
  resolveAllWorkerTools,
  ALL_TOOL_IDS,
  BUILTIN_DOMAINS,
  BUILTIN_SUBAGENTS,
  loadCapabilityDomains,
  loadSubAgentDefs,
  buildCapabilityDomainPrompt,
  buildDomainSubagents,
  buildSubagentDescription,
  buildSubagentPrompt
} from './capabilityDomains'

export type { DomainSubagentSpec } from './capabilityDomains'

export type {
  WorkerToolMeta,
  CapabilityDomain,
  DomainRuntime,
  DomainLoadResult
} from './capabilityDomains'
