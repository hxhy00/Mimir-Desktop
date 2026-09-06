/**
 * 会议模板注入：常用学术会议/期刊的官方排版指引写入
 * `paperDir/template/TEMPLATE.md`，供写作时对照（AI 自动重排版为后续增强）。
 */
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

export interface VenueTemplate {
  readonly id: string
  readonly name: string
  readonly series: string
  readonly url: string
  readonly checklist: string
}

export const VENUE_TEMPLATES: readonly VenueTemplate[] = Object.freeze([
  {
    id: 'cvpr',
    name: 'CVPR (IEEE/CVF)',
    series: 'CV',
    url: 'https://cvpr.thecvf.com/Conferences/2025/AuthorGuidelines',
    checklist: 'Format via CVPR template (IEEEtran)\n- two-column, 10pt\n- anonymous submission, no author info\n- page limit per CfP\n- figures vectorized, refs via IEEE style',
  },
  {
    id: 'iccv',
    name: 'ICCV (IEEE/CVF)',
    series: 'CV',
    url: 'https://iccv.thecvf.com/',
    checklist: 'IEEEtran two-column template\n- use ICCV official .sty/kit\n- double-blind review\n- camera-ready with page numbers',
  },
  {
    id: 'neurips',
    name: 'NeurIPS',
    series: 'ML',
    url: 'https://neurips.cc/',
    checklist: 'neurips_2024.sty\n- single column, no author list in submission\n- appendix allowed after references\n- check page limit',
  },
  {
    id: 'icml',
    name: 'ICML',
    series: 'ML',
    url: 'https://icml.cc/',
    checklist: 'icml2025.sty\n- two-column\n- anonymous\n- appendix after references',
  },
  {
    id: 'iclr',
    name: 'ICLR',
    series: 'ML',
    url: 'https://iclr.cc/',
    checklist: 'iclr2025.sty + rebuttal instructions\n- anonymous single-column draft\n- camera-ready two-column',
  },
  {
    id: 'acl',
    name: 'ACL Rolling Review',
    series: 'NLP',
    url: 'https://aclrollingreview.org/',
    checklist: 'acl.sty (ARR)\n- anonymous, no author names\n- paper must be self-contained',
  },
  {
    id: 'aaai',
    name: 'AAAI',
    series: 'AI',
    url: 'https://aaai.org/',
    checklist: 'aaai25.sty\n- two-column\n- anonymous\n- references IEEE-like within limit',
  },
])

/** 生成 TEMPLATE.md 内容。 */
export function templateBriefOf(template: VenueTemplate): string {
  const lines = [
    `# ${template.name} — 排版模板要点`,
    '',
    `官方资料：${template.url}`,
    '',
    '## Checklist',
    '',
    ...template.checklist
      .split('\n')
      .map((item) => `- ${item}`),
    '',
    '> 由 Mimir 写入，写作与编译前请对照核对。',
  ]
  return lines.join('\n')
}

export async function applyVenueTemplate(projectDir: string, templateId: string): Promise<string> {
  const template = VENUE_TEMPLATES.find((t) => t.id === templateId)
  if (template === undefined) throw new Error(`unknown venue template: ${templateId}`)
  const dir = join(projectDir, 'template')
  await mkdir(dir, { recursive: true })
  const target = join(dir, 'TEMPLATE.md')
  await writeFile(target, templateBriefOf(template), 'utf-8')
  return target
}
