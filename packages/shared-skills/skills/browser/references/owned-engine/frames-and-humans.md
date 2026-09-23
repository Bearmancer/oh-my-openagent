# Frames, overlays, dialogs, and the human

## Cross-origin frames and shadow DOM

A cross-origin iframe is a separate target with its own snapshot. Reconcile the child trees into
the parent so one tree describes the whole page, and address child elements through the page-level
ref — never by fetching a frame handle first. Shadow roots are traversed by the snapshot engine;
they are not a special case for you.

## Overlays that swallow clicks

Two identical misses on an element that is clearly visible usually means something invisible sits
on top: a consent banner, a modal backdrop, a sticky header, a full-viewport tracking layer.
Describe the layers at the click point before you retry. Either the overlay is named — dismiss it
and continue — or nothing is reported, which means the miss has another cause and you climb the
ladder instead.

## Dialogs never block

`alert`, `confirm`, `prompt`, and `beforeunload` must be answered by a policy set when the
browser is created, not by a listener you hope registers in time. Default to accepting
(`confirm` true, `prompt` empty). A run that hangs on an unhandled dialog looks exactly like a
hang with no cause, which is the most expensive kind to diagnose.

## Device emulation

Emulating a device is viewport plus user agent plus touch, applied together. Changing only the
viewport produces a desktop page at a phone size, which is not what you are testing. Re-read the
viewport after emulating, and re-pin coordinates.

## Handing the page to a human

When every rung fails on a login, a one-time code, or a challenge you cannot clear, the human is
the fallback, not the failure. Bring the tab to the front, state plainly what needs doing, and
wait on a **condition** — the URL changed, the element appeared — with a bounded timeout, rather
than on a fixed delay.

Respect the answer. A cancelled or timed-out handoff is a stop, and the correct response is to
report which rung failed with what evidence. Working around the user's refusal is never correct.
