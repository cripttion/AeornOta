# GitHub Actions

Publish updates from GitHub without storing any Aeron token there.

## How it stays safe

| Risk | What stops it |
|---|---|
| Someone steals a CI token | There is none. The workflow proves its identity to Aeron with GitHub's OIDC token: repository, branch and commit, signed by GitHub. Aeron issues a token that lasts one hour and works only for the apps you trusted that repository with |
| A pull request or fork tries to publish | Trust rules name the branch, usually `main`. Other branches and forks are refused |
| Fake "commit" info on an approval | The commit and run link come from GitHub's signed claims, not from the workflow |
| A compromised npm package steals the signing key | Expo workflows build the bundle in a step **without** the key. Only Aeron's CLI runs in the signing step |
| A tampered CLI download | The workflow checks the CLI against `AERON_CLI_SHA256`, a hash you pinned. It stops before using the key if the hash doesn't match |
| CI publishes something bad | It still waits under **Approvals** for a second person |
| A tampered GitHub Action | Every action is pinned to an exact commit, not a movable tag |

## Set it up (about 5 minutes)

### 1. Trust the repository

In the dashboard, go to **Integrations → GitHub Actions** and enter the app, `owner/repo` and branch `main`. Or use the CLI:

```bash
aeron github trust add --app calmi --repo acme/calmi --branch main
```

Optionally require a GitHub environment (`--environment production`) and add reviewers to it in GitHub.

### 2. Add the workflow file

In the app's repository:

```bash
aeron ci github --app calmi --write      # writes .github/workflows/aeron-calmi.yml
```

The dashboard also shows the same file under **Integrations**, ready to copy.

### 3. Add one secret and two variables

In GitHub, go to **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Variable | `AERON_SERVER` | Your Aeron URL |
| Variable | `AERON_CLI_SHA256` | Shown under **Integrations** (the hash of `aeron.mjs`) |
| Secret | `AERON_EXPO_PRIVATE_KEY` (Expo) or `AERON_FLUTTER_PRIVATE_KEY` (Flutter) | The full contents of `keys/private-key.pem` / `keys/patch-private.pem` |

### 4. Run it

1. Go to **Actions → OTA update: calmi** (or **OTA patch: fitloop**) → **Run workflow**.
2. Type what changed, then run it.
3. When it finishes, the update is under **Approvals** in the dashboard, with the commit and run linked. Approve it there.

## What the workflows do

**Expo / React Native:**
1. Check out the code and run `npm ci`.
2. Install `bsdiff`.
3. Download `aeron.mjs` and verify its hash.
4. `aeron expo export`: build with no secrets present.
5. `aeron expo publish --dist`: sign and submit, with only the CLI running.

**Flutter:**
1. Check out the code.
2. Set up Java 17 and Shorebird.
3. Download and verify the CLI.
4. `aeron flutter patch`: build, sign and submit.

Shorebird signs during its build, so Gradle and your build scripts run while the key is present. Keep dependencies reviewed. For the highest assurance, build Flutter patches on a trusted machine instead.

## Upgrading Aeron

After you redeploy the server, the CLI file and its hash change. Update the `AERON_CLI_SHA256` variable with the value shown under **Integrations**. Until you do, workflows stop safely at the hash check.

## Other CI systems

Use a **publisher** token limited to one app, with an expiry, as `AERON_TOKEN`, plus `AERON_SERVER` and the private key as secrets. Run the same `aeron` commands. Approvals still apply.
