/**
 * Single-screen editor for prompt automations: a title, an agent prompt, and a
 * one-time, recurring, or event schedule. Every editable automation persists
 * through the canonical prompt-trigger API so all schedules share one clock;
 * legacy Workbench rows may still be displayed here in read-only mode.
 */

import { AlertTriangle, Calendar, Clock3, Rocket, Zap } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import { isApiError } from "../../api/client-types-core";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { CRON_PRESETS, formatSchedule } from "../../utils/cron-format";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

/** The schedule shape persisted on a prompt trigger. */
export type TaskScheduleKind = "once" | "recurring" | "event";

export interface TaskEditorInitialValue {
  /** Trigger id, set when editing an existing prompt automation. */
  triggerId?: string;
  name: string;
  prompt: string;
  scheduleKind: TaskScheduleKind;
  scheduledAtIso: string;
  cronExpression: string;
  eventName: string;
}

export interface TaskEditorProps {
  initial?: Partial<TaskEditorInitialValue>;
  cloudAgentId?: string | null;
  onEnableAlwaysOn?: (agentId: string) => void;
  /**
   * Available trigger events the user can pick from. The host should
   * source this from the runtime's trigger catalog. We accept it as a
   * prop so this component stays free of upstream coupling.
   */
  availableEvents?: ReadonlyArray<{ id: string; label: string }>;
  /**
   * Displays a legacy Workbench automation without exposing its retired write
   * path. New and editable automations are always prompt triggers.
   */
  readOnly?: boolean;
  onSaved?: () => void;
  onCancel?: () => void;
}

function toDateTimeLocalValue(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return trimmed;
  const date = new Date(timestamp);
  const localTimestamp = timestamp - date.getTimezoneOffset() * 60_000;
  return new Date(localTimestamp).toISOString().slice(0, 16);
}

export function TaskEditor({
  initial,
  cloudAgentId = null,
  onEnableAlwaysOn,
  availableEvents = [],
  readOnly = false,
  onSaved,
  onCancel,
}: TaskEditorProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [scheduleKind, setScheduleKind] = useState<TaskScheduleKind>(
    initial?.scheduleKind ?? "once",
  );
  const [scheduledAt, setScheduledAt] = useState(() =>
    toDateTimeLocalValue(initial?.scheduledAtIso),
  );
  const [cron, setCron] = useState(
    initial?.cronExpression ?? CRON_PRESETS[1].expression,
  );
  const [eventName, setEventName] = useState(
    initial?.eventName ?? availableEvents[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alwaysOnRequirement, setAlwaysOnRequirement] = useState<string | null>(
    null,
  );

  const isEditing = Boolean(initial?.triggerId || readOnly);

  const cronPreview = useMemo(
    () => (scheduleKind === "recurring" ? formatSchedule(cron) : null),
    [scheduleKind, cron],
  );

  const nameField = useAgentElement<HTMLInputElement>({
    id: "task-title",
    role: "text-input",
    label: t("taskeditor.titleLabel", { defaultValue: "Title" }),
    group: "task-editor",
    description: "Prompt automation title",
    getValue: () => name,
    onFill: readOnly ? undefined : (value) => setName(value),
  });
  const promptField = useAgentElement<HTMLTextAreaElement>({
    id: "task-prompt",
    role: "textarea",
    label: t("taskeditor.promptLabel", { defaultValue: "Prompt" }),
    group: "task-editor",
    description: "Prompt the agent runs for this prompt automation",
    getValue: () => prompt,
    onFill: readOnly ? undefined : (value) => setPrompt(value),
  });
  const cronField = useAgentElement<HTMLInputElement>({
    id: "task-cron",
    role: "text-input",
    label: t("taskeditor.cronLabel", { defaultValue: "Cron expression" }),
    group: "task-editor",
    description: "Cron expression for the recurring schedule",
    getValue: () => cron,
    onFill: readOnly ? undefined : (value) => setCron(value),
  });
  const scheduledAtField = useAgentElement<HTMLInputElement>({
    id: "task-scheduled-at",
    role: "text-input",
    label: t("taskeditor.runAtLabel", { defaultValue: "Run at" }),
    group: "task-editor",
    description: "Date and time for this prompt automation to run once",
    getValue: () => scheduledAt,
    onFill: readOnly ? undefined : (value) => setScheduledAt(value),
  });
  const eventField = useAgentElement<HTMLButtonElement>({
    id: "task-event",
    role: "select",
    label: t("taskeditor.eventLabel", { defaultValue: "Trigger event" }),
    group: "task-editor",
    description: "Trigger event that runs this prompt automation",
    options: availableEvents.map((event) => event.id),
    getValue: () => eventName,
    onFill: readOnly ? undefined : (value) => setEventName(value),
  });
  const cancelButton = useAgentElement<HTMLButtonElement>({
    id: "task-cancel",
    role: "button",
    label: t("taskeditor.cancel", { defaultValue: "Cancel" }),
    group: "task-editor",
    description: "Discard changes and close the editor",
    onActivate: () => onCancel?.(),
  });
  const saveButton = useAgentElement<HTMLButtonElement>({
    id: "task-save",
    role: "button",
    label: isEditing
      ? t("taskeditor.saveTask", { defaultValue: "Save prompt automation" })
      : t("taskeditor.createTask", {
          defaultValue: "Create prompt automation",
        }),
    group: "task-editor",
    description: "Save the prompt automation",
  });

  const submit = useCallback(async () => {
    if (readOnly) return;
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName) {
      setError(
        t("taskeditor.titleRequired", { defaultValue: "Title is required." }),
      );
      return;
    }
    if (!trimmedPrompt) {
      setError(
        t("taskeditor.promptRequired", { defaultValue: "Prompt is required." }),
      );
      return;
    }
    let scheduledAtIso: string | undefined;
    if (scheduleKind === "once") {
      const scheduledAtMs = Date.parse(scheduledAt.trim());
      if (!Number.isFinite(scheduledAtMs)) {
        setError(
          t("taskeditor.scheduledTimeRequired", {
            defaultValue: "Choose a date and time to run this automation.",
          }),
        );
        return;
      }
      if (scheduledAtMs <= Date.now()) {
        setError(
          t("taskeditor.scheduledTimeFuture", {
            defaultValue: "Choose a future date and time.",
          }),
        );
        return;
      }
      scheduledAtIso = new Date(scheduledAtMs).toISOString();
    }
    if (scheduleKind === "recurring" && !cron.trim()) {
      setError(
        t("taskeditor.cronRequired", {
          defaultValue: "Cron expression is required.",
        }),
      );
      return;
    }
    if (scheduleKind === "event" && !eventName.trim()) {
      setError(
        t("taskeditor.eventRequired", { defaultValue: "Event is required." }),
      );
      return;
    }
    setError(null);
    setAlwaysOnRequirement(null);
    setBusy(true);
    try {
      const request = {
        kind: "prompt" as const,
        displayName: trimmedName,
        instructions: trimmedPrompt,
        triggerType:
          scheduleKind === "once"
            ? ("once" as const)
            : scheduleKind === "recurring"
              ? ("cron" as const)
              : ("event" as const),
        scheduledAtIso,
        cronExpression: scheduleKind === "recurring" ? cron.trim() : undefined,
        eventKind: scheduleKind === "event" ? eventName.trim() : undefined,
        wakeMode: "inject_now" as const,
        enabled: true,
      };
      if (initial?.triggerId) {
        await client.updateTrigger(initial.triggerId, request);
      } else {
        await client.createTrigger(request);
      }
      onSaved?.();
    } catch (e) {
      if (isApiError(e) && e.code === "workflow_requires_always_on") {
        setAlwaysOnRequirement(e.message);
        return;
      }
      setError(
        e instanceof Error
          ? e.message
          : t("taskeditor.saveError", {
              defaultValue: "Failed to save prompt automation.",
            }),
      );
    } finally {
      setBusy(false);
    }
  }, [
    name,
    prompt,
    scheduleKind,
    scheduledAt,
    cron,
    eventName,
    initial?.triggerId,
    readOnly,
    onSaved,
    t,
  ]);

  return (
    <PagePanel variant="padded" className="space-y-5">
      {readOnly && (
        <div className="rounded-sm bg-bg-accent/40 p-2 text-sm text-muted-strong">
          {t("taskeditor.legacyReadOnly", {
            defaultValue:
              "This legacy automation is read-only. New automations use scheduled triggers.",
          })}
        </div>
      )}
      {error && (
        <div role="alert" className="p-2 text-sm text-danger">
          {error}
        </div>
      )}
      {alwaysOnRequirement && (
        <div
          role="alert"
          data-testid="task-always-on-required"
          className="flex flex-col gap-3 rounded-sm border border-warning/25 bg-warning/10 p-3 text-sm text-accent-muted dark:text-warning sm:flex-row sm:items-center"
        >
          <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {t("taskeditor.alwaysOnRequired", {
                defaultValue: "Always-on agent required",
              })}
            </p>
            <p className="mt-1 text-xs opacity-90">{alwaysOnRequirement}</p>
            <p className="mt-1 text-xs opacity-90">
              {t("taskeditor.alwaysOnBilling", {
                defaultValue:
                  "Enabling always-on changes this agent from scale-to-zero to continuous hosting and starts continuous hourly credit usage.",
              })}
            </p>
          </div>
          {cloudAgentId && onEnableAlwaysOn && (
            <Button
              size="sm"
              className="min-h-11 shrink-0 sm:min-h-8"
              onClick={() => onEnableAlwaysOn(cloudAgentId)}
            >
              <Rocket className="h-4 w-4" aria-hidden />
              {t("taskeditor.enableAlwaysOn", {
                defaultValue: "Enable always-on",
              })}
            </Button>
          )}
        </div>
      )}

      <div className="space-y-2">
        <FieldLabel>
          {t("taskeditor.titleLabel", { defaultValue: "Title" })}
        </FieldLabel>
        <Input
          ref={nameField.ref}
          value={name}
          onChange={(e) => setName(e.target.value)}
          readOnly={readOnly}
          placeholder={t("taskeditor.titlePlaceholder", {
            defaultValue: "Summarise yesterday's emails",
          })}
          autoFocus
          data-testid="task-editor-name"
          {...nameField.agentProps}
        />
      </div>

      <div className="space-y-2">
        <FieldLabel>
          {t("taskeditor.promptLabel", { defaultValue: "Prompt" })}
        </FieldLabel>
        <Textarea
          ref={promptField.ref}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          readOnly={readOnly}
          placeholder={t("taskeditor.promptPlaceholder", {
            defaultValue: "What should the agent do when this runs?",
          })}
          rows={5}
          data-testid="task-editor-prompt"
          {...promptField.agentProps}
        />
      </div>

      <fieldset className="space-y-3">
        <legend className="text-xs text-muted">
          {t("taskeditor.scheduleLegend", { defaultValue: "Schedule" })}
        </legend>
        <div className="flex flex-wrap gap-2">
          <ScheduleRadio
            id="task-sched-once"
            label={t("taskeditor.scheduleOnce", { defaultValue: "Once" })}
            icon={<Zap className="h-3.5 w-3.5" aria-hidden />}
            checked={scheduleKind === "once"}
            onSelect={() => setScheduleKind("once")}
            disabled={readOnly}
          />
          <ScheduleRadio
            id="task-sched-recurring"
            label={t("taskeditor.scheduleRecurring", {
              defaultValue: "Recurring",
            })}
            icon={<Clock3 className="h-3.5 w-3.5" aria-hidden />}
            checked={scheduleKind === "recurring"}
            onSelect={() => setScheduleKind("recurring")}
            disabled={readOnly}
          />
          <ScheduleRadio
            id="task-sched-event"
            label={t("taskeditor.scheduleEvent", { defaultValue: "On event" })}
            icon={<Calendar className="h-3.5 w-3.5" aria-hidden />}
            checked={scheduleKind === "event"}
            onSelect={() => setScheduleKind("event")}
            disabled={readOnly || availableEvents.length === 0}
          />
        </div>

        {scheduleKind === "once" && !readOnly && (
          <div className="space-y-2">
            <FieldLabel htmlFor="task-scheduled-at">
              {t("taskeditor.runAtLabel", { defaultValue: "Run at" })}
            </FieldLabel>
            <Input
              ref={scheduledAtField.ref}
              id="task-scheduled-at"
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
              data-testid="task-editor-scheduled-at"
              {...scheduledAtField.agentProps}
            />
          </div>
        )}

        {scheduleKind === "recurring" && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {CRON_PRESETS.map((preset) => (
                <CronPresetButton
                  key={preset.expression}
                  label={preset.label}
                  expression={preset.expression}
                  active={cron === preset.expression}
                  onSelect={setCron}
                  disabled={readOnly}
                />
              ))}
            </div>
            <Input
              ref={cronField.ref}
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              readOnly={readOnly}
              placeholder="0 9 * * 1-5"
              className="font-mono text-xs"
              data-testid="task-editor-cron"
              {...cronField.agentProps}
            />
            {cronPreview && (
              <div className="text-xs text-muted-strong">
                {t("taskeditor.runsPrefix", { defaultValue: "Runs " })}
                <span className="text-txt">{cronPreview.toLowerCase()}</span>.
              </div>
            )}
          </div>
        )}

        {scheduleKind === "event" && availableEvents.length > 0 && (
          <Select
            value={eventName}
            onValueChange={setEventName}
            disabled={readOnly}
          >
            <SelectTrigger
              ref={eventField.ref}
              className="w-full rounded-sm border-border/40 bg-bg text-sm text-txt"
              data-testid="task-editor-event"
              {...eventField.agentProps}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableEvents.map((event) => (
                <SelectItem key={event.id} value={event.id}>
                  {event.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </fieldset>

      <div className="flex items-center justify-end gap-2 pt-2">
        {onCancel && (
          <Button
            ref={cancelButton.ref}
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
            {...cancelButton.agentProps}
          >
            {t("taskeditor.cancel", { defaultValue: "Cancel" })}
          </Button>
        )}
        {!readOnly && (
          <Button
            ref={saveButton.ref}
            variant="default"
            size="sm"
            onClick={() => void submit()}
            disabled={busy || !name.trim() || !prompt.trim()}
            data-testid="task-editor-save"
            {...saveButton.agentProps}
          >
            {busy ? <Spinner className="mr-2 h-3.5 w-3.5" /> : null}
            {isEditing
              ? t("taskeditor.saveTask", {
                  defaultValue: "Save prompt automation",
                })
              : t("taskeditor.createTask", {
                  defaultValue: "Create prompt automation",
                })}
          </Button>
        )}
      </div>
    </PagePanel>
  );
}

function ScheduleRadio({
  id,
  label,
  icon,
  checked,
  onSelect,
  disabled,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id,
    role: "tab",
    label,
    group: "task-schedule-kind",
    description: `Set the schedule to ${label}`,
    status: checked ? "active" : "inactive",
    onActivate: () => {
      if (!disabled) onSelect();
    },
  });
  return (
    <label
      htmlFor={id}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-xs transition-colors ${
        disabled
          ? "cursor-not-allowed border-border/30 text-muted opacity-60"
          : checked
            ? "border-accent bg-accent/10 text-accent"
            : "border-border/40 text-muted-strong hover:border-border"
      }`}
    >
      <Input
        ref={ref}
        id={id}
        type="radio"
        name="task-schedule-kind"
        className="sr-only"
        checked={checked}
        onChange={onSelect}
        disabled={disabled}
        aria-current={checked ? "true" : undefined}
        {...agentProps}
      />
      {icon}
      {label}
    </label>
  );
}

function CronPresetButton({
  label,
  expression,
  active,
  onSelect,
  disabled,
}: {
  label: string;
  expression: string;
  active: boolean;
  onSelect: (expression: string) => void;
  disabled?: boolean;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `task-cron-preset-${expression.replace(/[^a-z0-9]+/gi, "-")}`,
    role: "button",
    label,
    group: "task-cron-presets",
    description: `Use the ${label} cron preset`,
    status: active ? "active" : "inactive",
    onActivate: () => {
      if (!disabled) onSelect(expression);
    },
  });
  return (
    <Button
      ref={ref}
      onClick={() => onSelect(expression)}
      variant="ghost"
      size="sm"
      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-accent bg-accent/10 text-accent"
          : "border-border/40 text-muted-strong hover:border-border"
      }`}
      disabled={disabled}
      {...agentProps}
    >
      {label}
    </Button>
  );
}
