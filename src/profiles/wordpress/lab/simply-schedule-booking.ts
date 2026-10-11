import type { DockerResult, Resources } from "./index.js";

type WordPressCommand = (
  resource: Resources,
  args: readonly string[],
) => Promise<DockerResult>;

const TARGET_SLUG = "simply-schedule-appointments";

/** A generic booking-page scenario needs a target adapter before provision. */
export function assertSimplyScheduleBookingTarget(
  bookingPage: boolean,
  targetSlug: string,
): void {
  if (bookingPage && targetSlug !== TARGET_SLUG)
    throw new Error("No booking-page Lab adapter for this target");
}

/** Set up one ordinary, published appointment type and a public booking page. */
export async function seedSimplyScheduleBooking(input: {
  readonly bookingPage: boolean;
  readonly targetSlug: string;
  readonly resource: Resources;
  readonly wp: WordPressCommand;
}): Promise<void> {
  if (!input.bookingPage) return;
  assertSimplyScheduleBookingTarget(input.bookingPage, input.targetSlug);

  // The pinned Basic edition's own appointment-type fixture uses this weekly
  // schedule and the plugin's documented shortcode renders the booking form.
  const script = [
    'if(!function_exists("ssa") || !shortcode_exists("ssa_booking")) exit(1);',
    '$admin=get_user_by("login","harness-admin"); if(!$admin) exit(2); wp_set_current_user($admin->ID);',
    '$availability=[]; foreach(["Monday","Tuesday","Wednesday","Thursday","Friday"] as $day) $availability[$day]=[["time_start"=>"09:00:00","time_end"=>"17:00:00"]]; $availability["Saturday"]=[]; $availability["Sunday"]=[];',
    "$model=ssa()->appointment_type_model;",
    '$id=$model->insert(["title"=>"Lab consultation","slug"=>"lab-consultation","status"=>"publish","duration"=>30,"capacity"=>1,"availability_type"=>"available_blocks","availability"=>$availability,"availability_increment"=>30,"timezone_style"=>"localized","booking_layout"=>"week","custom_customer_information"=>[["field"=>"Name","display"=>true,"required"=>true,"type"=>"single-text","icon"=>"face","values"=>""],["field"=>"Email","display"=>true,"required"=>true,"type"=>"single-text","icon"=>"email","values"=>""]]]);',
    "if(!is_numeric($id) || (int)$id<1) exit(3);",
    '$type=$model->get($id); if(!is_array($type) || $type["status"]!=="publish" || (int)$type["duration"]!==30 || $type["slug"]!=="lab-consultation" || ($type["availability"]["Monday"][0]["time_start"] ?? null)!=="09:00:00") exit(4);',
    '$page_id=wp_insert_post(["post_type"=>"page","post_status"=>"publish","post_name"=>"lab-booking","post_title"=>"Book an appointment","post_content"=>"[ssa_booking]"],true);',
    "if(is_wp_error($page_id) || !is_numeric($page_id) || (int)$page_id<1) exit(5);",
    '$page=get_post($page_id); if(!$page || $page->post_status!=="publish" || $page->post_type!=="page" || !has_shortcode($page->post_content,"ssa_booking")) exit(6);',
  ].join(" ");
  await input.wp(input.resource, ["eval", script]);
}
