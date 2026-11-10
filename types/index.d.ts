export type BranchKind = 'q' | 'wi'

export type BranchNode = {
  id: string
  kind: BranchKind
  /** null = hangs directly off the main thread */
  parentId: string | null
  text: string
  answer: string
  status: 'pending' | 'done' | 'error'
  /** main-thread turn count when the branch was opened */
  turn: number
  at: number
  /** already written back into the main thread's history */
  merged?: boolean
  /** upgraded into this heavy-branch session */
  upgradedTo?: string
  /** carried over from the parent session when this session was upgraded from it */
  inherited?: boolean
}

/** one real cc session in the project's session map */
export type SessionEntry = {
  id: string
  title: string
  parentId: string | null
  /** parent's turn count when it was forked */
  fromTurn?: number
  /** the light branch it was upgraded from, if any */
  fromBranch?: string
  createdAt: number
  /** Orca terminal handle of the tab it is open in right now */
  tab?: string
}

/** the project's session map, one JSON file per project, shared by every process */
export type Graph = {
  sessions: Record<string, SessionEntry>
  /** history records waiting for a child session to write them in at its start */
  pending: Record<string, string>
  /** an in-place fork this process asked for, finished once the switch lands */
  inplace?: { parentId: string; title: string; record?: string; fromBranch?: string; fromTurn: number; at: number }
}

/** the full-width reading row placed in the transcript (`$.ui.place`) */
export type Reader = {
  /** the placed row's id; null = no reader row */
  row: string | null
  /** the placed row's requestId, what `$.ui.scroll` takes */
  req: string | null
  /** the branch node it shows */
  node: string | null
  /** expanded (true) or folded to one line */
  open: boolean
  /** requestId of the transcript message that was at the top before jumping */
  back: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-branch-control': {
      nodes: Shaped<BranchNode[]>
      selected: string | null
      isOpen: boolean
      graph: Shaped<Graph>
      currentId: string
      liveTabs: string[]
      mapCollapsed: boolean
      mapSelected: string | null
      reader: Reader
    }
  }
}
