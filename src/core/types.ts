export type PostcardSize = '4x6' | '6x9' | '6x11';

export interface PostalAddress {
  /** Mailstream requires split names on recipient addresses. */
  firstName: string;
  lastName: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
}

export function addressDisplayName(a: PostalAddress): string {
  return `${a.firstName} ${a.lastName}`.trim();
}

export interface TeamConfig {
  teamId: string;
  /** Encrypted at rest — see core/crypto.ts ("kms:" or "plain:" prefixed). */
  mailstreamApiKey?: string;
  address?: PostalAddress;
  /**
   * Optional "copy to me": when set, every card also mails a second identical
   * copy here (a second real card — its own points + daily-cap slot). Off
   * until set; cleared with `/postie cc off`.
   */
  ccAddress?: PostalAddress;
  threshold: number;
  triggerEmoji: string;
  dailyCap: number;
  size: PostcardSize;
  /**
   * 'everywhere': Postie auto-joins public channels (join-all backfill +
   * new-channel auto-join) so reactions always work — right for a workspace
   * that trusts itself. 'invited': Postie only works where it was added via
   * /postie here or /invite — the privacy-friendly default for public
   * distribution (reactions in other channels do nothing, silently).
   */
  presence: 'everywhere' | 'invited';
  /**
   * `/postie off` — a workspace-wide pause. Trigger reactions are ignored
   * (no new cards, no spend) until `/postie on`; already-mailed cards keep
   * being tracked. Absent means running, so existing configs need no
   * migration and `on` just removes the attribute.
   */
  paused?: boolean;
}

export type CardStatus = 'sending' | 'sent' | 'failed';

export interface CardRecord {
  teamId: string;
  channelId: string;
  messageTs: string;
  status: CardStatus;
  postcardId?: string;
  proofUrl?: string;
  sentAt?: string;
  error?: string;
  /** Last Mailstream status seen by the delivery tracker. */
  mailstreamStatus?: string;
  /** Set when tracking stops (terminal status or age limit). */
  trackingDone?: boolean;
}

export interface SendJob {
  type: 'send';
  teamId: string;
  channelId: string;
  messageTs: string;
}

/** Join every public channel so reaction events flow without manual invites. */
export interface JoinAllJob {
  type: 'join_all';
  teamId: string;
  /** Slash-command response_url for posting the summary (valid 30 min). */
  responseUrl: string;
}

/** Periodic tick from EventBridge: poll open cards for delivery updates. */
export interface TrackAllJob {
  type: 'track_all';
}

export type Job = SendJob | JoinAllJob | TrackAllJob;

export const CONFIG_DEFAULTS = {
  threshold: 5,
  triggerEmoji: 'postcard',
  dailyCap: 10,
  size: '4x6' as PostcardSize,
  // Single-workspace phase: no silent failures. Flip to 'invited' for public.
  presence: 'everywhere' as const,
};
