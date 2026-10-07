import { describe, expect, it } from "bun:test"
import { redactSecretLikeMaterial, scanSecretLikeMaterial } from "./redact"

describe("scanSecretLikeMaterial / redactSecretLikeMaterial with format and control characters", () => {
  describe("#given a format character outside the Basic Multilingual Plane inside a secret", () => {
    // A supplementary-plane format character is two UTF-16 units; the scanner must strip it whole.
    const OUTSIDE_BMP_FORMAT = String.fromCodePoint(0xe0020)
    const splitAt = (value: string, index: number): string => `${value.slice(0, index)}${OUTSIDE_BMP_FORMAT}${value.slice(index)}`

    it.each([
      ["a credential key", splitAt("token=abc123456def", 3), "credential_assignment"],
      ["a vendor token prefix", splitAt("ghp_AAAABBBBCCCCDDDD1111", 3), "vendor_token"],
      ["an OpenAI-style key prefix", splitAt("sk-proj-AAAABBBBCCCC", 3), "openai_key"],
    ] as const)("#then %s split by it is still detected and its original span masked", (_label, secret, expectedClass) => {
      // given
      const embedded = `before ${secret} after`

      // when
      const matches = scanSecretLikeMaterial(embedded)
      const masked = redactSecretLikeMaterial(embedded)

      // then
      expect(matches.map((match) => match.class)).toEqual([expectedClass])
      expect(masked).toBe("before *** after")
    })
  })

  describe("#given a format character gluing a word character to a secret", () => {
    // Stripping the character must not erase the word boundary the secret patterns anchor on.
    const formatCharacters = [["a zero-width space", "\u200b"], ["a format character outside the BMP", String.fromCodePoint(0xe0020)]] as const
    const secrets = [
      ["a vendor token", "ghp_AAAABBBBCCCCDDDD1111", "vendor_token"],
      ["an OpenAI-style key", "sk-proj-AAAABBBBCCCC", "openai_key"],
      ["an AWS access key id", "AKIAABCDEFGHIJKLMNOP", "aws_access_key"],
      ["a credential assignment", "token=abc123456def", "credential_assignment"],
    ] as const
    const cases = formatCharacters.flatMap(([formatLabel, format]) =>
      secrets.map(([secretLabel, secret, expectedClass]) => [`${secretLabel} after ${formatLabel}`, format, secret, expectedClass] as const))

    it.each(cases)("#then %s is still detected and only the secret is masked", (_label, format, secret, expectedClass) => {
      // given
      const embedded = `before x${format}${secret} after`

      // when
      const matches = scanSecretLikeMaterial(embedded)
      const masked = redactSecretLikeMaterial(embedded)

      // then
      expect(matches.map((match) => match.class)).toEqual([expectedClass])
      expect(masked).toBe(`before x${format}*** after`)
    })

    it.each(formatCharacters)("#then an AWS access key id glued to a following word character by %s is still detected", (_label, format) => {
      // given
      const embedded = `before AKIAABCDEFGHIJKLMNOP${format}x after`

      // when
      const masked = redactSecretLikeMaterial(embedded)

      // then
      expect(masked).toBe(`before ***${format}x after`)
    })
  })

  describe("#given characters outside the BMP that are kept before a secret", () => {
    it("#then the masked span still covers exactly the secret", () => {
      // given
      const kept = String.fromCodePoint(0x1f600)
      const embedded = `${kept}${kept} token=abc123456def tail`

      // when
      const masked = redactSecretLikeMaterial(embedded)

      // then
      expect(masked).toBe(`${kept}${kept} *** tail`)
    })
  })

  describe("#given a vendor token and a credential assignment joined by a format character", () => {
    // The joined scan reads the token through the credential key; the separated scan's credential match
    // overlaps that token span and must still be kept, or the credential value is left unmasked.
    const formatCharacters = [["a zero-width space", "\u200b"], ["a format character outside the BMP", String.fromCodePoint(0xe0020)]] as const
    const tokens = [["a vendor token", "ghp_AAAABBBBCCCCDDDD1111"], ["an OpenAI-style key", "sk-proj-AAAABBBBCCCC"]] as const
    const cases = formatCharacters.flatMap(([formatLabel, format]) => tokens.map(([tokenLabel, token]) => [`${tokenLabel} and ${formatLabel}`, format, token] as const))

    it.each(cases)("#then with %s both secrets are masked", (_label, format, token) => {
      // given
      const embedded = `before ${token}${format}token=hunter2hunter2 after`

      // when
      const masked = redactSecretLikeMaterial(embedded)

      // then
      expect(masked).toBe("before *** after")
    })
  })

  describe("#given a glued credential key whose value holds an invisible or control character", () => {
    // The joined pass loses the keyword's boundary, the separated pass stops at the inner character, and
    // the split pass covers the whole value: its match must survive overlapping the shorter one.
    const glues = [["a zero-width space", "\u200b"], ["a format character outside the BMP", String.fromCodePoint(0xe0020)], ["a NUL", "\u0000"]] as const
    const inner = [["a zero-width space", "\u200b"], ["a format character outside the BMP", String.fromCodePoint(0xe0020)], ["an ESC", "\u001b"]] as const
    const keys = ["token=", "password:"] as const
    const cases = glues.flatMap(([glueLabel, glue]) => inner.flatMap(([innerLabel, mid]) =>
      keys.map((key) => [`${key} glued by ${glueLabel} with ${innerLabel} in its value`, glue, key, mid] as const)))

    it.each(cases)("#then with %s no part of the value survives masking", (_label, glue, key, mid) => {
      // given
      const embedded = `before x${glue}${key}firsthalf${mid}secondhalf after`

      // when
      const masked = redactSecretLikeMaterial(embedded)

      // then
      expect(masked).not.toContain("firsthalf")
      expect(masked).not.toContain("secondhalf")
      expect(masked.startsWith("before x")).toBe(true)
      expect(masked.endsWith(" after")).toBe(true)
    })
  })

  describe("#given a control character gluing a word character to a secret", () => {
    it("#then the secret is still detected and only the secret is masked", () => {
      // given
      const embedded = "before x\u0000ghp_AAAABBBBCCCCDDDD1111 after"

      // when
      const masked = redactSecretLikeMaterial(embedded)

      // then
      expect(masked).toBe("before x\u0000*** after")
    })
  })
})
