# First-Time Setup

Use this when the designer is setting up Figma HTML Loop on a new device.

## Short Explanation

Say:

> Figma HTML Loop has two parts. The Figma plugin reads your selected design. The local helper runs on your computer and prepares the HTML files for the Agent.

Do not mention Figma-Bridge unless the user asks about implementation history.

## Setup Steps

Guide the user through these steps in order.

### 1. Start The Local Helper

Tell the user:

> I will start the local helper. Please keep it running while we work.

Use the available helper command. Preferred:

```bash
cd /Users/bytedance/figma-html-loop
npm run build
node packages/cli/bin/figma-html-loop.js start
```

Then check:

```bash
node packages/cli/bin/figma-html-loop.js doctor
```

Success means the helper is reachable at `http://localhost:7799`.

### 2. Find The Plugin File

Tell the user:

> Next, we will install the Figma plugin that comes with this Skill.

The plugin file is:

```text
assets/figma-plugin/manifest.json
```

If the user needs the full path, run:

```bash
cd /Users/bytedance/figma-html-loop
node packages/cli/bin/figma-html-loop.js plugin-path
```

### 3. Install The Plugin In Figma

Give these exact steps:

1. Open Figma.
2. Open any design file.
3. In the top menu, choose **Plugins**.
4. Choose **Development**.
5. Choose **Import plugin from manifest**.
6. Select the `manifest.json` file from `assets/figma-plugin/`.
7. After import, open **Plugins > Development** again.
8. Click **Figma HTML Loop**.
9. Confirm the plugin shows **Plugin version: bridge-assets-0.3** or newer.

### 4. Confirm The Connection

Tell the user:

> The plugin should show **Connected**. If it says **Offline**, the local helper is not running or Figma cannot reach it yet.

If blocked, use `references/troubleshooting.md`.

### 5. Export The First Selection

Tell the user:

1. Select one Frame or component in Figma.
2. Open the **Figma HTML Loop** plugin.
3. Check that the plugin shows the selected layer name.
4. Click **Export Selection**.

The Agent should then wait for the confirmed selection and continue.

## What Good Looks Like

When setup works, say:

> Great, the loop is connected. Now we can send this Figma selection to HTML, edit it, and bring approved changes back to Figma.

## Safety Rules

Do not apply changes back to Figma without approval.

Do not ask the user to install or clone an external Figma-Bridge project.

Do not continue if the plugin is Offline.
