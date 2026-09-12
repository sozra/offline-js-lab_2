import ts from 'typescript'
import type { ScriptLanguage } from '@shared/types'
import { applyMappedEdits, type SourceEdit } from './instrumentation-map'

const LINE_AWARE_CONSOLE_METHODS = new Set(['debug', 'error', 'info', 'log', 'warn'])

export interface InstrumentSourceResult {
  code: string
  sourceMap: string
  originalPosition: (line: number, column: number) => { line: number; column: number }
  consoleLines: number[]
  implicitLines: number[]
}

function sourceLineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function getConsoleMethod(node: ts.CallExpression): string | null {
  const callee = node.expression
  if (node.questionDotToken) return null
  if (
    ts.isPropertyAccessExpression(callee) &&
    !callee.questionDotToken &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'console' &&
    LINE_AWARE_CONSOLE_METHODS.has(callee.name.text)
  ) {
    return callee.name.text
  }

  if (
    ts.isElementAccessExpression(callee) &&
    !callee.questionDotToken &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'console' &&
    callee.argumentExpression &&
    ts.isStringLiteral(callee.argumentExpression) &&
    LINE_AWARE_CONSOLE_METHODS.has(callee.argumentExpression.text)
  ) {
    return callee.argumentExpression.text
  }

  return null
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function isDirectConsoleCall(node: ts.CallExpression): boolean {
  const callee = unwrapTransparentExpression(node.expression)
  return (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'console'
  )
}

function isDirectivePrologue(statement: ts.ExpressionStatement): boolean {
  if (!ts.isStringLiteral(statement.expression)) return false

  const parent = statement.parent
  let statements: ts.NodeArray<ts.Statement> | undefined
  if (ts.isSourceFile(parent)) {
    statements = parent.statements
  } else if (ts.isBlock(parent) && ts.isFunctionLike(parent.parent)) {
    statements = parent.statements
  }
  if (!statements) return false

  for (const current of statements) {
    if (current === statement) return true
    if (!ts.isExpressionStatement(current) || !ts.isStringLiteral(current.expression)) return false
  }
  return false
}

/**
 * 只把“删掉也不改变程序状态”的调试表达式作为纯值隐式输出候选。
 * 独立函数调用由 getImplicitOutputKind() 单独处理；其他有行为的
 * 构造、赋值、自增、自减、await/yield/delete/void 不会产生额外输出。
 */
function isImplicitOutputCandidate(expression: ts.Expression): boolean {
  let excluded = false

  const visit = (node: ts.Node): void => {
    if (excluded) return

    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isDeleteExpression(node) ||
      ts.isVoidExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    ) {
      excluded = true
      return
    }

    if (
      ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      excluded = true
      return
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      excluded = true
      return
    }

    // 函数/类表达式不是常见调试值；嵌套的方法体也不在创建对象时执行。
    if (ts.isFunctionLike(node) || ts.isClassExpression(node)) {
      if (node === expression) excluded = true
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(expression)
  return !excluded
}

type ImplicitOutputKind = 'call' | 'value'

function getImplicitOutputKind(expression: ts.Expression): ImplicitOutputKind | null {
  const unwrapped = unwrapTransparentExpression(expression)
  const possibleCall = ts.isAwaitExpression(unwrapped)
    ? unwrapTransparentExpression(unwrapped.expression)
    : unwrapped

  if (ts.isCallExpression(possibleCall)) {
    // console.* 已经是明确的输出意图，包括 table/dir 等未做行定位的方法。
    return isDirectConsoleCall(possibleCall) ? null : 'call'
  }

  return isImplicitOutputCandidate(expression) ? 'value' : null
}

export function instrumentSource(
  code: string,
  language: ScriptLanguage,
  sourcePath = language === 'typescript' ? 'scratch.ts' : 'scratch.js'
): InstrumentSourceResult {
  const sourceFile = ts.createSourceFile(
    language === 'typescript' ? 'scratch.ts' : 'scratch.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    language === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS
  )
  const edits: SourceEdit[] = []
  const consoleLines = new Set<number>()
  const implicitLines = new Set<number>()

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const method = getConsoleMethod(node)
      if (method) {
        const line = sourceLineOf(sourceFile, node)
        const originalCallee = node.expression.getText(sourceFile)
        consoleLines.add(line)
        edits.push(
          {
            start: node.expression.getStart(sourceFile),
            end: node.expression.end,
            text: 'globalThis.__offlineJsLabConsole'
          },
          {
            start: node.arguments.pos,
            end: node.arguments.pos,
            text:
              `${line}, ${JSON.stringify(method)}, ${originalCallee}, console` +
              (node.arguments.length ? ', ' : '')
          }
        )
      }
    }

    if (ts.isExpressionStatement(node) && !isDirectivePrologue(node)) {
      const outputKind = getImplicitOutputKind(node.expression)
      if (outputKind) {
        const line = sourceLineOf(sourceFile, node.expression)
        implicitLines.add(line)
        edits.push(
          {
            start: node.expression.getStart(sourceFile),
            end: node.expression.getStart(sourceFile),
            text:
              outputKind === 'call'
                ? `globalThis.__offlineJsLabInspectCall(${line}, (`
                : `globalThis.__offlineJsLabInspect(${line}, (`
          },
          { start: node.expression.end, end: node.expression.end, text: '))' }
        )
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return {
    ...applyMappedEdits(code, edits, sourcePath),
    consoleLines: [...consoleLines].sort((left, right) => left - right),
    implicitLines: [...implicitLines].sort((left, right) => left - right)
  }
}
