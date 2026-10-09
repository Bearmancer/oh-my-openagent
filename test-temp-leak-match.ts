export type ReportOnlyList = Readonly<Record<string, readonly string[]>>

/** A report-only entry ending in "$" names one temp entry exactly; any other entry is a prefix of the names derived from it. */
export function reportOnlyEntryMatches(entry: string, name: string): boolean {
  return entry.endsWith("$") ? name === entry.slice(0, -1) : name.startsWith(entry)
}

export function reportOnlyOwner(name: string, list: ReportOnlyList): string | undefined {
  for (const [owner, entries] of Object.entries(list)) {
    if (entries.some((entry) => reportOnlyEntryMatches(entry, name))) return owner
  }
  return undefined
}
