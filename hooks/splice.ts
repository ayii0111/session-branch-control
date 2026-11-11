import type { BranchNode } from '../types'
import type { Api } from './graph'
import { CHAIN, type Row, baseOf, findTranscript, isPrompt, pairRows, parseRows } from './transcript'

// Writing merged turns into the current session's own transcript file, so a
// reload (/resume, a restart) shows them as ordinary turns where they belong:
// a light branch's questions and answers after the turn it was asked in, a
// heavy branch's rows after the conversation's end.
//
// The running process never reads its file again: what its model reads this
// run is the hidden record `$.session.append` wrote, and its next row still
// hangs on the row it knows as newest. So the file is mended again later
// (`repairSplices`, at each turn's end and when the session ends): the hidden
// record is dropped (the turns now stand in its place), and any row hanging
// where a splice went in is hung after the splice instead.
//
// cc writes this file too, so a rewrite reads it twice and writes in place
// only when it did not change in between.
//
// NB: every helper that takes `$` is a function declaration (see transcript.ts).

/** one run of rows put in: its first hangs on `after`; what hung there now hangs on `last` */
export type Splice = { after: string; last: string; ours: string[] }

/** what one merge did to a session's file, kept while that session's process may still write it */
export type SpliceJob = {
  /** the hidden record the running model reads: dropped from the file */
  hidden: string | null
  /** the row the hidden record hung on, learnt when it is dropped */
  hiddenParent: string | null
  splices: Splice[]
}

type Insert = { after: string; rows: Row[] }
type Line = { raw: string; row?: Row }

const linesOf = (text: string): Line[] =>
  text.split('\n').map(raw => {
    if (!raw.trim()) return { raw }
    try {
      return { raw, row: JSON.parse(raw) as Row }
    } catch {
      return { raw }
    }
  })

const LINKS = ['parentUuid', 'logicalParentUuid', 'leafUuid'] as const

/** the file with `inserts` put in and `job`'s links mended; undefined when an insert has no place */
const edit = (text: string, job: SpliceJob, inserts: readonly Insert[]) => {
  const lines = linesOf(text)
  for (const ins of inserts) {
    const at = lines.findLastIndex(l => l.row?.uuid === ins.after)
    if (at < 0) return undefined
    const have = new Set(lines.map(l => l.row?.uuid))
    const add = ins.rows.filter(r => !have.has(r.uuid))
    lines.splice(at + 1, 0, ...add.map(r => ({ raw: JSON.stringify(r), row: r })))
  }
  if (job.hidden) {
    const at = lines.findIndex(l => l.row?.uuid === job.hidden)
    if (at >= 0) {
      const p = lines[at]!.row!.parentUuid
      job.hiddenParent = typeof p === 'string' ? p : null
      lines.splice(at, 1)
    }
  }
  const ours = new Set(job.splices.flatMap(s => s.ours))
  const redirect = (v: unknown) => {
    if (typeof v !== 'string') return v
    let p = v
    if (job.hidden && p === job.hidden && job.hiddenParent) p = job.hiddenParent
    return job.splices.find(s => s.after === p)?.last ?? p
  }
  for (const l of lines) {
    const r = l.row as Record<string, unknown> | undefined
    if (!r || (typeof r.uuid === 'string' && ours.has(r.uuid))) continue
    let changed = false
    for (const k of LINKS) {
      if (!(k in r)) continue
      const to = redirect(r[k])
      if (to !== r[k]) {
        r[k] = to
        changed = true
      }
    }
    if (changed) l.raw = JSON.stringify(r)
  }
  return lines.map(l => l.raw).join('\n')
}

/** rewrite `file` with `change`, only if cc did not write it meanwhile */
async function rewrite($: Api, file: string, change: (text: string) => string | undefined) {
  for (let i = 0; i < 3; i++) {
    const before = await $.fs.read(file)
    const out = change(before)
    if (out === undefined) return false
    if (out === before) return true
    if ((await $.fs.read(file)) !== before) continue
    await $.fs.write(file, out)
    return true
  }
  return false
}

/** the session's conversation as cc loads it: from the last compaction to the newest row, the hidden record left out */
const livePath = (rows: readonly Row[], hidden: string | null) => {
  const byUuid = new Map<string, Row>()
  let leaf: Row | undefined
  for (const r of rows) {
    if (typeof r.uuid !== 'string' || r.isSidechain === true || !CHAIN.includes(r.type ?? '')) continue
    byUuid.set(r.uuid, r)
    if (r.uuid !== hidden) leaf = r
  }
  const path: Row[] = []
  const seen = new Set<string>()
  for (let r = leaf; r?.uuid && !seen.has(r.uuid); r = r.parentUuid ? byUuid.get(r.parentUuid) : undefined) {
    seen.add(r.uuid)
    path.unshift(r)
  }
  return { path, hiddenRow: hidden ? byUuid.get(hidden) : undefined }
}

async function fileOf($: Api, sessionId: string) {
  const src = await findTranscript($, sessionId)
  return src && { file: `${src.folder}/${sessionId}.jsonl`, rows: parseRows(src.text) }
}

const jobOf = (hidden: string | null, inserts: readonly Insert[]): SpliceJob => ({
  hidden,
  hiddenParent: null,
  splices: inserts.map(i => ({ after: i.after, last: i.rows.at(-1)!.uuid!, ours: i.rows.map(r => r.uuid!) })),
})

/**
 * A light branch merged back: each question and answer as visible turns,
 * right after the turn it was asked in (before the next prompt). A question
 * whose turn is gone (rewound) or before the last compaction, which a reload
 * does not show, goes at the end. Undefined when the file cannot be written.
 */
export async function spliceLight($: Api, sessionId: string, nodes: readonly BranchNode[], hidden: string | null) {
  const f = await fileOf($, sessionId)
  if (!f || nodes.length === 0) return undefined
  const { path, hiddenRow } = livePath(f.rows, hidden)
  const end = (typeof hiddenRow?.parentUuid === 'string' ? hiddenRow.parentUuid : undefined) ?? path.at(-1)?.uuid
  if (!end) return undefined
  const env = [...path].reverse().find(r => r.type === 'user') ?? path.at(-1)!
  const lastAssistant = [...path].reverse().find(r => r.type === 'assistant')
  const model = (lastAssistant?.message as { model?: string } | undefined)?.model ?? (await $.session.model())
  const base = baseOf(env, sessionId)

  const index = new Map(path.map((r, i) => [r.uuid!, i]))
  const groups = new Map<string, Row[]>()
  for (const n of nodes) {
    let after = end
    const at = n.anchor ? index.get(n.anchor) : undefined
    if (at !== undefined) {
      // the end of the turn it was asked in: just before the next prompt
      let j = at
      while (j + 1 < path.length && !isPrompt(path[j + 1]!)) j++
      after = j + 1 < path.length ? path[j]!.uuid! : end
    }
    const run = groups.get(after) ?? []
    const parent = run.at(-1)?.uuid ?? after
    run.push(...pairRows(base, model, parent, `（輕支線）${n.text}`, n.answer, new Date(n.at).toISOString()))
    groups.set(after, run)
  }
  const inserts = [...groups].map(([after, rows]) => ({ after, rows }))
  const job = jobOf(hidden, inserts)
  return (await rewrite($, f.file, t => edit(t, job, inserts))) ? job : undefined
}

/**
 * A heavy branch merged in: its rows, as they stand in its file, after the
 * end of this session's conversation; the first prompt marked with where they
 * came from. Compaction rows are left out (they would cut this session's
 * history there). Undefined when the file cannot be written.
 */
export async function spliceMerged($: Api, sessionId: string, taken: readonly Row[], fromName: string, hidden: string | null) {
  const f = await fileOf($, sessionId)
  if (!f) return undefined
  const { path, hiddenRow } = livePath(f.rows, hidden)
  const after = (typeof hiddenRow?.parentUuid === 'string' ? hiddenRow.parentUuid : undefined) ?? path.at(-1)?.uuid
  if (!after) return undefined
  const have = new Set(f.rows.map(r => r.uuid))
  const rows: Row[] = []
  let parent = after
  let marked = false
  for (const r of taken) {
    if (typeof r.uuid !== 'string' || have.has(r.uuid)) continue
    if (r.isCompactSummary === true || (r.type === 'system' && r.subtype === 'compact_boundary')) continue
    const { logicalParentUuid: _drop, ...rest } = r
    const copy: Row = { ...rest, parentUuid: parent, sessionId, ...('session_id' in r ? { session_id: sessionId } : {}) }
    if (!marked && isPrompt(r)) {
      marked = true
      const tag = `（⤳ 併入自「${fromName}」）`
      const m = r.message as { content?: unknown }
      const c = m.content
      copy.message = {
        ...m,
        content: typeof c === 'string' ? `${tag}${c}` : [{ type: 'text', text: tag }, ...(Array.isArray(c) ? c : [])],
      }
    }
    rows.push(copy)
    parent = r.uuid
  }
  if (rows.length === 0) return undefined
  const inserts = [{ after, rows }]
  const job = jobOf(hidden, inserts)
  return (await rewrite($, f.file, t => edit(t, job, inserts))) ? job : undefined
}

/** mend the links of rows cc wrote since; true when the file is as it should be */
export async function repairSplices($: Api, sessionId: string, jobs: readonly SpliceJob[]) {
  const src = await findTranscript($, sessionId)
  if (!src || jobs.length === 0) return false
  return rewrite($, `${src.folder}/${sessionId}.jsonl`, t => jobs.reduce((acc, j) => edit(acc, j, []) ?? acc, t))
}
