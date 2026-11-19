# CLI reference

Install: see [Install](INSTALL.md). Commands and flags are identical on macOS, Linux and Windows. Run `aeron help` for the full list in your terminal.

## Configuration

| Source | Meaning |
|---|---|
| `aeron login --server URL --token TOKEN` | Saves both in `~/.aeron/config.json` (`%USERPROFILE%\.aeron\config.json` on Windows) |
| `AERON_SERVER`, `AERON_TOKEN` | Override the saved login (other CI systems) |
| `AERON_SERVER` inside GitHub Actions with `id-token: write` | Signs in automatically through GitHub OIDC, with no token needed |
| `AERON_EXPO_PRIVATE_KEY` / `AERON_EXPO_PRIVATE_KEY_PATH` | Expo signing key (PEM contents or path), instead of `--key` |
| `AERON_FLUTTER_PRIVATE_KEY` / `AERON_FLUTTER_PRIVATE_KEY_PATH` | Flutter patch key (PEM contents or path) |
| `AERON_KEY_PASSPHRASE` | Passphrase for an encrypted Expo private key |
| `SHOREBIRD_BIN` | Path to the shorebird CLI if it isn't on PATH |
| `AERON_CF_ACCESS_CLIENT_ID` / `AERON_CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token, when the admin API is behind Access |

## Everyday

| Command | What it does |
|---|---|
| `aeron doctor [--project .] [--app id]` | Read-only check of your login and the project (Expo, bare RN or Flutter): config, keys, git safety, server state, and the two plain React Native problems (missing `import 'expo'`, Expo CLI lookup in native builds) |
| `aeron whoami` | Shows the token's name, role, apps and expiry |
| `aeron approvals` | Lists what's waiting for approval |
| `aeron review expo <update-id> --approve\|--reject [--percent 10]` | Approve or reject an Expo update (admin, not the submitting token) |
| `aeron review flutter --app A --release V --patch N --approve\|--reject [--channel stable] [--percent 10]` | Approve or reject a Flutter patch |
| `aeron audit [--app id]` | Shows recent changes |

## Expo and bare React Native

| Command | What it does |
|---|---|
| `aeron expo init --app A [--project .] [--channel production] [--write]` | Detects managed / bare / plain React Native. Creates and registers keys, writes app.json, syncs native files for bare apps, adds `import 'expo'` and fixes the Expo CLI lookup in plain React Native projects, git-ignores keys. Without `--write` it only lists the changes |
| `aeron expo publish --app A --key K [options]` | Exports, uploads new files, signs, builds patches, submits |
| `aeron expo export --out dir [--platform all]` | Builds the bundle and records config and runtime **without any secrets**. Then run `publish --dist dir` |
| `aeron expo republish --app A --update ID --key K [--channel C] [--rollout N]` | Re-signs an existing bundle as the newest update (promote or roll forward) |
| `aeron expo runtime register --app A [--platform all] [--runtime-version X]` | Registers a shipped store build |
| `aeron expo rollout --app A --runtime-version X [--platform all] [--channel production] (--percent N \| --halt \| --undo \| --cancel-undo)` | Changes a rollout |
| `aeron expo status --app A` | Shows current rollouts |
| `aeron expo keys generate\|register\|list --app A` | Manage signing keys by hand |
| `aeron expo configure --app A` | Prints the app.json snippet |

`publish` options:

| Option | Meaning |
|---|---|
| `--channel production` | Channel |
| `--platform all\|ios\|android` | Platforms |
| `--rollout 10` | Percentage after approval |
| `--message "…"` | Shown to the approver |
| `--critical` | Client kit applies it immediately |
| `--runtime-version X` | Skip resolution |
| `--dist dir` | Use an `aeron expo export` folder |
| `--no-patches` | Skip bsdiff patches |
| `--key-id main` | Which registered key signs |

## Flutter

| Command | What it does |
|---|---|
| `aeron flutter init --app A [--project .] [--write]` | Keys, shorebird.yaml, pubspec asset, INTERNET permission, .gitignore |
| `aeron flutter release --app A [--platform android\|ios\|android,ios] [--flutter-version V]` | Runs `shorebird release` with the right server, token and public key |
| `aeron flutter patch --app A [--release latest] [--track stable] [--platform android] [--message "…"]` | Runs `shorebird patch` with your keys (checks they match), then attaches the commit and message |
| `aeron flutter status --app A` | Releases, patches, approval and rollout state |
| `aeron flutter rollout --app A --release V --patch N [--channel stable] (--percent N \| --halt \| --rollback \| --rollforward \| --promote)` | Changes a patch's rollout |
| `aeron flutter keys generate\|register` | Manage patch keys by hand |
| `aeron flutter signing --app A --require on\|off` | Signing requirement (locked once releases are live) |
| `aeron flutter env` | Prints SHOREBIRD_* variables for direct shorebird use |

## Admin

| Command | What it does |
|---|---|
| `aeron apps list` / `aeron apps create <id> --kind expo\|flutter [--name N]` | Apps |
| `aeron apps delete <id> [--dry-run] [--confirm <id>]` | Shows what deleting the app removes; with `--confirm <id>`, deletes it permanently (admin) |
| `aeron tokens create --name N [--role publisher] [--apps a,b] [--shorebird] [--expires-days 90] [--no-expiry]` | Create a token; `--shorebird` makes it start with `sb_api_` |
| `aeron tokens list` / `aeron tokens revoke <id>` | List or revoke |
| `aeron github trust add --app A --repo owner/name [--branch main] [--environment E]` | Let a GitHub repository publish to an app through OIDC |
| `aeron github trust list` / `remove <id>` | Manage trust rules |
| `aeron ci github --app A [--project .] [--write]` | Generate the GitHub Actions workflow |
