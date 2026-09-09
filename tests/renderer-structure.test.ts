import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, relativePath), 'utf8')

const app = read('src/renderer/src/App.vue')
const output = read('src/renderer/src/components/OutputConsole.vue')
const css = read('src/renderer/src/styles.css')
const rendererMain = read('src/renderer/src/main.ts')
const rendererHtml = read('src/renderer/index.html')
const startupError = read('src/renderer/src/startup-error.ts')
const monaco = read('src/renderer/src/monaco.ts')
const outputBuffer = read('src/renderer/src/composables/useOutputBuffer.ts')
const resizableSplit = read('src/renderer/src/composables/useResizableSplit.ts')
const packageJson = JSON.parse(read('package.json')) as {
  version: string
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('Vue renderer architecture', () => {
  it('使用 Vue 3 + electron-vite + TypeScript + Monaco', () => {
    expect(packageJson.version).toBe('0.3.2')
    expect(packageJson.dependencies.vue).toBeTruthy()
    expect(packageJson.dependencies['monaco-editor']).toBe('0.56.0')
    expect(packageJson.devDependencies['electron-vite']).toBeTruthy()
    expect(packageJson.devDependencies.typescript).toBeTruthy()
    expect(app).toMatch(/<script setup lang="ts">/)
    expect(app).toMatch(/<MonacoEditor/)
  })

  it('保留左右可调分栏、手动与实时运行', () => {
    expect(app).toMatch(/class="split-deck"/)
    expect(app).toMatch(/class="deck-splitter"/)
    expect(app).toMatch(/setRunMode\('manual'\)/)
    expect(app).toMatch(/setRunMode\('live'\)/)
    expect(app).toMatch(/AUTO_RUN_DELAY_MS = 500/)
  })

  it('手动和实时运行共用持久化的运行前清空设置', () => {
    expect(app).toMatch(/offlineJsLab\.clearOutputOnRun/)
    expect(app).toMatch(/if \(clearOutputOnRun\.value\) clearOutput\(\)/)
    expect(output).toMatch(/update:clearOnRun/)
  })

  it('Monaco 0.56 直接使用 TypeScript register 入口导出，避免挂载前黑屏', () => {
    expect(monaco).toMatch(
      /from 'monaco-editor\/languages\/features\/typescript\/register'/
    )
    expect(monaco).toMatch(/typescriptDefaults/)
    expect(monaco).toMatch(/javascriptDefaults/)
    expect(monaco).not.toMatch(/candidate\.typescript/)
    expect(monaco).not.toMatch(/candidate\.languages\?\.typescript/)
  })

  it('Renderer 启动失败时显示诊断界面，而不是保持纯黑', () => {
    expect(rendererMain).toMatch(/await import\('\.\/App\.vue'\)/)
    expect(rendererMain).toMatch(/renderStartupFailure/)
    expect(rendererHtml).toMatch(/renderer-loading/)
    expect(startupError).toMatch(/host\.replaceChildren\(root\)/)
    expect(startupError).toMatch(/window\.location\.reload\(\)/)
    expect(css).toMatch(/\.startup-failure/)
  })

  it('只读 computed 使用 ComputedRef 类型，不误判为 WritableComputedRef', () => {
    expect(outputBuffer).toMatch(/hasOutput: ComputedRef<boolean>/)
    expect(resizableSplit).toMatch(/gridTemplateColumns: ComputedRef<string>/)
    expect(outputBuffer).not.toMatch(/ReturnType<typeof computed<boolean>>/)
    expect(resizableSplit).not.toMatch(/ReturnType<typeof computed<string>>/)
  })

  it('避开 vue-tsc 3.1.6 的模板 codegen 崩溃版本', () => {
    expect(packageJson.devDependencies['vue-tsc']).not.toBe('3.1.6')
  })

  it('不包含运行超时设置，并包含可降低动态效果的样式', () => {
    expect(app).not.toMatch(/timeoutMs|offlineJsLab\.timeout/)
    expect(css).toMatch(/prefers-reduced-motion: reduce/)
    expect(css).toMatch(/--cyber-yellow:/)
    expect(css).toMatch(/boot-screen/)
  })
})
