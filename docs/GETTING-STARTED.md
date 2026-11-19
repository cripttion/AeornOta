# Getting started

Aeron sends bug fixes and UI changes straight to your users' phones in minutes, without waiting for an App Store or Play Store review. It runs entirely on your own Cloudflare account, so there's no per-user fee and no third party in the middle.

```flow
Change your code → Publish → A second person approves → 10% of phones → 100% of phones
```

## What you can change over the air

| Your app | What Aeron can update | What still needs a store release |
|---|---|---|
| **Expo** (managed) | JavaScript: screens, text, logic, styles, images | New native libraries, permissions, Expo SDK upgrades, app icon |
| **React Native** with `android/` and `ios/` folders ("bare") | The same | The same |
| **Flutter** | Dart code: screens, text, logic | Native code, plugins with native parts, files under `assets/`, Flutter upgrades |

Example: hiding a paywall, adding a pop-up on top of it, changing prices shown in the UI, or fixing a crash in your JavaScript or Dart all work over the air. See the [FAQ](FAQ.md) for more.

## Your path

1. **Understand it** (5 minutes): [How Aeron works](HOW-IT-WORKS.md).
2. **Set up your server** (one person, once, about 30 minutes, starting from nothing): [Set up your Aeron server](SETUP.md).
3. **Install the tools** on each Mac or Windows PC you publish from: [Install](INSTALL.md).
4. **Ship your first update** step by step: [Your first update](WALKTHROUGH.md).
5. **Automate it** with GitHub Actions: [GitHub Actions](GITHUB.md).
6. **Lock it down**: open **Security** in the dashboard and make every item green.

## Where things happen

| In the dashboard (this website) | In your terminal or CI (the `aeron` command) |
|---|---|
| **Approve** or reject new code before any phone gets it | Connect a project once (`aeron expo init`, `aeron flutter init`) |
| **Roll out** gradually: 10%, 50%, 100% | **Publish** a change (`aeron expo publish`, `aeron flutter patch`) |
| **Halt**, **undo** or **roll back** in one click | Check a project for problems (`aeron doctor`) |
| See what phones run, and the error rate per update | Sign updates with your private key, which never leaves your computer or CI |
| Manage people's access, GitHub, alerts and security | |

Every page in the dashboard has a **Help** button (top right, or press `?`) that explains the page and its words.

## Why nobody else can push code to your apps

> **Note:** Each layer works on its own. An attacker would have to beat all of them.

1. **Signed on your side.** Every update is signed with a key only you hold. Phones check that signature against a certificate built into your store app. A hacked server can't fake it.
2. **A second person approves.** New code waits under **Approvals** until another admin says yes. A stolen CI secret alone can't ship anything.
3. **Unsigned builds get nothing.** Builds that don't check signatures never receive updates.
4. **No stored CI tokens.** GitHub Actions prove which repository and branch they run from, and get a one-hour token.
5. **Optional company login + MFA** for approvals, with Cloudflare Access.
6. **Everything is logged**, and can be posted to Slack or Discord as it happens.

The full model is on the [Security](SECURITY.md) page. Unfamiliar word? See the [Glossary](GLOSSARY.md).
