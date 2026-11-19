# Glossary

Every word Aeron uses, in plain language. In the dashboard, words with a dotted underline show these explanations when you point at them.

## The basics

| Word | Meaning |
|---|---|
| **Over the air (OTA)** | Changing an app's code on users' phones without a new App Store or Play Store release |
| **Store build** | The app people install from the App Store or Play Store. It contains the native code and a starting copy of your app's code |
| **Update** | An over-the-air change for an Expo or React Native app: a new JavaScript bundle plus any changed images |
| **Patch** | An over-the-air change for a Flutter app: a small file that replaces the app's Dart code |
| **App** | One of your mobile apps, registered in Aeron. Its id (such as `calmi`) is part of the update address built into the app, so keep it short and permanent |

## Matching updates to builds

| Word | Meaning |
|---|---|
| **Runtime version** | Expo / React Native: a label for a store build's native code, such as `2.3.0`. Updates go only to builds with the same label, so they never reach a build missing native code they need |
| **Release** | Flutter: a store build made with `aeron flutter release`, named versionName+versionCode, such as `1.4.0+12`. Every patch belongs to one release |
| **Fingerprint** | An automatic runtime version for Expo managed apps. It changes by itself when native code changes |
| **Channel** | Expo: a named stream of updates, such as `production` or `staging`. A store build listens to one channel |
| **Track** | Flutter's word for a channel, such as `stable` or `beta` |

## Shipping safely

| Word | Meaning |
|---|---|
| **Approval (four-eyes)** | New code waits until a second person, an admin with a different token, approves it |
| **Rollout** | The share of phones that get the newest change. A phone keeps its place as the share grows |
| **Previous update** | The last update that was fully rolled out. Phones outside the rollout keep running it |
| **Halt** | Sets the rollout to 0%: no new phones get the change, phones that have it keep it |
| **Undo** | Expo: phones running the newest update go back to the code in their store build, and are offered the previous update |
| **Roll back** | Flutter: phones remove the patch on their next launch |
| **Restore** | Flutter: undo a roll back |
| **Critical update** | Applied as soon as it's downloaded (with the client kit) instead of on the next launch |
| **Republish** | Ship an existing update again as the newest one, for example to promote it from staging or to go back to an older version |

## Security

| Word | Meaning |
|---|---|
| **Signing** | Sealing an update with your private key, on your computer or in CI. Phones check the seal against the certificate or public key built into the store build |
| **Private key** | The secret file that signs updates (`keys/private-key.pem`, `keys/patch-private.pem`). Never commit it, never share it, back it up |
| **Certificate / public key** | The public half, built into your store build, that phones use to check signatures. Safe to commit |
| **Key id** | The name of an Expo signing key, usually `main` |
| **Access token** | A password-like key for the CLI, CI or the dashboard, with a role, optional app limits and an expiry. A token can never sign code |
| **Role** | What a token may do: **viewer** (look), **publisher** (publish and move rollouts), **admin** (everything, including approvals) |
| **Setup token (bootstrap token)** | The one-time admin token printed by `npm run setup` on a new server. Use it once to create your own admin token, then turn it off |
| **GitHub OIDC** | GitHub proves which repository and branch a workflow runs from. Aeron then gives it a one-hour token, so no Aeron token is stored in GitHub |
| **Trust rule** | Says which GitHub repository and branch may publish to which app |
| **Cloudflare Access** | Puts the dashboard behind your company login with multi-factor authentication |
| **Break-glass switch** | A setting only someone with Cloudflare account access can flip, to allow a normally blocked action. Remove it right after use |
| **Audit log** | The permanent record of every change: who, what, when |

## Delivery and health

| Word | Meaning |
|---|---|
| **Update download** | One phone downloading an update or patch |
| **Patch download (bsdiff)** | Phones on the previous update download only the bytes that changed, often a few KB instead of megabytes |
| **Healthy launch** | An app start that a phone reported as successful |
| **Error rate** | Errors ÷ (healthy launches + errors). Watch it after every rollout step |
| **Client kit** | An optional helper for Expo apps (`useAeronUpdates`) that checks for updates when the app returns to the foreground and reports launches and errors |
| **Edge** | Cloudflare's locations around the world. Update checks are answered by the one nearest the phone |

## Tools

| Word | Meaning |
|---|---|
| **`aeron` CLI** | Aeron's command-line tool. One file that runs on macOS, Windows and Linux with Node.js |
| **`aeron doctor`** | Checks a project and your setup, and says how to fix what's wrong. Changes nothing |
| **expo-updates** | The official Expo library inside your app that downloads and runs updates |
| **Shorebird** | The Flutter engine and CLI that make Dart patches possible. Aeron replaces only its server |
| **Worker, D1, R2** | Cloudflare's code runner, database and file storage, where Aeron runs |
