import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPreview, locatePreviewSource, previewBuildFailure } from '../src/main/preview-build'
import { createPreviewRuntime } from '../src/main/preview-runtime'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

async function fixture(withDependencies = true): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-preview-test-'))
  roots.push(root)
  if (withDependencies) {
    const files: Record<string, string> = {
      'react/package.json': '{"name":"react","main":"index.js"}',
      'react/index.js': 'export default { Component: class {}, createElement: (...args) => args, isValidElement: () => false, useLayoutEffect: () => {} };',
      'react/jsx-runtime.js': 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;',
      'react-dom/package.json': '{"name":"react-dom","main":"client.js"}',
      'react-dom/client.js': 'export const createRoot = () => ({ render() {} });'
    }
    for (const [name, content] of Object.entries(files)) {
      const destination = path.join(root, 'node_modules', name)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, content)
    }
  }
  return root
}

describe('browser preview compiler', () => {
  it('bundles TSX, CSS and assets locally, maps output back to the unsaved original source, and writes no run files', async () => {
    const root = await fixture()
    await fs.writeFile(path.join(root, 'style.css'), 'button { background-image: url("./pixel.png"); color: red }')
    await fs.writeFile(path.join(root, 'pixel.png'), Buffer.from([137, 80, 78, 71]))
    const artifact = await buildPreview(root, 'compile-test', {
      language: 'tsx', sourceFilePath: null,
      code: 'import "./style.css"\nconst message: string = "hello"\nconsole.log(message)\nexport default function App() { return <button>{message}</button> }',
      input: { format: 'json', text: '{"count":7}' }
    })
    expect(artifact.assets.has('/index.html')).toBe(true)
    expect(artifact.assets.has('/preview.css')).toBe(true)
    expect([...artifact.assets.keys()].some((name) => name.endsWith('.png'))).toBe(true)
    const code = Buffer.from(artifact.assets.get('/preview.js')!.body).toString('utf8')
    const position = code.indexOf('console.log(message)')
    expect(position).toBeGreaterThan(0)
    const line = code.slice(0, position).split('\n').length
    const column = position - code.lastIndexOf('\n', position)
    expect(locatePreviewSource(artifact, `Error\n at App (lab-preview://random/preview.js:${line}:${column})`)).toEqual({ file: path.join(root, 'scratch.tsx'), line: 3, column: 1 })
    await expect(fs.access(path.join(root, '.offline-js-lab'))).rejects.toThrow()
    expect(code).not.toContain('from "react"')
  })

  it('returns actionable missing dependencies, JSON validation and source compilation errors', async () => {
    const root = await fixture(false)
    const payload = { language: 'jsx' as const, sourceFilePath: null, code: 'export default () => <button />' }
    await expect(buildPreview(root, 'missing', payload)).rejects.toThrow('依赖')
    await expect(buildPreview(root, 'input', { ...payload, input: { format: 'json', text: '{' } })).rejects.toThrow('有效 JSON')
    const installed = await fixture()
    try {
      await buildPreview(installed, 'broken', { ...payload, code: '\nexport default () => <button>' })
      expect.fail('Invalid JSX must fail')
    } catch (error) {
      expect(previewBuildFailure(error).location?.line).toBe(2)
    }
    await expect(buildPreview(installed, 'node', { ...payload, code: 'import fs from "node:fs"; export default () => <div>{fs}</div>' })).rejects.toThrow('本地浏览器依赖')
    try {
      await buildPreview(installed, 'no-export', { ...payload, code: 'export const value = 1' })
      expect.fail('Missing default export must fail')
    } catch (error) {
      expect(previewBuildFailure(error)).toEqual({ error: expect.stringContaining('默认导出 React 组件') })
    }
  })

  it('captures structured logs once without evaluating accessors, and provides lab input before source evaluation', () => {
    const sent: unknown[] = []
    const listeners = new Map<string, (event: unknown) => void>()
    const window = { location: { origin: 'lab-preview://test' }, postMessage: (data: unknown) => sent.push(data), addEventListener: (event: string, listener: (event: unknown) => void) => listeners.set(event, listener) }
    const sandbox = vm.createContext({ window, TextEncoder, console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, table() {} } })
    vm.runInContext(createPreviewRuntime('capture', { format: 'json', text: '{"name":"sample"}' }), sandbox)
    vm.runInContext('let reads=0;const obj={name:lab.input.name,get secret(){reads++;return 99}};obj.self=obj;console.log(obj);if(reads)throw Error("getter evaluated")', sandbox)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ runId: 'capture', type: 'output', values: [{ kind: 'object', children: [{ key: 'name', value: { preview: '"sample"' } }, { key: 'secret', value: { kind: 'accessor' } }, { key: 'self', value: { kind: 'circular' } }] }] })
    expect(listeners.has('unhandledrejection')).toBe(true)
    vm.runInContext('console.error("%o %s", new Error("render failed"), "details")', sandbox)
    expect(sent[1]).toMatchObject({ stream: 'stderr', text: 'Error: render failed details\n', stack: expect.stringContaining('render failed') })
    vm.runInContext('console.log("123", "true", "{\\"a\\":1}")', sandbox)
    expect(sent[2]).toMatchObject({ text: '123 true {"a":1}\n', values: [{ kind: 'string', preview: '"123"' }, { kind: 'string', preview: '"true"' }, { kind: 'string', preview: '"{\\"a\\":1}"' }] })
  })

  it('maps compile error UTF-8 byte columns to editor UTF-16 columns', async () => {
    const root = await fixture()
    const code = 'const 中文 = <div 属性={}></div>'
    try {
      await buildPreview(root, 'unicode', { code, language: 'tsx', sourceFilePath: null })
      expect.fail('Empty JSX expression must fail')
    } catch (error) {
      expect(previewBuildFailure(error).location).toMatchObject({ line: 1, column: code.indexOf('}') + 1 })
    }
  })

  it('preserves JSON own __proto__ keys in browser input without changing prototypes', () => {
    const sandbox = vm.createContext({ window: { location: { origin: 'lab-preview://test' }, postMessage() {}, addEventListener() {} }, TextEncoder, console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, table() {} } })
    vm.runInContext(createPreviewRuntime('input-proto', { format: 'json', text: '{"__proto__":{"flag":true},"text":"</script>\\u2028"}' }), sandbox)
    expect(vm.runInContext('Object.hasOwn(lab.input, "__proto__")', sandbox)).toBe(true)
    expect(vm.runInContext('lab.input.flag', sandbox)).toBeUndefined()
    expect(vm.runInContext('lab.input.__proto__.flag', sandbox)).toBe(true)
  })
})
