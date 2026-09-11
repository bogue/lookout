# Lookout

**Your GitHub lookout.**

> ⚠️ **Opinionated.** This app encodes the author's personal review flow (discover → dispatch a Claude review → push comments → follow up → approve) and has only been tested against their personal Claude Code slash commands — it may not fit yours out of the box. Configure the dispatched prompts in **Settings → Claude commands** (defaults use Claude Code's built-in `/review`; placeholders `<branch_name>` and `<pr_id>` are supported).

Desktop overview of all your Claude Code review sessions: discover open PRs across hand-picked repos, dispatch review/follow-up sessions, track follow-ups, auto-clear merged PRs.

Tauri v2 + React + TypeScript + Tailwind. No server — the app polls `gh`, scans `~/.claude/projects/` sessions and each repo's `AI_TASKS/code-review/` exports.

## Install

### Homebrew (no Gatekeeper prompt)

This repo doubles as its own Homebrew tap:

```bash
brew tap chartrandf/lookout https://github.com/chartrandf/lookout
brew trust --cask chartrandf/lookout/lookout   # Homebrew 6+ gates third-party casks
brew install --cask lookout                    # --force to replace a hand-installed copy
```

No Gatekeeper prompt: the cask's `postflight_steps` clears `com.apple.quarantine` from the installed app.
The flag rides along on the downloaded `.dmg` and propagates to everything copied out of it, so
without that step the first launch is blocked. Trusting the cask is what authorises it to run —
`brew trust` exists for exactly this, so read the cask before trusting it (it's 30 lines).

`brew update && brew upgrade --cask lookout` picks up later releases (the cask is bumped by the
release workflow — `brew update` is what pulls it), and `brew uninstall --cask --zap lookout`
removes the app plus its stored data.

`--no-quarantine` no longer exists: Homebrew [dropped its quarantine machinery][brew-quarantine] in
July 2026, which is why the cask has to do it.

[brew-quarantine]: https://github.com/Homebrew/brew/commit/594fcc12ce

### Manual

Grab the latest `.dmg` from [Releases](https://github.com/chartrandf/lookout/releases) (universal — Apple Silicon + Intel) and drag **Lookout** to Applications.

The bundle is ad-hoc signed (`signingIdentity: "-"`, so its signature verifies with
`codesign --verify --deep --strict`) but it carries no Developer ID and isn't notarized, so
Gatekeeper still rejects it (`spctl -a` → rejected). Nothing to do in Terminal:

1. Double-click **Lookout** — the launch is blocked.
2. **System Settings → Privacy & Security → Open Anyway**.

That's a one-time click. (Right-click → Open no longer bypasses Gatekeeper on macOS 15+.) If you'd
rather clear the quarantine flag yourself:

```bash
xattr -dr com.apple.quarantine /Applications/Lookout.app
```

A signature alone can't remove that prompt — only a paid Apple Developer ID plus notarization can.

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
command -v lookout >/dev/null && lookout card comments-pushed --branch "$BRANCH" --count 3 --quiet || true
```

When the app is running it repaints immediately: the CLI pings a unix socket the app publishes next
to the database, and the app re-reads. The event is only a hint — every failure degrades to the app
noticing at its next sync.

## Font

Bundles [Leckerli One](https://fonts.google.com/specimen/Leckerli+One) (SIL Open Font License 1.1).

## License

[MIT](LICENSE)
