/**
 * Trigger a browser download for generated content.
 * No-op outside the browser (tests, SSR).
 */
export function downloadFile(
  fileName: string,
  data: Uint8Array | string,
  mimeType: string,
): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return

  const blobPart: BlobPart =
    typeof data === 'string'
      ? data
      : new Uint8Array(data).slice().buffer
  const blob = new Blob([blobPart], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoke on the next tick so the click has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
