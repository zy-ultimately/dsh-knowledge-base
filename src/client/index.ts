/**
 * Browser-half entry for the dsh-knowledge-base plugin — runs inside the dsh
 * web GUI. Registers the centered modal panel in the `shell.overlay` frame
 * layer and injects the left-sidebar entry row (same UI family as the task
 * board): a 32px icon row that toggles the panel via the `dsh-kb-toggle`
 * window event.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { KbApi } from './api.ts'
import { KbOverlay } from './KbOverlay.tsx'

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots']

/** Type-only surface. */
export type { KbOverlayProps } from './KbOverlay.tsx'
export type { KbApi, KbApiError } from './api.ts'

/** Stable data attribute identifying the injected sidebar entry. */
const KB_ENTRY_SELECTOR = '[data-dsh-kb-entry]'

/** Inline icon (matches the shell's 16px nav-icon look). */
const KB_ENTRY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9v11h-9A1.5 1.5 0 0 0 2 14.5z"/><path d="M2 3.5v11M5 5.5h5M5 8h5"/></svg>'

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The New Session button (the placement anchor for the entry row). */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** Build the entry row (a detached button; inserted once the shell is up). */
function createEntry(): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshKbEntry = ''
  entry.className = 'dsh-kb-entry'
  entry.setAttribute('aria-label', '知识库')
  entry.innerHTML = `<span class="dsh-kb-entryIcon">${KB_ENTRY_ICON}</span><span class="dsh-kb-entryLabel">知识库</span>`
  entry.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('dsh-kb-toggle'))
  })
  return entry
}

/** Insert the entry after the New Session row, next to sibling plugin entries. */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-kb-entry]'),
    )
    const kbIndex = family.findIndex((el) => el.matches(KB_ENTRY_SELECTOR))
    if (kbIndex !== -1) return true // already in place
    const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling
    root.insertBefore(entry, anchor)
  }
  return true
}

/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @returns disposer removing the entry and its observers.
 */
function mountSidebarEntry(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(KB_ENTRY_SELECTOR) !== null) return () => {}
  const entry = createEntry()
  let root: HTMLElement | undefined
  let placed = false

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root = root ?? sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }

  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = placeEntry(root, entry)
  })

  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    entry.remove()
  }
}

/**
 * Mount the KB overlay + sidebar entry.
 * @param ctx - client root context (slots service).
 */
export function apply(ctx: ClientContext): void {
  const api = new KbApi()
  ctx.effect(
    () => ctx.slots.register(
      { name: 'shell.overlay', id: 'knowledge-base', order: 90, label: '知识库' },
      () => <KbOverlay api={api} />,
    ),
    'kb: shell.overlay occupant',
  )
  const disposer = mountSidebarEntry()
  ctx.effect(() => () => { disposer() }, 'kb: sidebar entry')
}
