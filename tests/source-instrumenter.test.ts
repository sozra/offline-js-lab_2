import { describe, expect, it } from 'vitest'
import { instrumentSource } from '../src/main/source-instrumenter'

describe('source instrumenter', () => {
  it('标注 console 输出并将纯表达式变成隐式输出', () => {
    const source = [
      'const value = 7',
      'value > 3',
      'console.log(value)',
      'const nested = console.warn(console.info("inside"))'
    ].join('\n')
    const result = instrumentSource(source, 'typescript')

    expect(result.implicitLines).toEqual([2])
    expect(result.consoleLines).toEqual([3, 4])
    expect(result.code).toContain('globalThis.__offlineJsLabInspect(2, (value > 3))')
    expect(result.code).toContain(
      'globalThis.__offlineJsLabConsole(3, "log", console.log, console, value)'
    )
    expect(result.code).toContain(
      'globalThis.__offlineJsLabConsole(4, "warn", console.warn, console, globalThis.__offlineJsLabConsole(4, "info", console.info, console, "inside"))'
    )
  })

  it('显示未使用的独立调用结果，并保留指令序言', () => {
    const source = [
      '"use strict"',
      'let count = 0',
      'count += 1',
      'count++',
      'doWork()',
      'await Promise.resolve(count)',
      'count'
    ].join('\n')
    const result = instrumentSource(source, 'javascript')

    expect(result.implicitLines).toEqual([5, 6, 7])
    expect(result.code).toContain('"use strict"')
    expect(result.code).toContain('count += 1')
    expect(result.code).toContain('count++')
    expect(result.code).toContain('globalThis.__offlineJsLabInspectCall(5, (doWork()))')
    expect(result.code).toContain(
      'globalThis.__offlineJsLabInspectCall(6, (await Promise.resolve(count)))'
    )
    expect(result.code).toContain('globalThis.__offlineJsLabInspect(7, (count))')
  })

  it('不重复接管 console，也不单独打印已赋值或作为参数的调用', () => {
    const source = [
      'calculate()',
      'console.log(calculate())',
      'console.table([])',
      'const result = calculate()',
      'consume(calculate())'
    ].join('\n')
    const result = instrumentSource(source, 'typescript')

    expect(result.implicitLines).toEqual([1, 5])
    expect(result.code).toContain('globalThis.__offlineJsLabInspectCall(1, (calculate()))')
    expect(result.code).not.toContain('__offlineJsLabInspectCall(2')
    expect(result.code).not.toContain('__offlineJsLabInspectCall(3')
    expect(result.code).not.toContain('__offlineJsLabInspectCall(4')
    expect(result.code).toContain(
      'globalThis.__offlineJsLabInspectCall(5, (consume(calculate())))'
    )
  })

  it('非指令位置的字符串与条件表达式可以直接显示', () => {
    const source = 'const ready = true\n"visible"\nready ? { ok: 1 } : null\n'
    const result = instrumentSource(source, 'typescript')

    expect(result.implicitLines).toEqual([2, 3])
  })

  it('保持 await、展开参数和逗号表达式的原作用域与求值形态', () => {
    const source = [
      'const values = [1, 2]',
      'console.log(...values, await Promise.resolve(3))',
      'values[0], values[1]'
    ].join('\n')
    const result = instrumentSource(source, 'typescript')

    expect(result.code).toContain(
      'globalThis.__offlineJsLabConsole(2, "log", console.log, console, ...values, await Promise.resolve(3))'
    )
    expect(result.code).toContain(
      'globalThis.__offlineJsLabInspect(3, (values[0], values[1]))'
    )
  })
})
