import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowTool, openWorkflowManager, WorkflowRegistry } from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  // One registry per session, shared by the workflow tool (which launches runs) and the
  // /workflows manager (which lists and controls them).
  const registry = new WorkflowRegistry();
  const workflowTool = createWorkflowTool({ registry });
  pi.registerTool(workflowTool);

  pi.registerCommand("workflows", {
    description: "Open the workflow manager to watch and control running and completed workflows",
    handler: async (_args, ctx) => {
      await openWorkflowManager(ctx, registry);
    },
  });

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
  });
}
