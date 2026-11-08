import type { Hook } from 'claude-code'

import type { Graph, SessionEntry } from '../types'

export type Api = Parameters<Hook<'command.run'>>[0]

export const MAP_COLLAPSED_KEY = 'pref:mapCollapsed'

// NB: every helper that takes `$` is a function declaration: past an import
// the engine follows `$` only into those.

async function graphPath($: Api) {
  const home = (await $.env.get('HOME')) ?? '/tmp'
  const cwd = await $.session.cwd()
  return `${home}/.claude/session-branch-control/${cwd.replace(/[^A-Za-z0-9]+/g, '-')}.json`
}

export async function readGraph($: Api): Promise<Graph> {
  try {
    const g = JSON.parse(await $.fs.read(await graphPath($))) as Partial<Graph>
    return { sessions: g.sessions ?? {}, pending: g.pending ?? {}, ...(g.inplace ? { inplace: g.inplace } : {}) }
  } catch {
    return { sessions: {}, pending: {} }
  }
}

/** read → change → write the shared file */
export async function mutateGraph($: Api, fn: (g: Graph) => void) {
  const g = await readGraph($)
  fn(g)
  await $.fs.write(await graphPath($), JSON.stringify(g, null, 2))
  return g
}

export const ensureEntry = (g: Graph, id: string, title: string, at: number, parentId: string | null = null) => {
  if (!g.sessions[id]) g.sessions[id] = { id, title, parentId, createdAt: at }
  return g.sessions[id] as SessionEntry
}

/** the connected family of sessions `id` belongs to (root first) */
export const familyOf = (g: Graph, id: string): SessionEntry[] => {
  const all = g.sessions
  let root = all[id]
  const seen = new Set<string>()
  while (root?.parentId && all[root.parentId] && !seen.has(root.id)) {
    seen.add(root.id)
    root = all[root.parentId]
  }
  if (!root) return []
  const out: SessionEntry[] = [root]
  const walk = (pid: string) => {
    for (const s of Object.values(all)) {
      if (s.parentId === pid && !out.includes(s)) {
        out.push(s)
        walk(s.id)
      }
    }
  }
  walk(root.id)
  return out
}

export const flattenFamily = (g: Graph, id: string) => {
  const fam = familyOf(g, id)
  const rows: { s: SessionEntry; prefix: string }[] = []
  const root = fam[0]
  if (!root) return rows
  const walk = (pid: string, indent: string) => {
    const kids = fam.filter(s => s.parentId === pid)
    kids.forEach((s, i) => {
      const last = i === kids.length - 1
      rows.push({ s, prefix: `${indent}${last ? '└ ' : '├ '}` })
      walk(s.id, `${indent}${last ? '  ' : '│ '}`)
    })
  }
  rows.push({ s: root, prefix: '' })
  walk(root.id, '')
  return rows
}

// ---- Orca tabs ----------------------------------------------------------

export type OrcaTerminal = { handle: string; tabId?: string; connected?: boolean }

async function orcaBin($: Api) {
  const dir = await $.env.get('ORCA_CLI_BIN_DIR')
  return dir ? `${dir}/orca` : 'orca'
}

export async function listTabs($: Api): Promise<OrcaTerminal[]> {
  if ((await $.env.get('ORCA_WORKTREE_ID')) === undefined) return []
  try {
    const r = await $.process.run([await orcaBin($), 'terminal', 'list', '--limit', '500', '--json'])
    if (r.exitCode !== 0) return []
    const j = JSON.parse(r.stdout) as { result?: { terminals?: OrcaTerminal[] } }
    return j.result?.terminals ?? []
  } catch {
    return []
  }
}

/** the Orca terminal handle this process is drawn in */
export async function ownTab($: Api, tabs: readonly OrcaTerminal[]) {
  const tabId = await $.env.get('ORCA_TAB_ID')
  if (!tabId) return undefined
  return tabs.find(t => t.tabId === tabId)?.handle
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** a new Orca tab running `claude` with this mod loaded; falls back to the clipboard */
export async function openTab($: Api, title: string, claudeArgs: readonly string[]) {
  // a session is found by its project folder: start there whatever the tab's own folder is
  const cwd = await $.session.cwd()
  // an installed plugin loads in every session by itself; only a dev copy needs --plugin-dir
  const isInstalled = $.plugin.root.includes('/plugins/cache/')
  const pluginArgs = isInstalled ? [] : ['--plugin-dir', shq($.plugin.root)]
  const cmd = `cd ${shq(cwd)} && ${['command', 'claude', ...pluginArgs, ...claudeArgs.map(shq)].join(' ')}`
  const wt = await $.env.get('ORCA_WORKTREE_ID')
  if (!wt) {
    await $.ui.copy({ text: cmd })
    $.ui.toast('不在 Orca 裡：啟動指令已複製到剪貼簿，貼到新的終端機分頁執行即可')
    return undefined
  }
  const r = await $.process.run([
    await orcaBin($),
    'terminal',
    'create',
    '--worktree',
    `id:${wt}`,
    '--title',
    title,
    '--command',
    cmd,
    '--focus',
    '--json',
  ])
  if (r.exitCode !== 0) {
    $.ui.toast(`開分頁失敗：${(r.stderr || r.stdout).slice(0, 120)}`)
    return undefined
  }
  return r.stdout.match(/term_[0-9a-f-]+/)?.[0]
}

export async function switchTab($: Api, handle: string) {
  const r = await $.process.run([await orcaBin($), 'terminal', 'switch', '--terminal', handle, '--json'])
  return r.exitCode === 0
}

/** a short title for the current session: its first prompt */
export async function titleOfCurrent($: Api) {
  const msgs = await $.session.messages()
  const first = msgs.find(m => m.role === 'user' && m.text.trim() && !m.text.trim().startsWith('<'))
  const t = (first?.text ?? '主線').replace(/\s+/g, ' ').trim()
  return t.length > 30 ? `${t.slice(0, 30)}…` : t
}
