import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { TypeDefinitionFile } from '../src/shared/types'
import { getEditorJsxMode, hasReactJsxRuntimeTypes } from '../src/renderer/src/jsxTypeSupport'

const reactTypes: TypeDefinitionFile[] = [
  {
    uri: 'file:///workspace/node_modules/@types/react/index.d.ts',
    content: `
      export declare function useState<S>(initial: S): [S, (value: S) => void];
      export namespace JSX {
        interface Element { readonly type: string }
        interface IntrinsicElements {
          div: { children?: any };
          button: { children?: any; disabled?: boolean };
        }
      }
    `
  },
  {
    uri: 'file:///workspace/node_modules/@types/react/jsx-runtime.d.ts',
    content: "export { JSX } from './index';"
  }
]

/** The same URI-only virtual filesystem used by the Monaco worker's extra libs. */
function diagnose(code: string, extension: 'jsx' | 'tsx', types: TypeDefinitionFile[]) {
  const uri = `file:///workspace/scratch.${extension}`
  const files = new Map(types.map((file) => [file.uri, file.content]))
  files.set(uri, code)
  const readFile = (fileName: string): string | undefined => files.get(fileName) ?? ts.sys.readFile(fileName)
  const options: ts.CompilerOptions = {
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    allowJs: extension === 'jsx',
    checkJs: extension === 'jsx',
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noEmit: true,
    jsx: getEditorJsxMode(types, ts.JsxEmit),
    strict: false,
    target: ts.ScriptTarget.ESNext
  }
  const service = ts.createLanguageService({
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => '1',
    getScriptSnapshot: (fileName) => {
      const content = readFile(fileName)
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content)
    },
    getCurrentDirectory: () => '',
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (fileName) => readFile(fileName) !== undefined,
    readFile
  })
  try {
    return {
      semantic: service.getSemanticDiagnostics(uri).map((diagnostic) => diagnostic.code),
      syntax: service.getSyntacticDiagnostics(uri).map((diagnostic) => diagnostic.code)
    }
  } finally {
    service.dispose()
  }
}

describe('Monaco React JSX type support', () => {
  it.each(['jsx', 'tsx'] as const)('没有 React 类型时 %s 仍可检查源码，不要求 Worker 加载运行时', (extension) => {
    expect(diagnose('export default function App() { return <div>Hello</div> }', extension, [])).toEqual({ semantic: [], syntax: [] })

    const props = extension === 'tsx'
      ? 'function Card(props: { count: number })'
      : '/** @param {{count: number}} props */ function Card(props)'
    const invalid = diagnose(`${props} { return <div>{props.count}</div> }; export default function App() { return <Card count="wrong" /> }; unknownVariable;`, extension, [])
    expect(invalid.semantic).toContain(2322)
    expect(invalid.semantic).toContain(2304)
    expect(invalid.semantic).not.toContain(2875)
    expect(diagnose('export default function App() { return <div> }', extension, []).syntax.length).toBeGreaterThan(0)
  })

  it.each(['jsx', 'tsx'] as const)('有工作区类型时 %s 恢复 automatic JSX 并检查 HTML 属性和 Hook 参数', (extension) => {
    expect(getEditorJsxMode(reactTypes, ts.JsxEmit)).toBe(ts.JsxEmit.ReactJSX)
    const valid = diagnose('import { useState } from "react"; export default function App() { const [count] = useState(0); return <button disabled={false}>{count}</button> }', extension, reactTypes)
    expect(valid).toEqual({ semantic: [], syntax: [] })
    const invalid = diagnose('import { useState } from "react"; export default function App() { const [count, setCount] = useState(0); setCount("wrong"); return <button disabled="wrong">{count}</button> }', extension, reactTypes)
    expect(invalid.semantic).toContain(2322)
    expect(invalid.semantic).toContain(2345)
    expect(invalid.semantic).not.toContain(2875)
  })

  it('跟随类型刷新切换模式，只认可可被模块解析的 JSX 入口', () => {
    expect(getEditorJsxMode([], ts.JsxEmit)).toBe(ts.JsxEmit.Preserve)
    expect(getEditorJsxMode(reactTypes, ts.JsxEmit)).toBe(ts.JsxEmit.ReactJSX)
    expect(getEditorJsxMode([], ts.JsxEmit)).toBe(ts.JsxEmit.Preserve)
    expect(hasReactJsxRuntimeTypes([{ uri: 'file:///workspace/node_modules/react/jsx-runtime.d.ts', content: '' }])).toBe(true)
    expect(hasReactJsxRuntimeTypes([{ uri: 'file:///workspace/node_modules/@types/react/ts5.0/jsx-runtime.d.ts', content: '' }])).toBe(false)
    expect(hasReactJsxRuntimeTypes(reactTypes.slice(0, 1))).toBe(false)
  })
})
