# BoneLaunch

A mod launcher for BONELAB on Windows, with Thunderstore built in.

![BoneLaunch home screen](docs/screenshots/home.png)

## What it does

- **Finds your game.** Detects whether you play on Steam or Meta (Oculus). If you have both, you can switch between them.
- **Browse Thunderstore.** Search, sort and filter every BONELAB mod without leaving the app.
- **One-click install.** Mods go into the right folders for you, along with any mods they need.
- **MelonLoader handled.** BoneLaunch spots when the mod loader is missing and installs it. You can pick the version.
- **Manage what you have.** Switch mods on and off, update them, remove them. Mods you added by hand show up too.
- **Profiles.** Save sets of switched-on mods and swap between them. Share a profile with a friend as a code.
- **Launch.** A big green button, plus "Launch without mods" for when something breaks.
- **Make it yours.** Accent colors, your own background picture, fade and blur.
- **mod.io mods too.** Browse mod.io in a BoneLaunch window; anything you download there installs by itself. No account or key needed. Zips you downloaded elsewhere are picked up from Downloads, and every mod.io mod can be switched on or off.
- **Optional mod.io key.** Add your own free mod.io key in Settings to get a built-in search tab.
- **Camerium camera built in.** One switch in Settings installs the Camerium in-game camera.
- **Updates itself.** BoneLaunch checks for a newer version at startup and installs it when you say yes.
- **Light when idle.** Minimize it and BoneLaunch closes its window and waits in the system tray, using about 10 MB of memory.

![Browsing mods](docs/screenshots/browse.png)

## Download

Get the newest version from the [Releases page](https://github.com/DuoL4B/BoneLaunch/releases/latest), or visit the [website](https://duol4b.github.io/BoneLaunch/):

- `BoneLaunch-Setup-x.y.z.exe` installs it like a normal app.
- `BoneLaunch-Portable-x.y.z.exe` runs without installing and keeps its data in a `BoneLaunchData` folder next to itself.

The files are not code-signed, so Windows SmartScreen may warn you the first time. Choose **More info**, then **Run anyway**.

## Good to know

- Close BONELAB before installing, removing or switching mods. Windows locks mod files while the game is running.
- The first launch after installing MelonLoader takes a few minutes while it sets itself up.
- Switching a mod off renames its `.dll` to `.dll.disabled`. Nothing is deleted.
- Removing a mod you added by hand sends it to the Recycle Bin.
- NSFW and deprecated mods are hidden in Browse by default. You can show them in Settings.

## Build it yourself

BoneLaunch is written in Rust with [Tauri](https://tauri.app). You need:

- [Rust](https://rustup.rs)
- Microsoft C++ Build Tools (the "Desktop development with C++" workload)
- [Node.js](https://nodejs.org) 20 or newer, for the build tool

```bash
npm install
npm run dev
```

To make the installer (it lands in `src-tauri/target/release/bundle/nsis/`):

```bash
npm run build
```

The portable version is the plain `src-tauri/target/release/bonelaunch.exe`, renamed so its name contains "Portable". That name is what tells it to keep its data beside itself.

## Releasing a new version

BoneLaunch finds updates by looking at the newest release on this repository, so the file names matter.

1. Change the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`, and the `RELEASE` block in `docs/index.html`.
2. Run `npm run build`.
3. Create a GitHub release and attach two files, named exactly like this (with the new version number):
   - `BoneLaunch-Setup-1.2.0.exe` (the installer from `src-tauri/target/release/bundle/nsis/`)
   - `BoneLaunch-Portable-1.2.0.exe` (a copy of `src-tauri/target/release/bonelaunch.exe`)

Installed copies look for the `Setup` file and portable copies look for the `Portable` file. A release without them is ignored. Each download is checked against the SHA-256 fingerprint GitHub publishes for it before it runs.

## How it works

- `src-tauri/src` is the Rust part with access to your PC: finding the game, talking to Thunderstore, unpacking mods.
- `ui` is the window you see, in plain HTML, CSS and JavaScript, drawn by the WebView2 engine that ships with Windows.
- Mod zips are unpacked by folder: `Mods`, `Plugins`, `UserLibs`, `UserData` and `MelonLoader` go to the same folder in the game. Loose DLLs go to `Mods`.
- BoneLaunch only downloads from `thunderstore.io`, and uses no accounts or API keys.

## Disclaimer

BoneLaunch is a fan-made tool. It is not affiliated with or endorsed by Stress Level Zero, Thunderstore, Valve or Meta. BONELAB is a trademark of Stress Level Zero. Mods are made by their own authors; use them at your own risk.

## License

[MIT](LICENSE)
