'use strict'

const fs = require('node:fs')
const util = require('node:util')
const { pathToFileURL } = require('node:url')

const INSPECT_OPTIONS = {
  colors: false,
  depth: 8,
  maxArrayLength: 200,
  breakLength: 100
}
const STRUCTURED_TEXT_CHARS = 32 * 1024

function writeStructuredOutput(line, stream, text) {
  for (let textOffset = 0; textOffset < text.length; textOffset += STRUCTURED_TEXT_CHARS) {
    const payload = `${JSON.stringify({
      line,
      stream,
      text: text.slice(textOffset, textOffset + STRUCTURED_TEXT_CHARS)
    })}\n`
    const buffer = Buffer.from(payload)
    let bufferOffset = 0
    while (bufferOffset < buffer.length) {
      bufferOffset += fs.writeSync(3, buffer, bufferOffset)
    }
  }
}

function installLineAwareOutput() {
  try {
    fs.fstatSync(3)
  } catch {
    return
  }

  const nativeConsoleMethods = Object.fromEntries(
    ['debug', 'error', 'info', 'log', 'warn'].map((method) => [method, console[method]])
  )

  Object.defineProperty(globalThis, '__offlineJsLabConsole', {
    configurable: false,
    enumerable: false,
    writable: false,
    value(line, method, operation, target, ...args) {
      if (target !== globalThis.console || operation !== nativeConsoleMethods[method]) {
        return Reflect.apply(operation, target, args)
      }
      const stream = method === 'error' || method === 'warn' ? 'stderr' : 'stdout'
      writeStructuredOutput(
        line,
        stream,
        `${util.formatWithOptions(INSPECT_OPTIONS, ...args)}\n`
      )
    }
  })

  Object.defineProperty(globalThis, '__offlineJsLabInspect', {
    configurable: false,
    enumerable: false,
    writable: false,
    value(line, value) {
      writeStructuredOutput(
        line,
        'expression',
        `⇒ ${util.inspect(value, INSPECT_OPTIONS)}\n`
      )
      return value
    }
  })

  Object.defineProperty(globalThis, '__offlineJsLabInspectCall', {
    configurable: false,
    enumerable: false,
    writable: false,
    value(line, value) {
      // 无返回值的动作型函数仍照常执行，但不制造“⇒ undefined”噪音。
      if (value !== undefined) {
        writeStructuredOutput(
          line,
          'expression',
          `⇒ ${util.inspect(value, INSPECT_OPTIONS)}\n`
        )
      }
      return value
    }
  })
}

function formatError(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  return util.inspect(value, {
    ...INSPECT_OPTIONS
  })
}

installLineAwareOutput()

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`Unhandled rejection: ${formatError(reason)}\n`)
  process.exitCode = 1
})

process.on('uncaughtException', (error) => {
  process.stderr.write(`${formatError(error)}\n`)
  process.exitCode = 1
})

;(async () => {
  const entryPath = process.argv[2]
  if (!entryPath) throw new Error('缺少待执行脚本路径。')
  const entryUrl = `${pathToFileURL(entryPath).href}?run=${Date.now()}`
  await import(entryUrl)
})().catch((error) => {
  process.stderr.write(`${formatError(error)}\n`)
  process.exitCode = 1
})
