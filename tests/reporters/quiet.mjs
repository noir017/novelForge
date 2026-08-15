/**
 * node:test 的精简 reporter：只吐失败与总计。
 *
 * 默认 spec/tap reporter 每条失败带十几行 YAML（duration_ms、location、完整 stack），
 * 几百个用例跑下来输出以万字计——人要往回翻，塞进 agent 上下文更是纯浪费。
 * 这里每条失败压成两三行：位置 + 用例全名 + 期望/实际。
 *
 *   node --test --test-reporter=./tests/reporters/quiet.mjs "tests/unit/**\/*.test.js"
 *
 * 环境变量：
 *   NF_TEST_LOGS=1        连带打印失败文件里的 console 输出（默认丢弃）
 *   NF_TEST_MAX_FAILS=n   最多详细展示几条失败，超出只计数（默认 25，0 表示不限）
 *   NF_TEST_STACK=1       每条失败附一行仓库内的调用位置
 */

import path from 'node:path'

const CWD = process.cwd()
const SHOW_LOGS = process.env.NF_TEST_LOGS === '1'
const SHOW_STACK = process.env.NF_TEST_STACK === '1'
const MAX_FAILS = process.env.NF_TEST_MAX_FAILS === undefined
  ? 25
  : Number(process.env.NF_TEST_MAX_FAILS) || Infinity

const VALUE_CAP = 160
const MSG_CAP = 300

const rel = (f) => (f ? path.relative(CWD, f).replaceAll('\\', '/') : '?')

/**
 * 事件之间的文件键。
 *
 * `test:stderr` 给的是**命令行上那个写法**（多半是相对路径），`test:fail` 给的是绝对路径——
 * 两边直接当 key 用会对不上，加载期崩溃就查不到真正的原因。统一 resolve 一次。
 */
const key = (f) => (f ? path.resolve(CWD, f) : '')

/** 压成单行并截断——多行 diff 是 reporter 体积的主要来源。 */
function flat(s, cap) {
  const one = String(s).replace(/\s*\n\s*/g, ' ⏎ ').trim()
  return one.length > cap ? one.slice(0, cap) + ` …(共 ${one.length} 字)` : one
}

function show(v) {
  if (typeof v === 'string') return flat(JSON.stringify(v), VALUE_CAP)
  if (v === undefined) return 'undefined'
  try {
    return flat(JSON.stringify(v), VALUE_CAP)
  } catch {
    return flat(String(v), VALUE_CAP)
  }
}

/** 两个长字符串只报第一处分歧，别把两份全文都印出来。 */
function diffHint(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null
  if (a.length < 80 && b.length < 80) return null
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const win = (s) => flat(JSON.stringify(s.slice(Math.max(0, i - 20), i + 40)), VALUE_CAP)
  return `第 ${i} 字起分歧：实际 ${win(a)} / 期望 ${win(b)}`
}

/** 找出第一帧落在仓库里、又不在 tests/helpers 的调用位置。 */
function repoFrame(stack) {
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = line.match(/\(?([A-Za-z]:[\\/][^):]+|\/[^):]+):(\d+):(\d+)\)?$/)
    if (!m) continue
    if (m[1].includes('node_modules') || m[1].startsWith('node:')) continue
    const r = rel(m[1])
    if (r.startsWith('..')) continue
    return `${r}:${m[2]}`
  }
  return null
}

export default async function* quiet(source) {
  /** 每个文件一份祖先栈——文件之间是并行跑的，事件会交错。 */
  const stacks = new Map()
  const logs = new Map()
  const errs = new Map()
  let failed = 0
  let counts = null
  let durationMs = 0

  /** 边跑边吐失败，不攒到最后——整轮要跑几十秒，第一条失败该立刻看见。 */
  function* render(f) {
    yield `\n✗ ${f.file}${f.line ? ':' + f.line : ''}\n  ${f.name}\n`
    const c = f.cause
    if (c && typeof c === 'object' && 'expected' in c && 'actual' in c) {
      const hint = diffHint(c.actual, c.expected)
      yield hint
        ? `  ${hint}\n`
        : `  实际 ${show(c.actual)}\n  期望 ${show(c.expected)}${c.operator ? `（${c.operator}）` : ''}\n`
      if (c.generatedMessage === false) yield `  ${flat(c.message, MSG_CAP)}\n`
    } else if (f.bare) {
      // 文件在加载期就崩时，node 只给一句 "test failed"，真正的原因在 stderr 上。
      const first = (errs.get(f.rawFile) || []).find((l) => /\w*Error\b/.test(l))
      yield `  ${flat(first || c, MSG_CAP)}\n`
    } else {
      const name = c?.constructor?.name
      yield `  ${name && name !== 'Error' ? name + ': ' : ''}${flat(c?.message ?? c, MSG_CAP)}\n`
    }
    if (SHOW_STACK) {
      const at = repoFrame(f.stack)
      if (at) yield `  at ${at}\n`
    }
    if (SHOW_LOGS) {
      const buf = logs.get(f.rawFile)
      // 日志是按文件收的，不是按用例——同文件多条失败会各自附上同一份。
      if (buf?.length) yield `  ── ${f.file} 的输出 ──\n` + buf.map((l) => '  │ ' + flat(l, MSG_CAP)).join('\n') + '\n'
    }
  }

  for await (const event of source) {
    const d = event.data || {}

    switch (event.type) {
      case 'test:start': {
        const k = key(d.file)
        const s = stacks.get(k) || []
        s.length = d.nesting
        s[d.nesting] = d.name
        stacks.set(k, s)
        break
      }

      case 'test:stderr': {
        // stderr 始终留一份：加载期崩溃的真实原因只在这里。
        const eb = errs.get(key(d.file)) || []
        eb.push(d.message)
        if (eb.length > 60) eb.shift()
        errs.set(key(d.file), eb)
      }
      // fallthrough：stderr 也算日志
      case 'test:stdout': {
        if (!SHOW_LOGS) break
        const buf = logs.get(key(d.file)) || []
        buf.push(d.message)
        if (buf.length > 40) buf.shift()
        logs.set(key(d.file), buf)
        break
      }

      case 'test:fail': {
        const err = d.details?.error
        // 套件的失败只是子用例失败的回声，叶子那条已经报过了。
        if (err?.failureType === 'subtestsFailed') break
        failed++
        if (failed > MAX_FAILS) break
        const s = stacks.get(key(d.file)) || []
        const trail = s.slice(0, d.nesting).filter(Boolean)
        const cause = err?.cause ?? err
        yield* render({
          rawFile: key(d.file),
          file: rel(d.file),
          line: d.line,
          name: [...trail, d.name].join(' › '),
          cause,
          bare: typeof cause === 'string',
          stack: err?.cause?.stack || err?.stack,
        })
        break
      }

      case 'test:summary': {
        // 每个文件一条、末尾再来一条总的（无 file）——只认总的那条。
        if (d.file) break
        counts = d.counts
        durationMs = d.duration_ms
        break
      }
    }
  }

  if (failed > MAX_FAILS) {
    yield `\n…另有 ${failed - MAX_FAILS} 条失败未展开（NF_TEST_MAX_FAILS=0 看全部）\n`
  }
  if (!counts) {
    yield '\n没有拿到汇总——多半是某个测试文件在加载期就崩了。\n'
    return
  }

  const secs = (durationMs / 1000).toFixed(1)
  const bits = [`通过 ${counts.passed}`]
  // 用叶子失败数，不用 counts.failed——后者把套件的 rollup 也算了进去，与上面展开的条数对不上。
  if (failed) bits.push(`失败 ${failed}`)
  if (counts.skipped) bits.push(`跳过 ${counts.skipped}`)
  if (counts.todo) bits.push(`todo ${counts.todo}`)
  if (counts.cancelled) bits.push(`取消 ${counts.cancelled}`)
  yield `\n${failed ? '✗' : '✓'} ${bits.join(' / ')}，${counts.tests} 条，${secs}s\n`
}
