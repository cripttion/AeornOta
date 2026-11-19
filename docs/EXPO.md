# Expo and React Native apps

Aeron works with every React Native setup that can run the official `expo-updates` library. It has been tested end to end on a real Android phone with both an Expo app and a plain React Native 0.88 app.

| Your project | Works? | What's different |
|---|---|---|
| **Expo, managed** (no `android/` or `ios/` folder) | Yes | Settings live in `app.json`. The runtime version follows your native code automatically (`"policy": "fingerprint"`) |
| **Expo or React Native with native folders** ("bare") | Yes | Settings are copied into `AndroidManifest.xml` and `Expo.plist`. You set the runtime version yourself |
| **Plain React Native** without Expo | Yes, after adding Expo modules | Three extra steps, below |
| Expo Go | No | Use a development or release build |

## Connect the project (once per app)

In the app folder:

```bash
aeron expo init --app calmi            # dry run: lists every change
aeron expo init --app calmi --write    # makes the changes
aeron doctor                           # checks the result
```

What `init --write` does:

1. Installs `expo-updates` if it's missing, and fixes the two common plain React Native problems (see [below](#plain-react-native-no-expo-yet)).
2. Creates the app on Aeron if it doesn't exist yet (needs an admin token).
3. Creates `keys/private-key.pem` (secret) and `certs/certificate.pem` (public), and git-ignores `keys/`.
4. Registers the public key, plus a signed "no update" answer, so the server never needs your private key.
5. Writes the update settings into `app.json`:

```json
{
  "runtimeVersion": { "policy": "fingerprint" },
  "updates": {
    "url": "https://YOUR-AERON-SERVER/expo/calmi/manifest",
    "requestHeaders": { "expo-channel-name": "production" },
    "codeSigningCertificate": "./certs/certificate.pem",
    "codeSigningMetadata": { "keyid": "main", "alg": "rsa-v1_5-sha256" },
    "checkAutomatically": "ON_LOAD",
    "fallbackToCacheTimeout": 0
  }
}
```

6. **Bare projects only:** sets a fixed `runtimeVersion` (your app version), then runs `npx expo-updates configuration:syncnative` for Android and iOS to copy the same settings into the native files.

> **Note:** If your config is `app.config.js` or `app.config.ts`, `init` prints the snippet for you to paste, because code can't be edited safely.

### Plain React Native (no Expo yet)

#### 1. Add Expo modules and expo-updates

```bash
npx install-expo-modules@latest
npx expo install expo-updates
```

On a Mac, for iOS:

**macOS**

```bash
export LANG=en_US.UTF-8          # avoids a CocoaPods text-encoding error
cd ios && pod install && cd ..
```

**Windows**

```powershell
# iOS builds need a Mac. Android needs nothing extra here.
```

#### 2. Load Expo at the top of `index.js`

`aeron expo init --write` does this for you, and `aeron doctor` flags it if it's missing. It makes this the **first line** of `index.js` (or whatever file `package.json` → `main` points to):

```js
import 'expo';
```

Without it, text and logic update fine but **images inside updates don't show**, because the part of Expo that finds downloaded images never starts. Apps created with Expo already do this.

#### 3. Check the native builds find Expo's CLI

`aeron expo init --write` does this for you too, in `android/app/build.gradle` and in the iOS Xcode project, and `aeron doctor` flags it. By hand: open `android/app/build.gradle` and find the `cliFile` line inside `react { … }`. If it reads `require.resolve('@expo/cli')`, change it to:

```groovy
cliFile = new File(["node", "--print", "require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })"].execute(null, rootDir).text.trim())
```

npm sometimes installs `@expo/cli` inside the `expo` package folder. The shorter line then finds nothing, and the release build fails with *"uses this output of task … without declaring a dependency"*. The iOS build script in the Xcode project uses the same lookup and gets the same fix.

#### 4. Connect the project

Run `aeron expo init --app myapp` to see every change (including steps 2 and 3), then `aeron expo init --app myapp --write` and `aeron doctor`.

> **Note:** A warning like *Root-level "expo" object found. Ignoring extra keys* is harmless. Plain React Native keeps `name` at the top of `app.json` for `AppRegistry`.

## Runtime versions: the rule that prevents crashes

An update may only reach a store build with the **same native code**. The runtime version is how Aeron knows.

| Setup | Use | What it means for you |
|---|---|---|
| Managed | `{"policy": "fingerprint"}` | Changes by itself whenever native code changes |
| Bare / plain React Native | A string like `"2.3.0"` | **Bump it with every native change**: a new native library, an SDK or React Native upgrade |

Aeron refuses to publish to a runtime no store build has registered.

## Ship the store build

Build and submit as usual (EAS Build, Xcode, or Gradle). The build must include the settings above. When it's live:

```bash
aeron expo runtime register --app calmi --platform all
```

For bare apps, or when the version can't be worked out automatically, add `--runtime-version 2.3.0`.

## Publish updates

```bash
aeron expo publish --app calmi --key keys/private-key.pem --message "Fix paywall copy" --rollout 10
```

What happens:

1. `expo export` builds the bundle.
2. Only files the server doesn't have yet are uploaded. Unchanged images and fonts are skipped.
3. The manifest is signed on your computer.
4. Small patches are built from the bundles phones currently run (needs `bsdiff`).
5. The update waits under **Approvals**, unless approvals are off for the app.

| Option | Effect |
|---|---|
| `--platform ios` or `--platform android` | Publish one platform only |
| `--channel staging` | Publish to staging builds first |
| `--critical` | With the client kit, phones apply it as soon as it's downloaded |
| `--runtime-version X` | Skip working out the runtime version |
| `--dist dir` | Publish a folder made earlier by `aeron expo export` |

Promote a staging update to production, or ship an older version again:

```bash
aeron expo republish --app calmi --update <update-id> --channel production --key keys/private-key.pem
```

## Faster delivery (optional client kit)

On its own, `expo-updates` checks for updates only when the app starts from scratch. The client kit also checks when the app comes back to the foreground, applies `--critical` updates right away, and reports launches and errors so the dashboard can show an error rate per update:

```tsx
import { useAeronUpdates } from "@aeron/expo-client";

export default function App() {
  useAeronUpdates({ server: "https://YOUR-AERON-SERVER", appId: "calmi" });
  // …
}
```

The kit is in `packages/expo-client` of the Aeron repository. Copy `src/index.ts` into your app, or install it from that path.

## Test before production

Build internal or TestFlight builds with `"expo-channel-name": "staging"`. Publish with `--channel staging`, test, then `republish` the same bundle to `production`.
