import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BranchKind, BranchNode, Graph, MergeJob, MergeRow, Reader, SessionEntry } from '../types'
import {
  type Api,
  MAP_COLLAPSED_KEY,
  ensureEntry,
  familyOf,
  flattenFamily,
  listTabs,
  mutateGraph,
  openTab,
  ownTab,
  readGraph,
  switchTab,
  titleOfCurrent,
} from './graph'
import { planMerge } from './merge'
import { type PromptIndex, allSessionIds, deleteSession, promptIndex, sessionExists, sessionName, writeBranchTranscript } from './transcript'

const graphAtom = atom({ plugin: 'session-branch-control', key: 'graph' } as const, { sessions: {}, pending: {} } as Graph, {
  shape: 'graph-1',
})
const currentIdAtom = atom({ plugin: 'session-branch-control', key: 'currentId' } as const, '')
const liveTabsAtom = atom({ plugin: 'session-branch-control', key: 'liveTabs' } as const, [] as string[])
const mapCollapsedAtom = atom({ plugin: 'session-branch-control', key: 'mapCollapsed' } as const, false)
const mapSelectedAtom = atom({ plugin: 'session-branch-control', key: 'mapSelected' } as const, null as string | null)
const lightCollapsedAtom = atom({ plugin: 'session-branch-control', key: 'lightCollapsed' } as const, false)
/** the light-branch section folded, kept across sessions like the map's */
const LIGHT_COLLAPSED_KEY = 'pref:lightCollapsed'
/** the light branch last opened in the reader, marked in the sidebar */
const recentAtom = atom({ plugin: 'session-branch-control', key: 'recent' } as const, null as string | null)
/** each family session's name in cc (/rename, else cc's summary title), by session id */
const namesAtom = atom({ plugin: 'session-branch-control', key: 'names' } as const, {} as Record<string, string>, {
  shape: 'names-1',
})
/** the heavy branch waiting on the delete dialog */
/** 📍 where the person reads: the prompt the topmost message on screen belongs to, of how many */
const viewAtom = atom({ plugin: 'session-branch-control', key: 'view' } as const, null as { at: number; total: number } | null, {
  shape: 'view-1',
})
/** branches whose context a rewind took out of the conversation (theirs or an ancestor's) */
const rewoundAtom = atom({ plugin: 'session-branch-control', key: 'rewound' } as const, [] as string[])
const confirmAtom = atom({ plugin: 'session-branch-control', key: 'confirm' } as const, null as { id: string; name: string } | null, {
  shape: 'confirm-1',
})
const CONFIRM = 'sbc-confirm'

/** change the shared map file and redraw from what was written */
const mutate = async ($: Api, fn: (g: Graph) => void) => {
  const g = await mutateGraph($, fn)
  await update($, graphAtom, () => g)
  return g
}

const PANE = 'session-branch-control'
const TITLE = '🌳 脈絡樹'

const nodesAtom = atom({ plugin: 'session-branch-control', key: 'nodes' } as const, [] as BranchNode[], {
  shape: 'nodes-1',
})
const selectedAtom = atom({ plugin: 'session-branch-control', key: 'selected' } as const, null as string | null)
const openAtom = atom({ plugin: 'session-branch-control', key: 'isOpen' } as const, false)
const READER0: Reader = { node: null, rows: {}, open: [], back: null }
const ROW_PREFIX = 'reader-'
const rowOf = (nodeId: string) => `${ROW_PREFIX}${nodeId}`
const readerAtom = atom({ plugin: 'session-branch-control', key: 'reader' } as const, READER0)

const storeKey = (sessionId: string) => `tree:${sessionId}`
/** the person's last choice, kept across sessions: start collapsed or not */
const COLLAPSED_KEY = 'pref:collapsed'

const openPane = async ($: Api, focus = false) => {
  const r = await $.ui.open(focus ? { id: PANE, title: TITLE, focus: true } : { id: PANE, title: TITLE })
  await update($, openAtom, () => r.isPlaced)
  await $.store.set(COLLAPSED_KEY, false)
}

const closePane = async ($: Api) => {
  await $.store.set(COLLAPSED_KEY, true)
  await $.ui.close({ id: PANE })
  await update($, openAtom, () => false)
}

const togglePane = async ($: Api) => {
  const isUp = (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
  if (isUp) await closePane($)
  else await openPane($)
  return !isUp
}

/**
 * terminal cells a string takes: wide (CJK, full-width, emoji) count two, and
 * so do symbols whose width fonts disagree on (arrows, ⑂, ●, ▶): counted
 * wide, a row is cut a little short rather than wrapped
 */
const charCells = (cp: number) =>
  (cp >= 0x2190 && cp <= 0x24ff) ||
  (cp >= 0x25a0 && cp <= 0x2bff) ||
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)
    ? 2
    : 1
const cells = (s: string) => {
  let w = 0
  for (const ch of s) w += charCells(ch.codePointAt(0) ?? 0)
  return w
}
/** cut to at most `max` cells, ending in … when cut */
const cut = (s: string, max: number) => {
  if (cells(s) <= max) return s
  let w = 0
  let out = ''
  for (const ch of s) {
    const c = charCells(ch.codePointAt(0) ?? 0)
    if (w + c > max - 1) break
    out += ch
    w += c
  }
  return `${out}…`
}

const newId = () =>`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** root → node, inclusive */
const chainOf = (nodes: readonly BranchNode[], id: string | null): BranchNode[] => {
  const out: BranchNode[] = []
  let cur = id ? nodes.find(n => n.id === id) : undefined
  while (cur) {
    out.unshift(cur)
    const pid = cur.parentId
    cur = pid ? nodes.find(n => n.id === pid) : undefined
  }
  return out
}

const descendantsOf = (nodes: readonly BranchNode[], id: string): Set<string> => {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const n of nodes) {
      if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
        out.add(n.id)
        grew = true
      }
    }
  }
  return out
}

// /wi was folded into /q: `wi` stays a kind only so branches saved before still read
const KIND_RULE: Record<BranchKind, string> = {
  q:
    '類型：旁支追問。若是在問主線中出現、用戶不熟的概念，用白話解釋它是什麼，並點出它在目前主線脈絡裡扮演什麼角色；' +
    '若是在問「如果換成某個情境或前提會怎樣」，就推演主線先前的論述哪些仍成立、哪些會翻轉、關鍵原因是什麼。',
  wi: '類型：假設推演。用戶想知道「若換成下列情境或前提」，主線先前的論述與後續推論會怎麼變：哪些結論仍成立、哪些會翻轉、關鍵原因是什麼。',
}

const buildPrompt = (kind: BranchKind, text: string, chain: readonly BranchNode[]) => {
  const history = chain
    .filter(n => n.status === 'done')
    .map(n => `${n.kind === 'q' ? '問' : '假設'}：${n.text}\n答：${n.answer}`)
    .join('\n\n')
  return [
    '【旁支提問｜這次回答只會顯示在用戶的支線閱讀區，不會進入主線對話】',
    '規則：你在這裡沒有任何工具可用，請直接根據既有對話脈絡立刻回答，不需要長考。用繁體中文，精簡（約 150–400 字），可用 Markdown。',
    KIND_RULE[kind],
    history ? `這條支線先前的問答（請延續它）：\n${history}` : '',
    `本次${kind === 'q' ? '問題' : '假設'}：${text}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The one record format a light branch is written back into a session's
 * history with: merge-back and upgrade-to-heavy-branch both use it.
 */
const toRecord = (chain: readonly BranchNode[], purpose: 'merge' | 'upgrade') =>
  [
    `<side-branch from-turn="${chain[0]?.turn ?? 0}" nodes="${chain.length}" purpose="${purpose}">`,
    purpose === 'merge'
      ? '以下是用戶在側邊支線中，帶著本對話脈絡另外問過的問答（當時沒有寫進主線）。用戶決定把它併回主線：請把其中的結論視為已知背景，之後的工作要納入考量；不需要逐條回覆。'
      : '這個 session 是從主線分出來的「重支線」。以下是分出來之前，用戶在側邊支線裡已經問過的問答：這條重支線就是要接著這個方向，用完整的工具能力深入下去。請把它當作本支線的起點與背景；不需要逐條回覆，等用戶下一個指示。',
    ...chain.map(
      (n, i) =>
        `<turn index="${i + 1}" kind="${n.kind === 'q' ? 'concept' : 'what-if'}" main-turn="${n.turn}">\n` +
        `<ask>${n.text}</ask>\n<answer>${n.answer}</answer>\n</turn>`,
    ),
    '</side-branch>',
  ].join('\n')

const flatten = (nodes: readonly BranchNode[]) => {
  const rows: { node: BranchNode; prefix: string }[] = []
  const walk = (parentId: string | null, indent: string) => {
    // newest first, at every level
    const kids = nodes.filter(n => n.parentId === parentId).sort((a, b) => b.at - a.at)
    kids.forEach((node, i) => {
      const last = i === kids.length - 1
      rows.push({ node, prefix: `${indent}${last ? '└ ' : '├ '}` })
      walk(node.id, `${indent}${last ? '  ' : '│ '}`)
    })
  }
  walk(null, '')
  return rows
}

const persist = async ($: Api) => {
  const id = await $.session.id()
  const nodes = await read($, nodesAtom)
  await $.store.set(storeKey(id), nodes)
}

const loadFor = async ($: Api) => {
  const id = await $.session.id()
  const saved = await $.store.get(storeKey(id))
  const nodes = Array.isArray(saved) ? (saved as BranchNode[]) : []
  // a fork cut off by a restart never finishes: mark it
  const fixed = nodes.map(n => (n.status === 'pending' ? { ...n, status: 'error' as const, answer: '（中斷：session 重啟時尚未回答）' } : n))
  await update($, nodesAtom, () => fixed)
  await update($, selectedAtom, () => null)
  // placed rows do not survive a resume or /clear
  await update($, readerAtom, () => READER0)
  // another conversation: its own prompt numbers
  index = undefined
  indexedAt = -Infinity
  seen.clear()
  await update($, viewAtom, () => null)
  await update($, rewoundAtom, () => [])
  await refreshIndex($, true)
}

// ---- reader: a full-width row placed in the transcript -----------------------

/**
 * What the transcript has on screen, learned from pass-through render hooks
 * on its messages: `n` is the order a message was first drawn in.
 */
type Seen = { n: number; on: { first: number; last: number; of: number } | null | undefined }
const seen = new Map<string, Seen>()
let seq = 0

/**
 * A transcript message's requestId is its uuid (the transcript file's): only
 * those are tracked. The prompt's empty-state row draws as a UserMessage
 * under `placeholder`, always on screen, and nothing scrolls to it.
 */
const isMessageId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id)

const track = (requestId: string, on: Seen['on']) => {
  if (!isMessageId(requestId)) return
  const s = seen.get(requestId)
  if (s) s.on = on
  else seen.set(requestId, { n: ++seq, on })
}

/**
 * Where to come back to: the earliest message whose head is in the viewport.
 * Scrolling it to the top lands within the few rows of the message above it
 * that showed, where the message cut at the top edge would land at its own
 * head, possibly far above. One message filling the whole viewport (no head
 * showing) is the only answer then.
 */
const topVisible = () => {
  let head: [string, Seen] | undefined
  let cut: [string, Seen] | undefined
  for (const entry of seen) {
    const on = entry[1].on
    if (!on) continue
    if (on.first === 0) {
      if (!head || rank(entry) < rank(head)) head = entry
    } else if (!cut || rank(entry) < rank(cut)) cut = entry
  }
  return (head ?? cut)?.[0] ?? null
}

// ---- where the person reads: prompt numbers from the transcript file ---------

/** the live conversation's prompt numbers, read from the transcript file */
let index: PromptIndex | undefined
let indexedAt = -Infinity
let indexing: Promise<void> | undefined
/** re-read the file at most this often for messages it did not have yet */
const INDEX_EVERY_MS = 5_000

/**
 * A message's place in the conversation: its place along the file's path,
 * else (not written yet) after every known one, in the order it was drawn.
 * Draw order alone misleads once older messages are drawn on scrolling up.
 */
const rank = ([id, s]: [string, Seen]) => index?.order.get(id) ?? 1e9 + s.n

const refreshIndex = async ($: Api, force = false) => {
  const now = await $.clock.now()
  if (!force && now - indexedAt < INDEX_EVERY_MS) return
  if (indexing) return indexing
  indexedAt = now
  indexing = (async () => {
    try {
      index = (await promptIndex($, await $.session.id())) ?? index
    } catch {}
  })()
  await indexing
  indexing = undefined
  await syncRewound($)
}

/**
 * A branch stands on the row that was newest when it was asked. Once that row
 * is off the conversation's path (a rewind went back past it), the main
 * thread no longer holds what the answer drew on, and neither does a
 * follow-up under it.
 */
const syncRewound = async ($: Api) => {
  if (!index) return
  const nodes = await read($, nodesAtom)
  const own = new Set(nodes.filter(n => n.anchor && !index!.order.has(n.anchor)).map(n => n.id))
  const ids = nodes.filter(n => chainOf(nodes, n.id).some(c => own.has(c.id))).map(n => n.id)
  const prev = await read($, rewoundAtom)
  if (prev.join() !== ids.join()) await update($, rewoundAtom, () => ids)
}

/**
 * Drawing is pure (no state written while a render is dispatched): the
 * render hooks only queue 📍's update, once per burst of draws.
 */
let viewQueued = false
const queueView = ($: Api) => {
  if (viewQueued) return
  viewQueued = true
  $.clock.after(50, () => {
    viewQueued = false
    void syncView($)
  })
}

/** the prompt count right now, for a new branch's #n (the same count 📍 shows) */
const promptsNow = async ($: Api) => {
  await refreshIndex($, true)
  return index?.total ?? (await $.session.turns())
}

/**
 * 📍 the prompt the topmost message on screen belongs to, of how many: kept
 * while only reader rows are on screen, re-read when the file is behind.
 */
const syncView = async ($: Api) => {
  const shown = [...seen].filter(([, s]) => s.on)
  if (shown.length === 0) return
  const known = shown.filter(([id]) => index?.turnOf.has(id))
  if (known.length < shown.length) {
    // messages the file did not have when read: read it again (now, when none is known)
    await refreshIndex($, known.length === 0)
  }
  if (!index) return
  const top = shown.filter(([id]) => index!.turnOf.has(id)).sort((a, b) => rank(a) - rank(b))[0]
  if (!top) return
  const view = { at: index.turnOf.get(top[0])!, total: index.total }
  const prev = await read($, viewAtom)
  if (prev?.at !== view.at || prev?.total !== view.total) await update($, viewAtom, () => view)
}

/**
 * How a reader row is opened:
 * - `here`: where the person already is (a fresh /q, unfolding in place): no scroll
 * - `jump`: from elsewhere (the sidebar, /r): remember where they read, scroll to the row
 * - `follow`: from inside a reader row (a breadcrumb, a follow-up): scroll, the
 *   place they first came from stays the one to go back to
 */
type OpenMode = 'here' | 'jump' | 'follow'

/**
 * Expand `nodeId`'s reading row. Each branch has its own row, standing where
 * it was asked: the engine answers the same id with the row that stands, and
 * places a new one at the transcript's end only when that row is gone (a
 * resume, /clear or a compaction ended it). Scrolling only works from the
 * person's own press or command.
 */
const openReader = async ($: Api, nodeId: string, mode: OpenMode) => {
  await update($, recentAtom, () => nodeId)
  const r = await read($, readerAtom)
  const back = mode === 'here' ? null : mode === 'follow' ? r.back : (topVisible() ?? null)
  await update($, readerAtom, v => ({ ...v, node: nodeId, open: v.open.includes(nodeId) ? v.open : [...v.open, nodeId], back }))
  const p = await $.ui.place({ id: rowOf(nodeId) })
  const req = p.requestId
  if (req) await update($, readerAtom, v => ({ ...v, rows: { ...v.rows, [nodeId]: req } }))
  if (mode !== 'here') await trace($, `openReader ${mode} node=${nodeId} req=${req} prev=${r.rows[nodeId] ?? '-'} back=${back} ${seenSummary()}`)
  if (mode !== 'here' && req) await scrollTo($, req, 'to-reader')
}

/** bring a transcript row to the viewport's top; a refusal is told, never thrown */
const scrollTo = async ($: Api, requestId: string, why0 = '') => {
  let why: string | undefined
  try {
    why = (await $.ui.scroll({ to: { requestId }, block: 'start' })).deny
  } catch (err) {
    why = String((err as Error)?.message ?? err)
  }
  await trace($, `scroll ${why0} → ${requestId}: ${why ? `DENY ${why}` : 'ok'}`)
  if (!why) return
  // every refusal goes to the debug log; the person hears each kind once
  $.ui.log(`scroll to ${requestId} refused: ${why}`, { to: 'debug' })
  if (scrollDenied.has(why)) return
  scrollDenied.add(why)
  $.ui.toast(`閱讀區沒辦法捲動（${why}）`)
}
const scrollDenied = new Set<string>()

/** back to the message that was at the top before the reader was jumped to */
const goBack = async ($: Api) => {
  const back = (await read($, readerAtom)).back
  await trace($, `goBack back=${back}`)
  if (back) await scrollTo($, back, 'back')
}

/**
 * Diagnostics while the scroll behaviour is being verified on a real
 * terminal: one line per step into ~/.claude/session-branch-control/trace.log
 * (the last 200 lines kept). Never throws.
 */
const trace = async ($: Api, line: string) => {
  try {
    const path = `${(await $.env.get('HOME')) ?? '/tmp'}/.claude/session-branch-control/trace.log`
    let old = ''
    try {
      old = await $.fs.read(path)
    } catch {}
    const at = new Date(await $.clock.now()).toISOString().slice(11, 19)
    const lines = `${old}${at} ${line}\n`.split('\n').filter(Boolean).slice(-200)
    await $.fs.write(path, `${lines.join('\n')}\n`)
  } catch {}
}

/** what the transcript tracking holds right now, for the trace */
const seenSummary = () => {
  const showing = [...seen].filter(([, s]) => s.on).map(([id, s]) => `${id.slice(0, 8)}#${s.n}[${s.on!.first}-${s.on!.last}/${s.on!.of}]`)
  return `seen=${seen.size} showing=${showing.length} ${showing.slice(0, 8).join(' ')}`
}

/** whether the branch the reader controls act on is expanded */
const focusOpen = (r: Reader) => r.node !== null && r.open.includes(r.node)

/** fold `nodeId`'s row (default: the focused one) to one line in place, and go back to where the person was */
const foldReader = async ($: Api, nodeId?: string) => {
  const r = await read($, readerAtom)
  const id = nodeId ?? r.node
  if (!id) return
  await update($, readerAtom, v => ({ ...v, open: v.open.filter(o => o !== id) }))
  if (id === r.node) await goBack($)
}

/** /r and the 📖 buttons: fold the focused row, else open the selected (or focused, or latest) branch */
const toggleReader = async ($: Api) => {
  const r = await read($, readerAtom)
  if (focusOpen(r)) {
    await foldReader($)
    return false
  }
  const nodes = await read($, nodesAtom)
  const sel = await read($, selectedAtom)
  const target = (sel && nodes.some(n => n.id === sel) ? sel : null) ?? (r.node && nodes.some(n => n.id === r.node) ? r.node : null) ?? nodes.at(-1)?.id
  if (!target) return null
  await update($, selectedAtom, () => target)
  await openReader($, target, 'jump')
  return true
}

const mergeBack = async ($: Api, id: string) => {
  const chain = chainOf(await read($, nodesAtom), id).filter(n => n.status === 'done')
  if (chain.length === 0) return
  try {
    // a hidden user row at the end: the main agent reads it next turn,
    // no turn is started and nothing already sent changes (cache kept)
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: toRecord(chain, 'merge') }] } })
    await update($, nodesAtom, list => list.map(n => (chain.some(c => c.id === n.id) ? { ...n, merged: true } : n)))
    await persist($)
    $.ui.toast(`已把 ${chain.length} 段支線問答併回主線，主線下一輪就會讀到`)
  } catch (err) {
    $.ui.toast(`併回失敗：${String((err as Error)?.message ?? err)}`)
  }
}

const upgradeNode = async ($: Api, id: string, where: 'here' | 'tab') => {
  const spec = await upgradeSpec($, id)
  if (!spec) {
    $.ui.toast('這條支線還沒有完成的回答，不能升級')
    return
  }
  // already upgraded into a session that still exists: go there, no duplicate
  const done = (await read($, nodesAtom)).find(n => n.id === id)?.upgradedTo
  if (done && (await sessionExists($, done))) {
    $.ui.toast('這條已經升級過了，直接帶你到那個重分支')
    if (where === 'here') await switchHere($, done)
    else await openInTab($, done)
    return
  }
  // first choice: write the child's transcript with the branch as real turns;
  // cc's own fork (record hidden, shown in the reader) when that cannot be done
  if (await upgradeWritten($, id, spec, where)) return
  if (where === 'here') await forkHere($, spec)
  else await forkToTab($, await $.session.id(), spec)
}

/**
 * Upgrade by writing the child session's transcript first: the branch's
 * questions and answers are ordinary turns in it, visible and kept, then
 * open it (`/resume` here, or `claude --resume` in a new tab).
 */
const upgradeWritten = async ($: Api, nodeId: string, spec: ForkSpec, where: 'here' | 'tab') => {
  const parentId = await $.session.id()
  const chain = chainOf(await read($, nodesAtom), nodeId).filter(n => n.status === 'done')
  const child = crypto.randomUUID()
  let ok = false
  try {
    ok = await writeBranchTranscript($, parentId, child, spec.title, chain)
  } catch (err) {
    $.ui.log(`writing the branch transcript failed: ${String((err as Error)?.message ?? err)}`, { to: 'debug' })
  }
  if (!ok) return false
  const now = await $.clock.now()
  const parentTitle = await titleOfCurrent($)
  await mutate($, g => {
    ensureEntry(g, parentId, parentTitle, now)
    g.sessions[child] = { id: child, title: spec.title, parentId, fromTurn: spec.fromTurn, createdAt: now, fromBranch: nodeId }
  })
  await seedChild($, child, parentId, nodeId)
  await markUpgraded($, parentId, nodeId, child)
  if (where === 'tab') {
    const handle = await openTab($, `⑂ ${spec.title}`, ['--resume', child])
    if (handle) {
      await mutate($, g => {
        const s = g.sessions[child]
        if (s) s.tab = handle
      })
    }
    await syncSelf($)
  } else {
    $.ui.toast(`原地切到重支線：${spec.title}`)
    await $.command.run({ command: 'resume', args: child })
  }
  return true
}

/**
 * Gone as if never asked: the node and every follow-up under it leave the
 * tree, the reader and the marks. A heavy branch upgraded from one of them is
 * a session of its own and stays.
 */
const removeNode = async ($: Api, id: string) => {
  const all = await read($, nodesAtom)
  const gone = descendantsOf(all, id)
  const target = all.find(n => n.id === id)
  await update($, nodesAtom, list => list.filter(n => !gone.has(n.id)))
  await update($, selectedAtom, s => (s && gone.has(s) ? (target?.parentId ?? null) : s))
  await update($, recentAtom, v => (v && gone.has(v) ? null : v))
  // their rows draw nothing from now on
  await update($, readerAtom, v => ({
    ...v,
    node: v.node && gone.has(v.node) ? null : v.node,
    open: v.open.filter(o => !gone.has(o)),
    back: v.node && gone.has(v.node) ? null : v.back,
  }))
  await persist($)
}

/** ↳ follow up on `id`: it becomes /qf's target, the prompt is primed */
const followUp = async ($: Api, id: string) => {
  await update($, selectedAtom, () => id)
  const filled = await $.prompt.fill({ text: '/qf ' }).catch(() => undefined)
  if (!filled?.isFilled) $.ui.toast('已選中這個節點：輸入 /qf <問題> 接著追問')
}

/** the branch /qf follows up on: the selected one, else the one last read */
const followTarget = async ($: Api) => {
  const nodes = await read($, nodesAtom)
  const sel = await read($, selectedAtom)
  const recent = await read($, recentAtom)
  return [sel, recent].find(id => id && nodes.some(n => n.id === id)) ?? null
}

/** `parentId` null: a question on the session itself (/q); else a follow-up under that branch (/qf) */
const ask = async ($: Api, kind: BranchKind, text: string, parentId: string | null) => {
  const nodes = await read($, nodesAtom)
  const chain = chainOf(nodes, parentId)
  const node: BranchNode = {
    id: newId(),
    kind,
    parentId,
    text,
    answer: '',
    status: 'pending',
    turn: await promptsNow($),
    at: await $.clock.now(),
    // the row it stands on (promptsNow just read the file)
    ...(index?.leaf ? { anchor: index.leaf } : {}),
  }
  await update($, nodesAtom, list => [...list, node])
  await update($, selectedAtom, () => node.id)
  await persist($)
  // the answer shows in the branch's own full-width row at the transcript's
  // end, where the person already is: no jump, nothing to come back to.
  // Detached from the command's dispatch: the row then lands under the
  // command's own echo (placed during the hook it would stand above it),
  // and a long answer is not cut off
  $.clock.after(0, () => {
    void (async () => {
      await openReader($, node.id, 'here')
      const prompt = buildPrompt(kind, text, chain)
      let r = await $.model.fork({ prompt })
      if (!r.isAnswered && r.reason === 'nothing-to-fork') {
        // this process has not sent the main thread yet (just resumed or
        // switched in place): answer from the saved transcript instead
        r = await answerFromTranscript($, prompt)
      }
      const patch: Partial<BranchNode> = r.isAnswered
        ? { status: 'done', answer: r.text }
        : { status: 'error', answer: `（沒有回答：${reasonText(r)}）` }
      await update($, nodesAtom, list => list.map(n => (n.id === node.id ? { ...n, ...patch } : n)))
      await persist($)
      if (r.isAnswered) $.ui.toast(`支線回答好了：${text.slice(0, 20)}`)
    })()
  })
}

/** the tail of the main thread, as plain text, at most `limit` characters */
const TRANSCRIPT_LIMIT = 60_000
const transcriptText = async ($: Api) => {
  const msgs = await $.session.messages()
  const parts: string[] = []
  let size = 0
  for (let i = msgs.length - 1; i >= 0 && size < TRANSCRIPT_LIMIT; i--) {
    const m = msgs[i]!
    const tools = m.toolUses.map(t => `[工具 ${t.tool}]`).join(' ')
    const body = [m.text.trim(), tools].filter(Boolean).join('\n')
    if (!body) continue
    const piece = `${m.role === 'user' ? '【用戶】' : '【助理】'}\n${body}`
    parts.unshift(piece.length > TRANSCRIPT_LIMIT - size ? piece.slice(-(TRANSCRIPT_LIMIT - size)) : piece)
    size += piece.length
  }
  return parts.join('\n\n')
}

const answerFromTranscript = async ($: Api, prompt: string) => {
  const history = await transcriptText($)
  if (!history) return { isAnswered: false as const, reason: 'nothing-to-fork' as const }
  return $.model.complete({
    model: await $.session.model(),
    system: '你在協助用戶理解他與 AI 助理的一段對話。下面先給對話紀錄（可能只有後段），再給用戶的旁支提問。',
    prompt: [
      { text: `<對話紀錄>\n${history}\n</對話紀錄>` },
      { text: prompt },
    ],
    maxTokens: 4096,
  })
}

const reasonText = (r: { reason: string; status?: number | null }) =>
  r.reason === 'nothing-to-fork'
    ? '主線還沒有對話內容可以參考'
    : r.reason === 'aborted'
      ? '被中斷了'
      : r.reason === 'empty-reply'
        ? '模型沒有回任何文字'
        : `${r.reason}${r.status ? ` ${r.status}` : ''}`

// ---- session map (B layer) ----------------------------------------------

const appendRecord = async ($: Api, text: string) => {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

/** write this process's tab into the map, take any record waiting for this session */
const syncSelf = async ($: Api) => {
  const id = await $.session.id()
  const tabs = await listTabs($)
  const mine = await ownTab($, tabs)
  let waiting: string | undefined
  await mutate($, g => {
    for (const s of Object.values(g.sessions)) {
      if (s.id !== id && mine && s.tab === mine) delete s.tab
    }
    const me = g.sessions[id]
    if (me) {
      if (mine) me.tab = mine
      else delete me.tab
    }
    waiting = g.pending[id]
    delete g.pending[id]
  })
  await update($, currentIdAtom, () => id)
  await update($, liveTabsAtom, () => tabs.filter(t => t.connected !== false).map(t => t.handle))
  if (waiting) {
    try {
      await appendRecord($, waiting)
      $.ui.toast('已把支線紀錄寫進這個重支線的歷史')
      await showInherited($)
    } catch (err) {
      $.ui.toast(`寫入支線紀錄失敗：${String((err as Error)?.message ?? err)}`)
    }
  }
}

/** the poll: other processes change the map too */
const refreshGraph = async ($: Api) => {
  const g = await readGraph($)
  const prev = await read($, graphAtom)
  if (JSON.stringify(prev) !== JSON.stringify(g)) await update($, graphAtom, () => g)
  const live = (await listTabs($)).filter(t => t.connected !== false).map(t => t.handle)
  const prevLive = await read($, liveTabsAtom)
  if (prevLive.join() !== live.join()) await update($, liveTabsAtom, () => live)
  await pruneMap($, g, live)
}

/** a session started this recently may not have written its transcript yet */
const PRUNE_GRACE_MS = 3 * 60_000
/** prune at most this often: one file check per session in the map */
const PRUNE_EVERY_MS = 60_000
let prunedAt = 0

/**
 * The map is the mod's own record; the sessions themselves are cc's. A session
 * whose transcript is gone (deleted, or a tab that never started it) leaves
 * the map: its children move up to its parent, a light branch upgraded into
 * it can be upgraded again. The current session, a young entry, and one open
 * in a live tab are kept.
 */
const pruneMap = async ($: Api, g: Graph, live: readonly string[], force = false) => {
  const now = await $.clock.now()
  if (!force && now - prunedAt < PRUNE_EVERY_MS) return
  prunedAt = now
  const cur = await $.session.id()
  await refreshNames($, g, cur)
  const gone: string[] = []
  for (const s of Object.values(g.sessions)) {
    if (s.id === cur || now - s.createdAt < PRUNE_GRACE_MS || (s.tab && live.includes(s.tab))) continue
    if (!(await sessionExists($, s.id))) gone.push(s.id)
  }
  if (gone.length === 0) return
  await mutate($, gg => {
    for (const id of gone) {
      const s = gg.sessions[id]
      if (!s) continue
      for (const o of Object.values(gg.sessions)) if (o.parentId === id) o.parentId = s.parentId
      delete gg.sessions[id]
      delete gg.pending[id]
    }
  })
  await update($, mapSelectedAtom, v => (v && gone.includes(v) ? null : v))
  // this session's light branches no longer point at a session that is gone
  const nodes = await read($, nodesAtom)
  if (nodes.some(n => n.upgradedTo && gone.includes(n.upgradedTo))) {
    await update($, nodesAtom, list => list.map(({ upgradedTo, ...n }) => (upgradedTo && gone.includes(upgradedTo) ? n : { ...n, ...(upgradedTo ? { upgradedTo } : {}) })))
    await persist($)
  }
}

/**
 * The light-branch store is one for every project: a session whose transcript
 * is gone everywhere (deleted with any tool) leaves its branches behind. Drop
 * them, sparing this session and one the map saw born within the grace
 * period (a child is seeded before cc writes its file).
 */
const pruneStore = async ($: Api) => {
  const keys = (await $.store.keys()).filter(k => k.startsWith('tree:'))
  if (keys.length === 0) return
  const alive = await allSessionIds($)
  if (!alive) return
  const cur = await $.session.id()
  const now = await $.clock.now()
  const g = await read($, graphAtom)
  for (const key of keys) {
    const id = key.slice('tree:'.length)
    const born = g.sessions[id]?.createdAt
    if (id === cur || alive.has(id) || (born !== undefined && now - born < PRUNE_GRACE_MS)) continue
    await $.store.delete(key)
  }
}

/** an in-place /branch this process asked for has landed: name the child, write its record */
const finishInplace = async ($: Api, oldId: string) => {
  const newSid = await $.session.id()
  const now = await $.clock.now()
  let job: Graph['inplace']
  await mutate($, g => {
    const ip = g.inplace
    if (!ip || ip.parentId !== oldId || newSid === oldId || now - ip.at > 120_000) return
    job = ip
    delete g.inplace
    g.sessions[newSid] = {
      id: newSid,
      title: ip.title,
      parentId: ip.parentId,
      fromTurn: ip.fromTurn,
      createdAt: now,
      ...(ip.fromBranch ? { fromBranch: ip.fromBranch } : {}),
    }
  })
  if (!job) return
  if (job.record) {
    try {
      await appendRecord($, job.record)
    } catch (err) {
      $.ui.toast(`寫入支線紀錄失敗：${String((err as Error)?.message ?? err)}`)
    }
  }
  if (job.fromBranch) {
    const chain = await seedChild($, newSid, job.parentId, job.fromBranch)
    await update($, nodesAtom, () => chain)
    await markUpgraded($, job.parentId, job.fromBranch, newSid)
    await showInherited($)
  }
  $.ui.toast(`已原地切到重支線：${job.title}`)
}

/**
 * Copy the upgraded branch (root → node, answered ones) into the child
 * session's own tree: the record in its history is hidden from the person,
 * so the tree and the reader are where they see what the branch started from.
 */
const seedChild = async ($: Api, childId: string, ownerSession: string, nodeId: string) => {
  const saved = await $.store.get(storeKey(ownerSession))
  if (!Array.isArray(saved)) return []
  const done = chainOf(saved as BranchNode[], nodeId).filter(n => n.status === 'done')
  const chain: BranchNode[] = done.map(({ upgradedTo: _u, ...n }, i) => ({
    ...n,
    parentId: i > 0 ? done[i - 1]!.id : null,
    inherited: true,
    merged: true,
  }))
  await $.store.set(storeKey(childId), chain)
  return chain
}

/** a child just started from an upgrade: show what it was asked in the reader */
const showInherited = async ($: Api) => {
  const last = (await read($, nodesAtom)).filter(n => n.inherited).at(-1)
  if (!last) return
  await update($, selectedAtom, () => last.id)
  // let the resumed history draw first, so the row lands after it
  $.clock.after(1500, () => {
    void (async () => {
      await openReader($, last.id, 'here')
    })()
  })
}

const markUpgraded = async ($: Api, ownerSession: string, nodeId: string, to: string) => {
  const saved = await $.store.get(storeKey(ownerSession))
  if (!Array.isArray(saved)) return
  const next = (saved as BranchNode[]).map(n => (n.id === nodeId ? { ...n, upgradedTo: to } : n))
  await $.store.set(storeKey(ownerSession), next)
  if ((await $.session.id()) === ownerSession) await update($, nodesAtom, () => next)
}

type ForkSpec = { title: string; record?: string; fromBranch?: string; fromTurn: number }

/** fork the current session in place (cc's /branch), finished in finishInplace */
const forkHere = async ($: Api, spec: ForkSpec) => {
  const parentId = await $.session.id()
  const parentTitle = await titleOfCurrent($)
  const now = await $.clock.now()
  await mutate($, g => {
    ensureEntry(g, parentId, parentTitle, now)
    g.inplace = {
      parentId,
      title: spec.title,
      fromTurn: spec.fromTurn,
      at: now,
      ...(spec.record ? { record: spec.record } : {}),
      ...(spec.fromBranch ? { fromBranch: spec.fromBranch } : {}),
    }
  })
  await $.command.run({ command: 'branch', args: spec.title })
}

/** fork session `fromId` into a new Orca tab under a known id */
const forkToTab = async ($: Api, fromId: string, spec: ForkSpec) => {
  const child = crypto.randomUUID()
  const now = await $.clock.now()
  const cur = await $.session.id()
  const curTitle = await titleOfCurrent($)
  await mutate($, g => {
    if (fromId === cur) ensureEntry(g, cur, curTitle, now)
    g.sessions[child] = {
      id: child,
      title: spec.title,
      parentId: fromId,
      fromTurn: spec.fromTurn,
      createdAt: now,
      ...(spec.fromBranch ? { fromBranch: spec.fromBranch } : {}),
    }
    if (spec.record) g.pending[child] = spec.record
  })
  // before the tab starts: the child loads its tree at its start
  if (spec.fromBranch) await seedChild($, child, fromId, spec.fromBranch)
  const handle = await openTab($, `⑂ ${spec.title}`, ['--resume', fromId, '--fork-session', '--session-id', child, '-n', spec.title])
  if (handle) {
    await mutate($, g => {
      const s = g.sessions[child]
      if (s) s.tab = handle
    })
  }
  if (spec.fromBranch && fromId === cur) await markUpgraded($, cur, spec.fromBranch, child)
  // the parent may have just joined the map: note which tab it is in
  await syncSelf($)
  return child
}

const upgradeSpec = async ($: Api, nodeId: string): Promise<ForkSpec | undefined> => {
  const nodes = await read($, nodesAtom)
  const chain = chainOf(nodes, nodeId).filter(n => n.status === 'done')
  const node = nodes.find(n => n.id === nodeId)
  if (!node || chain.length === 0) return undefined
  const t = node.text.replace(/\s+/g, ' ').trim()
  return {
    title: t.length > 28 ? `${t.slice(0, 28)}…` : t,
    record: toRecord(chain, 'upgrade'),
    fromBranch: nodeId,
    fromTurn: node.turn,
  }
}

const childTitle = (g: Graph, fromId: string) => {
  const base = g.sessions[fromId]?.title ?? '主線'
  const n = Object.values(g.sessions).filter(s => s.parentId === fromId).length + 1
  return `${base.slice(0, 16)} › 分支 ${n}`
}

/** switch this window to `id`; a session already open in another tab is brought up there instead */
const switchHere = async ($: Api, id: string) => {
  const g = await readGraph($)
  const tab = g.sessions[id]?.tab
  const live = await read($, liveTabsAtom)
  if (tab && live.includes(tab)) {
    $.ui.toast('它已經開在另一個分頁，直接幫你切過去（同一個 session 不要兩邊同時開）')
    await switchTab($, tab)
    return
  }
  await $.command.run({ command: 'resume', args: id })
}

const openInTab = async ($: Api, id: string) => {
  const g = await readGraph($)
  const entry = g.sessions[id]
  const live = await read($, liveTabsAtom)
  if (entry?.tab && live.includes(entry.tab)) {
    await switchTab($, entry.tab)
    return
  }
  const handle = await openTab($, entry?.title ?? id.slice(0, 8), ['--resume', id])
  if (handle) {
    await mutate($, gg => {
      const s = gg.sessions[id]
      if (s) s.tab = handle
    })
  }
}

const removeFromMap = async ($: Api, id: string) => {
  await mutate($, g => {
    const gone = g.sessions[id]
    if (!gone) return
    for (const s of Object.values(g.sessions)) if (s.parentId === id) s.parentId = gone.parentId
    delete g.sessions[id]
    delete g.pending[id]
  })
  await update($, mapSelectedAtom, () => null)
}

/** delete a heavy branch for real, its transcript included, once the person confirms */
const deleteHeavy = async ($: Api, id: string) => {
  const g = await read($, graphAtom)
  const entry = g.sessions[id]
  if (!entry) return
  const live = await read($, liveTabsAtom)
  if (entry.tab && live.includes(entry.tab)) {
    $.ui.toast('它還開在某個分頁裡：先關掉那個分頁再刪除')
    return
  }
  const name = (await read($, namesAtom))[id] ?? entry.title
  // the mod's own dialog, 確定 focused so Enter confirms (the engine's question
  // dialog may answer itself while the person is away: not for a delete)
  await update($, confirmAtom, () => ({ id, name }))
  await $.ui.open({ id: CONFIRM, title: '刪除 session', focus: true, closeOnEscape: true, holdToasts: true, rows: 6 })
}

const answerDelete = async ($: Api, yes: boolean) => {
  const job = await read($, confirmAtom)
  await update($, confirmAtom, () => null)
  await $.ui.close({ id: CONFIRM })
  if (!yes || !job) return
  const removed = await deleteSession($, job.id)
  await removeFromMap($, job.id)
  // its light branches go with it
  await $.store.delete(storeKey(job.id))
  $.ui.toast(removed ? `已刪除「${job.name.slice(0, 40)}」` : `找不到它的紀錄檔，只從地圖拿掉「${job.name.slice(0, 40)}」`)
}

// ---- merging another session into this one (hooks/merge.ts) -------------

const MERGE = 'sbc-merge'
const MERGE_ROW = 'merged-'
const mergeJobAtom = atom({ plugin: 'session-branch-control', key: 'mergeJob' } as const, null as MergeJob | null, {
  shape: 'merge-job-1',
})
const mergeRowsAtom = atom({ plugin: 'session-branch-control', key: 'mergeRows' } as const, {} as Record<string, MergeRow>, {
  shape: 'merge-rows-1',
})
/** the record waiting on the dialog, and each merge row's record: too big to keep in state */
let mergeText = ''
const mergeTexts = new Map<string, string>()
/** an unfolded merge row shows at most this much of its record */
const MERGE_SHOW_MAX = 30_000

/** ⤳ on the map: prime the prompt, the person presses Enter */
const fillMerge = async ($: Api, id: string) => {
  const filled = await $.prompt.fill({ text: `/merge ${id.slice(0, 8)}` }).catch(() => undefined)
  if (!filled?.isFilled) $.ui.toast(`輸入 /merge ${id.slice(0, 8)} 把它併入目前 session`)
}

/** /merge's argument: a session on the map, by its id or the start of it */
const resolveMergeArg = (g: Graph, arg: string): { id: string } | { error: string } => {
  const a = arg.trim().toLowerCase()
  if (!a) return { error: '用法：/merge <session id 前幾碼>：把地圖上那個 session 多出來的對話補進目前 session' }
  const hits = Object.keys(g.sessions).filter(id => id.toLowerCase().startsWith(a))
  if (hits.length === 1) return { id: hits[0]! }
  return { error: hits.length === 0 ? `地圖上找不到 ${a} 開頭的 session` : `有 ${hits.length} 個 session 以 ${a} 開頭：多打幾碼` }
}

/** compare the two sessions; a job for the dialog, or why there is none */
const prepareMerge = async ($: Api, fromId: string): Promise<MergeJob | string> => {
  const cur = await $.session.id()
  if (fromId === cur) return '不能把目前 session 併入它自己'
  const g = await readGraph($)
  const entry = g.sessions[fromId]
  if (!entry) return '它不在 session 地圖上'
  const name = (await read($, namesAtom))[fromId] ?? (await sessionName($, fromId)) ?? entry.title
  const plan = await planMerge($, fromId, cur, name, entry.mergedInto?.[cur]?.upto)
  if (plan === 'missing') return `讀不到「${name}」的紀錄檔`
  if (plan === 'empty') return `「${name}」沒有目前 session 還沒有的內容`
  mergeText = plan.text
  const live = await read($, liveTabsAtom)
  return {
    from: fromId,
    name,
    upto: plan.upto,
    prompts: plan.prompts,
    tools: plan.tools,
    preview: plan.preview,
    otherCwd: plan.otherCwd ?? null,
    trimmed: plan.trimmed,
    live: !!entry.tab && live.includes(entry.tab),
  }
}

const answerMerge = async ($: Api, yes: boolean) => {
  const job = await read($, mergeJobAtom)
  const text = mergeText
  mergeText = ''
  await update($, mergeJobAtom, () => null)
  await $.ui.close({ id: MERGE })
  if (!yes || !job || !text) return
  const cur = await $.session.id()
  try {
    // a hidden user row, as merge-back writes: read next turn, no reload
    await appendRecord($, text)
  } catch (err) {
    $.ui.toast(`併入失敗：${String((err as Error)?.message ?? err)}`)
    return
  }
  const at = await $.clock.now()
  await mutate($, g => {
    const s = g.sessions[job.from]
    if (!s) return
    const prev = s.mergedInto?.[cur]
    s.mergedInto = { ...s.mergedInto, [cur]: { upto: job.upto, at, prompts: (prev?.prompts ?? 0) + job.prompts } }
  })
  const rowId = `${MERGE_ROW}${job.from.slice(0, 8)}-${at.toString(36)}`
  mergeTexts.set(rowId, text)
  await update($, mergeRowsAtom, v => ({ ...v, [rowId]: { name: job.name, prompts: job.prompts, tools: job.tools, open: false } }))
  await $.ui.place({ id: rowId })
  $.ui.toast(`已把「${job.name.slice(0, 30)}」的 ${job.prompts} 次提問補進目前 session，下一輪就會讀到`)
}

/** what cc calls each session of the current family now */
const refreshNames = async ($: Api, g: Graph, cur: string) => {
  const names: Record<string, string> = {}
  for (const { s } of flattenFamily(g, cur)) {
    const n = await sessionName($, s.id)
    if (n) names[s.id] = n
  }
  const prev = await read($, namesAtom)
  if (JSON.stringify(prev) !== JSON.stringify(names)) await update($, namesAtom, () => names)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'q', description: '開輕分支：針對目前 session 追問概念或「如果改成…會怎樣」（答案只進閱讀區，不進主線）', argumentHint: '[問題]' })
    await $.command.register({ name: 'qf', description: '接著選中（或最後看過）的輕分支追問，帶著那條支線的問答', argumentHint: '[問題]' })
    await $.command.register({ name: 'tree', description: '打開脈絡樹面板並聚焦' })
    await $.command.register({ name: 't', description: '快速開合脈絡樹面板（對話進行中也能用）', immediate: true })
    await $.command.register({ name: 'r', description: '開合支線閱讀區（全寬顯示選中支線的問答；收合時捲回原處）', immediate: true })
    await $.command.register({ name: 'up', description: '把選中的輕支線升級成重支線，原地切過去' })
    await $.command.register({ name: 'up-tab', description: '把選中的輕支線升級成重支線，開在新分頁' })
    await $.command.register({ name: 'sub', description: '從目前 session 分出子 session，開在新分頁', argumentHint: '[標題]' })
    await $.command.register({ name: 'sub-here', description: '從目前 session 分出子 session，原地切過去', argumentHint: '[標題]' })
    await $.command.register({ name: 'map', description: '開合 Session 地圖區塊', immediate: true })
    await $.command.register({
      name: 'merge',
      description: '把地圖上另一個 session 多出來的對話（含工具呼叫）補進目前 session，對方保持原樣',
      argumentHint: '[session id 前幾碼]',
    })
    await loadFor($ as unknown as Api)
    await update($, mapCollapsedAtom, () => false)
    if ((await $.store.get(MAP_COLLAPSED_KEY)) === true) await update($, mapCollapsedAtom, () => true)
    await update($, lightCollapsedAtom, () => false)
    if ((await $.store.get(LIGHT_COLLAPSED_KEY)) === true) await update($, lightCollapsedAtom, () => true)
    await syncSelf($ as unknown as Api)
    // drop sessions deleted since the map last saw them, before drawing it
    await pruneMap($ as unknown as Api, await read($, graphAtom), await read($, liveTabsAtom), true)
    await pruneStore($ as unknown as Api)
    // open the tree only where it has something to show: a light branch of
    // this session's, or a session map with 2+ sessions in this family
    const hasBranches = (await read($, nodesAtom)).length > 0
    const hasFamily = familyOf(await read($, graphAtom), await read($, currentIdAtom)).length >= 2
    if ((hasBranches || hasFamily) && (await $.store.get(COLLAPSED_KEY)) !== true) {
      const r = await $.ui.open({ id: PANE, title: TITLE })
      await update($, openAtom, () => r.isPlaced)
    }
    $.clock.every(8000, () => {
      void refreshGraph($ as unknown as Api)
    })
    return next(e)
  })

  // the person closing it (its mark, ctrl+x x) counts as collapsing it
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) {
      await update($, openAtom, () => false)
      if (e.origin.kind === 'person') await $.store.set(COLLAPSED_KEY, true)
    }
    return r
  })

  on('command.run', { command: 't' }, async $ => {
    const isUp = await togglePane($)
    return { text: isUp ? '🌳 已展開' : '🌳 已收合（輸入框上方保留一行迷你列）' }
  })

  on('command.run', { command: 'r' }, async $ => {
    const opened = await toggleReader($)
    if (opened === null) return { text: '還沒有輕支線可以讀。先用 /q 開一條' }
    return { text: opened ? '📖 閱讀區已打開' : '📖 閱讀區已收合，捲回原處' }
  })

  // learn what the transcript has on screen, so the reader can come back to it
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    track(e.requestId, e.props.onScreen)
    queueView($ as unknown as Api)
    return next(e)
  })
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    track(e.requestId, e.props.onScreen)
    queueView($ as unknown as Api)
    return next(e)
  })

  // a branch's reading row: full width, as tall as the answer, where it was asked
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== 'session-branch-control' || !e.props.id.startsWith(ROW_PREFIX)) return next(e)
    const nodes = await read($, nodesAtom)
    const node = nodes.find(n => n.id === e.props.id.slice(ROW_PREFIX.length))
    // a deleted branch's row (or an older version's) draws nothing
    if (!node) return next(e)
    const r = await read($, readerAtom)
    const focused = r.node === node.id
    const rewound = (await read($, rewoundAtom)).includes(node.id)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    // an action that hands the answer on to a conversation that no longer has its
    // context: marked ⚠ in yellow while the branch is rewound
    const doubtful = (key: string, text: string, onPress: () => void) =>
      rewound ? (
        <Button key={key} onPress={onPress}>
          <Text color="yellow">{`⚠ ${text}`}</Text>
        </Button>
      ) : (
        <Button key={key} label={text} onPress={onPress} />
      )
    const icon = (n: BranchNode) => (n.kind === 'q' ? '?' : '⑂')
    const label = `${icon(node)} ${node.kind === 'q' ? '追問' : '假設'}：${node.text}`
    const fold = () => foldReader($ as unknown as Api, node.id)
    const back = () => goBack($ as unknown as Api)
    const showBack = focused && r.back !== null
    // another branch from inside this row: its own row, wherever it stands
    const show = (id: string) => () =>
      (async () => {
        await update($, selectedAtom, () => id)
        await openReader($ as unknown as Api, id, 'follow')
      })()

    if (!r.open.includes(node.id)) {
      return (
        <Box gap={1}>
          <Button key="unfold" plain label="[▸ 展開]" onPress={() => openReader($ as unknown as Api, node.id, 'here')} />
          <Text dimColor>📖</Text>
          {rewound && <Text color="yellow">↶</Text>}
          <Text wrap="truncate-end">{label}</Text>
        </Box>
      )
    }

    const chain = chainOf(nodes, node.id)
    const kids = nodes.filter(n => n.parentId === node.id)
    const vis = e.props.onScreen
    // the row's end is cut off by the viewport's bottom: float the controls
    // on the second-to-last row showing (the last holds the engine's own button)
    const floatAt = vis && vis.last >= 2 && vis.last < vis.of - 1 ? vis.last - 1 : null
    const status =
      node.status === 'pending' ? ' · 回答中…' : node.status === 'error' ? ' · ✗ 失敗' : ''
    const marks = `${node.inherited ? ' · ⇣ 從上層 session 升級帶來，已寫進這個 session 的歷史' : node.merged ? ' · ⤴ 已併回主線' : ''}${node.upgradedTo ? ' · ⇪ 已升級成重支線' : ''}`

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Button key="fold" plain label="[▴ 收合]" onPress={fold} />
          {showBack && <Button key="back" plain label="[↩ 回原處]" onPress={back} />}
          <Text dimColor>📖 支線閱讀區 · /r 開合</Text>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box flexWrap="wrap">
            <Button key="crumb-main" plain label="● 主線" onPress={() => (async () => {
              await update($, selectedAtom, () => null)
              await foldReader($ as unknown as Api, node.id)
            })()} />
            {chain.slice(0, -1).map(n => (
              <Box key={`c-${n.id}`}>
                <Text dimColor> › </Text>
                <Button key={`crumb-${n.id}`} plain label={`${icon(n)} ${n.text.slice(0, 24)}`} onPress={show(n.id)} />
              </Box>
            ))}
          </Box>
          <Text bold wrap="wrap">{label}</Text>
          <Text dimColor wrap="wrap">
            {`從主線第 ${node.turn} 輪分出 · /qf 會接在這個節點底下${status}${marks}`}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {node.status === 'pending' ? <Text dimColor>回答中…</Text> : <Markdown text={node.answer || '（空）'} />}
          </Box>
          {kids.length > 0 && (
            <Box flexWrap="wrap" gap={1} marginTop={1}>
              <Text dimColor>接續：</Text>
              {kids.map(k => (
                <Button key={`kid-${k.id}`} plain label={`${icon(k)} ${k.text.slice(0, 24)}`} onPress={show(k.id)} />
              ))}
            </Box>
          )}
          {rewound && (
            <Box marginTop={1}>
              <Text color="yellow" wrap="wrap">
                ↶ 這條支線的脈絡已被 rewind 退回：它回答時依據的對話，目前的主線已經看不到了。標 ⚠ 的動作會把它交給沒有這段脈絡的對話，結果可能接不上。
              </Text>
            </Box>
          )}
          <Box flexWrap="wrap" gap={1} marginTop={1}>
            {!node.inherited && doubtful('merge', '併回主線', () => void mergeBack($ as unknown as Api, node.id))}
            {doubtful('up-here', '⇪ 升級：原地', () => void upgradeNode($ as unknown as Api, node.id, 'here'))}
            {doubtful('up-tab', '⇪ 升級：新分頁', () => void upgradeNode($ as unknown as Api, node.id, 'tab'))}
            {doubtful('follow', '↳ 接著追問', () => void followUp($ as unknown as Api, node.id))}
            <Button key="del" label="刪除" onPress={() => removeNode($ as unknown as Api, node.id)} />
          </Box>
        </Box>
        <Box gap={1}>
          <Button key="fold2" plain label="[▴ 收合]" onPress={fold} />
          {showBack && <Button key="back2" plain label="[↩ 回原處]" onPress={back} />}
        </Box>
        {floatAt !== null && (
          <Box position="absolute" top={floatAt} right={0} gap={1}>
            {showBack && <Button key="back-float" plain label="[↩ 回原處]" onPress={back} />}
            <Button key="fold-float" plain label="[▴ 收合]" onPress={fold} />
          </Box>
        )}
      </Box>
    )
  })

  on('command.run', { command: 'map' }, async $ => {
    const now = !(await read($, mapCollapsedAtom))
    await update($, mapCollapsedAtom, () => now)
    await $.store.set(MAP_COLLAPSED_KEY, now)
    return { text: now ? '🗺 Session 地圖已收合' : '🗺 Session 地圖已展開' }
  })

  // collapsed: one line above the prompt, press to expand
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const isOpen = await read($, openAtom)
    const nodes = await read($, nodesAtom)
    const g = await read($, graphAtom)
    const cur = await read($, currentIdAtom)
    const fam = familyOf(g, cur).length
    if (isOpen || (nodes.length === 0 && fam < 2)) return next(e)
    const sel = await read($, selectedAtom)
    const reader = await read($, readerAtom)
    const recent = await read($, recentAtom)
    const readerOpen = focusOpen(reader)
    // the branch the reader holds (else the one last read, else the selected): its turn and question
    const shownId = [reader.node, recent, sel].find(id => id && nodes.some(n => n.id === id))
    const shown = shownId ? nodes.find(n => n.id === shownId) : undefined
    const { Box, Text, Button } = $.ui.resolve(e)
    const turn = shown ? `#${shown.turn} ` : ''
    const question = shown ? `${shown.text}${shown.status === 'pending' ? ' …' : ''}` : ''
    const treeLabel = '  [展開樹 /t]'
    const readerLabel = readerOpen ? '[📖 收合閱讀 /r]' : '[📖 閱讀 /r]'
    // 📍 the prompt the screen's top is in, of how many
    const view = await read($, viewAtom)
    const where = view ? `📍 ${view.at}/${view.total}  ` : ''
    // one row: size the free text by display width (CJK takes two cells)
    const room = e.props.bodyColumns - cells(where) - cells('🌳 ') - cells(turn) - cells(treeLabel) - (nodes.length > 0 ? cells(readerLabel) + 1 : 0) - 1
    return (
      <Box gap={1}>
        <Button key="expand" plain onPress={() => void openPane($ as unknown as Api)}>
          {view && <Text color="cyan">{where}</Text>}
          <Text>🌳 </Text>
          <Text dimColor>{turn}</Text>
          <Text>{cut(question, Math.max(6, room))}</Text>
          <Text dimColor>{treeLabel}</Text>
        </Button>
        {nodes.length > 0 && <Button key="reader" plain label={readerLabel} onPress={() => toggleReader($ as unknown as Api)} />}
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    const oldId = e.sessionId
    const r = await next(e)
    if (e.reason === 'resume' || e.reason === 'clear') {
      // an in-place /resume, /branch or /clear does not fire session.start again
      $.clock.after(800, () => {
        void (async () => {
          await loadFor($ as unknown as Api)
          await finishInplace($ as unknown as Api, oldId)
          await syncSelf($ as unknown as Api)
        })()
      })
    } else {
      // the process exits: this tab no longer holds it
      try {
        await mutate($ as unknown as Api, g => {
          const me = g.sessions[oldId]
          if (me) delete me.tab
        })
      } catch {}
    }
    return r
  })

  on('command.run', { command: 'q' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: '用法：/q <想追問的概念，或「如果改成…會怎樣」>' }
    // always on the session itself, never on a light branch (that is /qf)
    await ask($, 'q', text, null)
    return { text: '支線已開，答案會出現在下方的 📖 閱讀區' }
  })

  on('command.run', { command: 'qf' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: '用法：/qf <問題>：接著選中（或最後看過）的輕分支追問' }
    const target = await followTarget($)
    if (!target) return { text: '沒有可以接著追問的輕分支：先用 /q 開一條，或在側欄點選一條' }
    const parent = (await read($, nodesAtom)).find(n => n.id === target)
    const rewound = (await read($, rewoundAtom)).includes(target)
    await ask($, 'q', text, target)
    return {
      text: `接著「${(parent?.text ?? '').slice(0, 30)}」追問，答案會出現在下方的 📖 閱讀區${rewound ? '\n⚠ 這條支線的脈絡已被 rewind 退回：主線看不到它當初依據的對話，回答可能接不上' : ''}`,
    }
  })

  on('command.run', { command: 'tree' }, async $ => {
    await openPane($, true)
    return { text: '脈絡樹已打開' }
  })

  on('command.run', { command: 'up' }, async $ => {
    const sel = await read($, selectedAtom)
    const spec = sel ? await upgradeSpec($, sel) : undefined
    if (!spec) return { text: '先在脈絡樹選中一條已經回答完的輕支線，再用 /up' }
    // a command hook may not run another command itself: detach
    $.clock.after(0, () => {
      void upgradeNode($, sel!, 'here')
    })
    return { text: `升級中：原地分出重支線「${spec.title}」…` }
  })

  on('command.run', { command: 'up-tab' }, async $ => {
    const sel = await read($, selectedAtom)
    const spec = sel ? await upgradeSpec($, sel) : undefined
    if (!spec) return { text: '先在脈絡樹選中一條已經回答完的輕支線，再用 /up-tab' }
    $.clock.after(0, () => {
      void upgradeNode($, sel!, 'tab')
    })
    return { text: `升級中：在新分頁開出重支線「${spec.title}」…` }
  })

  on('command.run', { command: 'sub' }, async ($, e) => {
    const cur = await $.session.id()
    const g = await readGraph($)
    const title = e.args.trim() || childTitle(g, cur)
    const turn = await $.session.turns()
    $.clock.after(0, () => {
      void forkToTab($, cur, { title, fromTurn: turn })
    })
    return { text: `在新分頁開出子 session「${title}」…` }
  })

  on('command.run', { command: 'sub-here' }, async ($, e) => {
    const cur = await $.session.id()
    const g = await readGraph($)
    const title = e.args.trim() || childTitle(g, cur)
    const turn = await $.session.turns()
    $.clock.after(0, () => {
      void forkHere($, { title, fromTurn: turn })
    })
    return { text: `原地分出子 session「${title}」…` }
  })

  on('command.run', { command: 'merge' }, async ($, e) => {
    const r = resolveMergeArg(await readGraph($), e.args)
    if ('error' in r) return { text: r.error }
    const job = await prepareMerge($, r.id)
    if (typeof job === 'string') return { text: job }
    await update($, mergeJobAtom, () => job)
    // opened right here, as the answer to the person's command: from a timer it
    // counts as unasked and waits undrawn on terminals under 144 columns
    const opened = await $.ui.open({ id: MERGE, title: '併入 session', focus: true, closeOnEscape: true, holdToasts: true, rows: 12 })
    if (!opened.isPlaced) {
      await update($, mergeJobAtom, () => null)
      await $.ui.close({ id: MERGE })
      return { text: `確認窗開不出來（${opened.reason}），這次沒有併入` }
    }
    return { text: `比對好了：「${job.name.slice(0, 30)}」有 ${job.prompts} 次提問是目前 session 沒有的，請在確認窗決定是否併入` }
  })

  // the merge dialog: Enter merges, Esc cancels
  on('ui.render', { component: 'Pane', requestId: MERGE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const job = await read($, mergeJobAtom)
    if (!job) return <Text dimColor>（沒有等待確認的合併）</Text>
    return (
      <Box flexDirection="column">
        <Text wrap="wrap">{`把「${job.name.slice(0, 40)}」多出來的 ${job.prompts} 次提問、${job.tools} 次工具呼叫補進目前 session？它本身保持原樣。`}</Text>
        {job.preview.map((p, i) => (
          <Text key={`p${i}`} dimColor wrap="truncate-end">{`  · ${p.replace(/\s+/g, ' ')}`}</Text>
        ))}
        {job.prompts > job.preview.length && <Text dimColor>{`  … 共 ${job.prompts} 次提問`}</Text>}
        {job.trimmed && <Text color="yellow" wrap="wrap">⚠ 內容太長：較早的工具結果或對話會省略</Text>}
        {job.otherCwd && <Text color="yellow" wrap="wrap">{`⚠ 它的工作目錄是 ${job.otherCwd}：它改過的檔案不在這裡`}</Text>}
        {job.live && <Text color="yellow" wrap="wrap">⚠ 它還開在某個分頁：如果正在回答，最後一段可能還沒寫進紀錄</Text>}
        <Box gap={1} marginTop={1}>
          <Button key="yes" label="併入" variant="primary" hotkey="y" autoFocus onPress={() => answerMerge($ as unknown as Api, true)} />
          <Button key="no" label="取消" hotkey="n" onPress={() => answerMerge($ as unknown as Api, false)} />
        </Box>
      </Box>
    )
  })

  // a merge's row in the transcript: one line, unfolds to what was brought over
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== 'session-branch-control' || !e.props.id.startsWith(MERGE_ROW)) return next(e)
    const id = e.props.id
    const row = (await read($, mergeRowsAtom))[id]
    if (!row) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const toggle = () => update($, mergeRowsAtom, v => (v[id] ? { ...v, [id]: { ...v[id]!, open: !v[id]!.open } } : v))
    const head = (
      <Box gap={1}>
        <Button key="fold" plain label={row.open ? '[▾ 收合]' : '[▸ 展開]'} onPress={toggle} />
        <Text color="magenta">⤳</Text>
        <Text wrap="truncate-end">{`已從「${row.name}」補入 ${row.prompts} 次提問、${row.tools} 次工具呼叫`}</Text>
      </Box>
    )
    if (!row.open) return head
    const text = mergeTexts.get(id)
    return (
      <Box flexDirection="column">
        {head}
        <Text dimColor wrap="wrap">
          {text ? (text.length > MERGE_SHOW_MAX ? `${text.slice(0, MERGE_SHOW_MAX)}\n…（只顯示前 ${MERGE_SHOW_MAX} 字）` : text) : '（內容只在併入的那次開啟期間可以看）'}
        </Text>
      </Box>
    )
  })

  // the delete dialog: Enter confirms, Esc cancels
  on('ui.render', { component: 'Pane', requestId: CONFIRM }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const job = await read($, confirmAtom)
    return (
      <Box flexDirection="column">
        <Text wrap="wrap">{`永久刪除 session「${(job?.name ?? '').slice(0, 40)}」？紀錄檔會一併刪除，無法復原。`}</Text>
        <Box gap={1} marginTop={1}>
          <Button key="yes" label="確定" variant="primary" hotkey="y" autoFocus onPress={() => answerDelete($ as unknown as Api, true)} />
          <Button key="no" label="取消" hotkey="n" onPress={() => answerDelete($ as unknown as Api, false)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const nodes = await read($, nodesAtom)
    const sel = await read($, selectedAtom)
    const g = await read($, graphAtom)
    const cur = await read($, currentIdAtom)
    const live = await read($, liveTabsAtom)
    const mapCollapsed = await read($, mapCollapsedAtom)
    const mapSel = await read($, mapSelectedAtom)
    const lightCollapsed = await read($, lightCollapsedAtom)
    const rewound = await read($, rewoundAtom)
    const current = sel ? nodes.find(n => n.id === sel) : undefined
    const rows = flatten(nodes)
    const onPath = new Set(chainOf(nodes, sel ?? null).map(n => n.id))
    const famRows = flattenFamily(g, cur)
    const picked = mapSel && famRows.some(r => r.s.id === mapSel) ? g.sessions[mapSel] : undefined
    const names = await read($, namesAtom)
    const nameOf = (s: SessionEntry) => names[s.id] ?? s.title
    const recent = await read($, recentAtom)

    const reader = await read($, readerAtom)
    const readerOpen = focusOpen(reader)
    // press handlers that scroll return their promise: the engine lets a
    // transcript row scroll only while the press is still being answered
    const goMain = () =>
      (async () => {
        await update($, selectedAtom, () => null)
        if (readerOpen) await foldReader($ as unknown as Api)
      })()
    // the sidebar is the outline: a pick opens the branch in the full-width reader
    // ...and folds the sidebar away (the person's open/closed preference kept),
    // first, so the reader is scrolled to in the transcript's final width
    const select = (id: string) => () =>
      (async () => {
        await update($, selectedAtom, () => id)
        await $.ui.close({ id: PANE })
        await update($, openAtom, () => false)
        await openReader($ as unknown as Api, id, 'jump')
      })()
    const readerButton = (key: string) => (
      <Button key={key} label={readerOpen ? '📖 收合閱讀' : '📖 閱讀'} hotkey="r" onPress={() => toggleReader($ as unknown as Api)} />
    )

    const toggleMap = () => {
      void (async () => {
        const now = !(await read($, mapCollapsedAtom))
        await update($, mapCollapsedAtom, () => now)
        await $.store.set(MAP_COLLAPSED_KEY, now)
      })()
    }

    const toggleLight = () => {
      void (async () => {
        const now = !(await read($, lightCollapsedAtom))
        await update($, lightCollapsedAtom, () => now)
        await $.store.set(LIGHT_COLLAPSED_KEY, now)
      })()
    }

    const icon = (n: BranchNode) => (n.kind === 'q' ? '?' : '⑂')
    const mark = (n: BranchNode) =>
      n.status === 'pending' ? ' …' : n.status === 'error' ? ' ✗' : n.upgradedTo ? ' ⇪' : n.inherited ? ' ⇣' : n.merged ? ' ⤴' : ''

    // the footer is pinned to the window's bottom-left while docked: the tree
    // is at least the window tall, the footer drawn absolutely on the window's
    // last row, which follows the person's scroll (each scroll redraws)
    const dock = e.props.placement === 'dock'
    const { offset, bodyRows } = e.props.scroll
    const footerTop = offset + Math.max(1, bodyRows) - 1
    const footer = (
      <Box gap={1}>
        <Button key="collapse" label="⇥ 收合" hotkey="x" onPress={() => void closePane($ as unknown as Api)} />
        {nodes.length > 0 && readerButton('reader')}
      </Box>
    )

    // Every row is one line, left-aligned, sized in terminal cells: nothing is
    // pushed to the right edge, nothing wraps, so a narrow pane or a long
    // title only shortens the text, never breaks the layout.
    const cols = Math.max(16, e.props.bodyColumns - 1)
    const INDENT = '  '
    const section = (key: string, open: boolean, label: string, onPress: () => void) => (
      <Button key={key} plain onPress={onPress}>
        <Text>{open ? '▾ ' : '▸ '}</Text>
        <Text bold>{cut(label, cols - 2)}</Text>
      </Button>
    )

    // the heavy-branch system: shown only when this session is in a family
    // (a lone entry left after its branches were deleted is no family)
    const heavyRows = famRows.length >= 2 ? famRows : []
    const heavyRow = ({ s, prefix }: { s: SessionEntry; prefix: string }) => {
      const here = s.id === cur
      const gutter = here ? '▶ ' : '  '
      const tail = `${s.fromTurn !== undefined ? ` #${s.fromTurn}` : ''}${s.mergedInto?.[cur] ? ' ⤳' : ''}${s.tab && live.includes(s.tab) && !here ? ' ▣' : ''}${here ? ' 目前' : ''}`
      const room = cols - cells(INDENT) - cells(gutter) - cells(prefix) - cells(tail)
      return (
        <Button key={`s-${s.id}`} plain onPress={() => update($, mapSelectedAtom, v => (v === s.id ? null : s.id))}>
          <Text>{INDENT}</Text>
          <Text color="green" bold>{gutter}</Text>
          <Text dimColor>{prefix}</Text>
          <Text bold={here} color={here ? 'green' : undefined} inverse={s.id === mapSel}>
            {cut(`${s.parentId ? '⑂' : '●'} ${nameOf(s)}`, Math.max(4, room))}
          </Text>
          <Text dimColor={!here} color={here ? 'green' : undefined}>{tail}</Text>
        </Button>
      )
    }

    const mainLabel = '← /q 都從這裡分出'
    return (
      <Box flexDirection="column" minHeight={dock ? bodyRows : undefined}>
        {section('light-toggle', !lightCollapsed, `輕分支 · 這個 session 的追問（${nodes.length}）`, toggleLight)}
        {!lightCollapsed && (
          <Box flexDirection="column">
            <Button key="main" plain onPress={goMain}>
              <Text>{INDENT}</Text>
              <Text bold={!sel} inverse={!sel}>● 主線</Text>
              <Text dimColor>{` ${cut(mainLabel, cols - cells(INDENT) - 7)}`}</Text>
            </Button>
            {rows.map(({ node, prefix }) => {
              const seenLast = node.id === recent
              const tail = ` #${node.turn}${mark(node)}`
              const back = rewound.includes(node.id) ? ' ↶' : ''
              const flag = seenLast ? ' ◂ 剛看過' : ''
              const room = cols - cells(INDENT) - cells(prefix) - cells(tail) - cells(back) - cells(flag)
              return (
                <Button key={node.id} plain onPress={select(node.id)}>
                  <Text>{INDENT}</Text>
                  <Text dimColor>{prefix}</Text>
                  <Text
                    bold={node.id === sel || seenLast}
                    inverse={node.id === sel}
                    color={seenLast && node.id !== sel ? 'cyan' : undefined}
                    dimColor={!seenLast && !onPath.has(node.id) && node.status === 'done'}
                  >
                    {cut(`${icon(node)} ${node.text}`, Math.max(4, room))}
                  </Text>
                  <Text dimColor>{tail}</Text>
                  {back && <Text color="yellow">{back}</Text>}
                  {seenLast && <Text color="cyan">{flag}</Text>}
                </Button>
              )
            })}
            {rows.length === 0 && (
              <Box paddingLeft={2}>
                <Text dimColor wrap="wrap">還沒有輕分支。用 /q 追問概念或假設情境</Text>
              </Box>
            )}
            {current && (
              <Box paddingLeft={2}>
                <Text dimColor wrap="wrap">
                  {readerOpen && reader.node === current.id ? '📖 內容在對話中提問處的閱讀區' : '📖 點節點，捲到它在對話中的閱讀區'}
                </Text>
              </Box>
            )}
          </Box>
        )}
        {heavyRows.length > 0 && <Box height={1} />}
        {heavyRows.length > 0 && section('map-toggle', !mapCollapsed, `重分支 · session 地圖（${heavyRows.length}）`, toggleMap)}
        {heavyRows.length > 0 && !mapCollapsed && (
          <Box flexDirection="column">
            {heavyRows.map(heavyRow)}
            {picked && (
              <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1} marginLeft={2}>
                <Text bold>{cut(nameOf(picked), cols - 6)}</Text>
                <Text dimColor wrap="wrap">
                  {`${picked.parentId ? `從「${(() => { const p = g.sessions[picked.parentId]; return p ? nameOf(p) : '?' })()}」第 ${picked.fromTurn ?? '?'} 輪分出` : '根 session'}${picked.fromBranch ? ' · 由輕分支升級' : ''}${picked.tab && live.includes(picked.tab) ? ' · ▣ 已開在分頁' : ''}${picked.id === cur ? ' · 你目前在這裡' : ''}${picked.mergedInto?.[cur] ? ` · ⤳ 已併入目前 session（共 ${picked.mergedInto[cur]!.prompts} 次提問）` : ''}`}
                </Text>
                {picked.id !== cur && (
                  <Box flexDirection="column" marginTop={1}>
                    <Button key="m-tab" label="▣ 在新分頁開啟" onPress={() => void openInTab(($ as unknown as Api), picked.id)} />
                    <Button key="m-here" label="⇄ 切換成目前 session" onPress={() => void switchHere(($ as unknown as Api), picked.id)} />
                    <Button key="m-merge" label="⤳ 併入目前 session" onPress={() => void fillMerge(($ as unknown as Api), picked.id)} />
                    <Button key="m-del" label="🗑 刪除" onPress={() => deleteHeavy(($ as unknown as Api), picked.id)} />
                  </Box>
                )}
              </Box>
            )}
          </Box>
        )}
        {/* docked: a blank last row, so the end of the list scrolls clear of the pinned footer */}
        {dock && <Box height={1} />}
        {dock ? (
          <Box position="absolute" top={footerTop} left={0} width={e.props.bodyColumns}>
            {footer}
            {/* spaces paint over the row beneath, so the buttons never sit on text */}
            <Text wrap="truncate-end">{' '.repeat(e.props.bodyColumns)}</Text>
          </Box>
        ) : (
          <Box marginTop={1}>{footer}</Box>
        )}
      </Box>
    )
  })
}
