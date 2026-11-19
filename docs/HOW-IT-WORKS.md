# How Aeron works

This page explains Aeron without jargon. Read it once and the rest of the docs and the dashboard will make sense.

## The one-minute version

An app on a phone has two parts:

- **The store build**: the app people download from the App Store or Play Store. It contains the native code (the part written in Swift, Kotlin or C++) and a starting copy of your app's code.
- **Your app's code**: JavaScript for Expo and React Native, Dart for Flutter. This is where your screens, text and logic live.

Aeron lets you replace the second part without touching the first. Phones download the new code in the background and use it the next time the app starts.

```flow
You publish → Someone approves → Phones download it → Phones switch on next launch
```

## Step by step

### 1. You publish a change

You change your code and run one command, on your computer or in GitHub Actions:

| App | Command | What it does |
|---|---|---|
| Expo / React Native | `aeron expo publish` | Builds the JavaScript bundle, uploads only files the server doesn't already have, and **signs** it with your private key |
| Flutter | `aeron flutter patch` | Builds a small patch of your Dart code with Shorebird's tools, and **signs** it with your private key |

Signing is like sealing an envelope with a stamp only you own. The stamp is your **private key**: a file on your computer (or a CI secret) that never goes to the server.

### 2. Someone approves it

The change appears under **Approvals** in the dashboard. Nothing has reached any phone yet. A second person, an admin using a different token, looks at it: the message, the commit, the size. Then they click **Approve** and choose how many phones should get it first, for example 10%.

This "four-eyes" step means that even if someone steals a publishing token, they can't put code on phones by themselves.

### 3. Phones download it

Every time your app starts, it asks Aeron "is there anything new for me?". Aeron answers from the Cloudflare location nearest the phone, usually in well under a second.

- If the phone is in the chosen 10%, it downloads the new code in the background. Phones that already have the previous update download only the bytes that changed, often a few KB.
- The phone checks the **signature** against the certificate built into the store build. If it doesn't match, the phone throws the download away. This is why a hacked server can't push code.

### 4. Phones switch on the next launch

The new code runs the next time the user opens the app. (Expo apps with the optional client kit also check when the app comes back to the foreground, and can apply urgent fixes immediately.)

### 5. You watch, then go to 100%

The dashboard shows downloads and the error rate per update. If it looks healthy after an hour or so, raise the rollout to 50%, then 100%. A phone keeps its place as you raise the share, so nobody flips back and forth.

### 6. If something goes wrong

| Button | What happens | Use it when |
|---|---|---|
| **Halt** | No new phones get the update. Phones that have it keep it | You're unsure and want time to look |
| **Undo** (Expo) | Phones that have the update go back to the code inside their store build, and are offered the previous good update | The update is broken |
| **Roll back** (Flutter) | Phones remove the patch on their next launch | The patch is broken |

None of these need approval, because they never introduce new code.

## Why the store build matters

An update only reaches store builds whose native code matches. Aeron tracks this with a label:

- Expo and React Native call it the **runtime version** (for example `2.3.0`).
- Flutter calls it the **release** (for example `1.4.0+12`).

If you add a native library or upgrade the SDK, you ship a new store build with a new label. Updates for the old label keep going to old builds, and updates for the new label go to new builds. JavaScript or Dart code can therefore never reach a build that's missing something native it needs, which would crash.

## What runs where

| Place | What runs there | What it holds |
|---|---|---|
| **Your computer or CI** | The `aeron` CLI, your build tools | Your **private keys**. They never leave |
| **Your Cloudflare account** | The Aeron server (one Worker), its database (D1) and file storage (R2) | Updates, public keys, settings, the audit log. No private keys |
| **Users' phones** | Your app with `expo-updates` (Expo) or Shorebird's engine (Flutter) | The certificate or public key built into the store build |

Aeron uses the official `expo-updates` library for React Native apps and Shorebird's open-source Flutter engine for Flutter apps. Aeron replaces only their servers, so there's nothing extra to pay Expo or Shorebird.

## How fast and how much

| | |
|---|---|
| Time from approval to phones | About 15 seconds until phones see it; they switch on their next launch |
| Update check | Answered at the nearest Cloudflare location, usually under 250 ms |
| Download size | Expo: a patch of only the changed bytes (a 6 MB bundle became a 270-byte download in testing). Flutter: about 10 KB per patch |
| Cost | Cloudflare's free plan covers roughly 30,000 daily users across all apps; then $5 per month. See [What it costs](SETUP.md#what-it-costs) |

## Expo and Flutter side by side

| | Expo / React Native | Flutter |
|---|---|---|
| What you ship | An **update**: a JavaScript bundle plus changed images | A **patch**: a small file with new Dart code |
| Command | `aeron expo publish` | `aeron flutter patch` |
| Store build label | Runtime version | Release |
| Stream of updates | Channel (`production`, `staging`) | Track (`stable`, `beta`) |
| Take it back | **Undo** | **Roll back** |
| Library on the phone | `expo-updates` | Shorebird's Flutter engine |

Next: if your team doesn't have an Aeron server yet, [set one up](SETUP.md). Then [install the tools](INSTALL.md) and follow [your first update](WALKTHROUGH.md).
