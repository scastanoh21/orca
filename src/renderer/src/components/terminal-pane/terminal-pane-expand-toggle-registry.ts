type TerminalPaneExpandToggleHandler = () => boolean

const handlersByTabId = new Map<string, TerminalPaneExpandToggleHandler>()

export function registerTerminalPaneExpandToggleHandler(
  tabId: string,
  handler: TerminalPaneExpandToggleHandler
): () => void {
  handlersByTabId.set(tabId, handler)
  return () => {
    if (handlersByTabId.get(tabId) === handler) {
      handlersByTabId.delete(tabId)
    }
  }
}

export function requestRegisteredTerminalPaneExpandToggle(tabId: string): boolean {
  return handlersByTabId.get(tabId)?.() === true
}
