# NxtGen Mobile
Front screen = live session: scene buttons, clip grid (tap to launch/stop, tap an empty slot to make a pattern), step editor, then EQ and layer mixer. Pads are a pop-up (Pads button).

Try it: `npx serve .` then open the URL on your phone (same Wi-Fi) and use "Add to Home Screen". Audio/MIDI need HTTPS or localhost for installing; plain LAN http still plays.
Native app: `npm install`, `npx cap add android` (and/or `ios`), then `npm run android` / `npm run ios`.
Removed: recording, record-arm, login/encryption, rig files, audio-device panel, voice, online AI. Save Rig / Load Rig (header) write and read one file with the SoundFonts, scenes, scene names, layers (mixer + FX), EQ, tempo and pads. Nothing saves automatically.

Landscape: the app is landscape-only. The installed web app locks it through the manifest, and `npm run android` / `npm run ios` run lock-landscape.js to lock the native projects. A portrait phone sees a rotate prompt.

## Build the Android installer in the cloud (no Android Studio)
1. Make a free GitHub account and a new empty repository.
2. Upload every file in this folder (including the hidden `.github` folder) to it.
3. Open the repository's Actions tab, pick "Build Android app" and press Run workflow.
4. When it finishes (about 5-10 minutes) open the run and download the `NxtGen-apk` file at the bottom. Unzip it: inside is `app-debug.apk`.
5. Send the APK to your phone, tap it, and allow installs from that source.
