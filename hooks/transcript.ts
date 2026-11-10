import type { BranchNode } from '../types'
import type { Api } from './graph'

// Writes a heavy branch's transcript file before the session is opened, so the
// light branch's questions and answers are ordinary, visible turns in it.
//
// It does what `claude --resume <parent> --fork-session` does (copy the
// metadata rows and the message chain from the last compact boundary to the
// leaf, same uuids, sessionId rewritten), then adds one user + assistant pair
// per answered node. The file format is cc's own and undocumented: any failure
// returns false and the caller falls back to the fork-session path.
//
// NB: every helper that takes `$` is a function declaration: past an import
// the engine follows `$` only into those.

type Row = Record<string, unknown> & {
  type?: string
  uuid?: string
  parentUuid?: string | null
  isSidechain?: boolean
  messageId?: string
  message?: unknown
  isMeta?: boolean
  isCompactSummary?: boolean
  logicalParentUuid?: string | null
}

const META = ['ai-title', 'mode', 'permission-mode', 'session-owner', 'atis-latch']
const CHAIN = ['user', 'assistant', 'system', 'attachment']

/** cc keeps a session at ~/.claude/projects/<its folder, each non-alphanumeric as '-'>/<id>.jsonl */
async function findTranscript($: Api, sessionId: string) {
  const home = (await $.env.get('HOME')) ?? ''
  const dirs = new Set([await $.session.root(), await $.session.cwd()])
  for (const dir of dirs) {
    const folder = `${home}/.claude/projects/${dir.replace(/[^A-Za-z0-9]/g, '-')}`
    try {
      return { folder, text: await $.fs.read(`${folder}/${sessionId}.jsonl`) }
    } catch {}
  }
  return undefined
}

/** whether cc still keeps `sessionId`'s transcript (deleted sessions drop off the map) */
export async function sessionExists($: Api, sessionId: string) {
  const home = (await $.env.get('HOME')) ?? ''
  const dirs = new Set([await $.session.root(), await $.session.cwd()])
  for (const dir of dirs) {
    if (await $.fs.exists(`${home}/.claude/projects/${dir.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`)) return true
  }
  return false
}

/**
 * Where each message of the live conversation stands: the prompt it belongs to
 * (1 = the person's first prompt). Counted along the path from the newest row
 * back to the first, through compactions (a boundary's `logicalParentUuid`
 * leads on into the rows it summarized, which the file keeps), so the count
 * never restarts; rows a rewind left behind are not on the path.
 */
export type PromptIndex = {
  /** message uuid → the prompt it belongs to */
  turnOf: Map<string, number>
  /** message uuid → its place along the conversation (0 = first) */
  order: Map<string, number>
  /** the prompts so far */
  total: number
  /** the newest row's uuid: what a branch opened now stands on */
  leaf: string | undefined
}

/** a prompt the person typed: no tool result, no command echo, reminder or compaction summary */
const isPrompt = (r: Row) => {
  if (r.type !== 'user' || r.isSidechain === true || r.isMeta === true || r.isCompactSummary === true) return false
  const c = (r.message as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return c.trimStart() !== '' && !c.trimStart().startsWith('<')
  if (!Array.isArray(c) || c.length === 0) return false
  const blocks = c as { type?: string; text?: string }[]
  if (blocks.some(b => b?.type === 'tool_result')) return false
  const text = blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join('').trimStart()
  return text === '' ? blocks.some(b => b?.type !== 'text') : !text.startsWith('<')
}

export async function promptIndex($: Api, sessionId: string): Promise<PromptIndex | undefined> {
  const src = await findTranscript($, sessionId)
  if (!src) return undefined
  const byUuid = new Map<string, Row>()
  let leaf: Row | undefined
  for (const r of parseRows(src.text)) {
    if (typeof r.uuid !== 'string' || r.isSidechain === true || !CHAIN.includes(r.type ?? '')) continue
    byUuid.set(r.uuid, r)
    leaf = r
  }
  const path: Row[] = []
  const onPath = new Set<string>()
  for (let r = leaf; r?.uuid && !onPath.has(r.uuid); ) {
    onPath.add(r.uuid)
    path.push(r)
    const up = r.parentUuid ?? (typeof r.logicalParentUuid === 'string' ? r.logicalParentUuid : null)
    r = up ? byUuid.get(up) : undefined
  }
  path.reverse()
  const turnOf = new Map<string, number>()
  const order = new Map<string, number>()
  let total = 0
  path.forEach((r, i) => {
    if (isPrompt(r)) total++
    turnOf.set(r.uuid!, total)
    order.set(r.uuid!, i)
  })
  return { turnOf, order, total, leaf: leaf?.uuid }
}

/** the last `"type":"<type>"` row's `field` in a transcript's text */
const lastField = (text: string, type: string, field: string) => {
  const at = text.lastIndexOf(`"type":"${type}"`)
  if (at < 0) return undefined
  const start = text.lastIndexOf('\n', at) + 1
  const end = text.indexOf('\n', at)
  try {
    const v = (JSON.parse(text.slice(start, end < 0 ? undefined : end)) as Record<string, unknown>)[field]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * The name cc shows for `sessionId`: the one the person gave it (/rename),
 * else cc's own summary title. Unlike a first prompt, neither moves on compaction.
 */
export async function sessionName($: Api, sessionId: string) {
  const src = await findTranscript($, sessionId)
  if (!src) return undefined
  return lastField(src.text, 'custom-title', 'customTitle') ?? lastField(src.text, 'ai-title', 'aiTitle')
}

/**
 * Every session id cc keeps a transcript for, across all projects (the
 * light-branch store is one for every project). Undefined when the folders
 * cannot be listed: then nothing may be judged gone.
 */
export async function allSessionIds($: Api): Promise<Set<string> | undefined> {
  const root = `${(await $.env.get('HOME')) ?? ''}/.claude/projects`
  try {
    const ids = new Set<string>()
    for (const dir of await $.fs.list(root)) {
      if (dir.kind !== 'dir') continue
      for (const f of await $.fs.list(`${root}/${dir.name}`)) {
        if (f.kind === 'file' && f.name.endsWith('.jsonl')) ids.add(f.name.slice(0, -'.jsonl'.length))
      }
    }
    return ids.size > 0 ? ids : undefined
  } catch {
    return undefined
  }
}

/** delete `sessionId`'s transcript and its side folder (subagents, tool results) for good */
export async function deleteSession($: Api, sessionId: string) {
  const home = (await $.env.get('HOME')) ?? ''
  const dirs = new Set([await $.session.root(), await $.session.cwd()])
  let removed = false
  for (const dir of dirs) {
    const base = `${home}/.claude/projects/${dir.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}`
    if (!(await $.fs.exists(`${base}.jsonl`))) continue
    const r = await $.process.run(['rm', '-rf', `${base}.jsonl`, base])
    if (r.exitCode === 0) removed = true
  }
  return removed
}

const parseRows = (text: string) => {
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line) as Row)
    } catch {}
  }
  return rows
}

/**
 * Write `<childId>.jsonl` beside the parent's: the parent's conversation, then
 * `chain` as visible turns. Returns false (nothing written) when it cannot.
 */
export async function writeBranchTranscript(
  $: Api,
  parentId: string,
  childId: string,
  title: string,
  chain: readonly BranchNode[],
): Promise<boolean> {
  if (chain.length === 0) return false
  const src = await findTranscript($, parentId)
  if (!src) return false
  const rows = parseRows(src.text)

  // the leaf: the last row of the main thread's chain
  const byUuid = new Map<string, Row>()
  let leaf: Row | undefined
  for (const r of rows) {
    if (typeof r.uuid !== 'string' || r.isSidechain === true || !CHAIN.includes(r.type ?? '')) continue
    byUuid.set(r.uuid, r)
    leaf = r
  }
  if (!leaf?.uuid) return false

  // leaf → back to the compact boundary (its parentUuid is null), as a fork copies
  const path: Row[] = []
  const onPath = new Set<string>()
  for (let r: Row | undefined = leaf; r?.uuid && !onPath.has(r.uuid); r = r.parentUuid ? byUuid.get(r.parentUuid) : undefined) {
    onPath.add(r.uuid)
    path.unshift(r)
  }

  const retag = (r: Row): Row => ({ ...r, sessionId: childId, ...('session_id' in r ? { session_id: childId } : {}) })
  const latest = new Map<string, Row>()
  for (const r of rows) if (r.type && META.includes(r.type)) latest.set(r.type, r)
  const snapshots = rows.filter(r => r.type === 'file-history-snapshot' && typeof r.messageId === 'string' && onPath.has(r.messageId))

  const env = [...path].reverse().find(r => r.type === 'user') ?? leaf
  const lastAssistant = [...path].reverse().find(r => r.type === 'assistant')
  const model = (lastAssistant?.message as { model?: string } | undefined)?.model ?? (await $.session.model())
  const at = new Date(await $.clock.now()).toISOString()
  const base = {
    isSidechain: false,
    userType: env.userType ?? 'external',
    entrypoint: env.entrypoint ?? 'cli',
    cwd: env.cwd,
    version: env.version,
    gitBranch: env.gitBranch,
    sessionId: childId,
  }

  const added: Row[] = []
  let parent = leaf.uuid
  for (const n of chain) {
    const userUuid = crypto.randomUUID()
    const replyUuid = crypto.randomUUID()
    added.push({
      parentUuid: parent,
      ...base,
      type: 'user',
      message: { role: 'user', content: `${n.kind === 'q' ? '【支線追問】' : '【支線假設】'}${n.text}` },
      uuid: userUuid,
      timestamp: at,
      origin: { kind: 'human' },
      promptSource: 'typed',
    })
    added.push({
      parentUuid: userUuid,
      ...base,
      type: 'assistant',
      message: {
        model,
        id: `msg_sbc_${replyUuid.replace(/-/g, '')}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: n.answer }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      uuid: replyUuid,
      timestamp: at,
    })
    parent = replyUuid
  }

  const out: Row[] = [
    { type: 'custom-title', customTitle: title, sessionId: childId },
    { type: 'agent-name', agentName: title, sessionId: childId },
    ...[...latest.values()].map(retag),
    ...snapshots,
    ...path.map(retag),
    ...added,
    { type: 'last-prompt', lastPrompt: chain.at(-1)?.text ?? title, leafUuid: parent, sessionId: childId },
  ]
  await $.fs.write(`${src.folder}/${childId}.jsonl`, `${out.map(r => JSON.stringify(r)).join('\n')}\n`)
  return true
}
