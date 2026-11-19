# Troubleshooting

Start with `aeron doctor` in the app folder. It checks the most common problems and tells you how to fix each one. Then find your symptom below.

## Signing in

| Symptom | Fix |
|---|---|
| "That token was not accepted" | It's expired, revoked or incomplete. Copy it again, or ask an admin for a new one under **Access tokens** |
| "This action needs a person signed in through Cloudflare Access" | Approvals and security settings must be done in the dashboard in a browser once Access is on |
| The dashboard looks out of date after an upgrade | Reload the page (Ctrl+F5 on Windows, Cmd+Shift+R on macOS) |

## Approvals

| Symptom | Fix |
|---|---|
| "The token that published an update cannot approve it" | Approve in the dashboard with your admin token, not the one you published with. Working alone? Turn on Cloudflare Access: an approval made with your company login + MFA counts as the second check |
| Published, but phones don't get it | It's waiting under **Approvals** |
| "A newer update is already live" when approving | Another update went live first. Ship this bundle again with `aeron expo republish` to make it the newest |

## Expo and React Native

| Symptom | Cause and fix |
|---|---|
| Phones never update; **Security** shows blocked unsigned builds | The store build has no `codeSigningCertificate`. Run `aeron expo init --write`, rebuild and ship |
| Text and logic update, but **images are missing** after an update | Plain React Native apps don't load Expo at startup. `aeron expo init --write` adds `import 'expo';` as the first line of `index.js` (`aeron doctor` flags it). This fix itself can ship as an update. See [Expo and React Native](EXPO.md#2-load-expo-at-the-top-of-indexjs) |
| Android release build fails: "createBundleReleaseJsAndAssets … uses this output of task … without declaring a dependency" | npm put `@expo/cli` inside the `expo` folder, so the build can't find it. Run `aeron expo init --write`: it fixes the lookup in `android/app/build.gradle` and the iOS Xcode project (`aeron doctor` flags it). By hand: change the `cliFile` line to `require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })`. See [Expo and React Native](EXPO.md#3-check-the-native-builds-find-expos-cli) |
| "Runtime … is not registered" | Register the store build: `aeron expo runtime register`, or pass the right `--runtime-version` |
| "Manifest signature does not verify" | `--key` doesn't match the registered key. Check `aeron expo keys list` and `--key-id` |
| `runtimeversion:resolve` fails in a bare project | Bare projects need a fixed `runtimeVersion` in `app.json`. `aeron expo init --write` sets it |
| The bare app still talks to an old update address | Native files weren't synced. Run `npx expo-updates configuration:syncnative --platform android --workflow generic` (and `ios`), then rebuild |
| Plain React Native: "expo-updates needs Expo modules" | `npx install-expo-modules@latest`, `npx expo install expo-updates`, then `aeron expo init --write` |
| `pod install` fails with "Unicode Normalization not appropriate for ASCII-8BIT" (macOS) | A CocoaPods text-encoding bug. Run `export LANG=en_US.UTF-8`, then `cd ios && pod install`. Android isn't affected |
| Warning: "Root-level expo object found. Ignoring extra keys" | Harmless in plain React Native apps, which keep `name` at the top of `app.json` |
| Phones download but don't switch | Updates switch on the next cold start. Close the app completely and open it again, or use the client kit and `--critical` |
| No patches built ("bsdiff not found") | Install `bsdiff` (macOS: `brew install bsdiff`). On Windows, publish from GitHub Actions or WSL. Updates still work, just as full downloads |

## Flutter

| Symptom | Cause and fix |
|---|---|
| "shorebird CLI not found" | Install it (see [Install](INSTALL.md)), or set `SHOREBIRD_BIN` to where it is |
| Release fails: "missing the INTERNET permission" | `aeron flutter init --write` adds it, or add it to `android/app/src/main/AndroidManifest.xml` |
| Release fails: "failed to strip debug symbols" | Install **Android SDK Command-line Tools**: Android Studio → SDK Manager → SDK Tools |
| "patch_signing_required" or "patch_signature_invalid" | Release and patch with your key pair (`aeron flutter release` and `patch` do this). The private key must match the registered public key |
| "Signing can't be turned off" or "public key is locked" | That's the protection working: phones depend on the key. See break-glass in [Security](SECURITY.md) if you really must |
| Phones talk to Shorebird instead of Aeron | `base_url` was missing from `shorebird.yaml` when the release was built. Fix it and ship a new release |
| The shorebird CLI asks you to log in | Use `aeron flutter release` / `patch`, or set `SHOREBIRD_TOKEN` to an `sb_api_` token. Don't run `shorebird login` |

## Windows

| Symptom | Fix |
|---|---|
| `aeron` isn't recognised | Open a new PowerShell window after the install, or run `node "$HOME\.aeron\aeron.mjs" …` |
| PowerShell won't load your profile | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once |
| `npx` errors inside `aeron` | Check Node.js is on PATH in a new window: `node -v` |
| Paths with spaces | Put them in quotes: `--project "C:\My Apps\calmi"` |
| iOS commands fail | iOS builds and patches need a Mac. Use a Mac or GitHub Actions with a macOS runner |

## GitHub Actions

| Symptom | Fix |
|---|---|
| "No trust rule for owner/repo" | Add one under **Integrations**, with the exact branch the workflow runs on |
| "Could not get a GitHub OIDC token" | The workflow needs `permissions: id-token: write` |
| `sha256sum: WARNING: 1 computed checksum did NOT match` | Aeron was upgraded (or the download was tampered with). Copy the new `AERON_CLI_SHA256` from **Integrations** |

## Server

| Symptom | Fix |
|---|---|
| D1 write-limit warnings on the free plan | Set `EVENT_SAMPLE_RATE` to `0.1`, or move to Workers Paid ($5 per month) |
| Watch live server logs | `cd apps/server && npx wrangler tail` |
