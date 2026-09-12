import fs from 'node:fs/promises'
import path from 'node:path'
import { SourceMap } from 'node:module'
import * as esbuild from 'esbuild'
import type { RunStartPayload, SourceLocation } from '@shared/types'
import { createPreviewEntry, createPreviewRuntime } from './preview-runtime'

export const PREVIEW_SCHEME = 'lab-preview'
export const PREVIEW_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'"

export interface PreviewArtifact {
  assets: Map<string, { body: Uint8Array | string; mime: string }>
  sourceFile: string
  sourceMap: SourceMap | null
}

export async function buildPreview(workspacePath: string, runId: string, payload: RunStartPayload): Promise<PreviewArtifact> {
  if (payload.language !== 'jsx' && payload.language !== 'tsx') throw new Error('组件预览仅支持 JSX / TSX。')
  if (typeof payload.code !== 'string' || Buffer.byteLength(payload.code, 'utf8') > 2 * 1024 * 1024) throw new Error('组件代码必须是文本，且不能超过 2 MB。')
  // Validate input before resolving dependencies or doing compiler work.
  const banner = createPreviewRuntime(runId, payload.input)
  for (const name of ['react', 'react-dom']) {
    try { await fs.access(path.join(workspacePath, 'node_modules', name, 'package.json')) } catch {
      throw new Error(`工作区缺少 ${name}。请在「依赖」中安装 react react-dom；类型提示建议再安装 @types/react @types/react-dom。`)
    }
  }
  const sourceFile = payload.sourceFilePath ? path.resolve(payload.sourceFilePath) : path.join(workspacePath, `scratch.${payload.language}`)
  const resolveDir = path.dirname(sourceFile)
  const outdir = path.join(workspacePath, '.offline-js-lab', 'previews', runId)
  const result = await esbuild.build({
    stdin: { contents: createPreviewEntry(runId), resolveDir: workspacePath, sourcefile: 'lab-preview-entry.jsx', loader: 'jsx' },
    outfile: path.join(outdir, 'preview.js'),
    absWorkingDir: workspacePath,
    nodePaths: [path.join(workspacePath, 'node_modules')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'chrome152',
    jsx: 'automatic',
    sourcemap: 'external',
    sourcesContent: true,
    legalComments: 'none',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    banner: { js: banner },
    loader: { '.png': 'file', '.jpg': 'file', '.jpeg': 'file', '.gif': 'file', '.svg': 'file', '.webp': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
    plugins: [{
      name: 'offline-preview-source',
      setup(build) {
        build.onResolve({ filter: /^lab:source$/ }, () => ({ path: sourceFile, namespace: 'lab-source' }))
        build.onLoad({ filter: /.*/, namespace: 'lab-source' }, () => ({ contents: payload.code, loader: payload.language === 'tsx' ? 'tsx' : 'jsx', resolveDir }))
        // One React installation for both the harness and the user component,
        // including when the saved source is outside the selected workspace.
        build.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, async (args) => {
          if (args.pluginData?.workspaceReact) return undefined
          return build.resolve(args.path, { kind: args.kind, resolveDir: workspacePath, pluginData: { workspaceReact: true } })
        })
        build.onResolve({ filter: /^(?:https?:|data:|file:|node:)/ }, (args) => ({ errors: [{ text: `浏览器预览仅允许本地浏览器依赖，无法导入 ${args.path}` }] }))
      }
    }]
  })
  const assets: PreviewArtifact['assets'] = new Map()
  let sourceMap: SourceMap | null = null
  const mime: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }
  for (const file of result.outputFiles) {
    const relative = path.relative(outdir, file.path).split(path.sep).join('/')
    if (relative === 'preview.js.map') sourceMap = new SourceMap(JSON.parse(file.text))
    else assets.set(`/${relative}`, { body: file.contents, mime: mime[path.extname(relative)] || 'application/octet-stream' })
  }
  const css = assets.has('/preview.css') ? '<link rel="stylesheet" href="./preview.css">' : ''
  assets.set('/index.html', { mime: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><title>Offline component preview</title><style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif;color:#171c25;background:#fff}*{box-sizing:border-box}</style>${css}</head><body><div id="root"></div><script type="module" src="./preview.js"></script></body></html>` })
  return { assets, sourceFile, sourceMap }
}

export function locatePreviewSource(artifact: PreviewArtifact, stack: string): SourceLocation | undefined {
  const matches = stack.matchAll(/lab-preview:\/\/[^\s/)]+\/preview\.js:(\d+):(\d+)/g)
  for (const match of matches) {
    const mapped = artifact.sourceMap?.findEntry(Number(match[1]) - 1, Number(match[2]) - 1)
    if (mapped && 'originalSource' in mapped && mapped.originalSource === `lab-source:${artifact.sourceFile}`) {
      return { file: artifact.sourceFile, line: mapped.originalLine + 1, column: mapped.originalColumn + 1 }
    }
  }
  return undefined
}

export function previewBuildFailure(error: unknown): { error: string; location?: SourceLocation } {
  const errors = (error as { errors?: esbuild.Message[] })?.errors
  if (!Array.isArray(errors) || errors.length === 0) return { error: error instanceof Error ? error.message : String(error) }
  if (errors.some((item) => item.text.includes('No matching export') && item.text.includes('"default"'))) {
    return { error: '请默认导出 React 组件，例如 export default function App() { return <div /> }。' }
  }
  const first = errors.find((item) => item.location && item.location.file !== 'lab-preview-entry.jsx')?.location
  return {
    error: errors.map((item) => item.location ? `${item.location.file}:${item.location.line}:${item.location.column + 1} ${item.text}` : item.text).join('\n'),
    location: first ? { file: first.file.replace(/^lab-source:/, ''), line: first.line, column: Buffer.from(first.lineText, 'utf8').subarray(0, first.column).toString('utf8').length + 1 } : undefined
  }
}
