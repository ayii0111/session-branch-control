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
  await $.command.run({ command: 'wi', args: '若改用 OT' })
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
