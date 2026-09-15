<div align="center">
  <img src="assets/banner.png" alt="Lookout" width="820">
  <p><sub><em>Your GitHub lookout.</em></sub></p>
  <br />
</div>

Desktop overview of all your Claude Code review sessions: discover open PRs across hand-picked repos, dispatch review/follow-up sessions, track follow-ups, auto-clear merged PRs.

Tauri v2 + React + TypeScript + Tailwind. No remote server — everything runs locally: the app polls `gh`, scans `~/.claude/projects/` sessions and each repo's `AI_TASKS/code-review/` exports.

> ⚠️ **Opinionated.** This app encodes my personal review flow (discover → dispatch a Claude review → push comments → follow up → approve) and has only been tested against my personal commands — it may not fit yours out of the box.
>
> But you can configure the dispatched prompts in **Settings → Claude commands** (defaults use Claude Code's built-in `/review`; placeholders `<branch_name>` and `<pr_id>` are supported).

## Install

### Homebrew

This repo doubles as its own Homebrew tap:

```bash
brew tap chartrandf/lookout https://github.com/chartrandf/lookout
brew trust --cask chartrandf/lookout/lookout   # Homebrew 6+ gates third-party casks
brew install --cask lookout                    # --force to replace a hand-installed copy
```

> All three lines are required, in order. Homebrew expands a bare `chartrandf/lookout` to
> `chartrandf/homebrew-lookout`, which doesn't exist — so not even the fully-qualified
> `brew install --cask chartrandf/lookout/lookout` can tap this repo on its own. Skip the `brew tap`
> line and you get `Invalid usage: Casks must be fully-qualified` / `No Cask with this name exists`.

### Manual

Grab the latest `.dmg` from [Releases](https://github.com/chartrandf/lookout/releases) (universal — Apple Silicon + Intel) and drag **Lookout** to Applications.

### 🔒 Quarantine Issue

The bundle is self-signed, so macOS quarantines it. You may need to release the quarantine manually from the Terminal.

```bash
xattr -dr com.apple.quarantine /Applications/Lookout.app
```

## Dev

```bash
npm install
npm run tauri dev
```

Requirements: Rust toolchain, `gh` (authenticated), `claude` CLI.

## Usage

1. **Settings** — add local clone paths; `owner/repo` is detected from each clone's git origin. Your GitHub login is auto-detected; your own PRs are never listed.
2. **Discovery** — new open PRs land here. **Review** (add to board + dispatch `/do-review`), **Watch** (add to board), **Ignore** (hide forever). PRs you already reviewed or commented on skip Discovery.
3. **Reviews** — Watching / Needs Review / Reviewed / Follow-up / Done. Drag cards to triage or prioritize. Merged or closed PRs auto-move to Done and drop off after 24 h.
4. **Pull Requests** — your own PRs: Waiting / In Review / Ready to merge / Done. A human review moves a card to In Review, an approval to Ready to merge (where the CI tag is all you need to decide). Cards only ever move *forward* on their own, so re-requesting a review or flipping back to draft can't drop one out of In Review. Bot reviews (Cursor, Sonar) show a 🤖 badge but never move a card — they're lint, not review. Drag anywhere, in either direction: a drop stays put until GitHub itself changes its mind. Done holds what you merged or closed today and empties overnight.
5. **PR panel** — click a card: chat-style history (sessions, reports, commits, reviews), dispatch buttons, stage selector, one-click approve when follow-up is all green, resume sessions in Ghostty.
6. **Worktrees** — you only ever register the clone path. A branch checked out in a linked worktree is followed there: actions run in that worktree, its sessions and `AI_TASKS/code-review/` reports show up on the card, and resume opens the directory the session actually ran in.

## `lookout` CLI

The Homebrew cask puts a `lookout` command on your PATH — `brew install --cask lookout` symlinks it,
nothing else to do. Installing the DMG by hand instead leaves it inside the bundle at
`Lookout.app/Contents/Resources/lookout`; symlink it yourself:

```bash
ln -sf /Applications/Lookout.app/Contents/Resources/lookout ~/.local/bin/lookout
```

It runs on Node 22.13+ (or 23.4+), where `node:sqlite` stopped needing a flag. In a dev checkout:
`npm run build:cli`, then symlink `dist-cli/lookout.mjs`. It moves cards from a terminal, so a Claude Code skill can
report back once it has pushed comments — and it works whether or not the app is open, because it
writes the same SQLite database the app uses.

The command name says whose work it is: **`review`** for other people's PRs (the review pipeline),
**`mine`** for your own (the merge pipeline).

```bash
lookout review list --stage "in review"    # what's in a column
lookout review show --pr 2305              # one card, or omit the selector inside a repo checkout
lookout review reviewed                    # the PR for this repo + branch → Reviewed
lookout review comments-pushed --count 3   # what /do-review calls after `gh api .../reviews`

lookout mine list --column ready           # my PRs that are approved and just need a CI check
lookout mine show                          # my PR for this repo + branch
lookout mine ready                         # → Ready to merge

lookout doctor                             # database path and both board counts
```

Stages and columns are named the way the board names them — `needs-review`, `"In Review"`,
`follow-up`, `"Ready to merge"`, case and spacing ignored. Retired names still resolve (`inbox` is
now `needs_review`, and `lookout card …` is the old spelling of `lookout review …`), so older
scripts and shell aliases keep working.

A card is picked by `--id <id>`, `--pr <n>` or `--branch <b>` (add `--repo owner/repo` to
disambiguate); with no selector at all it uses the current checkout's origin and branch. Moves on
both boards are forward-only — the app's own rule, so an automated caller can't drag a card
backwards — with `--force` to override. `--json` for machine output, `--dry-run` to resolve without
writing.

Exit codes are the contract for scripts: `0` done · `1` error · `2` no matching card · `3` Lookout
has never run here · `4` selector matched several cards. In a skill, guard on the binary and let the
"nothing to do" codes pass:

```bash
command -v lookout >/dev/null && lookout review comments-pushed --branch "$BRANCH" --count 3 --quiet || true
```

When the app is running it repaints immediately: the CLI pings a unix socket the app publishes next
to the database, and the app re-reads. The event is only a hint — every failure degrades to the app
noticing at its next sync.

## Font

Bundles [Leckerli One](https://fonts.google.com/specimen/Leckerli+One) (SIL Open Font License 1.1).

## License

[MIT](LICENSE)
