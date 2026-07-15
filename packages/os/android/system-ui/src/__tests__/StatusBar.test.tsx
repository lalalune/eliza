/** Verifies the AOSP status surface renders device state with accessible indicator semantics. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusBar } from "../components/StatusBar";
import { MockSystemProvider } from "../providers/MockSystemProvider";

afterEach(cleanup);

describe("StatusBar", () => {
  it("renders indicators from MockSystemProvider", () => {
    render(
      <MockSystemProvider
        locale="en-US"
        timeZone="UTC"
        tickMs={60_000}
        initialBattery={{ percent: 78, charging: true }}
        initialWifi={{ connected: true, ssid: "eliza-home" }}
        initialAudio={{ level: 0.55, muted: false }}
        initialCell={{
          strengthBars: 4,
          carrier: "T-Mobile",
          airplaneMode: false,
        }}
      >
        <StatusBar />
      </MockSystemProvider>,
    );

    expect(screen.getByLabelText(/Wi-Fi/)).toBeDefined();
    expect(screen.getByLabelText(/T-Mobile 4\/5/)).toBeDefined();
    expect(screen.getByLabelText(/Audio/)).toBeDefined();
    expect(screen.getByLabelText(/Battery 78%/)).toBeDefined();
  });

  it("exposes the clock and indicator group to assistive technology", () => {
    render(
      <MockSystemProvider locale="en-US" timeZone="UTC" tickMs={60_000}>
        <StatusBar />
      </MockSystemProvider>,
    );

    const clock = screen.getByRole("timer", {
      name: /^Time \d{2}:\d{2}$/,
    });
    expect(clock.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(
      screen.getByRole("toolbar", { name: "System indicators" }),
    ).toBeDefined();
  });
});
