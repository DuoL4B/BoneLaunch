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
- Settings and the installed-mod list keep the same file formats as 1.0, in `%APPDATA%BoneLaunch`, so upgrading keeps everything.
- MelonLoader comes from Thunderstore (`LavaGang-MelonLoader`) and is unpacked into the game folder. BoneLaunch offers to install it when it is missing.
- Mod zips are unpacked by folder: `Mods`, `Plugins`, `UserLibs`, `UserData`, `MelonLoader` go to the same folder in the game; loose DLLs go to `Mods`; folders holding a `pallet.json` go to the game's LocalLow `Mods` folder.
- Switching a mod off renames its DLLs to `.dll.disabled`.
- The default background is original artwork drawn by `scripts/prep-assets.js`, so the public repo ships no game art. Anyone can set their own picture in Settings.

## Left out for now

- Switching between game patches (1 to 6). May come later.
