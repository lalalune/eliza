/**
 * Story states for the in-chat background picker widget. The `[BACKGROUND]`
 * marker renders this exact component inside the transcript, so the story is
 * the repeatable screenshot surface for the filmstrip controls rather than a
 * hand-built approximation.
 */

import type { Meta, StoryObj } from "@storybook/react";
import {
  assert,
  waitForTestId,
} from "../../../storybook/home-widget-decorator";
import { MockAppProvider } from "../../../storybook/mock-providers";
import { BackgroundWidget } from "./background-widget";

const meta = {
  title: "Chat/BackgroundWidget",
  component: BackgroundWidget,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <MockAppProvider>
        <div className="max-w-xl">
          <Story />
        </div>
      </MockAppProvider>
    ),
  ],
} satisfies Meta<typeof BackgroundWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FilmstripPicker: Story = {
  play: async ({ canvasElement }) => {
    await waitForTestId(canvasElement, "inline-background");
    assert(
      canvasElement.textContent?.includes("Background"),
      "background picker shell title renders",
    );
  },
};
