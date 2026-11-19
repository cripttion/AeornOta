# FAQ

Short answers to the questions people ask most. Unfamiliar words are in the [Glossary](GLOSSARY.md).

## What can I change?

### Can I hide a paywall, or show a pop-up on top of it, without a store release?

Yes, as long as the change is in your JavaScript (Expo, React Native) or Dart (Flutter) code: hiding or showing a screen, adding a modal, changing text, prices shown in the UI, layout, colours and logic. Publish it, approve it, and phones switch to it on their next launch.

### What can't I change over the air?

Anything native: new native libraries or plugins, permissions, Expo SDK / React Native / Flutter upgrades, the app icon, splash screen and app name. For Flutter, files under `assets/` (images, fonts) also need a store release. These go through the stores as usual, with a new [runtime version or release](HOW-IT-WORKS.md#why-the-store-build-matters).

### Do the App Store and Play Store allow this?

Both stores allow apps to download updated JavaScript or interpreted code, as long as the update doesn't change the app's main purpose, add features that would need review, or get around store policies. Use over-the-air updates for fixes and UI changes, and ship big new features through the stores. Read the current store guidelines for your own case.

## Cost and accounts

### How do I get my own Aeron server?

One person runs `npm run setup` once, from the Aeron code, on a free Cloudflare account. It takes about 30 minutes, including creating the account. Follow [Set up your Aeron server](SETUP.md): it starts from zero and explains every click.

### Do I need to pay Expo or Shorebird?

No. Your apps use the free, open-source `expo-updates` library and Shorebird's open-source Flutter engine. Aeron replaces their servers, so there's no Expo Updates or Shorebird plan to buy, and no Shorebird account needed.

### What does Aeron cost to run?

Only your Cloudflare usage. The free plan covers roughly 30,000 daily active users across all your apps. After that it's $5 per month for Workers Paid, plus about $0.30 per extra 10 million update checks. Downloads have no bandwidth fees. Details: [What it costs](SETUP.md#what-it-costs).

### How many apps can I add?

As many as you like. They share the same server and the same costs.

## Speed and reliability

### How fast do users get an update?

About 15 seconds after approval, phones see it on their next check. They download it in the background and run it on the next launch. With the Expo client kit, phones also check when the app comes back to the foreground, and `--critical` updates switch immediately.

### What if a user is offline?

The app opens normally with the code it already has. It picks up the update the next time it's online and starts.

### What if the Aeron server is down?

Apps keep working with the code they already have. They just don't get new updates until the server is back. Aeron never blocks an app from starting.

### What if an update crashes the app?

Both `expo-updates` and Shorebird's engine refuse to keep running code that fails to start, and fall back to the previous good code. In the dashboard, **Halt** stops the update spreading, and **Undo** (Expo) or **Roll back** (Flutter) takes it back from phones that have it. That's why you start rollouts at 10%.

### Do users have to do anything?

No. Updates download and apply on their own.

## Security

### Could a hacker push malicious code to my users?

Not without your private key **and** an approval. Every update is signed on your computer or in CI, and phones reject anything not signed with your key, even if the server itself is hacked. New code also needs a second person's approval, and with Cloudflare Access that approval needs a company login with MFA. See [Security](SECURITY.md#what-an-attacker-would-need).

### What happens if I lose my private key?

Builds that trust that key can't receive new updates. Ship new store builds with a new key, and move users to them. That's why `init` tells you to back the key up in your password manager.

### Can I work alone with four-eyes approval on?

Yes. Keep two tokens: publish with a publisher token, and approve in the dashboard with your admin token. With Cloudflare Access on, your own login + MFA counts as the second check.

## Daily use

### Mac or Windows?

Both. Every `aeron` command is the same. A few install steps differ, and the docs show them in **macOS** and **Windows** tabs. iOS builds and Flutter iOS patches need a Mac, as always.

### Can I test an update before everyone gets it?

Yes. Expo: build internal or TestFlight builds on the `staging` channel, publish with `--channel staging`, then `aeron expo republish` the same update to `production`. Flutter: `aeron flutter patch --track beta`. Or simply roll out to 1–10% first.

### Can I publish from GitHub instead of my laptop?

Yes, without storing any Aeron token in GitHub. See [GitHub Actions](GITHUB.md).

### Something isn't working. Where do I start?

Run `aeron doctor` in the app folder, then see [Troubleshooting](TROUBLESHOOTING.md).
