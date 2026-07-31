
<!-- cogitlog:begin -->
## cogitlog

This repository records **why** its changes were made — decisions, the alternatives that
were rejected, and the attempts that failed — in `.cogitlog/`.

### Read it before you edit

If a piece of code looks arbitrary, assume it isn't: someone may have already tried the
obvious thing and logged why it failed. Check before rewriting it.

  cogitlog why <file>              # decisions that touched this file
  cogitlog query "<topic>"         # full-text search across every session
  cogitlog log                     # recent sessions, newest first
  cogitlog log -d                  # ...with a one-line description per event
  cogitlog show <session-id>       # one session in full

**Nothing installed?** Either `npm i -g cogitlog` and use the commands above, or read the
store directly — `.cogitlog/sessions/*.jsonl` is plain JSONL, one event per line, one file
per session, human-readable with no tooling at all.

### Write it as you work

At the start of every task, open a session:

  cogitlog begin "<what you intend to do>"

Record events when they happen:
  - After choosing between alternatives: `cogitlog decision "<what and why>" -a "rejected:reason"`
  - After a fix or implementation attempt: `cogitlog attempt "<what you tried>" [succeeded|failed|partial]`
  - When you notice something worth remembering: `cogitlog note "<observation>"`
  - Before closing, if any choice was borderline: `cogitlog uncertainty "<the doubt>"`

A failed attempt is worth more than a successful one — it is what stops the next person
from walking back into the same dead end.

At the end, close the session:

  cogitlog close --outcome <completed|partial|abandoned|interrupted>

Run `cogitlog onboard` for full instructions.
<!-- cogitlog:end -->

