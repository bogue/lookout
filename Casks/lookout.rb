cask "lookout" do
  version "0.3.3"
  sha256 "107caf46c6acb5aa992f2d904f03b5acda6fe323d5d712d960a34ccadad21852"

  url "https://github.com/chartrandf/lookout/releases/download/v#{version}/Lookout_#{version}_universal.dmg"
  name "Lookout"
  desc "Desktop overview of your Claude Code review sessions"
  homepage "https://github.com/chartrandf/lookout"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :big_sur

  app "Lookout.app"
  # The `lookout` CLI ships inside the bundle: it moves review cards from a terminal, which is how
  # Claude Code skills report back (e.g. /do-review flipping a card to Reviewed).
  binary "#{appdir}/Lookout.app/Contents/Resources/lookout"

  # The build is ad-hoc signed but not notarized, and the downloaded DMG arrives quarantined (the
  # flag propagates to everything copied out of the mounted image), so Gatekeeper would block the
  # first launch. Clear it here — a third-party tap has to be `brew trust`ed to run this, which is
  # the consent that makes it acceptable.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Lookout.app"]
  end

  zap trash: [
    "~/Library/Application Support/com.francischartrand.lookout",
    "~/Library/Caches/com.francischartrand.lookout",
    "~/Library/HTTPStorages/com.francischartrand.lookout",
    "~/Library/Preferences/com.francischartrand.lookout.plist",
    "~/Library/Saved Application State/com.francischartrand.lookout.savedState",
    "~/Library/WebKit/com.francischartrand.lookout",
  ]
end
