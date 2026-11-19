# Install on Mac and Windows

Install a few tools on each computer you publish from. This page assumes your team already has an Aeron server; if not, [set one up first](SETUP.md). GitHub Actions installs the same tools by itself; see [GitHub Actions](GITHUB.md).

> **Tip:** Commands on these pages come in **macOS** and **Windows** tabs. Pick yours once and every page remembers it. Every `aeron` command is the same on both.

## 1. Node.js and Git (everyone)

| Tool | Why you need it |
|---|---|
| Node.js 20 or newer | Runs the `aeron` CLI |
| Git | Records which commit an update came from |

**macOS**

```bash
brew install node git        # or download Node.js from nodejs.org
node -v                      # should print v20 or newer
```

**Windows**

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
node -v                      # open a new PowerShell window first
```

## 2. The aeron CLI

The CLI is a single file. It's downloaded from **your own** Aeron server, so it always matches your server's version. The dashboard shows these commands with your server's address filled in, under **Integrations**.

**macOS** (Terminal)

```bash
mkdir -p ~/.aeron
curl -fsSL https://YOUR-AERON-SERVER/cli/aeron.mjs -o ~/.aeron/aeron.mjs
echo 'alias aeron="node ~/.aeron/aeron.mjs"' >> ~/.zshrc
source ~/.zshrc
aeron login --server https://YOUR-AERON-SERVER --token <your token>
```

**Windows** (PowerShell)

```powershell
New-Item -ItemType Directory -Force "$HOME\.aeron" | Out-Null
Invoke-WebRequest https://YOUR-AERON-SERVER/cli/aeron.mjs -OutFile "$HOME\.aeron\aeron.mjs"
Add-Content $PROFILE 'function aeron { node "$HOME\.aeron\aeron.mjs" @args }'
. $PROFILE
aeron login --server https://YOUR-AERON-SERVER --token <your token>
```

> **Note:** On Windows, if PowerShell refuses to load your profile, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, then try again. On Linux, use `~/.bashrc` instead of `~/.zshrc` if you use bash.

Check it works:

```bash
aeron whoami      # shows who you're signed in as
aeron doctor      # run inside an app folder: checks the project
```

Get your token from an admin (dashboard → **Access tokens**). To update the CLI after the server is upgraded, run the download line again.

## 3. For Expo and React Native apps

| Tool | Why |
|---|---|
| Your app's dependencies (`npm install`) | `expo export` builds the bundle |
| **bsdiff** (optional, recommended) | Phones on the previous update download only the changed bytes instead of the whole bundle |

**macOS**

```bash
brew install bsdiff
```

**Windows**

```powershell
# bsdiff isn't packaged for Windows. Without it, updates still work as full downloads.
# To get small patches, publish from GitHub Actions (Linux) or from WSL.
```

Building store apps still needs Android Studio (Android) and Xcode (iOS, Mac only), as before.

## 4. For Flutter apps

| Tool | Why |
|---|---|
| Shorebird CLI | Builds releases and patches with Shorebird's engine. Free; you don't need a Shorebird account |
| Java 17 | Android builds |
| Android SDK with **Command-line Tools** | Android release builds. In Android Studio → Settings → Android SDK → SDK Tools, tick **Android SDK Command-line Tools** |
| Xcode | iOS releases and patches (Mac only) |

**macOS**

```bash
curl --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/shorebirdtech/install/main/install.sh -sSf | bash
brew install openjdk@17
```

**Windows**

```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
iwr -UseBasicParsing 'https://raw.githubusercontent.com/shorebirdtech/install/main/install.ps1' | iex
winget install EclipseAdoptium.Temurin.17.JDK
```

If Shorebird lives somewhere custom (for example an external drive), tell `aeron` where:

**macOS**

```bash
echo 'export SHOREBIRD_BIN=/Volumes/MyDrive/shorebird/bin/shorebird' >> ~/.zshrc
```

**Windows**

```powershell
Add-Content $PROFILE '$env:SHOREBIRD_BIN = "D:\tools\shorebird\bin\shorebird.bat"'
```

## Environment variables

Some options are set as environment variables (the [CLI reference](CLI.md) lists them all).

| | macOS / Linux | Windows PowerShell |
|---|---|---|
| For this terminal only | `export AERON_KEY_PASSPHRASE=…` | `$env:AERON_KEY_PASSPHRASE = "…"` |
| Permanently | Add the line to `~/.zshrc` | Add the line to `$PROFILE` |
| File paths | `keys/private-key.pem` | `keys\private-key.pem` (forward slashes also work) |

## Where your keys live

`aeron expo init` and `aeron flutter init` create these in your app folder:

| File | Secret? | What to do |
|---|---|---|
| `keys/private-key.pem` (Expo) | **Yes** | Never commit it. Back it up in your password manager. Put it in CI as a secret |
| `certs/certificate.pem` (Expo) | No | Commit it. It's built into your app |
| `keys/patch-private.pem` (Flutter) | **Yes** | Same rules. If you lose it, that release can never be patched again |
| `keys/patch-public.pem` (Flutter) | No | Used when building releases |

Both `init` commands add the secret files to `.gitignore`, and `aeron doctor` warns you if one was ever committed.
