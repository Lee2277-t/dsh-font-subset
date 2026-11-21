// dsh-font-subset —— 按实际用到的字裁剪字体，并报告缺字。
//
// 中文网页字体动辄 5–15 MB，一个落地页加载一个字体就超预算。真正需要的字通常只有几百个，
// 按实际用字取子集能把这个数字压到几十 KB。这是确定性算法，不需要猜。
//
// 工具：
//   font_subset    取子集并写出文件，报告体积变化与缺字
//   font_coverage  只查缺字，不写文件
//
// 缺字检查自己解析 cmap 表，不依赖转换库：字体里没有某个字时，取子集会静默丢掉它，
// 页面上就出现豆腐块——这种问题必须在裁剪之前暴露出来。

import fs from 'node:fs'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import subsetFont from 'subset-font'

export const name = 'font-subset'
export const inject = ['tools']

export const Config = Schema.object({
  outputDir: Schema.string().default('').description('子集文件输出目录；留空则与源字体同目录。'),
  formats: Schema.array(Schema.string()).default(['woff2']).description('输出格式：woff2 / woff / ttf。'),
  maxChars: Schema.number().default(20000).description('单次最多处理的不同字符数，防止误传整本书。'),
})

// ---------------------------------------------------------------- cmap 解析

function readTableDirectory(buf) {
  if (buf.length < 12) return null
  const version = buf.readUInt32BE(0)
  if (version !== 0x00010000 && version !== 0x74727565 && buf.toString('latin1', 0, 4) !== 'OTTO') {
    return null
  }
  const numTables = buf.readUInt16BE(4)
  const tables = new Map()
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    if (rec + 16 > buf.length) break
    const tag = buf.toString('latin1', rec, rec + 4)
    tables.set(tag, { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) })
  }
  return tables
}

// 返回 [{start, end}] 码位区间；解析不了返回 null（绝不假装覆盖完整）
function readCodePointRanges(buf) {
  const tables = readTableDirectory(buf)
  if (!tables || !tables.has('cmap')) return null
  const cmap = tables.get('cmap').offset
  if (cmap + 4 > buf.length) return null

  const numSub = buf.readUInt16BE(cmap + 2)
  let best = null
  for (let i = 0; i < numSub; i++) {
    const rec = cmap + 4 + i * 8
    if (rec + 8 > buf.length) break
    const platform = buf.readUInt16BE(rec)
    const encoding = buf.readUInt16BE(rec + 2)
    const sub = cmap + buf.readUInt32BE(rec + 4)
    if (sub + 2 > buf.length) continue
    const format = buf.readUInt16BE(sub)
    // 优先 format 12（覆盖 BMP 之外），否则 format 4
    if (format === 12) {
      best = { sub, format, rank: 2 }
      break
    }
    if (format === 4 && (!best || best.rank < 2)) {
      best = { sub, format, rank: 1 + (platform === 3 && encoding === 1 ? 1 : 0) }
      if (best.rank === 2) best.rank = 1
    }
  }
  if (!best) return null

  const ranges = []
  if (best.format === 12) {
    const nGroups = buf.readUInt32BE(best.sub + 12)
    for (let i = 0; i < nGroups; i++) {
      const g = best.sub + 16 + i * 12
      if (g + 12 > buf.length) break
      const start = buf.readUInt32BE(g)
      const end = buf.readUInt32BE(g + 4)
      if (end >= start) ranges.push([start, end])
    }
  } else {
    const segCountX2 = buf.readUInt16BE(best.sub + 6)
    const segCount = segCountX2 / 2
    const endBase = best.sub + 14
    const startBase = endBase + segCountX2 + 2
    for (let i = 0; i < segCount; i++) {
      const end = buf.readUInt16BE(endBase + i * 2)
      const start = buf.readUInt16BE(startBase + i * 2)
      if (start === 0xffff && end === 0xffff) continue
      if (end >= start) ranges.push([start, end])
    }
  }
  if (ranges.length === 0) return null
  ranges.sort((a, b) => a[0] - b[0])
  return ranges
}

function rangeHas(ranges, cp) {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [s, e] = ranges[mid]
    if (cp < s) hi = mid - 1
    else if (cp > e) lo = mid + 1
    else return true
  }
  return false
}

// ---------------------------------------------------------------- 字符收集

function uniqueChars(text) {
  const set = new Set()
  for (const ch of text) set.add(ch)
  return [...set]
}

const TEXT_EXT = new Set(['.html', '.htm', '.vue', '.jsx', '.tsx', '.js', '.ts', '.mjs', '.cjs', '.css', '.json', '.md', '.txt', '.svelte', '.astro'])

function harvest(target, out, seen, budget) {
  let st
  try {
    st = fs.statSync(target)
  } catch {
    return
  }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(target, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
      harvest(path.join(target, e.name), out, seen, budget)
      if (out.size > budget) return
    }
    return
  }
  if (!TEXT_EXT.has(path.extname(target).toLowerCase())) return
  if (st.size > 4 * 1024 * 1024) return
  let real
  try {
    real = fs.realpathSync(target)
  } catch {
    return
  }
  if (seen.has(real)) return
  seen.add(real)
  const text = fs.readFileSync(target, 'utf8')
  for (const ch of text) out.add(ch)
}

// ---------------------------------------------------------------- 体积

function fmtSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(2)} MB`
}

function pct(before, after) {
  if (!before) return '—'
  const saved = (1 - after / before) * 100
  // 压到 99% 以上时一位小数会显示成 -100.0%，那是四舍五入不是事实
  const digits = Math.abs(saved) >= 99 ? 2 : 1
  return `${saved >= 0 ? '-' : '+'}${Math.abs(saved).toFixed(digits)}%`
}

function resolveFont(raw) {
  if (!raw) return { error: 'ERROR: font is required.' }
  const p = path.resolve(String(raw).replace(/^~/, process.env.USERPROFILE ?? ''))
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { error: `ERROR: 字体文件不存在: ${p}` }
  return { p }
}

function gatherText(args, config) {
  const chars = new Set()
  const sources = []
  if (args.text) {
    for (const ch of String(args.text)) chars.add(ch)
    sources.push(`text（${[...new Set(String(args.text))].length} 个不同字符）`)
  }
  if (args.textFile) {
    const p = path.resolve(String(args.textFile).replace(/^~/, process.env.USERPROFILE ?? ''))
    if (fs.existsSync(p)) {
      for (const ch of fs.readFileSync(p, 'utf8')) chars.add(ch)
      sources.push(`${path.basename(p)}`)
    }
  }
  if (args.paths) {
    const list = Array.isArray(args.paths) ? args.paths : [args.paths]
    const seen = new Set()
    for (const raw of list) {
      const p = path.resolve(String(raw).replace(/^~/, process.env.USERPROFILE ?? ''))
      if (!fs.existsSync(p)) continue
      harvest(p, chars, seen, config.maxChars ?? 20000)
      sources.push(path.basename(p))
    }
  }
  return { chars: [...chars], sources }
}

// ---------------------------------------------------------------- 工具

function coverageReport(fontPath, fontBuf, chars) {
  const ext = path.extname(fontPath).toLowerCase()
  const ranges = readCodePointRanges(fontBuf)
  if (!ranges) {
    return {
      known: false,
      text:
        ext === '.woff' || ext === '.woff2'
          ? '这是压缩包装的字体，无法直接读 cmap。缺字检查需要 .ttf / .otf 原件。'
          : '字体结构无法识别（可能不是 TrueType/OpenType），无法判定缺字。',
      missing: [],
    }
  }
  // 控制字符（换行、制表符）没有字形，不算缺字
  const visible = chars.filter((ch) => ch.codePointAt(0) >= 0x20)
  const missing = visible.filter((ch) => !rangeHas(ranges, ch.codePointAt(0)))
  return { known: true, missing, ranges: ranges.length, checked: visible.length }
}

function registerSubset(ctx, config) {
  ctx.tools.register(
    defineTool({
      name: 'font_subset',
      description:
        'Cut a font down to the characters that are actually used, and report the size before and ' +
        'after. Chinese webfonts are 5-15 MB; the few hundred characters a page really needs fit in ' +
        'tens of KB. Characters may come from a string, a text file, or a source tree (html/vue/js/' +
        'css). Also reports characters the font does not contain, which would otherwise silently ' +
        'render as tofu boxes after subsetting.',
      parameters: {
        font: { type: 'string', required: true, description: '字体文件：ttf / otf / woff / woff2。' },
        text: { type: 'string', description: '直接给出要保留的字符。' },
        textFile: { type: 'string', description: '从这个文件里取字符。' },
        paths: {
          type: 'array',
          description: '从这些文件或目录里收集字符（html/vue/js/ts/css/json/md/txt）。',
          items: { type: 'string' },
        },
        formats: {
          type: 'array',
          description: '输出格式，默认用配置里的（woff2）。',
          items: { type: 'string' },
        },
        outDir: { type: 'string', description: '输出目录，默认与源字体同目录或用配置。' },
        dryRun: { type: 'boolean', description: '只报告，不写文件。' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const font = resolveFont(args.font)
        if (font.error) return font.error
        const { chars, sources } = gatherText(args, config)
        if (chars.length === 0) {
          return 'ERROR: 没有可裁剪的字符。给 text / textFile / paths 之一。'
        }
        if (chars.length > (config.maxChars ?? 20000)) {
          return `ERROR: 不同字符数 ${chars.length} 超过上限 ${config.maxChars}。字符太多时子集化收益消失，请确认输入。`
        }

        const fontBuf = fs.readFileSync(font.p)
        const cov = coverageReport(font.p, fontBuf, chars)
        const formats = (args.formats ?? config.formats ?? ['woff2']).map((f) => String(f).toLowerCase())
        const bad = formats.filter((f) => !['woff2', 'woff', 'ttf'].includes(f))
        if (bad.length) return `ERROR: 不支持的格式 ${bad.join(', ')}（只支持 woff2 / woff / ttf）`

        // 默认不写回字体所在目录：那可能是 C:\Windows\Fonts。
        // 注意空串要当成"没设置"——?? 只挡 null/undefined，会把 "" 当成有效值。
        const nonEmpty = [args.outDir, config.outputDir].find((v) => v !== undefined && v !== null && String(v).trim() !== '')
        const outDir = path.resolve(
          String(nonEmpty ?? path.join(process.cwd(), 'font-subsets')).replace(/^~/, process.env.USERPROFILE ?? ''),
        )
        const base = path.basename(font.p, path.extname(font.p))

        const lines = []
        lines.push(`font_subset ${font.p}`)
        lines.push(`原文 ${fmtSize(fontBuf.length)} · 不同字符 ${chars.length} · 来源 ${sources.join(' + ') || '(未注明)'}`)
        lines.push('')

        const results = []
        for (const format of formats) {
          let out
          try {
            out = await subsetFont(fontBuf, chars.join(''), { targetFormat: format })
          } catch (e) {
            lines.push(`  ✗ ${format}: ${e.message}`)
            continue
          }
          results.push({ format, size: out.length, buf: out })
        }

        if (results.length === 0) return lines.concat(['', '所有格式都失败，未写出任何文件。']).join('\n')

        lines.push('## 体积')
        for (const r of results) {
          lines.push(`  ${r.format.padEnd(6)} ${fmtSize(r.size).padStart(10)}  ${pct(fontBuf.length, r.size).padStart(8)}`)
        }
        lines.push('')

        if (!args.dryRun) {
          fs.mkdirSync(outDir, { recursive: true })
          for (const r of results) {
            const target = path.join(outDir, `${base}.${r.format}`)
            fs.writeFileSync(target, r.buf)
            lines.push(`  写出 ${target}`)
          }
          lines.push('')
        } else {
          lines.push(`  dry run：将写到 ${outDir}，未改动任何文件。`)
          lines.push('')
        }

        lines.push('## 缺字')
        if (!cov.known) {
          lines.push(`  ${cov.text}`)
        } else if (cov.missing.length === 0) {
          lines.push(`  无 ✅ 这 ${cov.checked} 个可见字符字体里都有（cmap 分 ${cov.ranges} 段）`)
        } else {
          lines.push(`  ${cov.missing.length} 个字符字体里没有，取子集后它们会丢：`)
          lines.push(`    ${cov.missing.slice(0, 80).join(' ')}`)
          if (cov.missing.length > 80) lines.push(`    … 另 ${cov.missing.length - 80} 个`)
          lines.push('')
          lines.push('  这些字在页面上会显示成豆腐块。要么换字体，要么为它们指定 fallback 字体。')
        }

        return lines.join('\n')
      },
    }),
  )
}

function registerCoverage(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'font_coverage',
      description:
        'Report which characters of a text are missing from a font, without writing anything. Use it ' +
        'before subsetting: subsetting silently drops characters the font lacks, and they show up ' +
        'later as tofu boxes.',
      parameters: {
        font: { type: 'string', required: true, description: '字体文件（缺字检查需要 ttf / otf 原件）。' },
        text: { type: 'string', description: '要检查的字符。' },
        textFile: { type: 'string', description: '从这个文件里取字符。' },
        paths: {
          type: 'array',
          description: '从这些文件或目录里收集字符。',
          items: { type: 'string' },
        },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const font = resolveFont(args.font)
        if (font.error) return font.error
        const { chars, sources } = gatherText(args, { maxChars: 20000 })
        if (chars.length === 0) return 'ERROR: 没有可检查的字符。给 text / textFile / paths 之一。'

        const buf = fs.readFileSync(font.p)
        const cov = coverageReport(font.p, buf, chars)
        const lines = [`font_coverage ${path.basename(font.p)}`, `${chars.length} 个不同字符 · 来源 ${sources.join(' + ')}`, '']
        if (!cov.known) {
          lines.push(`  ${cov.text}`)
          return lines.join('\n')
        }
        if (cov.missing.length === 0) {
          lines.push('  全部覆盖 ✅')
        } else {
          lines.push(`  缺 ${cov.missing.length} 个（${((cov.missing.length / Math.max(1, cov.checked)) * 100).toFixed(1)}%）：`)
          lines.push(`    ${cov.missing.slice(0, 120).join(' ')}`)
          if (cov.missing.length > 120) lines.push(`    … 另 ${cov.missing.length - 120} 个`)
        }
        return lines.join('\n')
      },
    }),
  )
}

export function apply(ctx, config) {
  registerSubset(ctx, config)
  registerCoverage(ctx, config)
}
