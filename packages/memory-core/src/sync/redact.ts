/**
 * Secret-like material scanner and redactor for the memory boundary.
 *
 * One exported scanner with span reporting, shared by every surface that must
 * refuse or mask secret-like text: the sync mirror, the compiled projection,
 * recall hints, command output, and the commit gates. Matching runs on a
 * normalised shadow of the input (format characters and zero-width codepoints
 * stripped, non-breaking spaces folded) so split or visually obfuscated
 * credentials cannot evade it, and spans map back to the original string so
 * masking rewrites the original bytes. The matched text is never logged or
 * returned - only the pattern class and the span.
 */

const MASK = "***"

export type SecretPatternClass =
  | "aws_access_key"
  | "credential_assignment"
  | "authorization_header"
  | "openai_key"
  | "vendor_token"
  | "pem_block"
  | "split_credential_assignment"

export interface SecretMatch {
  readonly class: SecretPatternClass
  readonly start: number
  readonly end: number
}

/**
 * The value tail of the assignment-style classes stops at whitespace, quotes,
 * angle brackets, commas and closing delimiters, so a credential inside a JSON
 * string, an XML attribute or a Markdown link stays delimited and the
 * surrounding text survives masking.
 */
const SECRET_VALUE_TAIL = "[^\\s\"'<>,}\\])]"

export const SECRET_PATTERN_SOURCES: ReadonlyArray<readonly [SecretPatternClass, string, string]> = [
  ["aws_access_key", "\\bAKIA[0-9A-Z]{16}\\b", ""],
  [
    "credential_assignment",
    `\\b(?:bearer|token|api[_-]?key|secret|password|passwd|pwd)\\s*[=:]\\s*${SECRET_VALUE_TAIL}{1,256}`,
    "i",
  ],
  ["authorization_header", `\\bAuthorization\\s*:\\s*Bearer\\s+${SECRET_VALUE_TAIL}{1,256}`, "i"],
  ["openai_key", "\\bsk-(?:proj-)?[-_A-Za-z0-9]+\\b", ""],
  ["vendor_token", "\\b(?:ghp|github_pat|glpat|xox[baprs])[-_][-_A-Za-z0-9]+\\b", ""],
]

/**
 * Credential keys written with whitespace between the letters (`t o k e n`),
 * which the unsplit class cannot match. Applied only where no plain match
 * covers the span, so a normal assignment is never double-reported.
 */
const SPLIT_CREDENTIAL_ASSIGNMENT_SOURCE = `(?:a\\s*u\\s*t\\s*h\\s*o\\s*r\\s*i\\s*z\\s*a\\s*t\\s*i\\s*o\\s*n|p\\s*a\\s*s\\s*s\\s*w\\s*(?:o\\s*r\\s*)?d|s\\s*e\\s*c\\s*r\\s*e\\s*t|t\\s*o\\s*k\\s*e\\s*n|a\\s*p\\s*i\\s*[_-]?\\s*k\\s*e\\s*y)\\s*[:=]\\s*${SECRET_VALUE_TAIL}{6,256}`

const FORMAT_CHARACTER = /\p{Cf}/u

type FormatCharacterHandling = "drop" | "separate"

/**
 * Build a scan shadow of `text`: NBSP folds to a plain space, and C0 controls other than LF/TAB and
 * Unicode format characters (zero-width codepoints, bidi controls, BOM, tag characters) are either
 * dropped, which rejoins a secret split inside a word, or turned into a space, which keeps
 * the word boundary the patterns anchor on when one glues a word character to a secret. `map[i]` is
 * the original string index of shadow unit `i`, so a span found in the shadow maps back to the exact
 * original bytes to mask.
 */
function normalizeForSecretScan(text: string, formatCharacters: FormatCharacterHandling): Shadow {
  let shadow = ""
  const map: number[] = []
  const seams = new Set<number>()
  let dropped = false
  for (let index = 0; index < text.length; ) {
    // Walk by code point: a format character above U+FFFF (the tag block) is two UTF-16 units, and
    // neither lone surrogate matches \p{Cf}, so a per-unit walk would keep it in the shadow.
    const code = text.codePointAt(index) ?? 0
    const width = code > 0xffff ? 2 : 1
    const char = text.slice(index, index + width)
    const control = code < 0x20 && code !== 0x0a && code !== 0x09
    if (code === 0x00a0 || (formatCharacters === "separate" && (control || FORMAT_CHARACTER.test(char)))) {
      shadow += " "
      map.push(index)
    } else if (!control && !FORMAT_CHARACTER.test(char)) {
      if (dropped) seams.add(shadow.length)
      dropped = false
      shadow += char
      for (let unit = 0; unit < width; unit += 1) map.push(index + unit)
    } else {
      dropped = true
    }
    index += width
  }
  if (dropped) seams.add(shadow.length)
  return { shadow, map, seams }
}

/** `seams` are the shadow indices where a dropped character used to sit, i.e. where a word boundary may be hidden. */
type Shadow = { readonly shadow: string; readonly map: readonly number[]; readonly seams: ReadonlySet<number> }

function originalSpan({ map }: Shadow, start: number, end: number): { start: number; end: number } | undefined {
  const originalStart = map[start]
  const originalLast = map[end - 1]
  if (originalStart === undefined || originalLast === undefined) return undefined
  return { start: originalStart, end: originalLast + 1 }
}

function patternMatches(scan: Shadow, patternClass: SecretPatternClass, source: string, flags: string): SecretMatch[] {
  const found: SecretMatch[] = []
  const pattern = new RegExp(source, `${flags}g`)
  let match: RegExpExecArray | null
  while ((match = pattern.exec(scan.shadow)) !== null) {
    const span = originalSpan(scan, match.index, match.index + match[0].length)
    if (span !== undefined) found.push({ class: patternClass, ...span })
  }
  return found
}

const containedByAny = (matches: readonly SecretMatch[], span: SecretMatch): boolean =>
  matches.some((existing) => existing.start <= span.start && span.end <= existing.end)

const WORD = /[A-Za-z0-9_]/
const LEADING_BOUNDARY = "\\b"

/**
 * Boundary-anchored patterns retried at every seam of the joined shadow, with the leading `\b` replaced by
 * the seam itself. A dropped character that glued a word to a token hides that boundary, and the separated
 * scan only sees the token up to the next inner character, so neither pass alone masks the whole token.
 * A trailing `\b` must still hold, or the match must end at another seam.
 */
function seamMatches(scan: Shadow): SecretMatch[] {
  const found: SecretMatch[] = []
  for (const [patternClass, source, flags] of SECRET_PATTERN_SOURCES) {
    if (!source.startsWith(LEADING_BOUNDARY)) continue
    const trailing = source.endsWith(LEADING_BOUNDARY)
    const body = source.slice(LEADING_BOUNDARY.length, trailing ? -LEADING_BOUNDARY.length : undefined)
    const pattern = new RegExp(body, `${flags}y`)
    for (const seam of scan.seams) {
      pattern.lastIndex = seam
      const match = pattern.exec(scan.shadow)
      if (match === null) continue
      const end = seam + match[0].length
      const boundary = WORD.test(scan.shadow[end - 1] ?? "") !== WORD.test(scan.shadow[end] ?? "")
      if (trailing && !boundary && !scan.seams.has(end)) continue
      const span = originalSpan(scan, seam, end)
      if (span !== undefined) found.push({ class: patternClass, ...span })
    }
  }
  return found
}

export function scanSecretLikeMaterial(value: string): SecretMatch[] {
  if (!value) return []
  const joined = normalizeForSecretScan(value, "drop")
  const separated = normalizeForSecretScan(value, "separate")
  const matches: SecretMatch[] = []
  let pemOffset = 0
  while (true) {
    const block = findPemBlock(joined.shadow, pemOffset)
    if (block === undefined) break
    const span = originalSpan(joined, block.start, block.end)
    if (span !== undefined) matches.push({ class: "pem_block", ...span })
    pemOffset = block.end
  }
  for (const [patternClass, source, flags] of SECRET_PATTERN_SOURCES) matches.push(...patternMatches(joined, patternClass, source, flags))
  // A format character between a word character and a secret hides the secret's leading or trailing
  // \b once dropped; the separated shadow keeps that boundary. A separated match is kept unless a joined
  // match already covers all of it: one that only overlaps (a token read through the next key) would
  // otherwise leave the rest of the secret unmasked. The split pass follows the same rule. Masking merges
  // the overlapping spans.
  for (const [patternClass, source, flags] of SECRET_PATTERN_SOURCES) {
    for (const match of patternMatches(separated, patternClass, source, flags)) if (!containedByAny(matches, match)) matches.push(match)
  }
  for (const match of seamMatches(joined)) if (!containedByAny(matches, match)) matches.push(match)
  for (const match of patternMatches(joined, "split_credential_assignment", SPLIT_CREDENTIAL_ASSIGNMENT_SOURCE, "i")) {
    if (!containedByAny(matches, match)) matches.push(match)
  }
  return matches.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function containsSecretLikeMaterial(value: string): boolean {
  return scanSecretLikeMaterial(value).length > 0
}

export function redactSecretLikeMaterial(value: string): string {
  if (!value) return ""
  const matches = scanSecretLikeMaterial(value)
  if (matches.length === 0) return value
  const merged: Array<{ start: number; end: number }> = []
  for (const match of matches) {
    const last = merged[merged.length - 1]
    if (last !== undefined && match.start <= last.end) {
      last.end = Math.max(last.end, match.end)
    } else {
      merged.push({ start: match.start, end: match.end })
    }
  }
  let redacted = ""
  let cursor = 0
  for (const span of merged) {
    redacted += `${value.slice(cursor, span.start)}${MASK}`
    cursor = span.end
  }
  return `${redacted}${value.slice(cursor)}`
}

function findPemBlock(value: string, from = 0): { readonly start: number; readonly end: number } | undefined {
  const begin = value.indexOf("-----BEGIN ", from)
  if (begin < 0) return undefined
  const labelEnd = value.indexOf("-----", begin + 11)
  if (labelEnd < 0 || labelEnd - (begin + 11) > 64) return undefined
  const label = value.slice(begin + 11, labelEnd)
  if (label.length === 0 || /[^A-Za-z0-9 ]/.test(label)) return undefined
  let endMarker = value.indexOf("-----END ", labelEnd + 5)
  while (endMarker >= 0) {
    const endLabelStart = endMarker + 9
    const endLabelEnd = value.indexOf("-----", endLabelStart)
    if (endLabelEnd >= 0 && value.slice(endLabelStart, endLabelEnd) === label) {
      return { start: begin, end: endLabelEnd + 5 }
    }
    endMarker = value.indexOf("-----END ", endLabelEnd >= 0 ? endLabelEnd + 5 : endLabelStart)
  }
  return undefined
}

/**
 * `scheme://user:pass@` and `scheme://user@` inside arbitrary text.
 *
 * The userinfo character class deliberately excludes `/` and `@` so the match
 * cannot run past an authority boundary and swallow a path segment.
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]{1,256})(?::([^/@\s]{0,256}))?@/gi

/**
 * scp-style `user@host:path` (no scheme), anchored on a word boundary so a
 * plain email address inside a sentence is not rewritten into a URL shape.
 */
const SCP_USERINFO = /(^|[\s'"(<])([^\s:/@]{1,256})@([^\s:/@]{1,256}):/g

/**
 * Mask credentials in a URL, or in free text containing URLs.
 *
 * Both halves of a `user:password` pair are masked: the username of a token
 * pair is often the secret itself (`x-access-token:<token>` is the inverse of
 * `<token>:x-oauth-basic`), and a bare username still leaks account identity.
 * URLs without userinfo - `file://`, plain `https://` and local paths - are
 * returned unchanged.
 */
export function redactUrl(value: string): string {
  if (!value) return ""
  const withUrlCredentials = value.includes("://")
    ? value.replace(URL_USERINFO, (_match, scheme: string, _user: string, password?: string) =>
      password === undefined ? `${scheme}${MASK}@` : `${scheme}${MASK}:${MASK}@`,
    )
    : value
  const withScpCredentials = withUrlCredentials.includes("@")
    ? withUrlCredentials.replace(SCP_USERINFO, (_match, prefix: string, _user: string, host: string) =>
      `${prefix}${MASK}@${host}:`,
    )
    : withUrlCredentials
  return redactSecretLikeMaterial(withScpCredentials)
}
