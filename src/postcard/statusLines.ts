/**
 * Thread messages for Mailstream postcard status values, posted by the
 * polling tracker. Unknown statuses get a generic line, so new upstream
 * values degrade gracefully.
 */
export const STATUS_LINES: Record<string, string> = {
  ready: ':frame_with_picture: The print proof is ready.',
  failed:
    ':warning: Mailstream could not render the print proof — this card may not mail. Check the Mailstream dashboard.',
  preparing: ':printer: The card is being prepared for print.',
  printed: ':printer: Postcard printed — heading to the mail stream.',
  sent: ':envelope_with_arrow: Handed to USPS!',
  mailed: ':envelope_with_arrow: In the mail! USPS has it.',
  in_transit: ':truck: Moving through the postal network.',
  processed_for_delivery: ':mailbox_with_mail: Out for delivery.',
  delivered: ':tada: Delivered! Go check the mailbox.',
  returned:
    ':leftwards_arrow_with_hook: Returned to sender — check the address with `/postie status`.',
  cancelled: ':no_entry_sign: This postcard was cancelled in Mailstream.',
};

export function statusLine(status: string): string {
  return STATUS_LINES[status] ?? `:mailbox: Postcard update: ${status}`;
}

/** Statuses after which polling stops. */
export const TERMINAL_STATUSES = new Set(['delivered', 'returned', 'cancelled', 'failed']);
