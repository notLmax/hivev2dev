# shared/exchange — inter-agent file hand-offs

When an agent sends another agent a hivemind message larger than Discord's
limit, the full content is written here as a markdown file and the recipient
is pointed at it (they Read the file before responding). This avoids the
silent Discord-400 that would otherwise drop large delegations.

Files are named `<from>-<to>-<slug>-<YYYYMMDD-HHMMSS>.md` and are ephemeral —
this directory and its README are tracked; everything else is throwaway and
gitignored. Safe to delete old hand-off files at any time.
