/**
 * Pins the settings presentation contract for OS-private permission choices:
 * they stay neutral and settings-managed even if a backend reports prompt
 * eligibility, rather than appearing granted or prompting twice.
 */
import { describe, expect, it } from "vitest";
import { getPermissionAction, getPermissionBadge } from "./permission-types";

const untranslated = (key: string) => key;

describe("opaque permission presentation", () => {
  it("renders a neutral Choices set badge", () => {
    expect(getPermissionBadge(untranslated, "health", "opaque", "ios")).toEqual(
      {
        tone: "muted",
        label: "Choices set",
      },
    );
  });

  it("always manages choices in settings instead of requesting again", () => {
    expect(
      getPermissionAction(untranslated, "health", "opaque", true, "ios"),
    ).toEqual({
      ariaLabelPrefix: "Manage",
      label: "Manage",
      type: "settings",
    });
  });
});
