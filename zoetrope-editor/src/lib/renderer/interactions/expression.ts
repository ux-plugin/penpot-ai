/**
 * The interactions expression language — a constrained JS subset.
 *
 * Pure · total · side-effect-free · serializable. Authored as text, stored in the
 * IR as text (`ir.Expr`), parsed here to an `ExprNode` AST, then either:
 *   - evaluated for authoring-time preview (`evaluate`), or
 *   - lowered to a JS source string the React emitter transliterates (`toJs`).
 *
 * The evaluator and the JS lowering are kept semantically identical so a binding
 * previews the same value it will compute in the generated app (and identically
 * on web & native — it's just JS).
 *
 * Allowed: literals (string/number/boolean/null/array/object), refs, member &
 * index access, unary `! -`, binary `== != < > <= >= + - * / %`, logical
 * `&& ||`, ternary `?:`, single-param arrow fns, and a whitelist of pure methods
 * (`filter map some every find findIndex includes indexOf slice concat join
 * startsWith endsWith`) plus `Math.{min max abs round floor ceil sqrt pow}`.
 *
 * Forbidden (rejected at parse time): assignment, arbitrary function calls,
 * non-whitelisted methods, statements, loops — anything with effects.
 *
 * Note: `==`/`!=` mean STRICT equality; they lower to `===`/`!==`.
 */

// ---- AST ----

export type BinaryOp = '==' | '!=' | '<' | '>' | '<=' | '>=' | '+' | '-' | '*' | '/' | '%'

export type ExprNode =
  | { type: 'lit'; value: string | number | boolean | null }
  | { type: 'array'; items: ExprNode[] }
  | { type: 'object'; props: Array<{ key: string; value: ExprNode }> }
  | { type: 'ref'; name: string }
  | { type: 'member'; object: ExprNode; property: string }
  | { type: 'index'; object: ExprNode; index: ExprNode }
  | { type: 'unary'; op: '!' | '-'; operand: ExprNode }
  | { type: 'binary'; op: BinaryOp; left: ExprNode; right: ExprNode }
  | { type: 'logical'; op: '&&' | '||'; left: ExprNode; right: ExprNode }
  | { type: 'conditional'; test: ExprNode; consequent: ExprNode; alternate: ExprNode }
  | { type: 'call'; callee: ExprNode; args: ExprNode[] }
  | { type: 'lambda'; params: string[]; body: ExprNode }

export class ExprError extends Error {
  constructor(
    message: string,
    public pos?: number
  ) {
    super(message)
    this.name = 'ExprError'
  }
}

const METHODS = new Set([
  'filter',
  'map',
  'some',
  'every',
  'find',
  'findIndex',
  'includes',
  'indexOf',
  'slice',
  'concat',
  'join',
  'startsWith',
  'endsWith',
])
const MATH_METHODS = new Set(['min', 'max', 'abs', 'round', 'floor', 'ceil', 'sqrt', 'pow'])

const BINOP_PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
}

// ---- tokenizer ----

interface Token {
  kind: 'num' | 'str' | 'ident' | 'punct' | 'eof'
  value: string
  pos: number
}

const PUNCT2 = ['=>', '==', '!=', '<=', '>=', '&&', '||']
const PUNCT1 = '()[]{},.?:!<>+-*/%'.split('')

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c)
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c)

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      let out = ''
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') {
          const e = src[j + 1]
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e
          j += 2
        } else {
          out += src[j]
          j++
        }
      }
      if (j >= n) throw new ExprError('unterminated string', i)
      tokens.push({ kind: 'str', value: out, pos: i })
      i = j + 1
      continue
    }
    if (c >= '0' && c <= '9') {
      let j = i
      while (j < n && src[j] >= '0' && src[j] <= '9') j++
      if (src[j] === '.') {
        j++
        while (j < n && src[j] >= '0' && src[j] <= '9') j++
      }
      tokens.push({ kind: 'num', value: src.slice(i, j), pos: i })
      i = j
      continue
    }
    if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdentPart(src[j])) j++
      tokens.push({ kind: 'ident', value: src.slice(i, j), pos: i })
      i = j
      continue
    }
    const two = src.slice(i, i + 2)
    if (PUNCT2.includes(two)) {
      tokens.push({ kind: 'punct', value: two, pos: i })
      i += 2
      continue
    }
    if (PUNCT1.includes(c)) {
      tokens.push({ kind: 'punct', value: c, pos: i })
      i++
      continue
    }
    throw new ExprError(`unexpected character '${c}'`, i)
  }
  tokens.push({ kind: 'eof', value: '', pos: n })
  return tokens
}

// ---- parser (precedence climbing) ----

export function parse(src: string): ExprNode {
  const tokens = tokenize(src)
  let pos = 0
  const peek = () => tokens[pos]
  const at = (k: number) => tokens[pos + k]
  const next = () => tokens[pos++]
  const isPunct = (v: string) => peek().kind === 'punct' && peek().value === v
  const eat = (v: string) => {
    if (!isPunct(v)) throw new ExprError(`expected '${v}'`, peek().pos)
    pos++
  }

  function parseExpression(): ExprNode {
    const test = parseBinary(1)
    if (isPunct('?')) {
      next()
      const consequent = parseExpression()
      eat(':')
      const alternate = parseExpression()
      return { type: 'conditional', test, consequent, alternate }
    }
    return test
  }

  function parseBinary(minPrec: number): ExprNode {
    let left = parseUnary()
    while (true) {
      const t = peek()
      if (t.kind !== 'punct') break
      const prec = BINOP_PREC[t.value]
      if (prec === undefined || prec < minPrec) break
      next()
      const right = parseBinary(prec + 1)
      if (t.value === '&&' || t.value === '||') left = { type: 'logical', op: t.value, left, right }
      else left = { type: 'binary', op: t.value as BinaryOp, left, right }
    }
    return left
  }

  function parseUnary(): ExprNode {
    if (isPunct('!') || isPunct('-')) {
      const op = next().value as '!' | '-'
      return { type: 'unary', op, operand: parseUnary() }
    }
    return parsePostfix()
  }

  function parsePostfix(): ExprNode {
    let node = parsePrimary()
    while (true) {
      if (isPunct('.')) {
        next()
        const id = peek()
        if (id.kind !== 'ident') throw new ExprError('expected property name', id.pos)
        next()
        node = { type: 'member', object: node, property: id.value }
      } else if (isPunct('[')) {
        next()
        const index = parseExpression()
        eat(']')
        node = { type: 'index', object: node, index }
      } else if (isPunct('(')) {
        const callPos = peek().pos
        next()
        const args = parseArgs()
        eat(')')
        validateCallee(node, callPos)
        node = { type: 'call', callee: node, args }
      } else break
    }
    return node
  }

  function parseArgs(): ExprNode[] {
    const args: ExprNode[] = []
    while (!isPunct(')')) {
      args.push(parseArgument())
      if (isPunct(',')) next()
      else break
    }
    return args
  }

  function parseArgument(): ExprNode {
    // single-param arrow: `x => expr` (only valid as a call argument)
    if (peek().kind === 'ident' && at(1).kind === 'punct' && at(1).value === '=>') {
      const param = next().value
      next() // =>
      return { type: 'lambda', params: [param], body: parseExpression() }
    }
    return parseExpression()
  }

  function parsePrimary(): ExprNode {
    const t = peek()
    if (t.kind === 'num') {
      next()
      return { type: 'lit', value: Number(t.value) }
    }
    if (t.kind === 'str') {
      next()
      return { type: 'lit', value: t.value }
    }
    if (t.kind === 'ident') {
      next()
      if (t.value === 'true') return { type: 'lit', value: true }
      if (t.value === 'false') return { type: 'lit', value: false }
      if (t.value === 'null') return { type: 'lit', value: null }
      return { type: 'ref', name: t.value }
    }
    if (isPunct('(')) {
      next()
      const e = parseExpression()
      eat(')')
      return e
    }
    if (isPunct('[')) {
      next()
      const items: ExprNode[] = []
      while (!isPunct(']')) {
        items.push(parseExpression())
        if (isPunct(',')) next()
        else break
      }
      eat(']')
      return { type: 'array', items }
    }
    if (isPunct('{')) {
      next()
      const props: Array<{ key: string; value: ExprNode }> = []
      while (!isPunct('}')) {
        const k = peek()
        let key: string
        if (k.kind === 'ident' || k.kind === 'str') {
          key = k.value
          next()
        } else throw new ExprError('invalid object key', k.pos)
        eat(':')
        props.push({ key, value: parseExpression() })
        if (isPunct(',')) next()
        else break
      }
      eat('}')
      return { type: 'object', props }
    }
    throw new ExprError(`unexpected token '${t.value || 'eof'}'`, t.pos)
  }

  function validateCallee(callee: ExprNode, callPos: number): void {
    if (callee.type !== 'member') {
      throw new ExprError('only whitelisted method calls are allowed', callPos)
    }
    const prop = callee.property
    if (callee.object.type === 'ref' && callee.object.name === 'Math') {
      if (!MATH_METHODS.has(prop)) throw new ExprError(`Math.${prop}() is not allowed`, callPos)
    } else if (!METHODS.has(prop)) {
      throw new ExprError(`method .${prop}() is not allowed`, callPos)
    }
  }

  const node = parseExpression()
  if (peek().kind !== 'eof') throw new ExprError('unexpected trailing input', peek().pos)
  return node
}

// ---- evaluator (authoring-time preview) ----

export type ExprEnv = Record<string, unknown>

export function evaluate(node: ExprNode, env: ExprEnv = {}): unknown {
  switch (node.type) {
    case 'lit':
      return node.value
    case 'array':
      return node.items.map((it) => evaluate(it, env))
    case 'object': {
      const o: Record<string, unknown> = {}
      for (const p of node.props) o[p.key] = evaluate(p.value, env)
      return o
    }
    case 'ref':
      return node.name === 'Math' ? Math : env[node.name]
    case 'member': {
      const obj = evaluate(node.object, env)
      return obj == null ? undefined : (obj as Record<string, unknown>)[node.property]
    }
    case 'index': {
      const obj = evaluate(node.object, env)
      const idx = evaluate(node.index, env)
      return obj == null ? undefined : (obj as Record<string, unknown>)[idx as string]
    }
    case 'unary': {
      const v = evaluate(node.operand, env)
      return node.op === '!' ? !v : -(v as number)
    }
    case 'logical': {
      const l = evaluate(node.left, env)
      if (node.op === '&&') return l ? evaluate(node.right, env) : l
      return l ? l : evaluate(node.right, env)
    }
    case 'binary':
      return applyBinary(node.op, evaluate(node.left, env), evaluate(node.right, env))
    case 'conditional':
      return evaluate(node.test, env) ? evaluate(node.consequent, env) : evaluate(node.alternate, env)
    case 'lambda':
      return (...args: unknown[]) => {
        const s: ExprEnv = { ...env }
        node.params.forEach((p, i) => (s[p] = args[i]))
        return evaluate(node.body, s)
      }
    case 'call': {
      const callee = node.callee as Extract<ExprNode, { type: 'member' }>
      const obj = evaluate(callee.object, env)
      const fn = obj == null ? undefined : (obj as Record<string, unknown>)[callee.property]
      const args = node.args.map((a) => evaluate(a, env))
      if (typeof fn !== 'function') throw new ExprError(`'${callee.property}' is not callable`)
      return (fn as (...a: unknown[]) => unknown).apply(obj, args)
    }
  }
}

function applyBinary(op: BinaryOp, l: unknown, r: unknown): unknown {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  switch (op) {
    case '==':
      return l === r
    case '!=':
      return l !== r
    case '<':
      return (l as any) < (r as any)
    case '>':
      return (l as any) > (r as any)
    case '<=':
      return (l as any) <= (r as any)
    case '>=':
      return (l as any) >= (r as any)
    case '+':
      return (l as any) + (r as any)
    case '-':
      return (l as any) - (r as any)
    case '*':
      return (l as any) * (r as any)
    case '/':
      return (l as any) / (r as any)
    case '%':
      return (l as any) % (r as any)
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ---- JS lowering (what the emitter transliterates) ----

export function toJs(node: ExprNode): string {
  switch (node.type) {
    case 'lit':
      return node.value === null
        ? 'null'
        : typeof node.value === 'string'
          ? JSON.stringify(node.value)
          : String(node.value)
    case 'array':
      return '[' + node.items.map(toJs).join(', ') + ']'
    case 'object':
      return node.props.length
        ? '{ ' + node.props.map((p) => `${jsKey(p.key)}: ${toJs(p.value)}`).join(', ') + ' }'
        : '{}'
    case 'ref':
      return node.name
    case 'member':
      return `${toJs(node.object)}.${node.property}`
    case 'index':
      return `${toJs(node.object)}[${toJs(node.index)}]`
    case 'unary':
      return `${node.op}${wrap(node.operand)}`
    case 'binary':
      return `(${toJs(node.left)} ${jsBinOp(node.op)} ${toJs(node.right)})`
    case 'logical':
      return `(${toJs(node.left)} ${node.op} ${toJs(node.right)})`
    case 'conditional':
      return `(${toJs(node.test)} ? ${toJs(node.consequent)} : ${toJs(node.alternate)})`
    case 'call':
      return `${toJs(node.callee)}(${node.args.map(toJs).join(', ')})`
    case 'lambda':
      return `(${node.params.join(', ')}) => ${toJs(node.body)}`
  }
}

const jsBinOp = (op: BinaryOp) => (op === '==' ? '===' : op === '!=' ? '!==' : op)
const jsKey = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k))

function wrap(node: ExprNode): string {
  const s = toJs(node)
  return node.type === 'binary' || node.type === 'logical' || node.type === 'conditional' || node.type === 'lambda'
    ? `(${s})`
    : s
}

// ---- free-variable analysis (used by addressing + dependency tracking) ----

/** Root identifiers referenced but not bound by a lambda param (excludes `Math`). */
export function freeRefs(node: ExprNode, bound: Set<string> = new Set(), out: Set<string> = new Set()): Set<string> {
  switch (node.type) {
    case 'lit':
      break
    case 'ref':
      if (node.name !== 'Math' && !bound.has(node.name)) out.add(node.name)
      break
    case 'array':
      node.items.forEach((it) => freeRefs(it, bound, out))
      break
    case 'object':
      node.props.forEach((p) => freeRefs(p.value, bound, out))
      break
    case 'member':
      freeRefs(node.object, bound, out)
      break
    case 'index':
      freeRefs(node.object, bound, out)
      freeRefs(node.index, bound, out)
      break
    case 'unary':
      freeRefs(node.operand, bound, out)
      break
    case 'binary':
    case 'logical':
      freeRefs(node.left, bound, out)
      freeRefs(node.right, bound, out)
      break
    case 'conditional':
      freeRefs(node.test, bound, out)
      freeRefs(node.consequent, bound, out)
      freeRefs(node.alternate, bound, out)
      break
    case 'call':
      freeRefs(node.callee, bound, out)
      node.args.forEach((a) => freeRefs(a, bound, out))
      break
    case 'lambda': {
      const b = new Set(bound)
      node.params.forEach((p) => b.add(p))
      freeRefs(node.body, b, out)
      break
    }
  }
  return out
}

// ---- convenience wrappers (operate on source text) ----

export const evalExpr = (src: string, env?: ExprEnv): unknown => evaluate(parse(src), env)
export const compileToJs = (src: string): string => toJs(parse(src))
export const refsOf = (src: string): Set<string> => freeRefs(parse(src))
