/**
 * Source-derived authority map for the chat-first builtin-view contract.
 *
 * Builtin shell views may render buttons, toggles, filters, drag/drop handlers,
 * and form controls, but a user must be able to drive the same mutation through
 * a semantic agent action. Third-party plugin views use the generic
 * agent-surface bridge and are audited elsewhere; this file tracks only the
 * first-party pages bundled into the shell.
 *
 * The per-view validator checks semantic actions against the live registered
 * action inventory. The completeness sweep discovers every module under
 * `packages/ui/src/components/pages` and fails when a mutating page is neither
 * mapped to semantic actions nor explicitly exempt with a durable reason.
 * Coverage follows the current source graph rather than a historical handler
 * count, so refactors cannot create or consume numeric headroom.
 */

export interface BuiltinViewMutationAuthorityEntry {
  viewId: string;
  sourceFiles: readonly string[];
  semanticActions: readonly string[];
  exemptReason?: string;
  notes?: string;
}

export interface BuiltinViewMutationFinding {
  viewId: string;
  code: "missing-source" | "missing-semantic-action" | "invalid-exemption";
  message: string;
}

export interface BuiltinViewMutationCoverage {
  viewId: string;
  observedMutationSites: number;
  semanticActions: readonly string[];
  exempt: boolean;
}

export interface BuiltinViewMutationValidationResult {
  ok: boolean;
  coverage: BuiltinViewMutationCoverage[];
  findings: BuiltinViewMutationFinding[];
}

export const BUILTIN_VIEW_MUTATION_AUTHORITY = [
  {
    viewId: "tasks",
    sourceFiles: ["packages/ui/src/components/pages/TasksPageView.tsx"],
    semanticActions: ["SCHEDULED_TASKS"],
    notes:
      "Task list filters and row selection are covered by the scheduled-task semantic action.",
  },
  {
    viewId: "plugins-page",
    sourceFiles: [
      "packages/ui/src/components/pages/PluginsPageView.tsx",
      "packages/ui/src/components/pages/PluginsView.tsx",
      "packages/ui/src/components/pages/PluginCard.tsx",
      "packages/ui/src/components/pages/PluginConfigForm.tsx",
      "packages/ui/src/components/pages/plugin-view-connectors.tsx",
      "packages/ui/src/components/pages/plugin-view-modal.tsx",
      "packages/ui/src/components/pages/plugin-view-dialogs.tsx",
    ],
    semanticActions: [
      "APP",
      "SETTINGS",
      "PLUGIN",
      "SECRETS",
      "RUNTIME",
      "CONNECTOR",
    ],
    notes:
      "Plugin enable/config/reorder/setup flows are covered by app/settings/plugin/secrets/runtime actions; connector setup dialogs (plugin-view-connectors) pair with CONNECTOR.",
  },
  {
    viewId: "settings",
    sourceFiles: [
      "packages/ui/src/components/pages/SettingsView.tsx",
      "packages/ui/src/components/pages/ConfigPageView.tsx",
      "packages/ui/src/components/pages/PluginConfigForm.tsx",
      "packages/ui/src/components/pages/config-page-sections.tsx",
      "packages/ui/src/components/pages/SecretsView.tsx",
    ],
    semanticActions: [
      "SETTINGS",
      "MODEL_SWITCH",
      "BACKGROUND",
      "CHARACTER",
      "PLUGIN",
      "SECRETS",
    ],
    notes:
      "Settings sections delegate to SETTINGS or to the dedicated action that owns the section.",
  },
  {
    viewId: "background",
    sourceFiles: ["packages/ui/src/components/pages/BackgroundView.tsx"],
    semanticActions: ["BACKGROUND"],
  },
  {
    viewId: "character",
    sourceFiles: [
      "packages/ui/src/components/character/CharacterEditor.tsx",
      "packages/ui/src/components/character/CharacterEditorPanels.tsx",
    ],
    semanticActions: [
      "CHARACTER",
      "VIEW_CHARACTER_FILL_BIO",
      "VIEW_CHARACTER_ADD_STYLE_RULE",
      "VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE",
    ],
    notes:
      "Identity fields carry useAgentElement/onFill bindings so the CHARACTER action can drive the same mutations as the editor.",
  },
  {
    viewId: "logs",
    sourceFiles: ["packages/ui/src/components/pages/LogsView.tsx"],
    semanticActions: [],
    exemptReason:
      "read-only diagnostic view; controls are local inspect/filter affordances",
  },
  {
    viewId: "runtime",
    sourceFiles: ["packages/ui/src/components/pages/RuntimeView.tsx"],
    semanticActions: [],
    exemptReason: "read-only diagnostic view",
  },
  {
    viewId: "database",
    sourceFiles: [
      "packages/ui/src/components/pages/DatabasePageView.tsx",
      "packages/ui/src/components/pages/DatabaseView.tsx",
      "packages/ui/src/components/pages/SqlEditorPanel.tsx",
      "packages/ui/src/components/pages/database-utils.tsx",
      "packages/ui/src/components/pages/MediaGalleryView.tsx",
    ],
    semanticActions: [],
    exemptReason:
      "developer diagnostic view; SQL/editor/media-table browsing controls are not MVP chat mutations",
  },
  {
    viewId: "trajectories",
    sourceFiles: [
      "packages/ui/src/components/pages/TrajectoriesView.tsx",
      "packages/ui/src/components/pages/TrajectoryDetailView.tsx",
    ],
    semanticActions: [],
    exemptReason: "read-only trajectory inspection view",
  },
  {
    viewId: "documents",
    sourceFiles: [
      "packages/ui/src/components/pages/DocumentsView.tsx",
      "packages/ui/src/components/pages/documents-detail.tsx",
      "packages/ui/src/components/pages/KnowledgeView.tsx",
    ],
    semanticActions: ["OWNER_DOCUMENTS", "DOCUMENT"],
    notes:
      "Knowledge-hub upload/delete/tag controls have DOCUMENT (core CRUD) and OWNER_DOCUMENTS (personal-assistant portal) as chat twins, per the builtin-views relatedActions mapping.",
  },
  {
    viewId: "files",
    sourceFiles: ["packages/ui/src/components/pages/FilesView.tsx"],
    semanticActions: ["FILES"],
    notes:
      "File browser upload/delete/rename controls pair with the FILES action (packages/agent/src/actions/files.ts).",
  },
  {
    viewId: "memories",
    sourceFiles: [
      "packages/ui/src/components/pages/MemoryViewerView.tsx",
      "packages/ui/src/components/pages/MemoryDetailPanel.tsx",
    ],
    semanticActions: ["MEMORY"],
    notes:
      "Memory browse/prune controls pair with MEMORY (op create|search|update|delete, packages/agent/src/actions/memories.ts).",
  },
  {
    viewId: "automations",
    sourceFiles: [
      "packages/ui/src/components/pages/AutomationsFeed.tsx",
      "packages/ui/src/components/pages/TaskEditor.tsx",
      "packages/ui/src/components/pages/ScheduledTaskEditor.tsx",
      "packages/ui/src/components/pages/WorkflowEditor.tsx",
      "packages/ui/src/components/pages/WorkflowGraphViewer.tsx",
    ],
    semanticActions: ["SCHEDULED_TASKS", "TRIGGER"],
    notes:
      "Automations feed plus its task/workflow editors all write ScheduledTask records through the one scheduler; SCHEDULED_TASKS is the umbrella twin and TRIGGER pairs the trigger steps inside workflow editing.",
  },
  {
    viewId: "triggers",
    sourceFiles: [
      "packages/ui/src/components/pages/TriggersView.tsx",
      "packages/ui/src/components/pages/TriggerForm.tsx",
    ],
    semanticActions: ["TRIGGER"],
    notes:
      "Trigger editor (mounted as a detached desktop shell window via app-core DetachedShellRoot) pairs with the TRIGGER action (packages/agent/src/actions/trigger.ts).",
  },
  {
    viewId: "skills",
    sourceFiles: [
      "packages/ui/src/components/pages/SkillsView.tsx",
      "packages/ui/src/components/pages/skill-marketplace.tsx",
      "packages/ui/src/components/pages/skill-detail-panel.tsx",
    ],
    semanticActions: ["SKILL", "USE_SKILL"],
    notes:
      "Skill install/toggle/uninstall and marketplace flows pair with SKILL (manage) and USE_SKILL (invoke) from plugin-agent-skills.",
  },
  {
    viewId: "browser",
    sourceFiles: [
      "packages/ui/src/components/pages/BrowserWorkspaceView.tsx",
      "packages/ui/src/components/pages/BrowserTabSwitcher.tsx",
    ],
    semanticActions: ["BROWSER"],
    notes:
      "Browser workspace navigation/tab controls pair with the BROWSER action (plugin-browser); wallet-consent prompts are owner-in-the-loop by design.",
  },
  {
    viewId: "my-apps",
    sourceFiles: ["packages/ui/src/components/pages/MyAppsView.tsx"],
    semanticActions: ["BROWSER"],
    notes:
      "Cloud Apps studio row navigates via navigateBrowserPath, which the BROWSER action covers; the row itself is a signed-in-gated shortcut, not a state mutation surface.",
  },
  {
    viewId: "relationships",
    sourceFiles: [
      "packages/ui/src/components/pages/RelationshipsView.tsx",
      "packages/ui/src/components/pages/RelationshipsGraphPanel.tsx",
      "packages/ui/src/components/pages/relationships/RelationshipsWorkspaceView.tsx",
      "packages/ui/src/components/pages/relationships/RelationshipsPersonPanels.tsx",
      "packages/ui/src/components/pages/relationships/RelationshipsCandidateMergesPanel.tsx",
      "packages/ui/src/components/pages/relationships/RelationshipsActivityFeed.tsx",
      "packages/ui/src/components/pages/relationships/RelationshipsSidebar.tsx",
    ],
    semanticActions: ["ENTITY", "CONTACT"],
    notes:
      "Relationship workspace person edits and merge approvals go through EntityStore/RelationshipStore; ENTITY (personal-assistant) and CONTACT (agent contact CRUD) are the chat twins.",
  },
  {
    viewId: "chat",
    sourceFiles: ["packages/ui/src/components/pages/ChatView.tsx"],
    semanticActions: [],
    exemptReason:
      "the chat surface IS the semantic channel; its composer/attachment controls are how users reach every action, not mutations needing a chat twin",
  },
  {
    viewId: "launcher",
    sourceFiles: ["packages/ui/src/components/pages/Launcher.tsx"],
    semanticActions: [],
    exemptReason:
      "read-only launcher grid; tile taps navigate to views (VIEWS action drives the same navigation) and mutate no domain state",
  },
  {
    viewId: "app-route-not-found",
    sourceFiles: ["packages/ui/src/components/pages/AppRouteNotFound.tsx"],
    semanticActions: [],
    exemptReason:
      "designed not-found state for unclaimed /apps/<slug> routes (#17033); both controls are pure navigation (history push to the view's canonical path or /apps) and mutate no domain state",
  },
  {
    viewId: "native-os-apps",
    sourceFiles: ["packages/ui/src/components/pages/ElizaOsAppsView.tsx"],
    semanticActions: [],
    exemptReason:
      "AOSP-fork native OS surfaces (dialer, SMS, contacts) driven through the native-plugins bridge; device telephony affordances, not agent-domain mutations",
  },
  {
    viewId: "camera",
    sourceFiles: ["packages/ui/src/components/pages/CameraPageView.tsx"],
    semanticActions: [],
    exemptReason:
      "native camera preview surface (AOSP home tile); capture/switch controls are device affordances, not agent-domain mutations",
  },
  {
    viewId: "cloud-dashboard",
    sourceFiles: ["packages/ui/src/components/pages/ElizaCloudDashboard.tsx"],
    semanticActions: [],
    exemptReason:
      "cloud billing surface; Stripe checkout, top-up, and spend-limit changes are deliberately owner-in-the-loop consent flows, never agent-drivable (reads pair with CLOUD_ACCOUNT_STATUS)",
  },
  {
    viewId: "pendant-transcript",
    sourceFiles: ["packages/ui/src/components/pages/PendantTranscriptView.tsx"],
    semanticActions: [],
    exemptReason:
      "device-local BLE pendant capture surface; segments live in a browser-local optimistic cache, not agent domain state",
  },
  {
    viewId: "release-center",
    sourceFiles: ["packages/ui/src/components/pages/ReleaseCenterView.tsx"],
    semanticActions: [],
    exemptReason:
      "operator update surface (runtime/desktop update check + apply); the update lifecycle is owner-driven infrastructure with no chat-mutation twin",
  },
] as const satisfies readonly BuiltinViewMutationAuthorityEntry[];

const MUTATION_SITE_RE =
  /\b(?:onClick|onSubmit|onChange|onCheckedChange|onValueChange|onDragEnd|onDrop|onKeyDown|onPointerDown|onPointerUp)\s*=|\buseAgentElement(?:<[^>]*>)?\(/g;

export function countBuiltinViewMutationSites(source: string): number {
  return source.match(MUTATION_SITE_RE)?.length ?? 0;
}

export function validateBuiltinViewMutationCoverage(args: {
  authority?: readonly BuiltinViewMutationAuthorityEntry[];
  readSource: (path: string) => string | null | undefined;
  registeredActions: ReadonlySet<string>;
}): BuiltinViewMutationValidationResult {
  const authority: readonly BuiltinViewMutationAuthorityEntry[] =
    args.authority ?? BUILTIN_VIEW_MUTATION_AUTHORITY;
  const registeredActions = new Set(
    [...args.registeredActions].map((action) => action.toUpperCase()),
  );
  const findings: BuiltinViewMutationFinding[] = [];
  const coverage: BuiltinViewMutationCoverage[] = [];

  for (const entry of authority) {
    let observedMutationSites = 0;
    for (const sourceFile of entry.sourceFiles) {
      const source = args.readSource(sourceFile);
      if (source == null) {
        findings.push({
          viewId: entry.viewId,
          code: "missing-source",
          message: `${entry.viewId}: missing source ${sourceFile}`,
        });
        continue;
      }
      observedMutationSites += countBuiltinViewMutationSites(source);
    }

    const exempt = entry.exemptReason !== undefined;
    coverage.push({
      viewId: entry.viewId,
      observedMutationSites,
      semanticActions: entry.semanticActions,
      exempt,
    });

    if (exempt && entry.exemptReason?.trim().length === 0) {
      findings.push({
        viewId: entry.viewId,
        code: "invalid-exemption",
        message: `${entry.viewId}: exemption reason must be non-empty`,
      });
    }
    if (exempt && entry.semanticActions.length > 0) {
      findings.push({
        viewId: entry.viewId,
        code: "invalid-exemption",
        message: `${entry.viewId}: exempt views must not also claim semantic action coverage`,
      });
    }

    if (exempt) continue;
    for (const action of entry.semanticActions) {
      if (registeredActions.has(action.toUpperCase())) continue;
      findings.push({
        viewId: entry.viewId,
        code: "missing-semantic-action",
        message: `${entry.viewId}: semantic action ${action} is not registered in the live action catalog`,
      });
    }
    if (entry.semanticActions.length === 0) {
      findings.push({
        viewId: entry.viewId,
        code: "missing-semantic-action",
        message: `${entry.viewId}: mutating builtin view is not exempt and declares no semantic action mapping`,
      });
    }
  }

  return {
    ok: findings.length === 0,
    coverage,
    findings,
  };
}

export interface ShellPageSweepExemption {
  sourceFile: string;
  reason: string;
}

/**
 * Page modules excluded from the completeness sweep. Reserved for files that
 * are not mounted view surfaces at all — anything a user can actually reach
 * belongs in BUILTIN_VIEW_MUTATION_AUTHORITY (mapped or exempt-with-reason).
 */
export const SHELL_PAGE_SWEEP_EXEMPTIONS = [
  {
    sourceFile: "packages/ui/src/components/pages/documents-upload.tsx",
    reason:
      "UploadZone is not imported by any mounted surface (DocumentsView uses documents-upload.helpers directly); exercised only by its own dnd test — dead-module candidate, tracked in #16944",
  },
  {
    sourceFile: "packages/ui/src/components/pages/plugin-view-sidebar.tsx",
    reason:
      "ConnectorSidebar is not imported by any mounted surface (PluginsView renders plugin-view-connectors instead) — dead-module candidate, tracked in #16944",
  },
] as const satisfies readonly ShellPageSweepExemption[];

export interface ShellPageSweepFinding {
  sourceFile: string;
  code:
    | "unmapped-mutating-page"
    | "missing-source"
    | "stale-exemption"
    | "conflicting-exemption"
    | "duplicate-exemption"
    | "invalid-exemption";
  message: string;
}

export interface ShellPageSweepInventoryRow {
  sourceFile: string;
  mutationSites: number;
  /** viewId of the authority entry that claims the file, or null. */
  coveredBy: string | null;
  exempt: boolean;
}

export interface ShellPageSweepResult {
  ok: boolean;
  findings: ShellPageSweepFinding[];
  inventory: ShellPageSweepInventoryRow[];
}

/**
 * Source-completeness sweep (#16944): every enumerated shell page module with
 * at least one mutation site must be claimed by an authority entry's
 * sourceFiles or carry an explicit exemption. The caller enumerates
 * `pageFiles` (the test walks packages/ui/src/components/pages) so this stays
 * pure and testable against synthetic inventories. Exemptions are themselves
 * validated: one that points at a deleted file, a file the authority already
 * claims, or a file with no mutation sites left fails as stale/conflicting.
 */
export function validateShellPageSweepCompleteness(args: {
  pageFiles: readonly string[];
  authority?: readonly BuiltinViewMutationAuthorityEntry[];
  exemptions?: readonly ShellPageSweepExemption[];
  readSource: (path: string) => string | null | undefined;
}): ShellPageSweepResult {
  const authority: readonly BuiltinViewMutationAuthorityEntry[] =
    args.authority ?? BUILTIN_VIEW_MUTATION_AUTHORITY;
  const exemptions: readonly ShellPageSweepExemption[] =
    args.exemptions ?? SHELL_PAGE_SWEEP_EXEMPTIONS;

  const coveredBy = new Map<string, string>();
  for (const entry of authority) {
    for (const sourceFile of entry.sourceFiles) {
      coveredBy.set(sourceFile, entry.viewId);
    }
  }
  const findings: ShellPageSweepFinding[] = [];
  const inventory: ShellPageSweepInventoryRow[] = [];
  const pageFileSet = new Set(args.pageFiles);
  const exemptionByFile = new Map<string, ShellPageSweepExemption>();
  for (const exemption of exemptions) {
    if (exemptionByFile.has(exemption.sourceFile)) {
      findings.push({
        sourceFile: exemption.sourceFile,
        code: "duplicate-exemption",
        message: `${exemption.sourceFile}: duplicate SHELL_PAGE_SWEEP_EXEMPTIONS entries`,
      });
      continue;
    }
    exemptionByFile.set(exemption.sourceFile, exemption);
    if (exemption.reason.trim().length === 0) {
      findings.push({
        sourceFile: exemption.sourceFile,
        code: "invalid-exemption",
        message: `${exemption.sourceFile}: exemption reason must be non-empty`,
      });
    }
  }

  for (const sourceFile of args.pageFiles) {
    const source = args.readSource(sourceFile);
    if (source == null) {
      findings.push({
        sourceFile,
        code: "missing-source",
        message: `${sourceFile}: enumerated shell page could not be read`,
      });
      continue;
    }
    const mutationSites = countBuiltinViewMutationSites(source);
    const claimedBy = coveredBy.get(sourceFile) ?? null;
    const exempt = exemptionByFile.has(sourceFile);
    inventory.push({ sourceFile, mutationSites, coveredBy: claimedBy, exempt });

    if (exempt && claimedBy != null) {
      findings.push({
        sourceFile,
        code: "conflicting-exemption",
        message: `${sourceFile}: listed both in the '${claimedBy}' authority entry and in SHELL_PAGE_SWEEP_EXEMPTIONS; keep exactly one source of truth`,
      });
      continue;
    }
    if (mutationSites > 0 && claimedBy == null && !exempt) {
      findings.push({
        sourceFile,
        code: "unmapped-mutating-page",
        message: `${sourceFile}: ${mutationSites} mutation site(s) but no authority coverage — add it to a BUILTIN_VIEW_MUTATION_AUTHORITY entry with semantic actions (or an exemptReason), or add a SHELL_PAGE_SWEEP_EXEMPTIONS entry explaining why it is not a mounted view surface`,
      });
    }
  }

  for (const exemption of exemptions) {
    if (!pageFileSet.has(exemption.sourceFile)) {
      findings.push({
        sourceFile: exemption.sourceFile,
        code: "stale-exemption",
        message: `${exemption.sourceFile}: SHELL_PAGE_SWEEP_EXEMPTIONS entry points at a file the sweep did not enumerate; remove the stale exemption`,
      });
      continue;
    }
    const source = args.readSource(exemption.sourceFile);
    if (source != null && countBuiltinViewMutationSites(source) === 0) {
      findings.push({
        sourceFile: exemption.sourceFile,
        code: "stale-exemption",
        message: `${exemption.sourceFile}: exempt file no longer contains mutation sites; remove the exemption`,
      });
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    inventory,
  };
}
