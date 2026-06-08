import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowRegistry, WorkflowRun } from "./registry.js";
import { WorkflowManagerComponent } from "./workflow-manager.js";

/**
 * Open the `/workflows` manager as a focus-capturing overlay. Resolves when the user closes it
 * with Esc. The overlay reads live state from the registry, so it reflects runs that are still
 * in flight and updates as they progress.
 */
export async function openWorkflowManager(ctx: ExtensionCommandContext, registry: WorkflowRegistry): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("The workflow manager needs an interactive terminal.", "warning");
    return;
  }

  let manager: WorkflowManagerComponent | undefined;
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      manager = new WorkflowManagerComponent({
        registry,
        theme,
        tui,
        onClose: () => {
          manager?.dispose();
          done();
        },
        onSave: (run) => void saveRun(ctx, run),
      });
      return manager;
    },
    {
      overlay: true,
      overlayOptions: () => ({
        // Full width avoids chat bleeding through the side margins; the panel paints its own
        // background so it reads as a solid surface over the conversation.
        width: "100%",
        maxHeight: "90%",
        anchor: "center",
        // Called each render with the live terminal size, which the component uses to bound its viewport.
        visible: (cols: number, rows: number) => {
          manager?.setSize(cols, rows);
          return true;
        },
      }),
    },
  );
}

/** Persist a run's script under `.pi/workflows/<name>.js` so it can be reread and rerun. */
async function saveRun(ctx: ExtensionCommandContext, run: WorkflowRun): Promise<void> {
  try {
    const dir = path.join(ctx.cwd, ".pi", "workflows");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sanitizeName(run.meta.name)}.js`);
    await writeFile(file, ensureTrailingNewline(run.script), "utf8");
    ctx.ui.notify(`Saved ${run.meta.name} to ${file}`, "info");
  } catch (error) {
    ctx.ui.notify(`Could not save workflow: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "workflow";
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
