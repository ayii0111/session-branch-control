import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-branch-control',
  component: 'Pane',
  requestId: 'session-branch-control',
  surface: 'terminal',
  props: {
    title: '🌳 脈絡樹',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('/q opens a branch, its answer lands in the full-width reader, merge writes a record into history', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const session = mock.session(on)
  const forks: string[] = []
  const placed: string[] = []

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.place', (_, e) => {
    placed.push(e.id)
    return { value: { isPlaced: true, requestId: `req-${e.id}` } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.turns', () => ({ value: 7 }))
  on('model.fork', (_, e) => {
    forks.push(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: `ANSWER-${forks.length}`,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.command.run({ command: 'q', args: 'CRDT 是什麼' })
  await clock.advance(10)
  // follow-up under the selected node carries the chain
  await $.command.run({ command: 'qf', args: '若改用 OT' })
  await clock.advance(10)

  expect(forks.length).toBe(2)
  expect(forks[1]).toContain('CRDT 是什麼')
  expect(forks[1]).toContain('ANSWER-1')

  // each /q places its own reader row at the transcript's end, no jump
  expect(placed.length).toBe(2)
  const row = placed[1]!
  const reader = await $.ui.mount({
    plugin: 'session-branch-control',
    component: 'Placed',
    requestId: `req-${row}`,
    surface: 'terminal',
    props: { id: row, plugin: 'session-branch-control' },
  })
  expect((await reader.find({ type: 'Text', text: /若改用 OT/ }))?.text).toContain('若改用 OT')

  await reader.press({ key: 'merge' })
  const rows = session.appended()
  expect(rows.length).toBe(1)
  const text = JSON.stringify(rows[0])
  expect(text).toContain('side-branch')
  expect(text).toContain('ANSWER-1')
  expect(text).toContain('ANSWER-2')

  // the sidebar is only the outline now: no answer drawn there
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: /ANSWER-2/ })).toBeUndefined()
  // 📖 folds the open reader, a second press opens it again and jumps to it
  await pane.press({ key: 'reader' })
  expect(await reader.find({ type: 'Text', text: /ANSWER/ })).toBeUndefined()
  await pane.press({ key: 'reader' })
  expect((await reader.find({ type: 'Text', text: /若改用 OT/ }))?.text).toContain('若改用 OT')
  await pane.unmount()
  await reader.unmount()
})

test('/t collapses to a mini bar above the prompt and expands again', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  let shown = true
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    shown = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    shown = false
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: shown ? [{ id: 'session-branch-control', title: '🌳 脈絡樹', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-2' }))
  on('ui.place', () => ({ value: { isPlaced: true, requestId: 'row' } }))
  on('session.turns', () => ({ value: 3 }))
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: 'A',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'q', args: 'X 是什麼' })

  const band = {
    plugin: 'session-branch-control',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  } as const

  const r1 = await $.command.run({ command: 't', args: '' })
  expect(r1.text).toContain('已收合')
  expect(shown).toBe(false)
  const ui = await $.ui.mount(band)
  expect((await ui.find({ type: 'Text', text: /X 是什麼/ }))?.text).toContain('X 是什麼')
  await ui.press({ key: 'expand' })
  expect(shown).toBe(true)
  await ui.unmount()

  const r2 = await $.command.run({ command: 't', args: '' })
  expect(r2.text).toContain('已收合')
  const r3 = await $.command.run({ command: 't', args: '' })
  expect(r3.text).toContain('已展開')
})

test('/q right after a resume (nothing to fork) answers from the saved transcript', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const completes: string[] = []
  const toasts: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.place', (_, e) => ({ value: { isPlaced: true, requestId: `req-${e.id}` } }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-4' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.model', () => ({ value: 'opus' }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '幫我看投標須知', toolUses: [] },
      { role: 'assistant', text: '還缺的資料：規格文件', toolUses: [] },
    ],
  }))
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  on('model.complete', (_, e) => {
    completes.push(JSON.stringify(e))
    return {
      value: {
        isAnswered: true,
        text: 'FALLBACK',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'q', args: '作品要做到什麼程度' })
  await clock.advance(10)
  expect(completes.length).toBe(1)
  expect(completes[0]).toContain('投標須知')
  expect(completes[0]).toContain('作品要做到什麼程度')
  expect(toasts.some(t => t.includes('支線回答好了'))).toBe(true)
})

test('upgrading writes the child transcript: the fork chain, then the branch as visible turns', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const parent = [
    { type: 'ai-title', aiTitle: 'T', sessionId: 'P' },
    { type: 'user', uuid: 'old', parentUuid: null, isSidechain: false, sessionId: 'P', message: { role: 'user', content: 'before compact' } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'b', parentUuid: null, isSidechain: false, sessionId: 'P' },
    { type: 'user', uuid: 'u1', parentUuid: 'b', isSidechain: false, sessionId: 'P', cwd: '/w', version: '9', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, sessionId: 'P', message: { model: 'm1', role: 'assistant', content: [] } },
    { type: 'file-history-snapshot', messageId: 'u1', snapshot: {} },
    { type: 'assistant', uuid: 'side', parentUuid: 'a1', isSidechain: true, sessionId: 'P' },
  ]
  const files = new Map<string, string>([['/h/.claude/projects/-w/P.jsonl', parent.map(r => JSON.stringify(r)).join('\n')]])
  const copied: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'P' }))
  on('session.turns', () => ({ value: 2 }))
  on('session.root', () => ({ value: '/w' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'm0' }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'hi', toolUses: [] }] }))
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  let n = 0
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: `A${++n}`,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  const placed: string[] = []
  on('ui.place', (_, e) => {
    placed.push(e.id)
    return { value: { isPlaced: true, requestId: `req-${e.id}` } }
  })

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'q', args: 'Q1' })
  await clock.advance(10)
  await $.command.run({ command: 'qf', args: 'Q2' })
  await clock.advance(10)
  const row = placed.at(-1)!
  const reader = await $.ui.mount({
    plugin: 'session-branch-control',
    component: 'Placed',
    requestId: `req-${row}`,
    surface: 'terminal',
    props: { id: row, plugin: 'session-branch-control' },
  })
  await reader.press({ key: 'up-tab' })
  await reader.unmount()

  const child = [...files.keys()].find(k => k.startsWith('/h/.claude/projects/-w/') && !k.endsWith('/P.jsonl'))!
  expect(child).toBeDefined()
  const childId = child.split('/').at(-1)!.replace('.jsonl', '')
  // the new tab resumes the written session, no fork at launch
  expect(copied[0]).toContain(`'--resume' '${childId}'`)
  expect(copied[0]).not.toContain('--fork-session')

  const rows = files.get(child)!.trim().split('\n').map(l => JSON.parse(l))
  expect(rows.every(r => r.sessionId === undefined || r.sessionId === childId)).toBe(true)
  const chain = rows.filter(r => r.uuid)
  // from the compact boundary on, no sidechain, no pre-compact rows
  expect(chain.map(r => r.uuid).slice(0, 3)).toEqual(['b', 'u1', 'a1'])
  expect(chain.length).toBe(7)
  const [q1, a1, q2, a2] = chain.slice(3)
  expect(q1.message.content).toBe('【支線追問】Q1')
  expect(q1.parentUuid).toBe('a1')
  expect(a1.message.content[0].text).toBe('A1')
  expect(a1.message.model).toBe('m1')
  expect(q2.message.content).toBe('【支線追問】Q2')
  expect(q2.parentUuid).toBe(a1.uuid)
  expect(a2.message.content[0].text).toBe('A2')
  expect(rows.at(-1)).toEqual({ type: 'last-prompt', lastPrompt: 'Q2', leafUuid: a2.uuid, sessionId: childId })
  expect(rows.some(r => r.type === 'file-history-snapshot')).toBe(true)
})

test('the sidebar shows both systems, marks the session you are in, folds each, and keeps rows within its width', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.place', (_, e) => ({ value: { isPlaced: true, requestId: `req-${e.id}` } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-5' }))
  on('env.get', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', () => ({ value: undefined }))
  on('session.turns', () => ({ value: 4 }))
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: 'A',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'q', args: '一個非常非常長的中文問題，用來確認側欄在很窄的時候也不會折行或把版面撐破' })
  await clock.advance(10)

  const narrow = { ...PANE, props: { ...PANE.props, bodyColumns: 30 } }
  const pane = await $.ui.mount(narrow)
  expect((await pane.find({ key: 'light-toggle' }))?.text).toContain('▾')
  // a session in no family has no heavy-branch system to show
  expect(await pane.find({ key: 'map-toggle' })).toBeUndefined()

  const cellsOf = (s: string) => [...s].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) >= 0x2190 && !((ch.codePointAt(0) ?? 0) >= 0x2500 && (ch.codePointAt(0) ?? 0) <= 0x259f) ? 2 : 1), 0)
  for (const b of await pane.findAll({ type: 'Button' })) {
    if (b.key === 'collapse' || b.key === 'reader') continue
    expect(cellsOf(b.text ?? '')).toBeLessThanOrEqual(30)
  }

  // fold the light system: its rows go
  await pane.press({ key: 'light-toggle' })
  expect((await pane.find({ key: 'light-toggle' }))?.text).toContain('▸')
  expect(await pane.find({ key: 'main' })).toBeUndefined()
  await pane.unmount()
})

test('light branches list newest first and mark the one last read; ↳ primes a follow-up; delete leaves no trace', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const filled: string[] = []
  const placed: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.place', (_, e) => {
    placed.push(e.id)
    return { value: { isPlaced: true, requestId: `req-${e.id}` } }
  })
  on('ui.scroll', () => ({ value: { isScrolled: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-6' }))
  on('env.get', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', () => ({ value: undefined }))
  on('session.turns', () => ({ value: 2 }))
  on('model.fork', () => ({
    value: { isAnswered: true, text: 'A', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'q', args: 'first' })
  await clock.advance(10)
  // /q always asks the session itself: a sibling, never a follow-up
  await $.command.run({ command: 'q', args: 'second' })
  await clock.advance(10)

  let pane = await $.ui.mount(PANE)
  const branchRows = async () => (await pane.findAll({ type: 'Button' })).filter(b => /\? (first|second)/.test(b.text ?? ''))
  let rows = await branchRows()
  expect(rows.map(b => (b.text ?? '').includes('second'))).toEqual([true, false])
  // same depth: neither hangs under the other
  expect(rows.every(b => /^\s*└ |^\s*├ /.test(b.text ?? ''))).toBe(true)

  // each /q placed its own row where it was asked
  expect(placed.length).toBe(2)
  expect(new Set(placed).size).toBe(2)
  // read the older one: its own row is asked for again (the engine answers
  // the row that stands), never a new row; it is marked
  await pane.press({ key: rows[1]!.key! })
  expect(placed.length).toBe(3)
  expect(placed[2]).toBe(placed[0])
  await pane.unmount()
  pane = await $.ui.mount(PANE)
  rows = await branchRows()
  expect(rows[1]?.text).toContain('剛看過')
  expect(rows[0]?.text).not.toContain('剛看過')
  await pane.unmount()

  // the reader's ↳ primes /q under it
  const row = placed.at(-1)!
  const reader = await $.ui.mount({
    plugin: 'session-branch-control',
    component: 'Placed',
    requestId: `req-${row}`,
    surface: 'terminal',
    props: { id: row, plugin: 'session-branch-control' },
  })
  await reader.press({ key: 'follow' })
  expect(filled).toEqual(['/qf '])
  // delete: gone from the tree, the mark and the reader
  await reader.press({ key: 'del' })
  await reader.unmount()
  pane = await $.ui.mount(PANE)
  rows = await branchRows()
  expect(rows.map(b => b.text ?? '').join()).not.toContain('first')
  expect(rows.map(b => b.text ?? '').join()).not.toContain('剛看過')
  await pane.unmount()
})

test('the heavy map names sessions as cc does and deletes one for real after a confirm', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const graphFile = '/h/.claude/session-branch-control/-w.json'
  const files = new Map<string, string>([
    [
      graphFile,
      JSON.stringify({
        sessions: {
          P: { id: 'P', title: 'first prompt of P', parentId: null, createdAt: -1e9 },
          K: { id: 'K', title: 'first prompt of K', parentId: 'P', createdAt: -1e9 },
        },
        pending: {},
      }),
    ],
    ['/h/.claude/projects/-w/P.jsonl', '{"type":"ai-title","aiTitle":"cc summary"}\n{"type":"user"}\n'],
    ['/h/.claude/projects/-w/K.jsonl', '{"type":"custom-title","customTitle":"old name"}\n{"type":"custom-title","customTitle":"my name"}\n'],
  ])
  const ran: string[][] = []
  const asked: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    for (const p of e.argv) files.delete(p)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'P' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  let pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 's-P' }))?.text).toContain('cc summary')
  expect((await pane.find({ key: 's-K' }))?.text).toContain('my name')
  expect(await pane.find({ key: 'm-sub' })).toBeUndefined()

  await pane.press({ key: 's-K' })
  expect(await pane.find({ key: 'm-tab' })).toBeDefined()
  expect(await pane.find({ key: 'm-here' })).toBeDefined()
  await pane.press({ key: 'm-del' })
  expect(ran).toEqual([])
  const dialog = await $.ui.mount({ ...PANE, requestId: 'sbc-confirm' })
  asked.push((await dialog.find({ type: 'Text', text: /永久刪除/ }))?.text ?? '')
  expect(asked[0]).toContain('my name')
  await dialog.press({ key: 'yes' })
  await dialog.unmount()
  expect(ran[0]).toEqual(['rm', '-rf', '/h/.claude/projects/-w/K.jsonl', '/h/.claude/projects/-w/K'])
  expect(Object.keys(JSON.parse(files.get(graphFile)!).sessions)).toEqual(['P'])
  await pane.unmount()
  // P alone is no family: the map is gone
  pane = await $.ui.mount(PANE)
  expect(await pane.find({ key: 'map-toggle' })).toBeUndefined()
  await pane.unmount()
})

test('sessions whose transcript is gone leave the map; a young one and the current one stay', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const graphFile = '/h/.claude/session-branch-control/-w.json'
  const files = new Map<string, string>([
    [
      graphFile,
      JSON.stringify({
        sessions: {
          P: { id: 'P', title: 'main', parentId: null, createdAt: -1e9 },
          old: { id: 'old', title: 'deleted', parentId: 'P', createdAt: -1e9 },
          kid: { id: 'kid', title: 'under deleted', parentId: 'old', createdAt: -1e9 },
          young: { id: 'young', title: 'just opened', parentId: 'P', createdAt: 0 },
        },
        pending: { old: 'x' },
      }),
    ],
  ])
  const existing = new Set(['/h/.claude/projects/-w/P.jsonl', '/h/.claude/projects/-w/kid.jsonl'])
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'P' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.exists', (_, e) => ({ value: existing.has(e.path) }))
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const g = JSON.parse(files.get(graphFile)!)
  expect(Object.keys(g.sessions).sort()).toEqual(['P', 'kid', 'young'])
  expect(g.sessions.kid.parentId).toBe('P')
  expect(g.pending).toEqual({})
})

test('prompt numbers run through a compaction: a branch takes the count, 📍 shows where the screen is', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const u = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
  const row = (o: Record<string, unknown>) => JSON.stringify({ isSidechain: false, sessionId: 'S', ...o })
  const prompt = (n: number, parent: string | null, text: string) => row({ type: 'user', uuid: u(n), parentUuid: parent, message: { role: 'user', content: text } })
  const reply = (n: number, parent: string) => row({ type: 'assistant', uuid: u(n), parentUuid: parent, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
  const lines = [
    prompt(1, null, 'first'),
    reply(2, u(1)),
    row({ type: 'user', uuid: u(3), parentUuid: u(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }),
    prompt(4, u(3), 'second'),
    reply(5, u(4)),
    // the compaction: a boundary leading back, its summary, then on
    row({ type: 'system', subtype: 'compact_boundary', uuid: u(6), parentUuid: null, logicalParentUuid: u(5) }),
    row({ type: 'user', uuid: u(7), parentUuid: u(6), isCompactSummary: true, message: { role: 'user', content: 'summary' } }),
    prompt(8, u(7), '<command-name>/q</command-name>'),
    prompt(9, u(8), 'third'),
    reply(10, u(9)),
  ]
  const files = new Map([['/h/.claude/projects/-w/S.jsonl', `${lines.join('\n')}\n`]])
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  const placed: string[] = []
  on('ui.place', (_, e) => {
    placed.push(e.id)
    return { value: { isPlaced: true, requestId: `req-${e.id}` } }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.turns', () => ({ value: 99 }))
  on('ui.panes', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', () => ({ value: undefined }))
  on('model.fork', () => ({
    value: { isAnswered: true, text: 'A', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'q', args: 'Q' })
  await clock.advance(10)

  // 3 prompts (a tool result, a command echo and the summary are none), counted across the compaction
  const pane = await $.ui.mount(PANE)
  const q = (await pane.findAll({ type: 'Button' })).find(b => /\? Q/.test(b.text ?? ''))
  expect(q?.text).toContain('#3')
  await pane.unmount()

  // the screen's top shows the reply to the second prompt
  const msg = await $.ui.mount({
    plugin: 'session-branch-control',
    component: 'AssistantMessage',
    requestId: u(5),
    surface: 'terminal',
    props: { onScreen: { first: 0, last: 3, of: 4 } },
  } as never)
  await msg.unmount()
  await clock.advance(100)
  const band = await $.ui.mount({
    plugin: 'session-branch-control',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect((await band.findAll({ type: 'Text' })).map(t => t.text).join('|')).toContain('📍 2/3')
  await band.unmount()

  // a rewind back to the second prompt's reply, then a new prompt from there:
  // the branch asked after the third prompt lost its context
  files.set('/h/.claude/projects/-w/S.jsonl', `${[...lines, prompt(11, u(5), 'redo'), reply(12, u(11))].join('\n')}\n`)
  // the file is re-read at most every 5 s for messages it did not have
  await clock.advance(6000)
  const fresh = await $.ui.mount({
    plugin: 'session-branch-control',
    component: 'AssistantMessage',
    requestId: u(12),
    surface: 'terminal',
    props: { onScreen: { first: 0, last: 3, of: 4 } },
  } as never)
  await fresh.unmount()
  await clock.advance(100)
  const after = await $.ui.mount(PANE)
  const marked = (await after.findAll({ type: 'Button' })).find(b => /\? Q/.test(b.text ?? ''))
  expect(marked?.text).toContain('↶')
  expect(toasts.join('\n')).toContain('支線回答好了')

  // its reader: the warning, ⚠ on what hands the answer on, delete left plain
  const reader = await $.ui.mount({
    plugin: 'session-branch-control',
    component: 'Placed',
    requestId: `req-${placed[0]}`,
    surface: 'terminal',
    props: { id: placed[0]!, plugin: 'session-branch-control' },
  })
  expect((await reader.find({ type: 'Text', text: /rewind/ }))?.text).toContain('rewind')
  for (const key of ['merge', 'up-here', 'up-tab', 'follow']) expect((await reader.find({ key }))?.text).toContain('⚠')
  expect((await reader.find({ key: 'del' }))?.text).not.toContain('⚠')
  await reader.unmount()
  await after.unmount()
})
