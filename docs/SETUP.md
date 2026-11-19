# Set up your Aeron server

This guide takes you from nothing to your own working Aeron server, step by step. You don't need to know Cloudflare, servers or the command line: every step says exactly what to click, what to type, and what you should see.

> **Note:** Only **one person** does this, **once** (usually whoever looks after your apps). It takes about 30 minutes. Everyone else on the team just [installs the CLI](INSTALL.md) and signs in.

## What you're building

Aeron is a small program that runs on **your own Cloudflare account**, so you don't pay anyone per user and nobody else holds your data.

```flow
Your computer (the aeron code) → npm run setup → Your Cloudflare account → Your dashboard at https://aeron.yourname.workers.dev
```

The setup creates three things in your Cloudflare account:

| Cloudflare product | What Aeron uses it for | Cost |
|---|---|---|
| **Workers** | Runs the Aeron server and this dashboard | Free up to 100,000 requests a day |
| **D1** (database) | Apps, updates, tokens, the audit log | Free up to 5 million reads a day |
| **R2** (file storage) | The update files phones download | Free up to 10 GB, no download fees |

See [What it costs](#what-it-costs) for when you'd start paying (usually $5 a month at most).

## What you need

- A **Mac or Windows** computer, with an internet connection.
- An **email address** for your Cloudflare account.
- About **30 minutes**.
- Optional: a **domain** you own, if you want an address like `ota.yourcompany.com` instead of `aeron.yourname.workers.dev`. You can add it later, but it's best to decide before you ship app builds. See [Custom domain](#custom-domain).

> **Tip:** When a step says "open a terminal": on a **Mac**, press Cmd+Space, type **Terminal**, press Enter. On **Windows**, press the Windows key, type **PowerShell**, press Enter. You type (or paste) a command and press Enter to run it.

## Step 1. Create your Cloudflare account

1. Go to **https://dash.cloudflare.com/sign-up**.
2. Enter your email and a strong password, then click **Sign up**.
3. Open the email from Cloudflare and click the link to verify your address.
4. Turn on two-factor login (strongly recommended, because whoever controls this account controls your updates): click the person icon at the top right → **Profile** → **Authentication** → **Two-factor authentication**, and follow the steps.

**You should see:** the Cloudflare dashboard with your account name at the top left.

## Step 2. Switch on Workers and R2 (one time)

Two Cloudflare products need a one-time click before anything can use them.

**Workers (your server's address):**

1. In the left menu, click **Workers & Pages** (under *Compute*).
2. If Cloudflare asks you to choose a **subdomain**, type a short name, such as your company name, and confirm. Your server's address will be `https://aeron.<that-name>.workers.dev`.

**R2 (file storage):**

1. In the left menu, click **Storage & databases** → **R2** → **Overview**.
2. Click the button to activate R2 and follow the steps.

> **Important:** Cloudflare may ask you to add a card or PayPal to activate R2, even though the free allowance (10 GB stored, 1 million uploads and 10 million downloads a month) costs **$0**. Aeron's usage for a few apps stays well inside it. You can set a billing notification under **Manage account → Billing** if you want to be told about any charge.

D1 (the database) needs nothing: the setup creates it.

## Step 3. Install Node.js and Git

These are free tools the setup needs.

**macOS**

```bash
# 1. Install Homebrew (the Mac app installer for developer tools), if you don't have it:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# 2. Install Node.js and Git:
brew install node git
```

**Windows**

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
# Then close PowerShell and open a new window, so it finds the new tools.
```

Check they work (both should print a version number; Node must be 20 or higher):

```bash
node -v
git --version
```

> **Tip:** Prefer clicking to typing? Download Node.js (the **LTS** version) from **https://nodejs.org** and Git from **https://git-scm.com/downloads**, and install them like any app.

## Step 4. Get the Aeron code

**From GitHub** (the usual way). In the terminal:

```bash
cd ~                                   # your home folder (any folder is fine)
git clone https://github.com/cripttion/AeornOta.git aeron
cd aeron
```

The `aeron` at the end of the clone line names the folder. If your team keeps its own copy of Aeron on GitHub, use that address instead: on the repository page, click the green **Code** button → **HTTPS** → copy.

If GitHub asks you to sign in, use your GitHub username and a [personal access token](https://github.com/settings/tokens) as the password, or install **GitHub Desktop** and use **File → Clone repository** instead.

**If someone gave you the Aeron folder** (a ZIP file or a copy), unzip it somewhere, then in the terminal go into it. The easiest way is to type `cd ` (with a space), drag the **aeron** folder into the terminal window, and press Enter.

**You should see:** when you type `ls` (Mac) or `dir` (Windows), a list including `apps`, `docs`, `packages`, `scripts` and `package.json`.

The very first person who sets Aeron up can put it on GitHub for the team: see [Put Aeron on GitHub](#put-aeron-on-github-for-your-team).

## Step 5. Run the setup

In the terminal, inside the **aeron** folder:

```bash
npm run setup
```

Here's what happens, in order. You only need to act on steps 2 and 3.

1. **Checks your computer** and **downloads Aeron's building blocks** (1–2 minutes; yellow warnings here are normal).
2. **Signs in to Cloudflare.** A browser window opens: sign in if asked, then click **Allow**. Come back to the terminal.
3. **Asks which account to use**, only if you have several Cloudflare accounts. Type the number and press Enter.
4. **Creates the database** and **the file storage**, and sets up the database tables.
5. **Puts your server online** (about 30 seconds).
6. **Creates a one-time setup token** so you can sign in the first time.
7. **Checks your server answers.**

**You should see** at the end:

```text
Your Aeron server is ready.

  Dashboard:    https://aeron.yourname.workers.dev
  Setup token:  aer_boot_Xb3k…
```

The setup token is also saved in `.secrets/setup-token.txt` inside the aeron folder (git never uploads that folder).

> **Note:** Something went wrong? The setup says what to do in plain words. Fix it and run `npm run setup` again: it continues where it stopped and never creates anything twice. Common problems are listed under [If setup stops with an error](#if-setup-stops-with-an-error).

## Step 6. Sign in and create your own admin token

The setup token is temporary. Replace it with your own:

1. Open your **Dashboard** address in the browser.
2. Paste the **setup token** and click **Sign in**.
3. In the sidebar, click **Access tokens**.
4. Under **Create a token**: name it after yourself, choose **Admin**, keep **90 days**, and click **Create token**.
5. **Copy the token** that appears and save it in your password manager. It's shown only once.
6. Click **Sign out** (top right), then sign in again with **your new token**.

## Step 7. Turn off the setup token

Back in the terminal, inside the aeron folder:

```bash
cd apps/server
npx wrangler secret delete BOOTSTRAP_ADMIN_TOKEN
cd ../..
```

Type `y` and press Enter when asked. Then delete the saved copy, `.secrets/setup-token.txt`.

**You should see:** in the dashboard, **Security** shows "One-time setup token removed" with a green tick.

## Step 8. Install the aeron CLI and sign in

The CLI is the command you'll use to publish updates. In the dashboard, open **Integrations** → **The aeron command-line tool**, pick **macOS** or **Windows**, and copy the commands. They're also in [Install](INSTALL.md#2-the-aeron-cli).

For the `--token`, use a **Publisher** token (create one under **Access tokens**, limited to your app), not your admin token. Keeping them separate is what makes [four-eyes approval](ROLLOUTS.md) work.

**You should see:** `aeron whoami` prints your token's name and role.

## Step 9. Lock it down

Open **Security** in the dashboard. It lists every protection with a **Fix** button. Two optional extras:

- **Security alerts:** get a Slack or Discord message for every publish, approval and key change. See **Integrations → Security alerts**.
- **Company login + MFA for approvals** (Cloudflare Access): adds a login on top of your admin token. Useful once several people have admin access; needs your own domain. See [Security](SECURITY.md#setup-checklist).

**You're done.** Next: [add your first app and ship an update](WALKTHROUGH.md).

## Put Aeron on GitHub for your team

Do this once, so teammates can clone the code (Step 4) and you can [publish from GitHub Actions](GITHUB.md).

1. On **https://github.com/new**: name it `aeron`, choose **Private**, leave every box unticked, and click **Create repository**. Copy the **HTTPS** address it shows.
2. In the terminal, inside the aeron folder:

```bash
git init                     # skip if the folder already has git
git add .
git status                   # check the list (see the warning below)
git commit -m "Aeron server"
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/aeron.git
git push -u origin main
```

> **Warning:** Before `git commit`, look at the `git status` list and make sure `.secrets`, `keys` and any `*private*.pem` files are **not** in it. Aeron's `.gitignore` already excludes them, but check anyway. They must never be uploaded.

## Custom domain

Your server's address is built into every app build (as the update URL). The free `workers.dev` address works fine, but a domain you own, such as `ota.yourcompany.com`, lets you move Aeron later without new app builds, and is required for Cloudflare Access.

1. Your domain must be **managed by Cloudflare**. If it isn't yet: in the Cloudflare dashboard click **Add a domain**, follow the steps, and change the nameservers at the company you bought the domain from, as Cloudflare tells you. Wait until Cloudflare shows the domain as **Active**.
2. In the terminal, inside the aeron folder (use any subdomain you like):

```bash
npm run setup -- --domain ota.yourcompany.com
```

Cloudflare creates the address and its HTTPS certificate automatically. For a domain that just became **Active**, the certificate takes about 15 minutes (occasionally a few hours); until then browsers say the site can't provide a secure connection. The `workers.dev` address keeps working the whole time, and afterwards too, so app builds that use it keep getting updates.

## Updating Aeron later

When there's a newer version of Aeron:

```bash
git pull                     # or replace the folder with the new copy
npm run setup                # applies database changes and deploys; safe to repeat
```

Then, if you publish from GitHub Actions, copy the new `AERON_CLI_SHA256` value from **Integrations** into your repository's variables.

## Using an API token

The setup signs in through your browser. On a computer without a browser (a server, or CI), use a Cloudflare API token instead:

1. Cloudflare dashboard → person icon → **Profile** → **API Tokens** → **Create Token** → template **Edit Cloudflare Workers** → **Use template**.
2. Add permissions: **Account · D1 · Edit** and **Account · Workers R2 Storage · Edit**. Choose your account under *Account Resources*, then **Continue to summary → Create Token**, and copy it.
3. Find your **Account ID**: Workers & Pages → right-hand side of the overview page.

**macOS**

```bash
export CLOUDFLARE_API_TOKEN=paste-the-token
export CLOUDFLARE_ACCOUNT_ID=paste-the-account-id
npm run setup
```

**Windows**

```powershell
$env:CLOUDFLARE_API_TOKEN = "paste-the-token"
$env:CLOUDFLARE_ACCOUNT_ID = "paste-the-account-id"
npm run setup
```

Never put these in a file you commit.

## If setup stops with an error

| What you see | What to do |
|---|---|
| `node`, `npm` or `git` "is not recognized", or "command not found" | Step 3 isn't finished, or the terminal was open before you installed. Close it, open a new one, try again |
| "Node.js … is too old" | Install the **LTS** version from nodejs.org, then open a new terminal |
| "Can't find apps/server/wrangler.jsonc" | You're not inside the aeron folder. Use `cd` to go into it (Step 4) |
| No browser opened to sign in | Copy the link the terminal shows into your browser. On a computer without a browser, use an [API token](#using-an-api-token) |
| "You have several Cloudflare accounts" | Type the number of the account Aeron should live in |
| "R2 file storage isn't switched on" | Do [Step 2](#step-2-switch-on-workers-and-r2-one-time), the R2 part |
| "doesn't have a workers.dev address yet" | Do [Step 2](#step-2-switch-on-workers-and-r2-one-time), the Workers part |
| "Cloudflare couldn't attach" your domain | The domain must be **Active** in this Cloudflare account. See [Custom domain](#custom-domain) |
| "It isn't answering yet" | A brand-new address can take a few minutes. Open it in your browser a little later |
| "Can't provide a secure connection" on your new domain | Cloudflare is still issuing its HTTPS certificate. Wait 15 minutes and try again |
| The dashboard says "That token was not accepted" | Copy the whole token, with no spaces. If you already turned off the setup token, use your admin token |

## What it costs

| Cloudflare product | Free plan | When you'd pay |
|---|---|---|
| Workers | 100,000 requests a day | Beyond that, Workers Paid is $5 a month for 10 million requests, then $0.30 per million |
| D1 | 5 million rows read and 100,000 written a day | Included with Workers Paid, at much higher limits |
| R2 | 10 GB stored, 1 million writes and 10 million reads a month, **no download fees** | $0.015 per GB a month beyond 10 GB |

Each app launch makes one update check (one request). Rule of thumb: the free plan covers about **30,000 daily active users** across all your apps (about 3 launches each). After that it's $5 a month, plus about $0.30 per extra 10 million checks.

To write less to the database on the free plan, lower `EVENT_SAMPLE_RATE` in `apps/server/wrangler.jsonc` (for example to `0.1`). The dashboard scales the counts back up.

## For developers: run Aeron on your computer

To work on Aeron itself (not needed to use it):

```bash
npm install --legacy-peer-deps
cd apps/server
printf 'BOOTSTRAP_ADMIN_TOKEN=local-dev-bootstrap-token-0123456789\n' > .dev.vars
npx wrangler d1 migrations apply aeron --local
npm run dev                  # http://localhost:8787
```

An iOS Simulator reaches it at `http://localhost:8787`, an Android emulator at `http://10.0.2.2:8787`. Run the tests with `npm test`.
