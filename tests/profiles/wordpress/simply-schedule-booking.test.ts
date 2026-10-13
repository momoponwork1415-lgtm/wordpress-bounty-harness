import { describe, expect, it, vi } from "vitest";

import type { Resources } from "../../../src/profiles/wordpress/lab/index.js";
import {
  assertSimplyScheduleBookingTarget,
  seedSimplyScheduleBooking,
} from "../../../src/profiles/wordpress/lab/simply-schedule-booking.js";

const resource = {} as Resources;

describe("ordinary booking-page Lab adapter", () => {
  it("skips seeding when no booking page is requested", async () => {
    const wp = vi.fn();
    await seedSimplyScheduleBooking({
      bookingPage: false,
      targetSlug: "another-plugin",
      resource,
      wp,
    });
    expect(wp).not.toHaveBeenCalled();
  });

  it("fails closed when the selected target has no booking adapter", async () => {
    const wp = vi.fn();
    expect(() =>
      assertSimplyScheduleBookingTarget(true, "another-plugin"),
    ).toThrow("No booking-page Lab adapter for this target");
    await expect(
      seedSimplyScheduleBooking({
        bookingPage: true,
        targetSlug: "another-plugin",
        resource,
        wp,
      }),
    ).rejects.toThrow("No booking-page Lab adapter for this target");
    expect(wp).not.toHaveBeenCalled();
  });

  it("uses the plugin's normal model and verifies a public shortcode page", async () => {
    const wp = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    await seedSimplyScheduleBooking({
      bookingPage: true,
      targetSlug: "simply-schedule-appointments",
      resource,
      wp,
    });
    expect(wp).toHaveBeenCalledTimes(1);
    const args = wp.mock.calls[0]?.[1] as readonly string[];
    expect(args[0]).toBe("eval");
    expect(args[1]).toContain("$model=ssa()->appointment_type_model");
    expect(args[1]).toContain('"availability_type"=>"available_blocks"');
    expect(args[1]).toContain(
      '"Monday","Tuesday","Wednesday","Thursday","Friday"',
    );
    expect(args[1]).toContain('"post_status"=>"publish"');
    expect(args[1]).toContain('"post_content"=>"[ssa_booking]"');
    expect(args[1]).toContain(
      'has_shortcode($page->post_content,"ssa_booking")',
    );
  });
});
