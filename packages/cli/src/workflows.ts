/**
 * GitHub Actions workflow templates, shared by the CLI (`aeron ci github`) and the console
 * (Integrations page). Pure strings only: this file must not import Node or Worker APIs.
 */
// Pinned to exact commits (supply-chain safety). Update deliberately, not via moving tags.
export const ACTIONS = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  setupNode: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
  setupJava: "actions/setup-java@d1374f8ac74474200d16ef8ecee22c7ae7a51880 # v6.3.0",
  setupShorebird: "shorebirdtech/setup-shorebird@8b1059ddb56a926f0146edf4133cc647775c162f # v1.4.1",
};

const DOWNLOAD_CLI = `      - name: Download the Aeron CLI and check it against your pinned hash
        env:
          AERON_SERVER: \${{ vars.AERON_SERVER }}
          AERON_CLI_SHA256: \${{ vars.AERON_CLI_SHA256 }}
        run: |
          curl -fsSL "$AERON_SERVER/cli/aeron.mjs" -o "$RUNNER_TEMP/aeron.mjs"
          echo "$AERON_CLI_SHA256  $RUNNER_TEMP/aeron.mjs" | sha256sum -c -`;

export function expoWorkflow(appId: string, packageManager: "npm" | "yarn" | "pnpm") {
  const install = packageManager === "yarn" ? "yarn install --frozen-lockfile" : packageManager === "pnpm" ? "pnpm install --frozen-lockfile" : "npm ci";
  return `# Over-the-air update for "${appId}" through Aeron.
# Security model:
#  - No Aeron token is stored in GitHub. This run proves its identity to Aeron with GitHub OIDC,
#    and only repositories/branches you trust in Aeron (Integrations) are accepted.
#  - The JS bundle is built WITHOUT the signing key in the environment; only the Aeron CLI ever sees it.
#  - The update waits in Aeron's Approvals queue until a second person approves it.
name: "OTA update: ${appId}"

on:
  workflow_dispatch:
    inputs:
      message:
        description: What changed (shown to the approver)
        required: true
      rollout:
        description: Rollout % once approved
        default: "10"
      channel:
        description: Channel
        default: production

permissions:
  contents: read
  id-token: write

concurrency:
  group: aeron-${appId}
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: ${ACTIONS.checkout}
        with:
          persist-credentials: false
      - uses: ${ACTIONS.setupNode}
        with:
          node-version: 22
${packageManager === "npm" ? "          cache: npm\n" : ""}      - run: ${install}
      - name: Install bsdiff (lets phones download small patches)
        run: sudo apt-get update -qq && sudo apt-get install -y -qq bsdiff
${DOWNLOAD_CLI}
      - name: Build the bundle (no secrets in this step)
        env:
          AERON_SERVER: \${{ vars.AERON_SERVER }}
        run: node "$RUNNER_TEMP/aeron.mjs" expo export --platform all --out "$RUNNER_TEMP/ota"
      - name: Sign and submit for approval
        env:
          AERON_SERVER: \${{ vars.AERON_SERVER }}
          AERON_EXPO_PRIVATE_KEY: \${{ secrets.AERON_EXPO_PRIVATE_KEY }}
          MESSAGE: \${{ inputs.message }}
          ROLLOUT: \${{ inputs.rollout }}
          CHANNEL: \${{ inputs.channel }}
        run: node "$RUNNER_TEMP/aeron.mjs" expo publish --app ${appId} --dist "$RUNNER_TEMP/ota" --channel "$CHANNEL" --rollout "$ROLLOUT" --message "$MESSAGE"
`;
}

export function flutterWorkflow(appId: string) {
  return `# Over-the-air Dart patch for "${appId}" through Aeron (stock shorebird CLI).
# Security model:
#  - No Aeron or Shorebird token is stored in GitHub (GitHub OIDC → short-lived Aeron token).
#  - The patch is signed with your key; phones reject anything else.
#  - The patch waits in Aeron's Approvals queue until a second person approves it.
#  - Note: shorebird signs during the build, so build scripts run while the key is available.
#    Keep dependencies reviewed, or build patches on a trusted machine (see docs: Security).
name: "OTA patch: ${appId}"

on:
  workflow_dispatch:
    inputs:
      message:
        description: What changed (shown to the approver)
        required: true
      release:
        description: Release version to patch (e.g. 1.2.0+5), or latest
        default: latest
      track:
        description: Track
        default: stable

permissions:
  contents: read
  id-token: write

concurrency:
  group: aeron-${appId}
  cancel-in-progress: false

jobs:
  patch:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: ${ACTIONS.checkout}
        with:
          persist-credentials: false
      - uses: ${ACTIONS.setupJava}
        with:
          distribution: temurin
          java-version: "17"
      - uses: ${ACTIONS.setupShorebird}
        with:
          cache: true
      - uses: ${ACTIONS.setupNode}
        with:
          node-version: 22
${DOWNLOAD_CLI}
      - name: Build, sign and submit the patch for approval
        env:
          AERON_SERVER: \${{ vars.AERON_SERVER }}
          AERON_FLUTTER_PRIVATE_KEY: \${{ secrets.AERON_FLUTTER_PRIVATE_KEY }}
          MESSAGE: \${{ inputs.message }}
          RELEASE: \${{ inputs.release }}
          TRACK: \${{ inputs.track }}
        run: node "$RUNNER_TEMP/aeron.mjs" flutter patch --app ${appId} --release "$RELEASE" --track "$TRACK" --message "$MESSAGE"
`;
}

