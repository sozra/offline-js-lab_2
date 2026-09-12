'use strict'

const fs = require('node:fs')
const util = require('node:util')
const path = require('node:path')
const { pathToFileURL, fileURLToPath } = require('node:url')

const INSPECT_OPTIONS = {
  colors: false, depth: 6, maxArrayLength: 60, maxStringLength: 4096,
  breakLength: 100, getters: false, customInspect: false
}
const STRUCTURED_TEXT_CHARS = 16 * 1024
let sourceFile = ''
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get
let structuredAvailable = false
try { fs.fstatSync(3); structuredAvailable = true } catch { /* Direct CLI invocation. */ }

function regexpParts(value) {
  const source = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get.call(value)
  const flags = [['hasIndices', 'd'], ['global', 'g'], ['ignoreCase', 'i'], ['multiline', 'm'],
    ['dotAll', 's'], ['unicode', 'u'], ['unicodeSets', 'v'], ['sticky', 'y']]
    .filter(([name]) => Object.getOwnPropertyDescriptor(RegExp.prototype, name)?.get.call(value))
    .map(([, flag]) => flag).join('')
  return { source, flags }
}

function snapshotValues(values) {
  const budget = { nodes: 0, characters: 24 * 1024 }
  const seen = new WeakSet()
  const clipped = (value, maximum = 4096) => {
    const limit = Math.max(0, Math.min(maximum, budget.characters))
    const result = value.length > limit ? value.slice(0, limit) + '…' : value
    budget.characters -= Math.min(value.length, limit)
    return result
  }
  function visit(value, depth = 0) {
    if (++budget.nodes > 300 || budget.characters <= 0) return { kind: 'truncated', preview: '…', truncated: true }
    if (value === null) return { kind: 'null', preview: 'null' }
    const type = typeof value
    if (type === 'string') {
      const truncated = value.length > Math.min(4096, budget.characters)
      return { kind: 'string', preview: JSON.stringify(clipped(value)), truncated: truncated || undefined }
    }
    if (type !== 'object' && type !== 'function') {
      const text = type === 'bigint' ? String(value) + 'n' : String(value)
      const truncated = text.length > Math.min(4096, budget.characters)
      return { kind: type, preview: clipped(text), truncated: truncated || undefined }
    }
    // Reading properties of a Proxy can execute traps even with descriptors.
    if (util.types.isProxy(value)) return { kind: 'proxy', preview: '[Proxy — inspection skipped]', truncated: true }
    if (type === 'function') {
      const name = Object.getOwnPropertyDescriptor(value, 'name')?.value
      return { kind: 'function', preview: `[Function${typeof name === 'string' && name ? ': ' + clipped(name, 100) : ''}]` }
    }
    if (seen.has(value)) return { kind: 'circular', preview: '[Circular / shared reference]' }
    seen.add(value)
    let kind = Array.isArray(value) ? 'array' : 'object'
    let preview = kind === 'array' ? `Array(${Object.getOwnPropertyDescriptor(value, 'length').value})` : 'Object'
    if (util.types.isDate(value)) {
      const time = Date.prototype.getTime.call(value)
      return { kind: 'date', preview: Number.isNaN(time) ? 'Invalid Date' : new Date(time).toISOString() }
    }
    if (util.types.isRegExp(value)) {
      const { source, flags } = regexpParts(value)
      kind = 'regexp'; preview = clipped(`/${source}/${flags}`)
    }
    if (util.types.isNativeError(value)) { kind = 'error'; preview = '[Error]' }
    if (util.types.isPromise(value)) return { kind: 'promise', preview: '[Promise]' }
    if (util.types.isMap(value)) { kind = 'map'; preview = `Map(${Reflect.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(value)})` }
    if (util.types.isSet(value)) { kind = 'set'; preview = `Set(${Reflect.getOwnPropertyDescriptor(Set.prototype, 'size').get.call(value)})` }
    if (ArrayBuffer.isView(value)) return { kind: 'binary', preview: '[Typed array / DataView]', truncated: true }
    if (util.types.isAnyArrayBuffer(value)) return { kind: 'binary', preview: '[ArrayBuffer]', truncated: true }
    const result = { kind, preview, children: [] }
    if (depth >= 5) return { ...result, truncated: true }
    let count = 0
    const add = (key, child) => {
      if (count >= 60 || budget.nodes >= 300 || budget.characters <= 0) { result.truncated = true; return false }
      result.children.push({ key: clipped(String(key), 200), value: child() })
      count += 1
      return true
    }
    try {
      if (kind === 'map') {
        for (const [key, item] of Map.prototype.entries.call(value)) {
          if (!add(count, () => ({ kind: 'entry', preview: 'Entry', children: [
            { key: 'key', value: visit(key, depth + 2) }, { key: 'value', value: visit(item, depth + 2) }
          ] }))) break
        }
      } else if (kind === 'set') {
        for (const item of Set.prototype.values.call(value)) if (!add(count, () => visit(item, depth + 1))) break
      } else {
        // Enumerate keys, then inspect descriptors: never evaluate accessors or toJSON.
        const keys = kind === 'array'
          ? Array.from({ length: Math.min(Object.getOwnPropertyDescriptor(value, 'length').value, 61) }, (_, index) => String(index))
          : Reflect.ownKeys(value)
        for (const key of keys) {
          if (!add(typeof key === 'symbol' ? String(key) : key, () => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (!descriptor) return { kind: 'empty', preview: '<empty>' }
            if (!('value' in descriptor)) return { kind: 'accessor', preview: descriptor.get ? '[Getter]' : '[Setter]' }
            return visit(descriptor.value, depth + 1)
          })) break
        }
      }
    } catch { result.truncated = true }
    return result
  }
  return values.slice(0, 60).map((value) => visit(value))
}

function inspectText(value) {
  // Build a descriptor-only clone before util.inspect; custom hooks, getters and proxies stay inert.
  const seen = new WeakMap()
  let nodes = 0
  function safe(item, depth = 0) {
    if (item === null || (typeof item !== 'object' && typeof item !== 'function')) return item
    if (util.types.isProxy(item)) return '[Proxy — inspection skipped]'
    if (typeof item === 'function') {
      const name = Object.getOwnPropertyDescriptor(item, 'name')?.value
      return `[Function${typeof name === 'string' && name ? ': ' + name.slice(0, 100) : ''}]`
    }
    if (seen.has(item)) return '[Circular / shared reference]'
    if (++nodes > 300 || depth >= 5) return '[…]'
    if (util.types.isDate(item)) return new Date(Date.prototype.getTime.call(item))
    if (util.types.isRegExp(item)) { const { source, flags } = regexpParts(item); return new RegExp(source, flags) }
    if (util.types.isPromise(item)) return '[Promise]'
    if (util.types.isMap(item)) {
      const clone = new Map(); seen.set(item, clone)
      let count = 0
      for (const [key, value] of Map.prototype.entries.call(item)) { if (count++ >= 60) break; clone.set(safe(key, depth + 1), safe(value, depth + 1)) }
      return clone
    }
    if (util.types.isSet(item)) {
      const clone = new Set(); seen.set(item, clone)
      let count = 0
      for (const value of Set.prototype.values.call(item)) { if (count++ >= 60) break; clone.add(safe(value, depth + 1)) }
      return clone
    }
    if (ArrayBuffer.isView(item) || util.types.isAnyArrayBuffer(item)) return '[Binary data]'
    const clone = Array.isArray(item) ? [] : {}
    if (Array.isArray(item)) clone.length = Object.getOwnPropertyDescriptor(item, 'length').value
    seen.set(item, clone)
    const keys = Array.isArray(item)
      ? Array.from({ length: Math.min(Object.getOwnPropertyDescriptor(item, 'length').value, 60) }, (_, index) => String(index))
      : Reflect.ownKeys(item).slice(0, 60)
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor) continue
      Object.defineProperty(clone, key, {
        value: 'value' in descriptor ? safe(descriptor.value, depth + 1) : descriptor.get ? '[Getter]' : '[Setter]',
        enumerable: true, configurable: true, writable: true
      })
    }
    return clone
  }
  try { return util.inspect(safe(value), INSPECT_OPTIONS) } catch { return '[Unable to inspect value]' }
}

function formatConsole(args) {
  if (args.length === 0) return ''
  if (typeof args[0] !== 'string') return args.map((value) => typeof value === 'string' ? value : inspectText(value)).join(' ')
  let consumed = 1
  const first = args[0].replace(/%[%sdifjoOc]/g, (token) => {
    if (token === '%%') return '%'
    if (consumed >= args.length) return token
    const value = args[consumed++]
    if (token === '%c') return ''
    if (token === '%s' && typeof value === 'string') return value
    if (['%d', '%i', '%f'].includes(token) && (value === null || ['number', 'string', 'boolean', 'undefined'].includes(typeof value))) {
      return String(token === '%i' ? Number.parseInt(value) : token === '%f' ? Number.parseFloat(value) : Number(value))
    }
    return inspectText(value)
  })
  return first + (consumed < args.length ? ' ' + args.slice(consumed).map((item) => typeof item === 'string' ? item : inspectText(item)).join(' ') : '')
}

function writeStructuredOutput(line, stream, text, values, location) {
  if (!structuredAvailable) { (stream === 'stderr' ? process.stderr : process.stdout).write(text); return }
  for (let textOffset = 0; textOffset < text.length || textOffset === 0; textOffset += STRUCTURED_TEXT_CHARS) {
    const payload = `${JSON.stringify({ line, stream, text: text.slice(textOffset, textOffset + STRUCTURED_TEXT_CHARS),
      values: textOffset === 0 ? values : undefined, location })}\n`
    const buffer = Buffer.from(payload)
    let bufferOffset = 0
    while (bufferOffset < buffer.length) bufferOffset += fs.writeSync(3, buffer, bufferOffset)
  }
}

function installLineAwareOutput() {
  const nativeConsoleMethods = Object.fromEntries(['debug', 'error', 'info', 'log', 'warn'].map((method) => [method, console[method]]))
  Object.defineProperty(globalThis, '__offlineJsLabConsole', {
    value(line, method, operation, target, ...args) {
      if (target !== globalThis.console || operation !== nativeConsoleMethods[method]) return Reflect.apply(operation, target, args)
      const stream = method === 'error' || method === 'warn' ? 'stderr' : 'stdout'
      writeStructuredOutput(line, stream, formatConsole(args) + '\n', snapshotValues(args), { file: sourceFile, line, column: 1 })
    }
  })
  const inspect = (line, value) => {
    writeStructuredOutput(line, 'expression', `⇒ ${inspectText(value)}\n`, snapshotValues([value]), { file: sourceFile, line, column: 1 })
    return value
  }
  Object.defineProperty(globalThis, '__offlineJsLabInspect', { value: inspect })
  Object.defineProperty(globalThis, '__offlineJsLabInspectCall', {
    value(line, value) { return value === undefined ? value : inspect(line, value) }
  })
}

function errorLocation(text) {
  // Node --enable-source-maps has already chained esbuild and instrumentation maps.
  const frames = text.split('\n').map((line) => {
    const match = /(?:\(|\s)(file:\/\/\/[^\n]+?|[A-Za-z]:[\\/][^\n]+?|\/[^\n]+?):(\d+):(\d+)\)?$/.exec(line.trim())
    if (!match) return null
    let file = match[1]
    try { if (file.startsWith('file:')) file = fileURLToPath(file) } catch { return null }
    return { file, line: Number(match[2]), column: Number(match[3]) }
  }).filter(Boolean)
  const canonical = (file) => {
    try { return path.join(fs.realpathSync(path.dirname(file)), path.basename(file)) }
    catch { return path.resolve(file) }
  }
  const ownFrame = frames.find((frame) => canonical(frame.file) === canonical(sourceFile))
  return ownFrame ? { ...ownFrame, file: sourceFile } : undefined
}
function reportError(value, prefix = '') {
  let text
  if (util.types.isNativeError(value) && !util.types.isProxy(value)) {
    const stackDescriptor = Object.getOwnPropertyDescriptor(value, 'stack')
    // Native Error.stack is a lazy accessor on some Node versions; custom accessors stay inert.
    const stack = stackDescriptor && 'value' in stackDescriptor ? stackDescriptor.value
      : nativeStackGetter && stackDescriptor?.get === nativeStackGetter ? nativeStackGetter.call(value) : undefined
    text = typeof stack === 'string' ? stack : inspectText(value)
  } else text = inspectText(value)
  writeStructuredOutput(undefined, 'stderr', prefix + text + '\n', undefined, errorLocation(text))
  process.exitCode = 1
}

installLineAwareOutput()
process.on('unhandledRejection', (reason) => reportError(reason, 'Unhandled rejection: '))
process.on('uncaughtException', (error) => reportError(error))
;(async () => {
  const entryPath = process.argv[2]
  if (!entryPath) throw new Error('缺少待执行脚本路径。')
  const inputPath = process.argv[3]
  const data = inputPath ? JSON.parse(fs.readFileSync(inputPath, 'utf8')) : { input: {}, inputText: '', sourceFile: '' }
  sourceFile = data.sourceFile
  Object.defineProperty(globalThis, 'lab', {
    value: Object.freeze({ input: data.input, inputText: data.inputText }), configurable: false, writable: false
  })
  await import(pathToFileURL(entryPath).href)
})().catch((error) => reportError(error))
