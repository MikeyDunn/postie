import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import type { PostalAddress, PostcardSize } from '../core/types';

export interface CreatePostcardInput {
  size: PostcardSize;
  to: PostalAddress;
  /**
   * Public URLs of the rendered card images (S3). Artwork HTML fields cap at
   * 100k characters (verified live via 422), so images must be hosted, never
   * inlined as data URIs.
   */
  frontUrl: string;
  backUrl?: string;
  /** Stable per-message key; hashed into a deterministic idempotency UUID. */
  idempotencyKey: string;
  description?: string;
}

export interface PostcardResult {
  id: string;
  status: string;
  proofUrl?: string;
}

/** Fixed namespace so the same message always yields the same idempotency key. */
const IDEMPOTENCY_NAMESPACE = uuidv5('postie.mail', uuidv5.URL);

export interface MailstreamClient {
  createPostcard(input: CreatePostcardInput): Promise<PostcardResult>;
  getPostcard(id: string): Promise<PostcardResult>;
}

/** 402 — the workspace's Mailstream account has no print points. Not retryable. */
export class InsufficientPointsError extends Error {
  constructor(detail: string) {
    super(`Mailstream 402: ${detail.slice(0, 300)}`);
    this.name = 'InsufficientPointsError';
  }
}

/**
 * Local stand-in: deterministic ids, no network (MAILSTREAM_MODE=stub, the default).
 */
export class StubMailstreamClient implements MailstreamClient {
  async createPostcard(input: CreatePostcardInput): Promise<PostcardResult> {
    const hash = createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 12);
    return {
      id: `psc_stub_${hash}`,
      status: 'submitted',
      proofUrl: `https://my.mailstream.app/proofs/stub_${hash}.pdf`,
    };
  }

  async getPostcard(id: string): Promise<PostcardResult> {
    return { id, status: 'submitted' };
  }
}

/**
 * VERIFIED CONTRACT (probed live 2026-07-13; confirmed with a real
 * production order 2026-07-16):
 *   - Base URL https://my.mailstream.app/api/v1, `Authorization: Bearer <jwt>`
 *   - POST /postcards body: name, size (4x6|6x9|6x11), mail_type (first_class),
 *     to_address{first_name,last_name,address_line1[,address_line2],address_city,
 *     address_state(2-letter),address_zip(5-10)}, front_artwork + back_artwork —
 *     both must be HTML ("Must be valid HTML") capped at 100k chars, so
 *     rendered images ship inside a full-bleed <img> wrapper pointing at a
 *     hosted URL (data URIs would blow the cap).
 *   - Idempotency-Key header must be a UUID; same key + same payload replays the
 *     cached response (Idempotency-Status: Repeated), different payload → 422,
 *     concurrent → 409.
 *   - Return (from) address is account-level (/return-addresses, one default).
 *   - Printing is gated by print-points balance (charged at creation; 402
 *     with a balance breakdown when underfunded). API-created cards go
 *     straight to Scheduled — there is no proof-approval gate.
 */
export class HttpMailstreamClient implements MailstreamClient {
  constructor(
    private apiKey: string,
    private baseUrl: string = process.env.MAILSTREAM_BASE_URL ?? 'https://my.mailstream.app/api/v1',
  ) {}

  async createPostcard(input: CreatePostcardInput): Promise<PostcardResult> {
    const res = await fetch(`${this.baseUrl}/postcards`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Idempotency-Key': uuidv5(input.idempotencyKey, IDEMPOTENCY_NAMESPACE),
      },
      body: JSON.stringify({
        name: input.description ?? `Postie ${input.idempotencyKey}`,
        size: input.size,
        mail_type: process.env.MAILSTREAM_MAIL_TYPE ?? 'first_class',
        to_address: {
          first_name: input.to.firstName,
          last_name: input.to.lastName,
          address_line1: input.to.line1,
          address_line2: input.to.line2,
          address_city: input.to.city,
          address_state: input.to.state,
          address_zip: input.to.postalCode,
        },
        front_artwork: imageHtml(input.frontUrl),
        back_artwork: input.backUrl ? imageHtml(input.backUrl) : undefined,
      }),
    });
    if (res.status === 402) {
      throw new InsufficientPointsError(await res.text().catch(() => ''));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Mailstream ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as Record<string, any>;
    return mapPostcard(json.data ?? json);
  }

  async getPostcard(id: string): Promise<PostcardResult> {
    const res = await fetch(`${this.baseUrl}/postcards/${id}`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Mailstream ${res.status} fetching postcard ${id}`);
    }
    const json = (await res.json()) as Record<string, any>;
    return mapPostcard(json.data ?? json);
  }
}

function mapPostcard(card: Record<string, any>): PostcardResult {
  // Response shape verified live 2026-07-16: uuid (psc_…), campaign_uuid
  // (singles are auto-wrapped in a campaign), url = signed preview PDF
  // (~7-day expiry), thumbnails[{large,small}], status "pending",
  // send_date next-day, carrier/size/mail_type echoes.
  return {
    id: String(card.uuid ?? card.id ?? ''),
    status: String(card.status ?? 'submitted'),
    proofUrl: (card.url ?? card.proof_url) as string | undefined,
  };
}

/** Full-bleed HTML wrapper — Mailstream's artwork fields take HTML, not files. */
function imageHtml(imageUrl: string): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;width:100%;height:100%}' +
    'img{width:100%;height:100%;display:block;object-fit:cover}' +
    `</style></head><body><img src="${imageUrl}"></body></html>`
  );
}

export function getMailstreamClient(apiKey: string | undefined): MailstreamClient {
  const mode = process.env.MAILSTREAM_MODE ?? 'stub';
  if (mode === 'live') {
    if (!apiKey) throw new Error('MAILSTREAM_MODE=live but no API key is configured');
    return new HttpMailstreamClient(apiKey);
  }
  return new StubMailstreamClient();
}

export function isStubMode(): boolean {
  return (process.env.MAILSTREAM_MODE ?? 'stub') !== 'live';
}
