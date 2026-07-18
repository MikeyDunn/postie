import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { encryptSecret } from '../core/crypto';
import type { JobQueue } from '../core/queue';
import type { Store } from '../core/store';
import { addressDisplayName, type PostalAddress, type PostcardSize } from '../core/types';
import { isStubMode } from '../mailstream/client';
import { baseEmojiName } from '../postcard/emoji';

export interface ListenerDeps {
  store: Store;
  queue: JobQueue;
}

const HELP = [
  '*Postie* turns messages into real mailed postcards. React with the trigger emoji — when a message collects enough reactions, it prints and mails automatically.',
  '',
  "`/postie status` — current configuration + today's count",
  '`/postie setup` — set the Mailstream API key (admins)',
  '`/postie address` — set the mailing address (admins)',
  '`/postie threshold <n>` — reactions needed to send (default 5)',
  '`/postie emoji <name>` — trigger emoji (default :postcard:)',
  '`/postie cap <n>` — max cards per day (default 10)',
  '`/postie size <4x6|6x9|6x11>` — postcard size',
  '`/postie here` / `/postie leave` — add/remove Postie in this channel',
  '`/postie presence <everywhere|invited>` — auto-join all public channels, or only invited ones (admins)',
  '`/postie join-all` — join every public channel now (admins)',
  '',
  "_Postie only sees reactions in channels it's in — everywhere mode removes that footgun; invited mode is the privacy-friendly choice._",
].join('\n');

export function registerListeners(app: App, deps: ListenerDeps): void {
  registerReactionListener(app, deps);
  registerCommand(app, deps);
  registerViews(app, deps);
}

// ---------------------------------------------------------------------------
// The trigger: postcard reactions
// ---------------------------------------------------------------------------

function registerReactionListener(app: App, deps: ListenerDeps): void {
  // Reaction events only arrive for channels the bot is in — in 'everywhere'
  // mode, auto-join new public channels (backfill via /postie join-all).
  app.event('channel_created', async ({ event, body, client }) => {
    const config = await deps.store.getTeamConfig(body.team_id);
    if (config.presence !== 'everywhere') return;
    try {
      await client.conversations.join({ channel: event.channel.id });
    } catch (err) {
      console.warn('[postie] could not join new channel:', err);
    }
  });

  app.event('reaction_added', async ({ event, body }) => {
    if (event.item.type !== 'message') return;
    const teamId = body.team_id;
    const config = await deps.store.getTeamConfig(teamId);
    console.log(
      `[postie] reaction :${event.reaction}: in ${event.item.channel} (trigger=:${config.triggerEmoji}:, threshold=${config.threshold})`,
    );
    if (baseEmojiName(event.reaction) !== config.triggerEmoji) return;
    // Cheap ack path: the worker re-reads the true count and holds the
    // exactly-once lock, so enqueueing on every trigger reaction is safe.
    await deps.queue.enqueue({
      type: 'send',
      teamId,
      channelId: event.item.channel,
      messageTs: event.item.ts,
    });
  });
}

// ---------------------------------------------------------------------------
// /postie command router
// ---------------------------------------------------------------------------

function registerCommand(app: App, deps: ListenerDeps): void {
  app.command('/postie', async ({ command, ack, respond, client }) => {
    await ack();
    const [sub = '', ...rest] = command.text.trim().split(/\s+/);
    const teamId = command.team_id;

    // Bolt 5: respond() resolves to a fetch Response — swallow it so
    // listeners keep the required Promise<void> shape.
    const reply = async (text: string): Promise<void> => {
      await respond({ response_type: 'ephemeral', text });
    };

    switch (sub.toLowerCase()) {
      case '':
      case 'help':
        return reply(HELP);

      case 'status': {
        const config = await deps.store.getTeamConfig(teamId);
        const today = new Date().toISOString().slice(0, 10);
        const count = await deps.store.getDailyCount(teamId, today);
        const total = await deps.store.getCardTotal(teamId);
        const address = config.address
          ? `${addressDisplayName(config.address)}, ${config.address.line1}, ${config.address.city} ${config.address.state} ${config.address.postalCode}`
          : '_not set — run `/postie address`_';
        return reply(
          [
            '*Postie status*',
            `• Mailstream key: ${config.mailstreamApiKey ? ':lock: set' : '_not set — run `/postie setup`_'}`,
            `• Mode: ${isStubMode() ? ':test_tube: sandbox stub (no real mail)' : ':rocket: live'}`,
            `• Mail to: ${address}`,
            `• Trigger: ${config.threshold}× :${config.triggerEmoji}:`,
            `• Size: ${config.size} · Daily cap: ${count}/${config.dailyCap} used today · ${total} card${total === 1 ? '' : 's'} all-time`,
            `• Presence: ${config.presence === 'everywhere' ? ':earth_americas: everywhere (auto-joins public channels)' : ':door: invited only'}`,
          ].join('\n'),
        );
      }

      case 'setup': {
        if (!(await isAdmin(client, command.user_id))) {
          return reply(':no_entry: Only workspace admins can set the Mailstream API key.');
        }
        await client.views.open({
          trigger_id: command.trigger_id,
          view: setupModal(command.channel_id),
        });
        return;
      }

      case 'address': {
        if (!(await isAdmin(client, command.user_id))) {
          return reply(':no_entry: Only workspace admins can change the mailing address.');
        }
        const config = await deps.store.getTeamConfig(teamId);
        await client.views.open({
          trigger_id: command.trigger_id,
          view: addressModal(command.channel_id, config.address),
        });
        return;
      }

      // threshold/cap/size are the spend-control knobs — admins only.
      case 'threshold':
        if (!(await isAdmin(client, command.user_id))) {
          return reply(':no_entry: Only workspace admins can change the threshold.');
        }
        return updateNumber(deps, teamId, reply, rest[0], 1, 25, 'threshold', (n) => ({
          threshold: n,
        }));

      case 'cap':
        if (!(await isAdmin(client, command.user_id))) {
          return reply(':no_entry: Only workspace admins can change the daily cap.');
        }
        return updateNumber(deps, teamId, reply, rest[0], 1, 50, 'daily cap', (n) => ({
          dailyCap: n,
        }));

      case 'emoji': {
        if (!(await isAdmin(client, command.user_id))) {
          return reply(':no_entry: Only workspace admins can change the trigger emoji.');
        }
        const name = (rest[0] ?? '').replace(/:/g, '').trim();
        if (!name) return reply('Usage: `/postie emoji <name>` (e.g. `/postie emoji postcard`)');
        await deps.store.updateTeamConfig(teamId, { triggerEmoji: name });
        return reply(
          `Trigger emoji is now :${name}: — messages need ${(await deps.store.getTeamConfig(teamId)).threshold} of them to mail.`,
        );
      }

      case 'join-all': {
        if (!(await isAdmin(client, command.user_id))) {
          return reply(':no_entry: Only workspace admins can run join-all.');
        }
        await deps.queue.enqueue({ type: 'join_all', teamId, responseUrl: command.response_url });
        return reply(
          ':hourglass_flowing_sand: Joining all public channels — summary coming shortly.',
        );
      }

      case 'here': {
        try {
          await client.conversations.join({ channel: command.channel_id });
          return reply(':postbox: Postie is in! Postcard reactions now work in this channel.');
        } catch {
          return reply(
            ":no_entry: Couldn't join — private channels need `/invite @postie` (Slack doesn't let bots self-join those).",
          );
        }
      }

      case 'leave': {
        try {
          await client.conversations.leave({ channel: command.channel_id });
          return reply(':wave: Postie left this channel. Postcard reactions here will do nothing.');
        } catch {
          return reply(":no_entry: Couldn't leave this channel.");
        }
      }

      case 'presence': {
        if (!(await isAdmin(client, command.user_id))) {
          return reply(':no_entry: Only workspace admins can change presence mode.');
        }
        const mode = rest[0];
        if (mode !== 'everywhere' && mode !== 'invited') {
          return reply(
            'Usage: `/postie presence <everywhere|invited>`\n• *everywhere* — auto-join all public channels; reactions always work\n• *invited* — only works where added via `/postie here` or `/invite @postie`',
          );
        }
        await deps.store.updateTeamConfig(teamId, { presence: mode });
        return reply(
          mode === 'everywhere'
            ? ':earth_americas: Presence set to *everywhere* — run `/postie join-all` to backfill existing channels.'
            : ':door: Presence set to *invited* — Postie stays only where it was added. Reactions in other channels will do nothing (silently — Slack sends no events).',
        );
      }

      case 'size': {
        if (!(await isAdmin(client, command.user_id))) {
          return reply(':no_entry: Only workspace admins can change the postcard size.');
        }
        const size = rest[0] as PostcardSize;
        if (!['4x6', '6x9', '6x11'].includes(size)) {
          return reply('Usage: `/postie size <4x6|6x9|6x11>`');
        }
        await deps.store.updateTeamConfig(teamId, { size });
        return reply(`Postcards will now print at ${size}.`);
      }

      default:
        return reply(`Unknown subcommand \`${sub}\`.\n\n${HELP}`);
    }
  });
}

async function updateNumber(
  deps: ListenerDeps,
  teamId: string,
  reply: (text: string) => Promise<unknown>,
  raw: string | undefined,
  min: number,
  max: number,
  label: string,
  patch: (n: number) => Record<string, number>,
): Promise<void> {
  const n = parseInt(raw ?? '', 10);
  if (Number.isNaN(n) || n < min || n > max) {
    await reply(`The ${label} must be a number between ${min} and ${max}.`);
    return;
  }
  await deps.store.updateTeamConfig(teamId, patch(n));
  await reply(`The ${label} is now *${n}*.`);
}

async function isAdmin(client: WebClient, userId: string): Promise<boolean> {
  try {
    const res = await client.users.info({ user: userId });
    return Boolean(res.user?.is_admin || res.user?.is_owner);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Modals — the API key goes through a modal (not command text) so the secret
// never lands in channel autocomplete history or command logs.
// ---------------------------------------------------------------------------

function setupModal(channelId: string) {
  return {
    type: 'modal' as const,
    callback_id: 'postie_setup_modal',
    private_metadata: JSON.stringify({ channelId }),
    title: { type: 'plain_text' as const, text: 'Postie · Mailstream' },
    submit: { type: 'plain_text' as const, text: 'Save' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'api_key',
        label: { type: 'plain_text', text: 'Mailstream API key' },
        hint: {
          type: 'plain_text',
          text: 'Stored encrypted. Your workspace funds its own postage.',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'ms_live_…' },
        },
      },
    ],
  };
}

function addressModal(channelId: string, existing?: PostalAddress) {
  const text = (t: string) => ({ type: 'plain_text' as const, text: t });
  const input = (
    blockId: string,
    label: string,
    initial?: string,
    optional = false,
    placeholder?: string,
  ) => ({
    type: 'input',
    block_id: blockId,
    optional,
    label: text(label),
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      initial_value: initial,
      placeholder: placeholder ? text(placeholder) : undefined,
    },
  });
  return {
    type: 'modal' as const,
    callback_id: 'postie_address_modal',
    private_metadata: JSON.stringify({ channelId }),
    title: text('Postie · Address'),
    submit: text('Save'),
    close: text('Cancel'),
    blocks: [
      input('first_name', 'Recipient first name', existing?.firstName, false, 'Jane'),
      input('last_name', 'Recipient last name', existing?.lastName, false, 'Doe'),
      input('line1', 'Address line 1', existing?.line1, false, '123 Main St'),
      input('line2', 'Address line 2', existing?.line2, true, 'Apt 4'),
      input('city', 'City', existing?.city, false, 'Anytown'),
      input('state', 'State (2 letters)', existing?.state, false, 'CA'),
      input('zip', 'ZIP', existing?.postalCode, false, '90210'),
    ],
  };
}

function registerViews(app: App, deps: ListenerDeps): void {
  app.view('postie_setup_modal', async ({ ack, view, body, client }) => {
    await ack();
    const teamId = view.team_id;
    const values = view.state.values;
    const apiKey = values.api_key?.value?.value?.trim();
    if (apiKey) {
      await deps.store.updateTeamConfig(teamId, {
        mailstreamApiKey: await encryptSecret(apiKey),
      });
    }
    await confirmEphemeral(
      client,
      view.private_metadata,
      body.user.id,
      ':lock: Mailstream API key saved (encrypted). Run `/postie status` to check the rest of the setup.',
    );
  });

  app.view('postie_address_modal', async ({ ack, view, body, client }) => {
    const values = view.state.values;
    const get = (blockId: string) => values[blockId]?.value?.value?.trim() ?? '';
    const address: PostalAddress = {
      firstName: get('first_name'),
      lastName: get('last_name'),
      line1: get('line1'),
      line2: get('line2') || undefined,
      city: get('city'),
      state: get('state').toUpperCase(),
      postalCode: get('zip'),
    };

    const errors: Record<string, string> = {};
    if (!/^[A-Z]{2}$/.test(address.state)) errors.state = 'Use the 2-letter state code, e.g. TX';
    if (!/^\d{5}(-\d{4})?$/.test(address.postalCode)) errors.zip = 'Use a 5-digit ZIP (or ZIP+4)';
    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors });
      return;
    }
    await ack();

    await deps.store.updateTeamConfig(view.team_id, { address });
    await confirmEphemeral(
      client,
      view.private_metadata,
      body.user.id,
      `:house: Postcards will mail to *${addressDisplayName(address)}*, ${address.line1}, ${address.city} ${address.state} ${address.postalCode}. The return address comes from your Mailstream account default.`,
    );
  });
}

async function confirmEphemeral(
  client: WebClient,
  privateMetadata: string,
  userId: string,
  text: string,
): Promise<void> {
  try {
    const { channelId } = JSON.parse(privateMetadata || '{}');
    if (channelId) await client.chat.postEphemeral({ channel: channelId, user: userId, text });
  } catch (err) {
    console.warn('[postie] could not post confirmation:', err);
  }
}
