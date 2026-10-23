// chrome.runtime is not exposed to dedicated workers, so packaged files are
// resolved against the extension origin. Works in pages and workers alike.
export function packagedUrl(path: string): string {
  return new URL(path, `${self.location.origin}/`).href;
}
