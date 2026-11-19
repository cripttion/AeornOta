# Flutter apps

Aeron ships Dart changes to Flutter apps as small signed patches, using Shorebird's open-source engine and CLI with Aeron as the server.

Why Shorebird? Release builds of Flutter compile Dart into machine code, so a downloaded file can't simply replace it. Shorebird's Flutter engine can run patched Dart code. Aeron implements the server side of Shorebird's protocol, so you keep:

- **Shorebird's Flutter engine** in your app. It contains the updater.
- **The `shorebird` CLI** to build releases and patches.

Both point at Aeron instead of Shorebird's cloud. You don't need a Shorebird account or plan. The `aeron flutter` commands wrap the shorebird CLI so you don't have to manage its flags, keys or tokens.

Install the shorebird CLI first: see [Install](INSTALL.md).

## Set up (once per app)

```bash
cd path/to/your-flutter-app
aeron flutter init --app fitloop            # dry run
aeron flutter init --app fitloop --write
aeron doctor
```

`init --write` does the following:

| Change | Why |
|---|---|
| Creates `keys/patch-public.pem` and `keys/patch-private.pem`, and registers the public key on Aeron | Phones only accept patches signed by your private key. Aeron also rejects badly signed patches at upload |
| Writes `shorebird.yaml` with `app_id` and `base_url` | `base_url` is the **only** way a phone finds Aeron. A release built without it talks to Shorebird's servers forever |
| Adds `shorebird.yaml` to `pubspec.yaml` → `flutter: assets:` | So it's bundled into the app |
| Adds `<uses-permission android:name="android.permission.INTERNET"/>` | The updater needs network access in release builds |
| Git-ignores `keys/patch-private.pem` | Never commit the private key |

**Back up `keys/patch-private.pem`.** Without it, releases built with its public key can never be patched again.

Note: `shorebird init --force` rewrites `shorebird.yaml` and drops `base_url`. Run `aeron doctor` afterwards.

## Release (store build)

```bash
aeron flutter release --app fitloop --platform android    # Mac, Windows, Linux
aeron flutter release --app fitloop --platform ios        # Mac only
```

Upload the `.aab` / `.ipa` to the stores as usual. Phones that install this version can receive patches.

## Patch (every Dart change)

```bash
aeron flutter patch --app fitloop --message "Fix results screen crash"
```

Options:

| Option | Effect |
|---|---|
| `--release 1.4.0+12` | Patch a specific release; the default is the latest |
| `--track beta` | Publish to beta testers only |
| `--platform ios` | Patch the iOS release |

The patch waits under **Approvals**. After approval, each phone downloads it on its next launch and runs it on the launch after that. Roll back from the dashboard at any time; phones remove the patch on their next launch.

## What a patch can change

| Ships as a patch | Needs a new store release |
|---|---|
| Dart code: screens, text, logic, bug fixes | Native code (Kotlin/Swift), or plugins with native parts |
| Pure-Dart packages | Images, fonts and other files under `assets/` |
| | Flutter/engine upgrades, permissions, app icon |

Each patch belongs to one release. Users on an older release only get patches built for that release, so patch it too with `--release <old version>` when needed.

## iOS note

Building an iOS patch uses a Shorebird linker tool (`aot-tools`) that the shorebird CLI downloads from Shorebird's public download server. Its source and license aren't published. Android patches don't use it.

## Using the shorebird CLI directly

Prefer `aeron flutter release` and `patch`. If you need shorebird itself, point it at Aeron first. Create the token with `aeron tokens create --name me --role publisher --apps fitloop --shorebird`.

**macOS**

```bash
export SHOREBIRD_HOSTED_URL=https://YOUR-AERON-SERVER
export SHOREBIRD_TOKEN=sb_api_...
shorebird release android --public-key-path=keys/patch-public.pem
shorebird patch android --release-version=latest --public-key-path=keys/patch-public.pem --private-key-path=keys/patch-private.pem
```

**Windows**

```powershell
$env:SHOREBIRD_HOSTED_URL = "https://YOUR-AERON-SERVER"
$env:SHOREBIRD_TOKEN = "sb_api_..."
shorebird release android --public-key-path=keys/patch-public.pem
shorebird patch android --release-version=latest --public-key-path=keys/patch-public.pem --private-key-path=keys/patch-private.pem
```

Don't use `shorebird login`; it signs in to Shorebird's own service. Aeron refuses Shorebird's "managed signing" (where the server holds the key), so every release must use `--public-key-path`.
