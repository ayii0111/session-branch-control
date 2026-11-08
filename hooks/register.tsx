import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BranchKind, BranchNode, Graph } from '../types'
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

const graphAtom = atom({ plugin: 'branch-tree', key: 'graph' } as const, { sessions: {}, pending: {} } as Graph, {
  shape: 'graph-1',
})
const currentIdAtom = atom({ plugin: 'branch-tree', key: 'currentId' } as const, '')
const liveTabsAtom = atom({ plugin: 'branch-tree', key: 'liveTabs' } as const, [] as string[])
const mapCollapsedAtom = atom({ plugin: 'branch-tree', key: 'mapCollapsed' } as const, false)
const mapSelectedAtom = atom({ plugin: 'branch-tree', key: 'mapSelected' } as const, null as string | null)

/** change the shared map file and redraw from what was written */
const mutate = async ($: Api, fn: (g: Graph) => void) => {
  const g = await mutateGraph($, fn)
  await update($, graphAtom, () => g)
  return g
}

const PANE = 'branch-tree'
const TITLE = '🌳 脈絡樹'

const nodesAtom = atom({ plugin: 'branch-tree', key: 'nodes' } as const, [] as BranchNode[], {
  shape: 'nodes-1',
})
const selectedAtom = atom({ plugin: 'branch-tree', key: 'selected' } as const, null as string | null)
const openAtom = atom({ plugin: 'branch-tree', key: 'isOpen' } as const, false)

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

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

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

const KIND_RULE: Record<BranchKind, string> = {
  q: '類型：概念說明。針對主線對話中出現、用戶不熟的概念，用白話解釋它是什麼，並點出它在目前主線脈絡裡扮演什麼角色。',
  wi: '類型：假設推演。用戶想知道「若換成下列情境或前提」，主線先前的論述與後續推論會怎麼變：哪些結論仍成立、哪些會翻轉、關鍵原因是什麼。',
}

const buildPrompt = (kind: BranchKind, text: string, chain: readonly BranchNode[]) => {
  const history = chain
    .filter(n => n.status === 'done')
    .map(n => `${n.kind === 'q' ? '問' : '假設'}：${n.text}\n答：${n.answer}`)
    .join('\n\n')
  return [
    '【旁支提問｜這次回答只會顯示在用戶的側欄，不會進入主線對話】',
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
    const kids = nodes.filter(n => n.parentId === parentId)
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
}

const ask = async ($: Api, kind: BranchKind, text: string) => {
  const nodes = await read($, nodesAtom)
  const sel = await read($, selectedAtom)
  const parentId = sel && nodes.some(n => n.id === sel) ? sel : null
  const chain = chainOf(nodes, parentId)
  const node: BranchNode = {
    id: newId(),
    kind,
    parentId,
    text,
    answer: '',
    status: 'pending',
    turn: await $.session.turns(),
    at: await $.clock.now(),
  }
  await update($, nodesAtom, list => [...list, node])
  await update($, selectedAtom, () => node.id)
  await persist($)
  // respect a collapsed tree: the mini bar above the prompt shows progress
  if ((await $.store.get(COLLAPSED_KEY)) !== true) await openPane($)

  // detach from the command's dispatch so a long answer is not cut off
  $.clock.after(0, () => {
    void (async () => {
      const r = await $.model.fork({ prompt: buildPrompt(kind, text, chain) })
      const patch: Partial<BranchNode> = r.isAnswered
        ? { status: 'done', answer: r.text }
        : { status: 'error', answer: `（沒有回答：${r.reason}）` }
      await update($, nodesAtom, list => list.map(n => (n.id === node.id ? { ...n, ...patch } : n)))
      await persist($)
      if (r.isAnswered) $.ui.toast(`支線回答好了：${text.slice(0, 20)}`)
    })()
  })
}

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
  if (job.fromBranch) await markUpgraded($, job.parentId, job.fromBranch, newSid)
  $.ui.toast(`已原地切到重支線：${job.title}`)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'q', description: '開支線：追問一個概念（答案只進側欄，不進主線）', argumentHint: '[問題]' })
    await $.command.register({ name: 'wi', description: '開支線：假設推演 what-if（答案只進側欄，不進主線）', argumentHint: '[假設情境]' })
    await $.command.register({ name: 'tree', description: '打開脈絡樹面板並聚焦' })
    await $.command.register({ name: 't', description: '快速開合脈絡樹面板（對話進行中也能用）', immediate: true })
    await $.command.register({ name: 'up', description: '把選中的輕支線升級成重支線，原地切過去' })
    await $.command.register({ name: 'up-tab', description: '把選中的輕支線升級成重支線，開在新分頁' })
    await $.command.register({ name: 'sub', description: '從目前 session 分出子 session，開在新分頁', argumentHint: '[標題]' })
    await $.command.register({ name: 'sub-here', description: '從目前 session 分出子 session，原地切過去', argumentHint: '[標題]' })
    await $.command.register({ name: 'map', description: '開合 Session 地圖區塊', immediate: true })
    await loadFor($ as unknown as Api)
    await update($, mapCollapsedAtom, () => false)
    if ((await $.store.get(MAP_COLLAPSED_KEY)) === true) await update($, mapCollapsedAtom, () => true)
    await syncSelf($ as unknown as Api)
    if ((await $.store.get(COLLAPSED_KEY)) !== true) {
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
    const current = sel ? nodes.find(n => n.id === sel) : undefined
    const pending = nodes.filter(n => n.status === 'pending').length
    const { Box, Text, Button } = $.ui.resolve(e)
    const where = current ? `${current.kind === 'q' ? '?' : '⑂'} ${current.text}` : (g.sessions[cur]?.title ?? '● 主線')
    return (
      <Box>
        <Button key="expand" onPress={() => void openPane($ as unknown as Api)}>
          <Text>🌳 </Text>
          <Text dimColor>
            {`${fam >= 2 ? `${fam} 個 session · ` : ''}${nodes.length} 條支線${pending ? ` · ${pending} 回答中…` : ''} · 目前：`}
          </Text>
          <Text wrap="truncate-end">{where.slice(0, Math.max(10, e.props.bodyColumns - 50))}</Text>
          <Text dimColor>  [展開 /t]</Text>
        </Button>
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
    if (!text) return { text: '用法：/q <想追問的概念>' }
    await ask($, 'q', text)
    return { text: '支線已開，答案會出現在 🌳 脈絡樹面板' }
  })

  on('command.run', { command: 'wi' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: '用法：/wi <假設情境>' }
    await ask($, 'wi', text)
    return { text: '支線已開，答案會出現在 🌳 脈絡樹面板' }
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
      void forkHere($, spec)
    })
    return { text: `升級中：原地分出重支線「${spec.title}」…` }
  })

  on('command.run', { command: 'up-tab' }, async $ => {
    const sel = await read($, selectedAtom)
    const spec = sel ? await upgradeSpec($, sel) : undefined
    if (!spec) return { text: '先在脈絡樹選中一條已經回答完的輕支線，再用 /up-tab' }
    const cur = await $.session.id()
    $.clock.after(0, () => {
      void forkToTab($, cur, spec)
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const nodes = await read($, nodesAtom)
    const sel = await read($, selectedAtom)
    const g = await read($, graphAtom)
    const cur = await read($, currentIdAtom)
    const live = await read($, liveTabsAtom)
    const mapCollapsed = await read($, mapCollapsedAtom)
    const mapSel = await read($, mapSelectedAtom)
    const current = sel ? nodes.find(n => n.id === sel) : undefined
    const rows = flatten(nodes)
    const onPath = new Set(chainOf(nodes, sel ?? null).map(n => n.id))
    const width = Math.max(20, e.props.bodyColumns - 2)
    const famRows = flattenFamily(g, cur)
    const hasMap = famRows.length >= 2
    const picked = mapSel ? g.sessions[mapSel] : undefined
    const curTitle = g.sessions[cur]?.title

    const goMain = () => update($, selectedAtom, () => null)
    const select = (id: string) => () => update($, selectedAtom, () => id)

    const mergeBack = (id: string) => () => {
      void (async () => {
        const chain = chainOf(await read($, nodesAtom), id).filter(n => n.status === 'done')
        if (chain.length === 0) return
        try {
          // a hidden user row at the end: the main agent reads it next turn,
          // no turn is started and nothing already sent changes (cache kept)
          await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: toRecord(chain, 'merge') }] } })
          await update($, nodesAtom, list => list.map(n => (chain.some(c => c.id === n.id) ? { ...n, merged: true } : n)))
          const sid = await $.session.id()
          await $.store.set(storeKey(sid), await read($, nodesAtom))
          $.ui.toast(`已把 ${chain.length} 段支線問答併回主線，主線下一輪就會讀到`)
        } catch (err) {
          $.ui.toast(`併回失敗：${String((err as Error)?.message ?? err)}`)
        }
      })()
    }

    const upgrade = (id: string, where: 'here' | 'tab') => () => {
      void (async () => {
        const spec = await upgradeSpec(($ as unknown as Api), id)
        if (!spec) {
          $.ui.toast('這條支線還沒有完成的回答，不能升級')
          return
        }
        if (where === 'here') await forkHere(($ as unknown as Api), spec)
        else await forkToTab(($ as unknown as Api), await $.session.id(), spec)
      })()
    }

    const remove = (id: string) => () => {
      void (async () => {
        const all = await read($, nodesAtom)
        const gone = descendantsOf(all, id)
        const target = all.find(n => n.id === id)
        await update($, nodesAtom, list => list.filter(n => !gone.has(n.id)))
        await update($, selectedAtom, s => (s && gone.has(s) ? (target?.parentId ?? null) : s))
        const sid = await $.session.id()
        await $.store.set(storeKey(sid), await read($, nodesAtom))
      })()
    }

    const toggleMap = () => {
      void (async () => {
        const now = !(await read($, mapCollapsedAtom))
        await update($, mapCollapsedAtom, () => now)
        await $.store.set(MAP_COLLAPSED_KEY, now)
      })()
    }

    const icon = (n: BranchNode) => (n.kind === 'q' ? '?' : '⑂')
    const mark = (n: BranchNode) =>
      n.status === 'pending' ? ' …' : n.status === 'error' ? ' ✗' : n.upgradedTo ? ' ⇪' : n.merged ? ' ⤴' : ''

    return (
      <Box flexDirection="column">
        {hasMap && (
          <Box flexDirection="column" marginBottom={1}>
            <Box justifyContent="space-between">
              <Button key="map-toggle" onPress={toggleMap}>
                <Text bold>{`🗺 Session 地圖（${famRows.length}）`}</Text>
                <Text dimColor>{mapCollapsed ? '  [+ 展開]' : '  [− 收合]'}</Text>
              </Button>
              <Button key="collapse" label="⇥ 收合" hotkey="x" onPress={() => void closePane(($ as unknown as Api))} />
            </Box>
            {!mapCollapsed &&
              famRows.map(({ s, prefix }) => (
                <Button key={`s-${s.id}`} onPress={() => update($, mapSelectedAtom, v => (v === s.id ? null : s.id))}>
                  <Text dimColor>{prefix}</Text>
                  <Text bold={s.id === cur} inverse={s.id === mapSel} wrap="truncate-end">
                    {`${s.parentId ? '⑂' : '●'} ${s.title}`.slice(0, Math.max(12, width - prefix.length - 14))}
                  </Text>
                  <Text dimColor>
                    {`${s.fromTurn !== undefined ? ` #${s.fromTurn}` : ''}${s.tab && live.includes(s.tab) && s.id !== cur ? ' ▣' : ''}`}
                  </Text>
                  {s.id === cur && <Text color="green"> ◀ 你在這</Text>}
                </Button>
              ))}
            {!mapCollapsed && picked && (
              <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
                <Text bold wrap="truncate-end">{picked.title}</Text>
                <Text dimColor>
                  {`${picked.parentId ? `從「${g.sessions[picked.parentId]?.title ?? '?'}」第 ${picked.fromTurn ?? '?'} 輪分出` : '根 session'}${picked.fromBranch ? ' · 由輕支線升級' : ''}${picked.tab && live.includes(picked.tab) ? ' · ▣ 已開在分頁' : ''}`}
                </Text>
                <Box flexWrap="wrap" gap={1} marginTop={1}>
                  {picked.id !== cur && <Button key="m-here" label="⇄ 原地切換" onPress={() => void switchHere(($ as unknown as Api), picked.id)} />}
                  {picked.id !== cur && <Button key="m-tab" label="▣ 分頁開啟" onPress={() => void openInTab(($ as unknown as Api), picked.id)} />}
                  <Button
                    key="m-sub"
                    label="＋ 子 session（新分頁）"
                    onPress={() => void forkToTab(($ as unknown as Api), picked.id, { title: childTitle(g, picked.id), fromTurn: 0 })}
                  />
                  {picked.id === cur && (
                    <Button
                      key="m-subhere"
                      label="＋ 子 session（原地）"
                      onPress={() => void (async () => forkHere(($ as unknown as Api), { title: childTitle(g, cur), fromTurn: await $.session.turns() }))()}
                    />
                  )}
                  {picked.id !== cur && <Button key="m-del" label="從地圖移除" onPress={() => void removeFromMap(($ as unknown as Api), picked.id)} />}
                </Box>
              </Box>
            )}
          </Box>
        )}
        <Box justifyContent="space-between">
          <Button key="main" onPress={goMain}>
            <Text bold={!sel} inverse={!sel}>{`● ${hasMap && curTitle ? curTitle.slice(0, Math.max(8, width - 24)) : '主線'}`}</Text>
            <Text dimColor>{sel ? '  （點此回主線）' : '  ← 你在這裡'}</Text>
          </Button>
          {!hasMap && <Button key="collapse" label="⇥ 收合" hotkey="x" onPress={() => void closePane(($ as unknown as Api))} />}
        </Box>
        {rows.length === 0 && (
          <Text dimColor wrap="wrap">
            還沒有輕支線。/q 追問概念、/wi 假設推演；/sub 開新分頁子 session、/sub-here 原地分出。
          </Text>
        )}
        {rows.map(({ node, prefix }) => (
          <Button key={node.id} onPress={select(node.id)}>
            <Text dimColor>{prefix}</Text>
            <Text
              bold={node.id === sel}
              inverse={node.id === sel}
              dimColor={!onPath.has(node.id) && node.status === 'done'}
              wrap="truncate-end"
            >
              {`${icon(node)} ${node.text}`.slice(0, width)}
            </Text>
            <Text dimColor>{` #${node.turn}${mark(node)}`}</Text>
          </Button>
        ))}
        {current && (
          <Box flexDirection="column" marginTop={1} borderStyle="single" borderDimColor paddingX={1}>
            <Text bold wrap="wrap">
              {current.kind === 'q' ? '? 追問：' : '⑂ 假設：'}
              {current.text}
            </Text>
            <Text dimColor>
              {`從主線第 ${current.turn} 輪分出 · 新的 /q、/wi 會接在這個節點底下${current.upgradedTo ? ' · 已升級成重支線' : ''}`}
            </Text>
            {current.status === 'pending' && <Text dimColor>回答中…</Text>}
            {current.status !== 'pending' && <Markdown text={current.answer || '（空）'} />}
            <Box flexWrap="wrap" gap={1} marginTop={1}>
              <Button key="merge" label="併回主線" onPress={mergeBack(current.id)} />
              <Button key="up-here" label="⇪ 升級：原地" onPress={upgrade(current.id, 'here')} />
              <Button key="up-tab" label="⇪ 升級：新分頁" onPress={upgrade(current.id, 'tab')} />
              <Button key="main2" label="回主線" onPress={goMain} />
              <Button key="del" label="刪除" onPress={remove(current.id)} />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
