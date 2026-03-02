function normalizeEscapedNewlines(value: string): string {
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

function truncateWithEllipsis(input: string, maxLen: number): string {
  if (input.length <= maxLen) return input
  return `${input.slice(0, maxLen - 1)}…`
}

export function toHistoryTitleSnippet(title: string, sessionId: string, maxLen = 36): string {
  const normalized = normalizeEscapedNewlines(title || '')
  const firstLine = normalized
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const base = (firstLine || sessionId || '').replace(/\s+/g, ' ').trim() || sessionId
  return truncateWithEllipsis(base, maxLen)
}

export function toHistorySummaryText(summary: string): string {
  const normalized = normalizeEscapedNewlines(summary || '')
    .replace(/\t/g, '  ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
  return normalized || '(No summary yet)'
}
