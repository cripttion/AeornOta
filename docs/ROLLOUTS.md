# Rollouts, approvals and speed

## The life of an update

```
publish (CLI / CI)  →  Approvals (second person)  →  rollout 10% → 50% → 100%
                                       ↘ reject              ↘ halt / undo / roll back
```

Nothing reaches a phone before approval. Changing the share, halting, undo and roll back don't need approval, because they never introduce new code.

In the dashboard, Expo rollouts are on each app's **Live now** tab and Flutter rollouts on **Releases & patches**. Each card says in plain words who runs what.

## A safe default

| Stage | Share | Wait | Watch |
|---|---|---|---|
| Approve | 10% | 1 hour | The app's **Activity** tab (error rate), your crash reports |
| Raise | 50% | 6–24 hours | Same, plus support tickets |
| Raise | 100% | — | — |

A phone is placed in a bucket from its install id. The same phone stays inside the rollout as the percentage grows. Phones outside it keep the last fully rolled-out update.

## When something goes wrong

| Situation | Expo / React Native | Flutter |
|---|---|---|
| Stop new phones getting it | **Halt** (0%) | **Halt** |
| Take it back from phones that have it | **Undo**: those phones return to the store build's code, then receive the stable update | **Roll back**: phones remove the patch on their next launch |
| Ship the previous good version as the newest | `aeron expo republish --update <good id>` (goes through approval) | New patch from the good commit |

Expo **Undo** uses a rollback instruction that was signed when the update was published, so it works instantly without your key. Both clients also refuse to relaunch code that failed to start.

## Getting updates to phones fast

| Lever | Effect |
|---|---|
| Edge serving | Update checks are answered by the Cloudflare location nearest the phone, from cache |
| Content-addressed files | Unchanged images and fonts are never downloaded twice |
| bsdiff patches (Expo) | Phones on a previous update download only the changed bytes. In testing, a 6.3 MB bundle became a 270-byte download |
| Flutter patches | Always small diffs (about 10 KB in testing). Downloads resume after interruptions |
| Client kit (Expo) | Checks again when the app returns to the foreground. `--critical` applies immediately |

## Channels for testing

- **Expo:** internal builds use `"expo-channel-name": "staging"`. Publish with `--channel staging`, then `republish --channel production`.
- **Flutter:** `aeron flutter patch --track beta`. Internal builds select the track with the `shorebird_code_push` package.
