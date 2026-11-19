# Your first update, step by step

From nothing to an approved update on real phones, in about 20 minutes. Each step says where it happens: the **dashboard** (this website), the **terminal** (the `aeron` CLI, the same on macOS and Windows) or the **store**.

Before you start, you need an Aeron server ([set one up](SETUP.md) if your team doesn't have one) and the tools on your computer ([Install](INSTALL.md)).

## 0. Get two tokens (dashboard)

1. Sign in to the dashboard with your admin token.
2. Open **Access tokens** and create a **Publisher** token, limited to your app, expiring in 90 days. For Flutter apps, tick **For Flutter**.
3. In the terminal, sign in with the publisher token:

```bash
aeron login --server https://YOUR-AERON-SERVER --token <publisher token>
```

> **Note:** Why two tokens? With four-eyes approval, the token that publishes can't approve. You publish with the publisher token and approve in the dashboard with your admin token. A leaked laptop or CI token then can't ship anything on its own.

## Expo or React Native app

### 1. Add the app (dashboard)

Click **Add app** (sidebar, next to *Apps*). Choose **Expo / React Native**, enter an id such as `calmi` and a display name. The app opens on its **Setup guide** with a checklist that ticks itself off as you go.

### 2. Connect the project (terminal, in the app folder)

```bash
aeron expo init --app calmi            # only shows what it would change
aeron expo init --app calmi --write    # makes the changes
aeron doctor                           # double-checks everything
```

`init` recognises your kind of project:

| Your project | What `init --write` does |
|---|---|
| **Expo (managed)**, no `android/` or `ios/` folder | Creates your signing key, registers its public half, writes the update settings to `app.json`, git-ignores `keys/` |
| **Bare** (has `android/` and/or `ios/`) | The same, plus a fixed `runtimeVersion`, and copies the settings into `AndroidManifest.xml` and `Expo.plist` |
| **Plain React Native** without Expo modules | Tells you to add them first (`npx install-expo-modules@latest`, then `npx expo install expo-updates`), then run `init` again. It then also adds `import 'expo'` to `index.js` and fixes how the native builds find Expo's CLI. See [Expo and React Native](EXPO.md#plain-react-native-no-expo-yet) |

> **Important:** Back up `keys/private-key.pem` in your password manager now. Without it you can't publish updates for builds that trust it.

**Check:** the app's checklist shows *Project connected* as done.

### 3. Ship one store build (store)

Build and submit as you always do. That build now contains Aeron's address and your certificate. When it's live, or installed on your test phone:

```bash
aeron expo runtime register --app calmi --platform all
```

**Check:** the app's **Store builds** tab lists it.

### 4. Publish a change (terminal)

Change something visible, such as a text on the home screen, then:

```bash
aeron expo publish --app calmi --key keys/private-key.pem --message "New home screen text" --rollout 10
```

It prints **waiting for approval**. Nothing has reached a phone yet.

### 5. Approve it and roll out (dashboard)

1. Open **Approvals**. The card shows the message, commit, size and signing key, and says exactly what will happen.
2. Check it's what you expect, then click **Approve** and click again to confirm.
3. On your test phone, close the app completely and open it twice: the first launch downloads the update, the second runs it.
4. Under **Apps → Calmi → Activity**, watch downloads and the error rate.
5. Under **Live now**, raise the rollout to **50%**, then **100%**.

If something's wrong: **Halt** stops it spreading, and **Undo** (click twice) sends affected phones back to their store build's code.

## Flutter app

### 1. Add the app (dashboard)

Click **Add app**, choose **Flutter**, enter an id such as `fitloop`.

### 2. Connect the project (terminal, in the Flutter project)

```bash
aeron flutter init --app fitloop            # only shows what it would change
aeron flutter init --app fitloop --write
aeron doctor
```

This creates and registers your patch keys, writes `shorebird.yaml` (with Aeron's address as `base_url`), adds it to `pubspec.yaml` assets, adds Android's INTERNET permission, and git-ignores the private key.

> **Important:** Back up `keys/patch-private.pem`. Without it, releases built with its public key can never be patched again.

### 3. Build the store release (terminal, then store)

```bash
aeron flutter release --app fitloop --platform android
```

Upload `build/app/outputs/bundle/release/app-release.aab` to the Play Store. On a Mac, `--platform ios` builds the iOS release.

### 4. Patch a change (terminal)

Change some Dart code, then:

```bash
aeron flutter patch --app fitloop --message "Fix crash on the results screen"
```

### 5. Approve it and roll out (dashboard)

1. **Approvals** shows the patch. Click **Approve** twice, starting at 10%.
2. Phones download it on their next launch and run it on the launch after.
3. Under **Apps → FitLoop → Releases & patches**, raise the rollout, **Halt**, or **Roll back** (phones remove the patch on their next launch).

## Every day

| You want to | Go to |
|---|---|
| See what needs you | **Overview** → *Needs your attention* |
| Approve or reject new code | **Approvals** (the sidebar shows how many are waiting) |
| Publish from GitHub instead of your laptop | **Integrations** → GitHub Actions ([guide](GITHUB.md)) |
| Check your protections | **Security** |
| See who changed what | **Audit log** |
| Cut someone's access immediately | **Access tokens** → **Revoke** |
| Understand a page | **Help** (top right), or press `?` |
