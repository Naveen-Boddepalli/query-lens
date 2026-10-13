# LESSONS.md — Post-mortems and observations

Maintained by the orchestrator only. Newest first. Keep under ~100 entries.
Format: `- [YYYY-MM-DD][T<id>][area] Symptom → Cause → Fix/Rule.`
Mark entries `(promoted)` once they are copied into GEMINI.md §7.

- [2026-10-13][R1-R3][ao] `ao pr merge <num>` returns INVALID_PR (URL and expected head SHA required) when provider link is untracked → CLI requires GitHub PR metadata → Use `gh pr merge <num> --repo SAM3114/query-lens --merge` as verified fallback. (promoted)
- [2026-10-13][R1-R3][ao] Native code review submit via `ao review submit --session <id> --reviews -` → Takes stdin JSON with `runId`, `verdict`, and `body` → Submits machine-readable status `approved` or `changes_requested`. (promoted)
- [2026-10-13][bootstrap][fs] Writing to root PLAN.md on macOS APFS overwrites existing 3000-line plan.md → APFS is case-insensitive by default → Keep product plan.md safe and store task plan in docs/PLAN.md. (promoted)
- [2026-10-13][bootstrap][ao] `ao send` requires `--session <id> --message "<msg>"`; positional args fail → CLI rejects positional arguments for session or message → Use exact flag syntax. (promoted)
- [2026-10-13][bootstrap][ao] `ao spawn` requires `--name <label>` (max 100 chars) and does not take positional project arg → Positional project fails with `accepts 0 arg(s), received 1` → Use `--project query-lens --name "<name>" --prompt "..."`. (promoted)
- [2026-10-13][bootstrap][ao] `ao dashboard` is not a valid subcommand → Unknown command error → Use `ao status` or `ao start`. (promoted)
- [2026-10-13][setup][agy] Worker exited with empty output → agy print mode drops stdout when not a TTY → Write results to files/PR, never rely on stdout. (promoted)
