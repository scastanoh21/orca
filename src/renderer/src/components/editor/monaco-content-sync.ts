import type { editor } from 'monaco-editor'

/**
 * Overwrite a Monaco model's text via pushEditOperations so the change
 * participates in the undo stack (unlike setValue, which blows it away).
 */
function replaceModelContent(
  editorInstance: editor.IStandaloneCodeEditor,
  model: editor.ITextModel,
  currentContent: string,
  content: string,
  withUndoStops: boolean
): void {
  if (currentContent === content) {
    return
  }
  const fullRange = model.getFullModelRange()
  if (withUndoStops) {
    editorInstance.pushUndoStop()
  }
  model.pushEditOperations([], [{ range: fullRange, text: content }], () => null)
  if (withUndoStops) {
    editorInstance.pushUndoStop()
  }
}

/**
 * Reconcile a freshly-mounted editor's retained model against the current
 * `content`. Used from handleMount.
 *
 * Why: `keepCurrentModel` retains Monaco models across unmounts so undo/redo
 * survives tab switches. But @monaco-editor/react skips its value→model sync
 * on the first render after a remount and reuses the retained model — so
 * external changes that arrived while the tab was unmounted are invisible
 * until we explicitly push them into the model here.
 */
export function syncContentOnMount(
  editorInstance: editor.IStandaloneCodeEditor,
  content: string
): boolean {
  const model = editorInstance.getModel()
  if (!model) {
    return false
  }
  const currentContent = model.getValue()
  if (currentContent === content) {
    return false
  }
  // Why: no undo stop on mount — the retained model's text was already the
  // user's last-known state, and adding an undo entry here would make Cmd+Z
  // revert to the pre-remount text, which is confusing.
  replaceModelContent(editorInstance, model, currentContent, content, false)
  return true
}

/**
 * Push a prop-driven content change into the live model. Used from a
 * useEffect that runs whenever `content` changes.
 *
 * Why: handles the live-mount update path — external file changes that
 * arrive while the editor stays mounted. The emitted-content short-circuit
 * is done at the call site before invoking this.
 */
export function syncContentUpdate(
  editorInstance: editor.IStandaloneCodeEditor,
  content: string
): void {
  const model = editorInstance.getModel()
  if (!model) {
    return
  }
  const currentContent = model.getValue()
  if (currentContent.length === content.length) {
    replaceModelContent(editorInstance, model, currentContent, content, true)
    return
  }
  if (content.length > currentContent.length && content.startsWith(currentContent)) {
    // Why: preserving the existing prefix lets Monaco retain viewport,
    // selection, find-widget, and tokenization state above a live-file append.
    const fullRange = model.getFullModelRange()
    editorInstance.pushUndoStop()
    model.pushEditOperations(
      [],
      [
        {
          range: {
            startLineNumber: fullRange.endLineNumber,
            startColumn: fullRange.endColumn,
            endLineNumber: fullRange.endLineNumber,
            endColumn: fullRange.endColumn
          },
          text: content.slice(currentContent.length)
        }
      ],
      () => null
    )
    editorInstance.pushUndoStop()
    return
  }
  replaceModelContent(editorInstance, model, currentContent, content, true)
}
