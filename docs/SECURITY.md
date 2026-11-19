# Security model

**Goal: nobody can get code onto your users' phones except through you.** Aeron uses several independent layers. An attacker has to beat all of them, not just one.

> **Tip:** The dashboard's **Security** page shows a live score and checklist of everything below, with a **Fix** button for anything not yet switched on.

## The layers

| Layer | What it means | Enforced by |
|---|---|---|
| 1. Signatures checked on the phone | Every Expo update and Flutter patch is signed with **your** private key. The phone checks it against the certificate or public key compiled into the store build, and checks every file's SHA-256 | `expo-updates` / Shorebird engine, on the device |
| 2. The server holds no private key | Aeron stores public keys only. Shorebird's "managed signing" (the server signs) is refused | Aeron server |
| 3. Signed builds only | Expo builds without a code signing certificate never receive updates. Flutter apps require signed releases | Aeron server |
| 4. Keys are locked | A key id can't be re-pointed to a different key. A Flutter app's patch key and its signing requirement can't be changed once it has live releases. The break-glass switch exists only in your Cloudflare account | Aeron server |
| 5. Four-eyes approval (on by default) | New code waits under **Approvals** until an admin approves it with a different token than the one that published it (or minted it) | Aeron server |
| 6. Human sign-in for sensitive actions (optional, recommended) | With Cloudflare Access, approving, and changing keys, tokens, trust rules or policies needs a person signed in with SSO + MFA. Tokens alone aren't enough | Cloudflare Access + Aeron server |
| 7. No stored CI tokens | GitHub Actions use OIDC for one-hour, single-app tokens tied to a repository and branch | Aeron server |
| 8. Short-lived, scoped tokens | Tokens have roles, optional app limits and expiry (90 days by default). Only their SHA-256 hash is stored | Aeron server |
| 9. Alerts and audit log | Every submit, approve, reject, halt, undo, rollback, key, token, trust or policy change is logged and can be posted to Slack or Discord | Aeron server |
| 10. Browser hardening | The dashboard sends a strict Content-Security-Policy, refuses framing, and never renders user content as HTML | Aeron server |

## What an attacker would need

| An attacker gets… | Can they ship code to phones? |
|---|---|
| Control of your Cloudflare Worker, database or storage | **No.** They can't sign. Phones reject anything else. At worst updates stop |
| A publisher token or CI secret | **No.** Their upload waits for approval, and you get an alert |
| Your Expo or Flutter **private key** alone | **No.** They also need a token to upload, and an approval |
| An admin token | Not if Cloudflare Access is on (approval needs your SSO + MFA). Without Access, an admin token can approve. **Turn Access on** |
| Your private key **and** an approval | Yes. This is why the key lives only in your password manager and CI secrets, and approvals need MFA |
| A phone on hostile Wi-Fi | **No.** TLS, plus signatures checked end to end |

## Setup checklist

The dashboard's **Security** page shows these with live status.

1. **Keep approvals on** for every app (each app's **Settings** tab).
2. **Use separate tokens.** Admin tokens are for the dashboard only. Publish with a publisher token limited to the app, or with GitHub OIDC.
3. **Turn on Cloudflare Access** (free for up to 50 users). It needs a custom domain:
   1. Cloudflare dashboard → **Zero Trust → Access → Applications → Add → Self-hosted**.
      - Domain: your Aeron domain, with two paths: `/dashboard` and `/api/admin/*`.
      - Policy: allow your emails, require MFA through your identity provider or one-time PIN.
      - Everything else stays public, as it must: the website and docs, and the paths phones, the shorebird CLI and GitHub Actions use.
   2. Put the application's **AUD** tag and your team domain in `apps/server/wrangler.jsonc` → `vars`: `"ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com"` and `"ACCESS_AUD": "<aud>"`. Then deploy (`npm run setup`).
   3. CLI calls to `/api/admin` from automation need an Access **service token**: set `AERON_CF_ACCESS_CLIENT_ID` / `AERON_CF_ACCESS_CLIENT_SECRET`. Service tokens can publish, but they can never approve.
4. **Set up alerts:** `npx wrangler secret put NOTIFY_WEBHOOK_URL` with a Slack or Discord incoming webhook. Then **Integrations → Send test alert**.
5. **Remove the bootstrap token** after first sign-in: `npx wrangler secret delete BOOTSTRAP_ADMIN_TOKEN`.
6. **Protect your Cloudflare and GitHub accounts** with passkeys or hardware security keys. Whoever controls Cloudflare controls the break-glass switches.
7. **Protect the private keys:**
   - **macOS:** keep them in your password manager (1Password, Bitwarden) or the Keychain. Put them on disk only while publishing.
   - **Windows:** same, or a BitLocker-encrypted folder.
   - **Encrypted file:** `openssl pkcs8 -topk8 -v2 aes-256-cbc -in private-key.pem -out private-key.enc.pem`, then set `AERON_KEY_PASSPHRASE` when publishing (Expo).
   - **CI:** only as encrypted secrets.
   - Run `aeron doctor` to confirm keys aren't committed.

## Break-glass switches

These live in `apps/server/wrangler.jsonc` → `vars`, so only someone with Cloudflare account access can flip them. Remove them right after use.

| Variable | Allows |
|---|---|
| `ALLOW_SIGNING_CHANGES = "1"` | Replacing a registered key or turning Flutter signing off for an app with live releases |
| `ALLOW_UNSIGNED_EXPO = "1"` | Serving updates to Expo builds without a code signing certificate. Never use this in production |

## If something goes wrong

1. **Stop the spread:**
   - Expo: **Halt** on the app's **Live now** tab, or **Undo** to send phones on the bad update back to the store build.
   - Flutter: **Roll back** in **Releases & patches**.
2. **Cut access:** go to **Access tokens** and revoke suspicious tokens. In **Integrations**, remove GitHub trust rules you don't recognise.
3. **Look:** check the **Audit log** for who submitted and who approved.
4. **If a private key leaked:**
   1. Generate a new key and register it under a **new key id** (Expo) or for a new release (Flutter).
   2. Ship store builds with the new certificate or public key.
   3. Use your backend's minimum-version check to move users off the old builds.
   4. Retire the old Expo key.

## Device-facing endpoints

These are public, because phones don't have secrets:
- `/expo/:app/manifest`, `/files/*`
- `/api/v1/patches/check`, `/sb/patches/*`
- `/api/auth/github`

They only return data that was already signed by you. The event endpoints accept anonymous counters, which can be spammed to inflate stats but can't change what code is delivered.
