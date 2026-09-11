/**
 * Issue 2 自检：URL 归一化 + 响应解析。
 *
 * 这个文件不依赖任何框架，Node 直接执行 `node --import tsx electron/modelDiscovery.test.ts`
 * 即可。把它当作 ponytail 的「一份可运行自检」：URL 边界错了上层就坏，
 * 这里用一组最小用例锁住。
 */

import { buildModelsEndpoint, parseModelsResponse } from './modelDiscovery.ts'

const cases: Array<{ input: string; expected: string }> = [
  { input: 'https://api.deepseek.com', expected: 'https://api.deepseek.com/v1/models' },
  { input: 'https://api.deepseek.com/', expected: 'https://api.deepseek.com/v1/models' },
  { input: 'https://api.example.com/v1', expected: 'https://api.example.com/v1/models' },
  { input: 'https://api.example.com/v1/', expected: 'https://api.example.com/v1/models' },
  { input: 'https://api.example.com/v2', expected: 'https://api.example.com/v2/models' },
  { input: 'https://api.example.com/models', expected: 'https://api.example.com/models' },
  { input: 'https://api.example.com/models?limit=100', expected: 'https://api.example.com/models?limit=100' }
]

let failed = 0
for (const c of cases) {
  const { url } = buildModelsEndpoint(c.input)
  if (url !== c.expected) {
    console.error(`FAIL buildModelsEndpoint(${JSON.stringify(c.input)}) → ${url}, want ${c.expected}`)
    failed += 1
  } else {
    console.log(`ok   buildModelsEndpoint(${JSON.stringify(c.input)}) → ${url}`)
  }
}

const jsonCases: Array<{ name: string; input: unknown; expectedIds: string[] }> = [
  {
    name: 'standard openai',
    input: { object: 'list', data: [{ id: 'gpt-4o', owned_by: 'openai' }, { id: 'gpt-4o-mini', owned_by: 'openai' }] },
    expectedIds: ['gpt-4o', 'gpt-4o-mini']
  },
  {
    name: 'plain array',
    input: [{ id: 'a' }, { id: 'b' }],
    expectedIds: ['a', 'b']
  },
  {
    name: 'fallback name',
    input: { models: [{ name: 'llama-3' }, { name: 'mistral' }] },
    expectedIds: ['llama-3', 'mistral']
  },
  {
    name: 'dedup',
    input: { data: [{ id: 'dup' }, { id: 'dup' }, { id: 'uniq' }] },
    expectedIds: ['dup', 'uniq']
  },
  {
    name: 'skip missing id',
    input: { data: [{ id: 'keep' }, { unrelated: 1 }, null] },
    expectedIds: ['keep']
  },
  {
    name: 'empty list',
    input: { data: [] },
    expectedIds: []
  }
]

for (const c of jsonCases) {
  const got = parseModelsResponse(c.input).map((m) => m.id)
  const sameLength = got.length === c.expectedIds.length
  const sameOrder = got.every((id, i) => id === c.expectedIds[i])
  if (!(sameLength && sameOrder)) {
    console.error(`FAIL parseModelsResponse[${c.name}] → ${JSON.stringify(got)}, want ${JSON.stringify(c.expectedIds)}`)
    failed += 1
  } else {
    console.log(`ok   parseModelsResponse[${c.name}] → ${JSON.stringify(got)}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed.')
