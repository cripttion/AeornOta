# Using the dashboard

The dashboard is where you **check, approve, control and watch** updates. Publishing happens in the terminal or in CI (see the [walkthrough](WALKTHROUGH.md)).

> **Tip:** Every page has a **Help** button in the top bar (or press `?`). It explains what the page is for, how to do common tasks, and the words used on it. Words with a dotted underline explain themselves when you point at them.

## Signing in

Open `/dashboard` on your Aeron address (for example `https://aeronota.online/dashboard`), paste your access token and click **Sign in**. The address itself (`/`) is the project website, and `/docs` opens these guides. The browser keeps it on this device only; untick **Keep me signed in** on shared computers.

- **First time:** use the one-time setup token printed by `npm run setup` (see [Set up your Aeron server](SETUP.md)), create your own admin token under **Access tokens**, then delete the setup token (the dashboard reminds you).
- **With Cloudflare Access:** opening `/dashboard` first asks for your email and a one-time code (or your company login). Then paste your token as usual.

| Role | Can |
|---|---|
| **Viewer** | See everything for their apps. Change nothing |
| **Publisher** | Publish from the CLI or CI. Change rollouts, halt, undo and roll back. **Can't approve** |
| **Admin** | Everything, including approvals, apps, tokens, keys, GitHub trust rules and policies |

## The layout

| Area | What's there |
|---|---|
| **Top bar** | The server you're connected to, **Help**, the theme switch (system, light, dark), who you're signed in as, **Sign out** |
| **Sidebar, top** | **Overview** and **Approvals** (with a badge showing how many changes are waiting) |
| **Sidebar, Apps** | One entry per app. An amber dot means an update is rolling out to part of the phones; red means an undo is active. **Add** creates a new app |
| **Sidebar, Manage** | **Security**, **Access tokens**, **Integrations**, **Audit log**, **Settings** |
| **Sidebar, Learn** | **Documentation** and **How Aeron works** |

On a phone or small window, the sidebar opens from the menu button at the top left.

## Overview

Your home page, from top to bottom:

1. **Needs your attention**: anything waiting for you, each with a button that takes you to the fix.
2. **How a change reaches phones**: the five steps every change goes through (publish, approve, roll out, phones update, watch health), with what's happening at each right now. Click a step to go there.
3. **Numbers for the last 14 days**: waiting approvals, update downloads, healthy launches, error rate and partial rollouts, each compared with the 7 days before.
4. **Two charts**: downloads per day, and the error rate per day. Point at a bar or the line to read a day; **Table** shows the same numbers as a table. Today's bar is lighter because the day isn't over.
5. **Your apps**: what phones run now for each app, the last publish, downloads, error rate and trend. Click a row to open the app.

## Approvals

Each card shows:

- the app, platform or release, and the message;
- **what happens if you approve**, in one sentence (for example *10% of iPhones on store build 2.3.0 get this update within about 15 seconds*);
- who submitted it and when, the commit and CI run (verified when it came from GitHub Actions), the size and download size, and the signing key;
- a short **Before you approve** checklist.

To approve: choose the starting share (10% is a safe start), click **Approve**, then click again within 4 seconds. **Reject** (also two clicks) removes it for good.

You can't approve something submitted with the token you're signed in with. Use your separate admin token, or ask a teammate. That's four-eyes review working.

## Expo and React Native app pages

The header shows the app, **Ship a change** (the exact command to publish, for your computer or GitHub) and **Setup guide**.

| Tab | What you do there |
|---|---|
| **Live now** | One card per group of phones (channel, platform and store build). Each card says in plain words who runs what, for example *25% of iPhones on store build 2.3.0 get "New onboarding copy"; the other 75% stay on "Fix paywall price rounding"*. Change the share with **1% / 10% / 25% / 50% / 100%** or a custom number. **Halt** stops new phones getting it. **Undo** (click twice) sends phones that have it back to their store build's code |
| **History** | Every update, with its status (waiting for approval, approved, rejected), size, patch size and commit. Click one for details and the command to ship it again |
| **Store builds** | The store builds this app may update. Register each one when it ships |
| **Signing keys** | The public keys phones trust. Retire old keys after rotating |
| **Activity** | Downloads and error rate per day, numbers per update, and recent changes |
| **Settings** | Four-eyes approval on or off. Admins also see **Delete this app**, which lists exactly what will be removed and asks you to type the app's id |
| **Setup guide** | The checklist, plus copy-paste steps for this app, including fixes for plain React Native projects |

## Flutter app pages

| Tab | What you do there |
|---|---|
| **Releases & patches** | Each store release with its patches. Each patch shows its message and, per track, a sentence such as *50% of phones on release 1.4.0+12 get it*, then buttons for **10% / 25% / 50% / 100%**, **Halt** and **Roll back** (click twice). A rolled-back patch can be **Restored** |
| **Signing** | Whether only signed patches are accepted, and the registered public key (locked once releases are live) |
| **Activity** | Patch downloads and install failures per day, numbers per release and patch, and recent changes |
| **Settings** | Four-eyes approval on or off |
| **Setup guide** | The checklist, plus the `aeron flutter init / release / patch` commands for this app |

## Manage

| Page | What it's for |
|---|---|
| **Security** | A score and a live checklist of every protection. Each item that isn't on says what to do, with a **Fix** button |
| **Access tokens** | Which role to use, creating tokens (shown once, with expiry) and revoking them. Shows where each token came from: manual, GitHub Actions or the CLI |
| **Integrations** | GitHub Actions trust rules and a ready-made workflow file, the CLI install commands for macOS or Windows, and security alerts |
| **Audit log** | Every change in plain words: who, what, which app, when. Filter by app |
| **Settings** | The addresses built into your apps, and deployment facts |

## Documentation

Groups on the left (*Start here*, *Guides*, *Security and hosting*, *Reference*), a search box at the top (press `/` to jump to it), and **On this page** on the right for long pages. Commands appear in **macOS** and **Windows** tabs; your choice is remembered.

## Habits that keep you safe

- Sign in to the dashboard with your admin token. Publish with a publisher token or GitHub Actions.
- Read the approval card before you approve. Does the commit match? Did the size jump unexpectedly?
- Start rollouts at 10%, check the error rate, then go higher.
- Keep **Security** all green.
