# Read the network, not the DOM

When a page renders a list, a table, or search results, the data almost always arrived as JSON one
request earlier. That JSON is complete, typed, free of markup, and immune to the layout changing
next week. Watching traffic costs nothing on a target you own, and the page cannot observe it.

**Snoop before you scrape.** Scroll-and-parse is the fallback, not the default.

## Wait for a request, never for a clock

A fixed sleep is a guess that fails on a slower machine and wastes time on a faster one. Subscribe
to the response you expect **before** triggering the action, then await that signal with a bounded
timeout. This is the same rule that governs test code, for the same reason.

## Collecting through infinite scroll

Drive scroll and extraction as a generator: scroll, collect what is new, stop on a target count or
a scroll ceiling. Bound both, so a page that keeps producing cannot run forever.

## Flight traces

For QA evidence, record a trace: one entry per step with before/after screenshots, the network
log, and console output, written as a line-delimited log plus an HAR. That triple is what makes a
failure reconstructable afterwards instead of re-runnable-in-theory.

Cap recorded body sizes. An untrimmed trace of a media-heavy page is mostly bytes nobody reads.

## Request interception

Route matching by glob, regular expression, or predicate lets you stub an endpoint, fail one
request to test an error path, or block third-party noise. Enable interception on the first route
and disable it on dispose — leaving it on slows every later navigation.

## Cookies

Injecting a cookie export into your own profile is legitimate for ordinary sessions and useless
for the ones you most want: accounts whose risk engines bind a session to a device will invalidate
it, and a password manager's session is tab-bound and never portable. Sanitize what you do inject
(drop expired entries, keep host-prefixed cookies secure and root-scoped).

**Never copy a session out of the user's real browser profile.** If you need their login, that is
the attached engine's job.
