# BoneLaunch design

A Windows mod launcher for BONELAB. Agreed with the owner on 2026-11-09.

## What it does

- **Home**: faded, partly hidden BONELAB picture in the background, a big green Launch button, and a badge showing Steam or Meta.
- **Browse**: search, sort and filter Thunderstore's BONELAB mods. One click installs a mod and the mods it needs.
- **Installed**: on/off switches, update, delete. Mods dropped into the folder by hand also show up.
- **Profiles**: saved sets of switched-on mods, with share codes.
- **Settings**: game folder, platform override, launch options, look and feel, browse filters, maintenance.

## Decisions

- Version 1.0 was built with Electron. Version 1.1 is Rust with Tauri: the logic is Rust, and the window is the same plain HTML/CSS/JS, drawn by WebView2.
- With the window open, memory use is about the same as Electron, because the web engine dominates. The saving comes from closing the window when minimized and waiting in the tray (about 10 MB).
- Ships as an installer and as a portable exe. The portable exe (its file name contains "Portable") keeps its data in a `BoneLaunchData` folder beside itself.
- Steam is found through the registry and Steam's library list (app 1592190). Meta is found through the Oculus library registry keys. If both exist the player can switch.
- Settings and the installed-mod list keep the same file formats as 1.0, in `%APPDATA%\BoneLaunch`, so upgrading keeps everything.
- MelonLoader comes from Thunderstore (`LavaGang-MelonLoader`) and is unpacked into the game folder. BoneLaunch offers to install it when it is missing.
- Mod zips are unpacked by folder: `Mods`, `Plugins`, `UserLibs`, `UserData`, `MelonLoader` go to the same folder in the game; loose DLLs go to `Mods`; folders holding a `pallet.json` go to the game's LocalLow `Mods` folder.
- Switching a mod off renames its DLLs to `.dll.disabled`.
- The default background is original artwork drawn by `scripts/prep-assets.js`, so the public repo ships no game art. Anyone can set their own picture in Settings.

## mod.io and Camerium (1.3.0)

- BoneLaunch does not call mod.io's API, because that needs a per-account key. Instead it works with mod.io's manual downloads: it looks in the Downloads folder for zips that contain a `pallet.json` file and unpacks them into `LocalLowStress Level ZeroBONELABMods`.
- Switching a mod.io mod off moves its folder to `ModsOff-BoneLaunch` beside the Mods folder. Removing one sends it to the Recycle Bin.
- Camerium (`DuoLab-CameriumCamera` on Thunderstore) has its own switch in Settings. Switching it on installs it from Thunderstore like any other mod; it is not bundled into the installer.

## Updating itself

- From 1.2.0, BoneLaunch asks GitHub for the newest release at startup (at most every 3 hours) and compares the version in the asset name `BoneLaunch-Setup-<version>.exe` (or `-Portable-`) with its own.
- The user is asked before anything is installed. The download must come from this repository's release URL and match GitHub's published SHA-256 digest.
- Installed copies run the installer quietly (`/P /R`) and it reopens the app. Portable copies save the new exe beside themselves and start it.
- Versions before 1.2.0 have no updater and must be updated by hand once.

## Left out for now

- Switching between game patches (1 to 6). May come later.
