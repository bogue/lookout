import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

// Settings → "Open links in your default browser". Off (the default): a click opens the in-app
// window, CMD+click the default browser. On: the other way round, so both stay one gesture away.
let preferBrowser = false
export const setOpenLinksInBrowser = (on: boolean) => {
  preferBrowser = on
}

// One window per PR (label = repo + number): re-clicking focuses instead of opening another tab.
// Built Rust-side (open_pr_window) so a navigation toolbar is injected into every page.
// cmd = the link was CMD+clicked: it flips whichever of the two the setting made the default.
export const openPrWindow = async (url: string, repo: string, prNumber: number, cmd = false) => {
  if (cmd !== preferBrowser) {
    await openUrl(url)
    return
  }
  const label = `pr-${repo}-${prNumber}`.replace(/[^a-zA-Z0-9-]/g, '-')
  await invoke('open_pr_window', { label, url, title: `${repo}#${prNumber}` })
}
