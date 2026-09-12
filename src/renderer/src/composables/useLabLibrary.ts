import { ref } from 'vue'
import type { LabDocument, SavedSnippet } from '@shared/types'
import { isLabDocument } from './useDocumentSession'

export const LAB_LIBRARY_KEY = 'offlineJsLab.snippetLibrary'
export const LIBRARY_SIZE_LIMIT = 2 * 1024 * 1024
export const LIBRARY_COUNT_LIMIT = 60

export interface LabTemplate extends LabDocument {
  id: string
  name: string
  description: string
}

const noInput = (): LabDocument['input'] => ({ format: 'text', text: '' })
export const LAB_TEMPLATES: readonly LabTemplate[] = [
  { id: 'blank-ts', name: '空白 TypeScript', description: 'Node 脚本，从一张空白开始', code: '', language: 'typescript', input: noInput() },
  { id: 'blank-js', name: '空白 JavaScript', description: 'Node 脚本，无类型标注', code: '', language: 'javascript', input: noInput() },
  {
    id: 'data-transform', name: 'JSON 数据处理', description: '读取输入面板，分组统计并输出结果', language: 'typescript',
    code: 'type Order = { category: string; amount: number }\nconst orders = lab.input as Order[]\nconst totals = orders.reduce<Record<string, number>>((result, order) => {\n  result[order.category] = (result[order.category] ?? 0) + order.amount\n  return result\n}, {})\ntotals\n',
    input: { format: 'json', text: '[\n  { "category": "图书", "amount": 80 },\n  { "category": "工具", "amount": 120 },\n  { "category": "图书", "amount": 45 }\n]' }
  },
  {
    id: 'async', name: '异步任务', description: '本地延迟任务与 Promise.all，不访问网络', language: 'typescript', input: noInput(),
    code: 'const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))\nconst results = await Promise.all([1, 2, 3].map(async value => {\n  await delay(value * 100)\n  return { value, doubled: value * 2 }\n}))\nresults\n'
  },
  {
    id: 'regex', name: '正则匹配', description: '将输入文本中的命名字段提取为对象', language: 'javascript',
    code: 'const pattern = /(?<name>[a-z]+)=(?<value>\\d+)/gi\nconst matches = Array.from(lab.inputText.matchAll(pattern), match => ({ ...match.groups }))\nmatches\n',
    input: { format: 'text', text: 'apples=12 oranges=8 pears=15' }
  },
  {
    id: 'react-jsx', name: 'React 交互组件 · JSX', description: '计数器；需要工作区安装 react 和 react-dom', language: 'jsx', input: noInput(),
    code: 'import { useState } from "react"\n\nexport default function App() {\n  const [count, setCount] = useState(0)\n  return (\n    <main style={{ fontFamily: "system-ui", padding: 32 }}>\n      <h1>本地组件实验</h1>\n      <p>每次运行会重置组件状态。</p>\n      <button onClick={() => setCount(count + 1)}>点击次数：{count}</button>\n    </main>\n  )\n}\n'
  },
  {
    id: 'react-tsx', name: 'React 数据组件 · TSX', description: '从 JSON 输入渲染列表；需要 React 及其类型定义', language: 'tsx',
    input: { format: 'json', text: '[\n  { "id": 1, "name": "观察结果" },\n  { "id": 2, "name": "修改组件" }\n]' },
    code: 'import { useState } from "react"\n\ntype Item = { id: number; name: string }\n\nexport default function App() {\n  const [selected, setSelected] = useState<number | null>(null)\n  const items = lab.input as Item[]\n  return (\n    <main style={{ fontFamily: "system-ui", padding: 32 }}>\n      <h1>输入数据预览</h1>\n      {items.map(item => (\n        <button key={item.id} onClick={() => setSelected(item.id)}\n          style={{ margin: 8, padding: 12, background: selected === item.id ? "#a8e6cf" : "#eee" }}>\n          {item.name}\n        </button>\n      ))}\n    </main>\n  )\n}\n'
  }
]

function isSavedSnippet(value: unknown): value is SavedSnippet {
  if (!isLabDocument(value)) return false
  const snippet = value as Partial<SavedSnippet>
  return typeof snippet.id === 'string' && snippet.id.length > 0 && snippet.id.length <= 100 &&
    typeof snippet.name === 'string' && snippet.name.trim().length > 0 && snippet.name.length <= 80 &&
    typeof snippet.updatedAt === 'number' && Number.isFinite(snippet.updatedAt) && snippet.updatedAt >= 0
}

export function useLabLibrary() {
  const snippets = ref<SavedSnippet[]>([])
  const error = ref('')
  const readOnly = ref(false)

  function read(): void {
    try {
      const raw = window.localStorage.getItem(LAB_LIBRARY_KEY)
      if (!raw) return
      if (raw.length > LIBRARY_SIZE_LIMIT) throw new Error('片段库超过容量限制，原有内容已保留。')
      const saved: unknown = JSON.parse(raw)
      if (!saved || typeof saved !== 'object') throw new Error('片段库格式无效，原有内容已保留。')
      const record = saved as { version?: unknown; snippets?: unknown }
      if (record.version !== 1 || !Array.isArray(record.snippets)) throw new Error('无法读取此版本的片段库，原有内容已保留。')
      const valid = record.snippets.filter(isSavedSnippet)
      const ids = new Set<string>()
      snippets.value = valid.filter(item => { if (ids.has(item.id)) return false; ids.add(item.id); return true }).slice(0, LIBRARY_COUNT_LIMIT)
      if (snippets.value.length !== record.snippets.length) {
        readOnly.value = true
        error.value = '部分收藏格式无效或超出数量限制，已跳过。为保护原始数据，片段库暂为只读；仍可载入可读片段并另存为文件。'
      }
    } catch (reason) {
      readOnly.value = true
      error.value = `${reason instanceof Error ? reason.message : '无法读取本地片段库。'} 为保护原始数据，片段库暂为只读。`
    }
  }

  function persist(next: SavedSnippet[]): boolean {
    if (readOnly.value) return false
    if (next.length > LIBRARY_COUNT_LIMIT) { error.value = `最多收藏 ${LIBRARY_COUNT_LIMIT} 个片段，请先删除不再需要的内容。`; return false }
    const serialized = JSON.stringify({ version: 1, snippets: next })
    if (serialized.length > LIBRARY_SIZE_LIMIT) { error.value = '片段库超过 2 MB 容量限制，请减少片段内容。'; return false }
    try {
      window.localStorage.setItem(LAB_LIBRARY_KEY, serialized)
      snippets.value = next
      error.value = ''
      return true
    } catch {
      error.value = '本地存储空间不足或不可用，收藏更改未保存。请先将代码保存到文件。'
      return false
    }
  }

  function save(name: string, document: LabDocument): boolean {
    if (readOnly.value) return false
    if (!name.trim() || name.trim().length > 80) { error.value = '片段名称需要 1–80 个字符。'; return false }
    if (!isLabDocument(document)) { error.value = '代码或输入内容超过大小限制，无法收藏。'; return false }
    return persist([{ ...document, input: { ...document.input }, id: crypto.randomUUID(), name: name.trim(), updatedAt: Date.now() }, ...snippets.value])
  }

  function rename(id: string, name: string): boolean {
    if (readOnly.value) return false
    if (!name.trim() || name.trim().length > 80) { error.value = '片段名称需要 1–80 个字符。'; return false }
    if (!snippets.value.some(item => item.id === id)) return false
    return persist(snippets.value.map(item => item.id === id ? { ...item, name: name.trim(), updatedAt: Date.now() } : item))
  }

  function remove(id: string): boolean {
    if (readOnly.value) return false
    return persist(snippets.value.filter(item => item.id !== id))
  }

  read()
  return { snippets, error, readOnly, save, rename, remove }
}
