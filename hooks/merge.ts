import type { Api } from './graph'
import { CHAIN, type Row, findTranscript, isPrompt, parseRows } from './transcript'

// Merging a heavy branch into the current session: the part of the other
// session's conversation this one does not have is written into this one's
// history as one hidden record, tool calls included, which the running model
// reads; its rows themselves are also copied into this one's transcript file
// (splice.ts), so a reload shows them as ordinary turns. The other session is
// left as it is.
//
// What "this one does not have" is: a fork keeps its rows' uuids, so the rows
// on the other session's path after the last one this session's file also
// holds. A merge already done is remembered by the last uuid it took (`after`),
// so merging again brings only what came since.
//
// NB: every helper that takes `$` is a function declaration (see transcript.ts).

/** one tool result, one tool call's input: at most this much each */
const RESULT_MAX = 2_000
const INPUT_MAX = 4_000
/** the whole record: past this, older tool results go first, then the oldest pieces */
const TOTAL_MAX = 100_000

type Piece = { kind: 'prompt' | 'text' | 'tool' | 'result' | 'summary'; s: string }

export type MergePlan = {
  /** the other session's newest row taken: where a later merge starts */
  upto: string
  prompts: number
  tools: number
  /** the record written into this session */
  text: string
  /** the first prompts brought over, for the confirm dialog */
  preview: string[]
  /** the other session works in another folder: its file changes are not here */
  otherCwd: string | undefined
  /** some of it did not fit */
  trimmed: boolean
  /** the other session's rows brought over, as they stand in its file */
  rows: Row[]
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…（截斷，原長 ${s.length} 字）` : s)

const blocksOf = (r: Row) => {
  const c = (r.message as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return [{ type: 'text', text: c }]
  return Array.isArray(c) ? (c as Record<string, unknown>[]) : []
}

const resultText = (b: Record<string, unknown>) => {
  const c = b.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return (c as Record<string, unknown>[])
      .map(x => (x.type === 'text' ? String(x.text ?? '') : `[${String(x.type ?? '?')}]`))
      .join('\n')
  }
  return ''
}

/** a row as the pieces a reader of the record needs */
const piecesOf = (r: Row): Piece[] => {
  if (r.type === 'user') {
    if (r.isCompactSummary === true) {
      const t = blocksOf(r).map(b => String(b.text ?? '')).join('')
      return t.trim() ? [{ kind: 'summary', s: `【對話壓縮摘要】\n${clip(t.trim(), RESULT_MAX * 4)}` }] : []
    }
    if (isPrompt(r)) {
      const t = blocksOf(r)
        .map(b => (b.type === 'text' ? String(b.text ?? '') : `[${String(b.type ?? '?')}]`))
        .join('')
        .trim()
      return [{ kind: 'prompt', s: `【用戶】\n${t}` }]
    }
    return blocksOf(r)
      .filter(b => b.type === 'tool_result')
      .map(b => ({ kind: 'result' as const, s: `  [${b.is_error === true ? '錯誤' : '結果'}] ${clip(resultText(b).trim(), RESULT_MAX)}` }))
  }
  if (r.type === 'assistant') {
    const out: Piece[] = []
    for (const b of blocksOf(r)) {
      if (b.type === 'text' && String(b.text ?? '').trim()) out.push({ kind: 'text', s: `【助理】\n${String(b.text).trim()}` })
      else if (b.type === 'tool_use') out.push({ kind: 'tool', s: `  [工具 ${String(b.name ?? '?')}] ${clip(JSON.stringify(b.input ?? {}), INPUT_MAX)}` })
    }
    return out
  }
  return []
}

/** keep the record under TOTAL_MAX: drop older tool results first, then the oldest pieces */
const fit = (pieces: Piece[]) => {
  const size = () => pieces.reduce((n, p) => n + p.s.length + 2, 0)
  let trimmed = false
  for (let i = 0; i < pieces.length && size() > TOTAL_MAX; i++) {
    if (pieces[i]!.kind === 'result') {
      pieces[i] = { kind: 'result', s: '  [結果略]' }
      trimmed = true
    }
  }
  let dropped = 0
  while (pieces.length > 1 && size() > TOTAL_MAX) {
    pieces.shift()
    dropped++
  }
  if (dropped > 0) {
    trimmed = true
    pieces.unshift({ kind: 'summary', s: `（較早的 ${dropped} 段因篇幅省略）` })
  }
  return trimmed
}

/** the path from the newest row back to the first, across compactions, oldest first */
const pathOf = (rows: readonly Row[]) => {
  const byUuid = new Map<string, Row>()
  let leaf: Row | undefined
  for (const r of rows) {
    if (typeof r.uuid !== 'string' || r.isSidechain === true || !CHAIN.includes(r.type ?? '')) continue
    byUuid.set(r.uuid, r)
    leaf = r
  }
  const path: Row[] = []
  const seen = new Set<string>()
  for (let r = leaf; r?.uuid && !seen.has(r.uuid); ) {
    seen.add(r.uuid)
    path.push(r)
    const up = r.parentUuid ?? (typeof r.logicalParentUuid === 'string' ? r.logicalParentUuid : null)
    r = up ? byUuid.get(up) : undefined
  }
  return path.reverse()
}

/**
 * What merging `fromId` into `intoId` would write. 'missing': the other
 * session's transcript cannot be read; 'empty': nothing new to bring over.
 */
export async function planMerge(
  $: Api,
  fromId: string,
  intoId: string,
  fromName: string,
  after?: string,
): Promise<MergePlan | 'missing' | 'empty'> {
  const src = await findTranscript($, fromId)
  if (!src) return 'missing'
  const dst = await findTranscript($, intoId)
  const have = new Set<string>()
  if (dst) for (const r of parseRows(dst.text)) if (typeof r.uuid === 'string') have.add(r.uuid)

  const path = pathOf(parseRows(src.text))
  let start = 0
  path.forEach((r, i) => {
    if (have.has(r.uuid!) || r.uuid === after) start = i + 1
  })
  // end on a finished answer: rows of a turn still running (a tool call
  // without its result yet) cannot be followed by this session's next prompt
  const rest = path.slice(start)
  const end = rest.findLastIndex((r, i) => r.type === 'assistant' && !blocksOf(r).some(b => b.type === 'tool_use') && rest[i + 1]?.type !== 'assistant')
  const tail = rest.slice(0, end + 1)
  const pieces = tail.flatMap(piecesOf)
  if (!pieces.some(p => p.kind !== 'result')) return 'empty'

  const prompts = tail.filter(isPrompt)
  const tools = pieces.filter(p => p.kind === 'tool').length
  const preview = prompts.slice(0, 3).map(p => piecesOf(p)[0]?.s.replace(/^【用戶】\n/, '') ?? '')
  const lastCwd = [...tail].reverse().find(r => typeof r.cwd === 'string')?.cwd as string | undefined
  const here = await $.session.cwd()
  const otherCwd = lastCwd && lastCwd !== here ? lastCwd : undefined
  const trimmed = fit(pieces)

  const head = [
    `以下是另一個 session「${fromName}」（${fromId}）在與本 session 分開之後進行的對話，包含工具呼叫過程。用戶把它併進本 session：請把它當成本 session 也經歷過的脈絡，其中的結論、決定與做過的改動，之後的工作都要納入考量；不需要逐條回覆。`,
    otherCwd
      ? `注意：那個 session 的工作目錄是 ${otherCwd}，與本 session 不同，它對檔案做的改動不在本 session 的目錄裡。`
      : '它與本 session 使用同一個工作目錄，它對檔案做的改動已經反映在目前的檔案上。',
  ].join('\n')
  return {
    upto: tail.at(-1)!.uuid!,
    prompts: prompts.length,
    tools,
    text: `${head}\n\n<併入的對話>\n${pieces.map(p => p.s).join('\n\n')}\n</併入的對話>`,
    preview,
    otherCwd,
    trimmed,
    rows: tail,
  }
}
