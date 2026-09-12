import type { ScriptInput } from '@shared/types'
import { parseScriptInput } from '@shared/input'

// This function is serialized into the browser bundle. Keep it self-contained:
// no Node APIs, imports, application bridge, or captured variables.
function installPreviewRuntime(runId: string, lab: { input: unknown; inputText: string }): void {
  Object.defineProperty(globalThis, 'lab', { value: lab, configurable: false })
  const post = window.postMessage.bind(window)
  const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get
  function errorStack(value: unknown): string | undefined {
    if (!(value instanceof Error)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, 'stack')
    if (typeof descriptor?.value === 'string') return descriptor.value
    // Current Chromium exposes Error.stack as a native accessor. Call only
    // the original engine accessor, never a user-supplied replacement getter.
    if (nativeStackGetter && descriptor?.get === nativeStackGetter) {
      try { return nativeStackGetter.call(value) as string } catch { return undefined }
    }
    return undefined
  }
  const send = (payload: Record<string, unknown>): void => {
    const message: Record<string, unknown> = { marker: 'offline-js-lab-preview', runId, ...payload }
    if (payload.type === 'output' && new TextEncoder().encode(JSON.stringify(message)).length > 200 * 1024) {
      delete message.values
      message.text = String(message.text).slice(0, 32768) + '\n[结果较大，已截断结构化快照]\n'
      message.stack = String(message.stack).slice(0, 8192)
    }
    post(message, window.location.origin)
  }
  type Snapshot = { kind: string; preview: string; children?: Array<{ key: string; value: Snapshot }>; truncated?: boolean }
  function snapshots(values: unknown[]): Snapshot[] {
    const seen = new WeakSet<object>()
    let remaining = 300
    function visit(value: unknown, depth = 0): Snapshot {
      if (remaining-- <= 0) return { kind: 'truncated', preview: '…', truncated: true }
      if (value === null) return { kind: 'null', preview: 'null' }
      const kind = typeof value
      if (kind === 'string') return { kind, preview: JSON.stringify((value as string).slice(0, 1024)), truncated: (value as string).length > 1024 }
      if (kind !== 'object' && kind !== 'function') return { kind, preview: String(value) }
      if (kind === 'function') return { kind, preview: '[Function]' }
      if (seen.has(value as object)) return { kind: 'circular', preview: '[Circular]' }
      seen.add(value as object)
      try {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const keys = Object.keys(descriptors).filter((key) => key !== 'length' && descriptors[key]?.enumerable)
        const array = Array.isArray(value)
        const preview = array ? `Array(${descriptors.length?.value ?? 0})` : value instanceof Error
          ? `${typeof descriptors.name?.value === 'string' ? descriptors.name.value : 'Error'}: ${typeof descriptors.message?.value === 'string' ? descriptors.message.value : ''}`
          : 'Object'
        if (depth >= 4) return { kind: array ? 'array' : kind, preview, truncated: keys.length > 0 }
        return {
          kind: array ? 'array' : value instanceof Error ? 'error' : kind,
          preview,
          children: keys.slice(0, 40).map((key) => {
            const descriptor = descriptors[key]!
            return { key, value: 'value' in descriptor ? visit(descriptor.value, depth + 1) : { kind: 'accessor', preview: '[Getter/Setter]' } }
          }),
          truncated: keys.length > 40
        }
      } catch {
        return { kind: 'unavailable', preview: '[Unavailable]' }
      }
    }
    return values.slice(0, 20).map((value) => visit(value))
  }
  function emit(stream: string, values: unknown[], stack: string): void {
    const captured = snapshots(values)
    const format = (value: Snapshot): string => value.kind === 'error' ? value.preview : value.children
      ? `${value.kind === 'array' ? '[' : '{'}${value.children.map((child) => `${child.key}: ${format(child.value)}`).join(', ')}${value.truncated ? ', …' : ''}${value.kind === 'array' ? ']' : '}'}`
      : value.preview
    const formatted = captured.map(value => value.kind === 'string' ? JSON.parse(value.preview) as string : format(value))
    let text = formatted.join(' ')
    if (captured[0]?.kind === 'string' && captured.length > 1) {
      let argument = 1
      text = formatted[0]!.replace(/%([sdifoOc%])/g, (placeholder, specifier: string) => {
        if (specifier === '%') return '%'
        if (argument >= formatted.length) return placeholder
        const value = formatted[argument++]!
        return specifier === 'c' ? '' : value
      })
      if (argument < formatted.length) text += ' ' + formatted.slice(argument).join(' ')
    }
    send({ type: 'output', stream, values: captured, text: text.slice(0, 65536) + '\n', stack: stack.slice(0, 32768) })
  }
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'table'] as const) {
    const original = console[method].bind(console)
    console[method] = (...values: unknown[]): void => {
      const errorValue = method === 'error' ? values.find((value) => value instanceof Error) : undefined
      const stack = errorStack(errorValue)
      emit(method === 'error' || method === 'warn' ? 'stderr' : 'stdout', values, stack || new Error().stack || '')
      original(...values)
    }
  }
  window.addEventListener('error', (event) => {
    const stack = event.error instanceof Error ? event.error.stack || '' : `${event.filename}:${event.lineno}:${event.colno}`
    emit('stderr', [event.message], stack)
    send({ type: 'state', status: 'failed', error: event.message.slice(0, 4096) })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const message = reason instanceof Error ? reason.message : '未处理的 Promise 拒绝'
    emit('stderr', [reason], reason instanceof Error ? reason.stack || '' : '')
    send({ type: 'state', status: 'failed', error: message.slice(0, 4096) })
  })
}

export function createPreviewRuntime(runId: string, input?: ScriptInput): string {
  // JSON.parse preserves an own "__proto__" key instead of object-literal prototype semantics.
  return `(${installPreviewRuntime.toString()})(${JSON.stringify(runId)}, JSON.parse(${JSON.stringify(JSON.stringify(parseScriptInput(input)))}));`
}

export function createPreviewEntry(runId: string): string {
  return `import React from 'react';
import { createRoot } from 'react-dom/client';
import Component from 'lab:source';
const sendState = (status, error) => window.postMessage({ marker: 'offline-js-lab-preview', runId: ${JSON.stringify(runId)}, type: 'state', status, error }, window.location.origin);
class PreviewBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error(error); sendState('failed', error instanceof Error ? error.message : String(error)); }
  render() { return this.state.error ? React.createElement('pre', { role: 'alert', style: { color: '#c93045', whiteSpace: 'pre-wrap', padding: 20 } }, this.state.error instanceof Error ? this.state.error.message : String(this.state.error)) : this.props.children; }
}
function Ready() { React.useLayoutEffect(() => sendState('ready'), []); return null; }
createRoot(document.getElementById('root')).render(React.createElement(PreviewBoundary, null, React.isValidElement(Component) ? Component : React.createElement(Component), React.createElement(Ready)));`
}
