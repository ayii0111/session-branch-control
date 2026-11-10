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
