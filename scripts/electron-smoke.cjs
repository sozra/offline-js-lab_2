'use strict'

/*
 * Whole-app Electron smoke test. Build first, then launch with the local Electron:
 *   <electron binary> scripts/electron-smoke.cjs --dependencies=/absolute/node_modules --node=/absolute/node
 * The optional dependency directory must contain React and ReactDOM. It is symlinked
 * into a fresh temporary workspace. Every profile, fixture, report and screenshot is
 * written under os.tmpdir(); the user's Electron profile/workspace is never used.
 * Only native open/save path selection is stubbed. All application actions use the
 * real DOM, keyboard events, public event subscriptions, IPC and compiled Main.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, dialog, webContents } = require('electron')
const repository = path.resolve(__dirname, '..')
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const dependencyPath = argument('dependencies')
const systemNode = argument('node') || process.env.OFFLINE_JS_LAB_NODE || 'node'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-js-lab-ui-smoke-'))
const profile = path.join(root, 'profile')
const workspace = path.join(root, 'workspace')
const screenshots = path.join(root, 'screenshots')
for (const directory of [profile, workspace, screenshots, path.join(profile, 'session')]) fs.mkdirSync(directory, { recursive: true })
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ workspacePath: workspace }))
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'offline-lab-smoke', private: true,
  dependencies: dependencyPath ? { react: '*', 'react-dom': '*' } : {} }))
if (dependencyPath) {
  for (const name of ['react', 'react-dom']) assert.ok(fs.existsSync(path.join(dependencyPath, name, 'package.json')), `Missing fixture dependency: ${name}`)
  fs.symlinkSync(path.resolve(dependencyPath), path.join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
}
app.setPath('userData', profile)
app.setPath('sessionData', path.join(profile, 'session'))
process.chdir(repository)
process.env.OFFLINE_JS_LAB_NODE = systemNode
delete process.env.ELECTRON_RENDERER_URL
const initialFile = path.join(workspace, 'recovered.ts')
const initialCode = 'console.log("SMOKE_INITIAL", lab.input.answer)\n'
fs.writeFileSync(initialFile, 'console.log("saved baseline")\n')
let openPath = null
let savePath = path.join(workspace, 'saved.ts')
dialog.showOpenDialog = async () => {
  const selected = openPath; openPath = null
  return selected ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] }
}
dialog.showSaveDialog = async () => ({ canceled: false, filePath: savePath })
const report = { root, repository, profile, workspace, dependencyPath: dependencyPath || null,
  node: systemNode, platform: process.platform, startedAt: new Date().toISOString(), steps: [], consoleErrors: [] }
let main = null
let finishing = false
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function wait(check, description, limit = 20000) {
  const deadline = Date.now() + limit
  let lastError
  while (Date.now() < deadline) {
    try {
      // A preview replacement can destroy WebContents while a read-only query
      // is pending. Re-resolve the current view on the next bounded probe.
      const result = await Promise.race([Promise.resolve().then(check), pause(Math.max(1, Math.min(250, deadline - Date.now()))).then(() => false)])
      if (result) return result
    } catch (error) { lastError = error }
    await pause(35)
  }
  throw new Error(`Timed out: ${description}${lastError ? ` (${lastError.message})` : ''}`)
}
const js = (source, ...args) => main.webContents.executeJavaScript(`(${source})(...${JSON.stringify(args)})`, true)
const visibleExpression = 'element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== "hidden" }'
async function exists(selector) { return js(`selector => [...document.querySelectorAll(selector)].some(${visibleExpression})`, selector) }
async function click(selector) {
  await wait(() => js(`selector => { const element = [...document.querySelectorAll(selector)].find(${visibleExpression}); if (!element || element.disabled) return false; element.click(); return true }`, selector), `click ${selector}`)
}
async function clickText(pattern, scope = 'body') {
  await wait(() => js(`(pattern, scope) => { const visible = ${visibleExpression}; const element = [...document.querySelectorAll(scope + ' button')].find(item => visible(item) && !item.disabled && new RegExp(pattern).test(item.textContent.trim())); if (!element) return false; element.click(); return true }`, pattern, scope), `button ${pattern} in ${scope}`)
}
async function fill(selector, value) {
  await wait(() => exists(selector), `field ${selector}`)
  await js(`(selector, value) => { const element = document.querySelector(selector); element.focus(); const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }`, selector, value)
}
async function storedDocument() {
  return js(`() => { const raw = localStorage.getItem('offlineJsLab.documentSession'); return raw ? JSON.parse(raw).document : { code: localStorage.getItem('offlineJsLab.code'), language: localStorage.getItem('offlineJsLab.language') } }`)
}
async function replaceCode(code, settled = true) {
  main.focus(); main.webContents.focus()
  await js(`() => { const editor = document.querySelector('.monaco-editor'); if (!editor) throw Error('Monaco missing'); const input = editor.querySelector('textarea.inputarea, .native-edit-context, [contenteditable="true"]'); if (!input) throw Error('Monaco accessible input missing'); input.focus() }`)
  const modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
  main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers })
  main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers })
  // sendInputEvent queues native key handling; insertText must wait for the
  // selection event to reach Monaco's actual editor before replacing it.
  await pause(60)
  await main.webContents.insertText(code)
  // Monaco may apply normal editor auto-indentation to multiline native text
  // insertion. Fixture semantics are asserted by real execution in each step.
  if (settled) await wait(async () => (await storedDocument()).code.replace(/\s+/g, ' ').trim() === code.replace(/\s+/g, ' ').trim(), 'Monaco edit persisted')
}
async function monitorEvents() {
  await js(`() => {
    window.__offlineSmokeEvents = [];
    for (const name of ['onRunOutput', 'onRunExit', 'onPreviewOutput', 'onPreviewState']) {
      window.offlineJsLab[name](payload => window.__offlineSmokeEvents.push({ name, payload }));
    }
  }`)
}
const events = () => js('() => window.__offlineSmokeEvents || []')
async function waitOutput(text, from = 0) {
  return wait(async () => (await events()).slice(from).find(event => /Output$/.test(event.name) && event.payload.text.includes(text)), `output ${text}`)
}
async function runNode(expected) {
  const before = (await events()).length
  await click('.execute-button')
  const exited = await wait(async () => (await events()).slice(before).find(event => event.name === 'onRunExit'), 'Node exit')
  await wait(() => js(`() => { const button = document.querySelector('.execute-button'); return button && !button.disabled }`), 'run button leaves running state')
  if (expected) await waitOutput(expected, before)
  return exited.payload
}
async function screenshot(name) {
  if (!main || main.isDestroyed()) return
  // DOM presence precedes Vue's enter transition and the compositor's next paint.
  await pause(220)
  await js('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  fs.writeFileSync(path.join(screenshots, name + '.png'), (await main.capturePage()).toPNG())
  const preview = currentPreview()
  if (preview) fs.writeFileSync(path.join(screenshots, name + '-preview.png'), (await preview.capturePage()).toPNG())
}
async function assertDialogCloseAligned(selector) {
  const rects = await js(`selector => {
    const dialog = document.querySelector(selector)
    const button = dialog.querySelector('.dialog-close')
    return { dialogRight: dialog.getBoundingClientRect().right, buttonRight: button.getBoundingClientRect().right }
  }`, selector)
  assert.ok(rects.buttonRight > rects.dialogRight - 45 && rects.buttonRight <= rects.dialogRight + 1,
    `${selector} close button must align with the dialog's right edge`)
}
async function step(name, action) {
  console.log(`SMOKE_STEP ${name}`)
  const started = Date.now()
  try {
    await action()
    report.steps.push({ name, ok: true, durationMs: Date.now() - started })
    console.log(`SMOKE_PASS ${name}`)
  } catch (error) {
    report.steps.push({ name, ok: false, durationMs: Date.now() - started, error: error.stack || String(error) })
    throw error
  }
}
async function confirm(accept = true) {
  await wait(() => exists('.confirm-dialog'), 'confirmation dialog')
  await click(`.confirm-dialog .confirm-actions button:${accept ? 'last' : 'first'}-child`)
  await wait(async () => !(await exists('.confirm-dialog')), 'confirmation closes')
}
async function settleOptionalConfirm(accept = true) {
  for (let index = 0; index < 12; index++) {
    if (await exists('.confirm-dialog')) { await confirm(accept); return true }
    await pause(35)
  }
  return false
}
async function inputText(text, format = 'json') {
  if (!(await exists('.input-panel textarea'))) await click('.input-panel__toggle')
  await js(`format => { const select = document.querySelector('.input-panel__controls select'); select.value = format; select.dispatchEvent(new Event('change', { bubbles: true })) }`, format)
  await fill('.input-panel textarea', text)
  await wait(async () => (await storedDocument()).input?.text === text, 'input persisted')
}
async function openLibrary() {
  if (await exists('.library-dialog')) return
  await wait(() => js(`() => { const visible = ${visibleExpression}; const button = [...document.querySelectorAll('button')].find(item => visible(item) && /片段|收藏|模板/.test((item.title || '') + ' ' + item.textContent)); if (!button || button.disabled) return false; button.click(); return true }`), 'open snippet library')
  await wait(() => exists('.library-dialog'), 'library dialog opens')
}
async function useTemplate(name) {
  await openLibrary()
  await js(`name => { const item = [...document.querySelectorAll('.library-item')].find(item => item.querySelector('strong')?.textContent.includes(name)); if (!item) throw Error('Template missing: ' + name); [...item.querySelectorAll('button')].find(button => /使用模板/.test(button.textContent)).click() }`, name)
}
function currentPreview() { return webContents.getAllWebContents().find(contents => !contents.isDestroyed() && contents.getURL().startsWith('lab-preview:')) }
function nativePreviewVisible(preview) {
  const view = main.contentView.children.find(child => child.webContents === preview)
  return Boolean(view?.getVisible())
}
async function selectConsole() {
  await clickText('^(控制台|Console|CONSOLE)(\\s|$)')
  await wait(() => exists('.output-panel'), 'console tab')
}
async function selectPreview() {
  await clickText('^(组件预览|预览|Preview|PREVIEW)(\\s|$)')
  await wait(() => exists('.preview-pane'), 'preview tab')
}
async function ready() {
  await wait(() => js(`() => !document.querySelector('.boot-screen') && !!document.querySelector('.monaco-editor') && /(?:TSX?|JSX?) LANGUAGE SERVICE ONLINE/.test(document.body.textContent)`), 'Monaco language service ONLINE', 30000)
}
async function reloadRenderer() {
  const loaded = new Promise(resolve => main.webContents.once('did-finish-load', resolve))
  main.webContents.reload()
  await loaded
  await ready()
}
async function finish(code, error) {
  if (finishing) return
  finishing = true
  if (error) {
    report.error = error.stack || String(error)
    console.error('SMOKE_FAILED', report.error)
    try { await screenshot('failed') } catch { /* Preserve the original error. */ }
  }
  try {
    if (main && !main.isDestroyed()) {
      report.events = await events()
      report.finalDocument = await storedDocument()
      report.dom = await js('() => ({ text: document.body.innerText, buttons: [...document.querySelectorAll("button")].map(button => ({ text: button.textContent.trim(), title: button.title, disabled: button.disabled })) })')
    }
  } catch { /* A renderer failure may prevent diagnostics. */ }
  report.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`SMOKE_REPORT ${path.join(root, 'report.json')}`)
  if (main && !main.isDestroyed()) main.destroy()
  app.exit(code)
}

async function suite() {
  await step('isolated profile and real renderer startup', async () => {
    await ready()
    await js(`session => { localStorage.clear(); localStorage.setItem('offlineJsLab.documentSession', JSON.stringify({ version: 1, document: session })); localStorage.setItem('offlineJsLab.runMode', 'manual'); localStorage.setItem('offlineJsLab.clearOutputOnRun', 'true'); }`, {
      code: initialCode, language: 'typescript', input: { format: 'json', text: '{"answer":3}' },
      filePath: initialFile, lastSavedCode: fs.readFileSync(initialFile, 'utf8'), dirty: true
    })
    await reloadRenderer()
    await monitorEvents()
    assert.equal((await storedDocument()).filePath, initialFile)
    assert.ok(await exists('.dirty-tag'), 'Recovered unsaved edits must remain dirty')
    assert.equal(app.getPath('userData'), profile)
    await screenshot('01-startup')
  })
  await step('ordinary Node completion and real source error location', async () => {
    assert.equal((await runNode('SMOKE_INITIAL 3')).reason, 'completed')
    await replaceCode('const before = 1\nthrow new Error("SMOKE_RUNTIME_ERROR")\n')
    assert.equal((await runNode('SMOKE_RUNTIME_ERROR')).reason, 'failed')
    assert.ok(await js(`() => [...document.querySelectorAll('.output-chunk--stderr .output-location')].some(button => /^L2:/.test(button.textContent))`), 'Runtime error must link to source line 2')
    await click('.output-chunk--stderr .output-location')
    await wait(() => js(`() => Boolean(document.activeElement?.closest('.monaco-editor'))`), 'error location focuses real editor')
    await screenshot('02-runtime-error')
  })
  await step('manual ABORT and debounced live edits execute only latest code', async () => {
    await replaceCode('console.log("SMOKE_RESIDENT"); setInterval(() => {}, 1000)')
    let before = (await events()).length
    await click('.execute-button')
    await waitOutput('SMOKE_RESIDENT', before)
    await click('.abort-button')
    const stopped = await wait(async () => (await events()).slice(before).find(event => event.name === 'onRunExit'), 'ABORT exit')
    assert.equal(stopped.payload.reason, 'stopped')
    await replaceCode('console.log("SMOKE_LIVE_0"); setInterval(() => {}, 1000)')
    before = (await events()).length
    await clickText('LIVE|实时', '.mode-switch')
    await waitOutput('SMOKE_LIVE_0', before)
    const editEvents = (await events()).length
    await replaceCode('console.log("SMOKE_LIVE_1")', false)
    await replaceCode('console.log("SMOKE_LIVE_2")')
    await waitOutput('SMOKE_LIVE_2', editEvents)
    await wait(async () => (await events()).slice(editEvents).some(event => event.name === 'onRunExit' && event.payload.reason === 'completed'), 'latest live script completion')
    assert.ok(!(await events()).slice(editEvents).some(event => event.name === 'onRunOutput' && event.payload.text.includes('SMOKE_LIVE_1')), 'Intermediate live edit executed')
    await clickText('MANUAL|手动', '.mode-switch')
  })
  await step('renderer reload stops resident Node and permits a fresh run', async () => {
    await replaceCode('console.log("SMOKE_RELOAD_RESIDENT", process.pid); setInterval(() => {}, 1000)')
    const before = (await events()).length
    await click('.execute-button')
    const resident = await waitOutput('SMOKE_RELOAD_RESIDENT', before)
    const pid = Number(resident.payload.text.match(/SMOKE_RELOAD_RESIDENT\s+(\d+)/)?.[1])
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Resident Node PID must be observable')
    await reloadRenderer()
    await monitorEvents()
    await wait(() => {
      try { process.kill(pid, 0); return false }
      catch (error) { if (error.code === 'ESRCH') return true; throw error }
    }, 'resident Node process exits after renderer reload')
    await replaceCode('console.log("SMOKE_AFTER_RELOAD")')
    assert.equal((await runNode('SMOKE_AFTER_RELOAD')).reason, 'completed')
  })
  await step('JSON input, fixed baseline, comparison and snapshot restore', async () => {
    await replaceCode('console.log("SMOKE_INPUT", lab.input.answer)')
    await inputText('{"answer":7}')
    await runNode('SMOKE_INPUT 7')
    await clickText('^固定结果$', '.output-panel')
    await wait(() => exists('.pinned-details'), 'baseline fixed')
    await inputText('{"answer":9}')
    await runNode('SMOKE_INPUT 9')
    await clickText('^比较$', '.output-panel')
    await wait(() => exists('.compare-dialog'), 'comparison dialog')
    assert.ok(await js(`() => document.querySelector('.compare-dialog').textContent.includes('SMOKE_INPUT 7') && document.querySelector('.compare-dialog').textContent.includes('SMOKE_INPUT 9')`))
    await screenshot('03-comparison')
    await assertDialogCloseAligned('.compare-dialog')
    await click('.compare-labels > div:first-child button')
    const cancelled = await settleOptionalConfirm(false)
    if (cancelled) assert.equal((await storedDocument()).input.text, '{"answer":9}')
    if (cancelled) {
      if (!(await exists('.compare-dialog'))) await clickText('^比较$', '.output-panel')
      await click('.compare-labels > div:first-child button'); await settleOptionalConfirm(true)
    }
    await wait(async () => (await storedDocument()).input.text === '{"answer":7}', 'baseline input restored')
    if (await exists('.compare-dialog')) await click('.compare-dialog .dialog-close')
  })
  await step('PURGE preserves output preference, real save/open and dirty session recovery', async () => {
    await click('.output-settings > summary')
    await js(`() => { const box = document.querySelector('input[aria-label="每次运行前清空输出"]'); if (box.checked) box.click() }`)
    await click('.output-settings > summary')
    await click('.output-controls button[title*="PURGE"]')
    await wait(async () => await js(`() => localStorage.getItem('offlineJsLab.clearOutputOnRun')`) === 'false', 'PURGE preserves clear preference')
    await click('.toolbar-button[title^="保存"]')
    await wait(async () => fs.readFileSync(initialFile, 'utf8') === (await storedDocument()).code, 'real save writes fixture file')
    const opened = path.join(workspace, 'opened.ts')
    fs.writeFileSync(opened, 'console.log("SMOKE_OPENED")\n')
    openPath = opened
    await click('.toolbar-button[title^="打开"]')
    await settleOptionalConfirm(true)
    await wait(async () => (await storedDocument()).filePath === opened, 'real open IPC file association')
    const draft = 'console.log("SMOKE_RESTORED_DRAFT")\n'
    await replaceCode(draft)
    await reloadRenderer(); await monitorEvents()
    const restored = await storedDocument()
    assert.equal(restored.filePath, opened)
    assert.equal(restored.code, draft)
    assert.equal(restored.dirty, true)
    assert.ok(await exists('.dirty-tag'))
    await screenshot('04-restored-draft')
  })
  await step('snippet save and template replacement cancellation', async () => {
    await openLibrary()
    await fill('#snippet-name', 'SMOKE saved experiment')
    await click('.library-save button[type="submit"]')
    await wait(() => js(`() => [...document.querySelectorAll('.library-item strong')].some(item => item.textContent === 'SMOKE saved experiment')`), 'snippet saved')
    const before = await storedDocument()
    await useTemplate('空白 TypeScript')
    await confirm(false)
    assert.equal((await storedDocument()).code, before.code)
    if (await exists('.library-dialog')) await click('.library-dialog .dialog-close')
    await replaceCode('// changed before restoring the saved snippet')
    await openLibrary()
    await js(`() => { const item = [...document.querySelectorAll('.library-item')].find(item => item.querySelector('strong')?.textContent === 'SMOKE saved experiment'); [...item.querySelectorAll('button')].find(button => button.textContent === '载入').click() }`)
    await settleOptionalConfirm(true)
    await wait(async () => (await storedDocument()).code === before.code, 'saved snippet restores its code')
    assert.deepEqual((await storedDocument()).input, before.input)
    await openLibrary()
    await screenshot('05-library')
    await assertDialogCloseAligned('.library-dialog')
    await click('.library-dialog .dialog-close')
  })
  if (dependencyPath) {
    await step('real React JSX template mounts and handles interaction', async () => {
      await useTemplate('React 交互组件')
      await settleOptionalConfirm(true)
      await wait(async () => (await storedDocument()).language === 'jsx', 'JSX template selected')
      await click('.execute-button')
      const preview = await wait(() => currentPreview(), 'native preview created')
      await wait(() => preview.executeJavaScript('document.querySelector("button")?.textContent.includes("点击次数：0")'), 'React component mounted')
      await preview.executeJavaScript('document.querySelector("button").click()')
      await wait(() => preview.executeJavaScript('document.querySelector("button")?.textContent.includes("点击次数：1")'), 'React state changed')
      await wait(() => nativePreviewVisible(preview), 'native preview visible')
      assert.equal(await preview.executeJavaScript('typeof window.offlineJsLab'), 'undefined')
      await screenshot('06-react-interactive')
    })
    await step('native preview hides for modal and Console, then resumes', async () => {
      const preview = currentPreview()
      await click('.select-trigger')
      await wait(() => !nativePreviewVisible(preview), 'native preview hidden under language menu')
      await wait(() => js(`() => document.activeElement?.matches('.select-menu')`), 'language menu receives keyboard focus')
      const highlighted = await js(`() => document.querySelector('.select-option--highlight')?.textContent.trim()`)
      main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
      main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
      await wait(async () => await js(`() => document.querySelector('.select-option--highlight')?.textContent.trim()`) !== highlighted, 'down arrow moves language highlight')
      main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' })
      main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' })
      await wait(async () => await js(`() => document.querySelector('.select-option--highlight')?.textContent.trim()`) === highlighted, 'up arrow restores language highlight')
      await screenshot('07-language-menu-over-preview')
      main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await wait(async () => !(await exists('.select-menu')), 'Escape closes language menu')
      await wait(() => nativePreviewVisible(preview), 'native preview resumes after language menu')
      assert.ok(await js(`() => document.activeElement?.matches('.select-trigger')`), 'Language trigger regains focus')
      await openLibrary()
      await wait(() => !nativePreviewVisible(preview), 'native preview hidden under modal')
      await screenshot('07-modal-over-preview')
      await click('.library-dialog .dialog-close')
      await wait(() => nativePreviewVisible(preview), 'native preview resumes after modal')
      await selectConsole()
      await wait(() => !nativePreviewVisible(preview), 'native preview hidden on Console')
      await selectPreview()
      await wait(() => nativePreviewVisible(preview), 'native preview resumes on Preview')
    })
    await step('compile failure preserves previous view and restart resets component state', async () => {
      const working = (await storedDocument()).code
      const previous = currentPreview()
      await replaceCode('export default function App() { return < }')
      await click('.execute-button')
      await wait(() => exists('.preview-notice--error'), 'visible JSX compilation error')
      assert.equal(currentPreview()?.id, previous.id)
      assert.ok(await previous.executeJavaScript('document.querySelector("button")?.textContent.includes("点击次数：1")'))
      await screenshot('08-jsx-error-preserved')
      await replaceCode(working)
      await clickText('^重启预览$', '.preview-pane')
      const restarted = await wait(() => { const current = currentPreview(); return current && current.id !== previous.id ? current : null }, 'preview replaced after restart')
      await wait(() => restarted.executeJavaScript('document.querySelector("button")?.textContent.includes("点击次数：0")'), 'component state reset')
    })
    await step('React live edits keep latest source and manual/stop cancel pending previews', async () => {
      const component = number => `console.log("SMOKE_JSX_LIVE_${number}"); export default function App() { return <button>SMOKE_JSX_LIVE_${number}</button> }`
      const before = (await events()).length
      await clickText('LIVE|实时', '.mode-switch')
      await replaceCode(component(1), false)
      await replaceCode(component(2), false)
      await replaceCode(component(3))
      await wait(async () => { const preview = currentPreview(); return preview && await preview.executeJavaScript('document.body.textContent.includes("SMOKE_JSX_LIVE_3")') }, 'latest React live preview')
      const delivered = (await events()).slice(before)
      assert.ok(!delivered.some(event => event.name === 'onPreviewOutput' && /SMOKE_JSX_LIVE_[12]/.test(event.payload.text)), 'Intermediate JSX edit executed')
      const currentId = currentPreview().id
      await replaceCode(component(4), false)
      await clickText('MANUAL|手动', '.mode-switch')
      await pause(750)
      assert.equal(currentPreview()?.id, currentId, 'Manual mode did not cancel queued preview')
      assert.ok(await currentPreview().executeJavaScript('document.body.textContent.includes("SMOKE_JSX_LIVE_3")'))
      await clickText('LIVE|实时', '.mode-switch')
      await wait(async () => { const preview = currentPreview(); return preview && await preview.executeJavaScript('document.body.textContent.includes("SMOKE_JSX_LIVE_4")') }, 'React live mode resumes')
      await replaceCode(component(5), false)
      await click('.abort-button')
      await wait(() => !currentPreview(), 'stop closes native preview')
      await pause(750)
      assert.equal(currentPreview(), undefined, 'Stopped preview unexpectedly restarted from pending edit')
      await clickText('MANUAL|手动', '.mode-switch')
    })
  } else {
    report.skipped = ['React JSX UI scenarios: provide --dependencies with a local React fixture.']
    console.log('SMOKE_SKIP React JSX: no --dependencies fixture supplied')
  }
  await step('minimum window retains accessible, nonoverlapping primary controls', async () => {
    if (dependencyPath) await selectConsole()
    const minimum = main.getMinimumSize()
    main.setSize(minimum[0], minimum[1])
    await pause(300)
    const layout = await js(`() => {
      const selectors = ['.execute-button', '.abort-button', '.mode-switch', '.editor-panel', '.output-panel'];
      const elements = selectors.map(selector => { const element = document.querySelector(selector); const rect = element.getBoundingClientRect(); return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom } });
      const toolbarLabels = [...document.querySelectorAll('.file-actions .toolbar-button b, .matrix-button b')].map(label => {
        const button = label.closest('button'); const rect = label.getBoundingClientRect(); const buttonRect = button.getBoundingClientRect();
        return { text: label.textContent.trim(), display: getComputedStyle(label).display, visibility: getComputedStyle(label).visibility,
          width: rect.width, height: rect.height, button: { x: buttonRect.x, y: buttonRect.y, right: buttonRect.right, bottom: buttonRect.bottom } };
      });
      return { width: innerWidth, height: innerHeight, elements, toolbarLabels };
    }`)
    report.minimumLayout = layout
    for (const element of layout.elements) {
      assert.ok(element.width >= 20 && element.height >= 20, `${element.selector} collapsed`)
      assert.ok(element.x >= -1 && element.y >= -1 && element.right <= layout.width + 1 && element.bottom <= layout.height + 1, `${element.selector} outside window`)
    }
    const [execute, abort] = layout.elements
    assert.ok(execute.right <= abort.x + 1 || abort.right <= execute.x + 1 || execute.bottom <= abort.y + 1 || abort.bottom <= execute.y + 1, 'Execute/ABORT controls overlap')
    assert.ok(layout.toolbarLabels.length >= 4, 'Primary file/dependency labels are missing')
    for (const label of layout.toolbarLabels) {
      assert.ok(label.width > 0 && label.height > 0 && label.display !== 'none' && label.visibility !== 'hidden', `${label.text} toolbar label is hidden`)
      assert.ok(label.button.x >= -1 && label.button.y >= -1 && label.button.right <= layout.width + 1 && label.button.bottom <= layout.height + 1, `${label.text} toolbar button outside window`)
    }
    assert.ok(await js(`() => /(?:TSX?|JSX?) LANGUAGE SERVICE ONLINE/.test(document.body.textContent)`))
    await screenshot('09-minimum-window')
  })
  console.log('WHOLE_APP_SMOKE_OK')
  await finish(0)
}

app.on('browser-window-created', (_event, window) => {
  if (main) return
  main = window
  window.webContents.on('console-message', details => {
    if (details.level === 'error') report.consoleErrors.push({
      message: details.message, sourceId: details.sourceId, lineNumber: details.lineNumber
    })
  })
  window.webContents.on('render-process-gone', (_event, details) => { if (!finishing) void finish(1, new Error(`Main renderer exited: ${details.reason}`)) })
  window.webContents.once('did-finish-load', () => suite().catch(error => finish(1, error)))
})
try { require(path.join(repository, 'out', 'main', 'index.js')) }
catch (error) { void finish(1, error) }
console.log(`SMOKE_ROOT ${root}`)
