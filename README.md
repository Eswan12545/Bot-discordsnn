# Shop Ticket Bot

A Discord.js v14 bot for your shop server: a ticket dashboard with an image + buttons for
**Shop Ticket**, **Ticket Mediator**, and **Ticket Support**, plus in-ticket controls for your
**Seller** role to add/remove users, rename, and close tickets — all using your custom emojis.

## 1. Install

```bash
npm install
```

## 2. Configure

**`.env`** — copy `.env.example` to `.env` and fill in:

```
DISCORD_TOKEN=your bot token
CLIENT_ID=your application/client id
GUILD_ID=your server id
```

Get these from https://discord.com/developers/applications (Bot tab for token, General
Information tab for Client ID). Enable Developer Mode in Discord (User Settings → Advanced) to
right-click and copy your Server ID.

**`config.json`** — fill in the placeholders (`PUT_..._HERE`):

| Field | What it is |
|---|---|
| `sellerRoleId` | The role that can manage tickets (add/remove/rename/close) |
| `categories.shop` / `.mediator` / `.support` | The category channel ID each ticket type is created under (create 3 categories first) |
| `logChannelId` | (optional) a channel to log ticket open/close events |
| `panel.imageUrl` | Direct link (.png/.jpg) for the banner image — **ignored** if `assets/banner.png` exists (see below) |

The custom emojis you dropped are already wired in under `config.emojis` — swap any of them out
by editing that section, format `<:name:id>` or `<a:name:id>` for animated ones.

## 2b. Banner image

Your ticket dashboard banner is already bundled at `assets/banner.png` and is used automatically
— no image hosting needed. Want to swap it? Just replace that file with a same-named `.png`.

## 3. Bot permissions & invite

When creating the invite link (OAuth2 → URL Generator), select scopes `bot` and
`applications.commands`, and permissions:
- Manage Channels
- Manage Roles
- View Channels
- Send Messages
- Read Message History
- Embed Links
- Attach Files

Make sure the bot's role in Server Settings → Roles is **above** your Seller role, or it won't be
able to manage ticket channel permissions correctly.

## 4. Register the slash command

```bash
npm run deploy
```

This registers `/panel` in your server (instant, since it's guild-scoped).

## 5. Run the bot

```bash
npm start
```

## 6. Post the dashboard

In any channel, run `/panel` (requires Manage Server permission). This posts the embed + image +
the three ticket buttons. Users click a button to open a private ticket channel in the matching
category, visible only to them, your Seller role, and staff with the Administrator permission.

## How it works

- **Opening a ticket**: creates a text channel named e.g. `shop-username` under the configured
  category, with permissions locked to the ticket owner + Seller role + bot.
- **Duplicate prevention**: a user can't open a second ticket while one is already open (checked
  via the channel topic).
- **Inside each ticket**, Sellers/Admins see 4 buttons:
  - **Add User** — opens a small form to add someone by ID or mention
  - **Remove User** — same, but removes their access
  - **Rename** — renames the channel
  - **Close** — asks for confirmation, then locks and deletes the channel after 5 seconds (and
    logs it to `logChannelId` if set)
- Only members with the Seller role (or Administrator) can use the management buttons — everyone
  else gets a polite "not allowed" message.

## What's new

### 🐛 Fixed: `DiscordjsTypeError [InvalidType]: Supplied parameter is not a cached User or Role`
This crashed ticket creation whenever a role ID in `.env` (`SHOP_ROLE_ID`, `ADMIN_ROLE_IDS`, etc.)
didn't match an actual role in the server (wrong ID, typo, or a role copied from another server).
The bot now checks every role ID against the server's role cache before using it. If one is bad,
it's simply skipped (with a warning printed in the console telling you exactly which env var to
fix) instead of crashing the whole interaction.

### 🎫 Apply tickets now ask "Choose your application type"
Opening a **Ticket Apply** now also drops a dropdown menu with **Apply Seller** and **Apply
Staff**, matching a standard ticket-tool style flow:
1. User picks Seller or Staff from the dropdown.
2. A short form (modal) pops up — age, experience, and reason for applying.
3. On submit, the bot posts their answers as an embed and pings the matching role
   (`APPLY_SELLER_ROLE_ID` / `APPLY_STAFF_ROLE_ID` in `.env`) with a **"Wait For:"** message, then
   locks the dropdown so it can't be used twice in the same ticket.

If you leave `APPLY_SELLER_ROLE_ID` / `APPLY_STAFF_ROLE_ID` empty, it still works — it just won't
ping a specific role.

### 👋 New member welcome message
Set `WELCOME_CHANNEL_ID` in `.env` to have the bot post a styled welcome embed (using your banner,
the new member's avatar, and their member number) every time someone joins. Wording, title, and
color are editable under the new `"welcome"` block in `config.json` — you can use `{user}`,
`{guild}`, and `{memberCount}` placeholders anywhere in the text.

> ⚠️ This requires the **Server Members Intent** to be turned ON for your bot in the
> [Discord Developer Portal](https://discord.com/developers/applications) → your app → Bot →
> Privileged Gateway Intents. Without it, `guildMemberAdd` never fires.

### 🏷️ Ticket opener's role now shown in the welcome message
When a ticket is opened, the welcome embed now shows the opener's **highest role** next to their
name, e.g. `Hello @Zero (VIP), thanks for opening a Mediator ticket.` If the member has no roles
besides `@everyone`, it just shows their name like before — nothing extra is added.

### 🔊 24/7 voice channel presence
Set `VOICE_CHANNEL_ID` in `.env` to a voice channel ID and the bot will join that channel as soon
as it starts, and **stay there permanently**:
- If Discord drops the connection (voice server move, brief network blip, etc.), the bot waits a
  few seconds to see if it reconnects on its own, and if not, destroys the old connection and
  rejoins from scratch automatically.
- The bot joins muted and deafened (`selfMute` / `selfDeaf`) since it's just holding a presence,
  not talking or listening — this avoids the "Bot is speaking" indicator without reason.
- Leave `VOICE_CHANNEL_ID` empty to disable this entirely.

This requires the new `@discordjs/voice` and `libsodium-wrappers` packages, already added to
`package.json` — just re-run `npm install` after pulling this update.

⚠️ Make sure the bot's role has **Connect** and **View Channel** permission on that voice channel,
or joining will silently fail (check the console for a `[voice]` warning).

## Running the bot 24/7 (so it doesn't stop when you close your PC)

Running `npm start` in your terminal only keeps the bot alive while that terminal window is open.
To have it run permanently, pick one of these:

### Option A — Your own VPS/server (Linux), using PM2
PM2 keeps the process running in the background, restarts it if it crashes, and can start it
automatically on server reboot.
```bash
npm install -g pm2
cd shop-ticket-bot
npm install
pm2 start index.js --name shop-ticket-bot
pm2 save
pm2 startup   # follow the printed instructions to enable auto-start on reboot
```
Useful commands afterward: `pm2 logs shop-ticket-bot`, `pm2 restart shop-ticket-bot`,
`pm2 stop shop-ticket-bot`.

### Option B — Railway / Render (no server management needed)
1. Push this folder to a GitHub repo.
2. Create a new project on Railway (https://railway.app) or Render (https://render.com) and
   connect that repo.
3. Set the **Start Command** to `npm start` (Railway/Render usually detect this automatically from
   `package.json`).
4. Add all the variables from your `.env` file as environment variables in the platform's
   dashboard (Railway: Variables tab; Render: Environment tab) — don't upload the `.env` file
   itself.
5. Deploy. The platform keeps the bot running continuously and restarts it automatically if it
   crashes.

Either option keeps the bot (and its voice-channel presence, if configured) running 24/7 without
needing your own computer on.

## Private Store system

Run `/storepanel` in any channel to post the **Private Store Menu** — a panel with a select menu
offering:
- **1 Week Store** (150,000 credits, 7 days)
- **1 Month Store** (500,000 credits, 30 days)
- **Renew Store** (extend an existing store's expiry)

### How a purchase works
1. The buyer picks an option from the select menu.
2. The bot replies (privately) with payment instructions: pay the required amount to the store
   owner (`STORE_OWNER_ID`) using ProBot, in the configured payment channel (`PAYMENT_CHANNEL_ID`) —
   e.g. `#credit <owner_id> <amount>`.
3. When the buyer sends that `#credit` command, the bot notes that this message belongs to them.
   ProBot then replies to that same message with a confirmation — the bot recognizes the reply and,
   as long as it looks like a success message, automatically:
   - Creates a private text channel under `PRIVATE_STORE_CATEGORY_ID`, named after the buyer, with
     the buyer given full control over it.
   - Records the store's expiry date.
   - Sends the buyer a DM confirming the purchase.
4. If nobody pays within `STORE_PAYMENT_TIMEOUT_MINUTES` (default 15), the request simply expires
   and they can try again from the panel.

### Renewing a store
Picking **Renew Store** opens a small form asking for the store's channel ID and a duration
("week" or "month"). It then goes through the same payment flow above — once ProBot confirms the
payment, the store's expiry is extended automatically instead of creating a new channel.

### Reminders & expiry
Every 10 minutes the bot checks all stores:
- **24 hours before expiry**, the owner gets a one-time DM reminder to renew.
- **Once expired**, the channel is deleted automatically and the owner is notified by DM.

Store records persist across restarts in `store-data.json` (created automatically next to
`index.js` — don't delete it, or the bot will forget which channels are stores and when they
expire).

### Setup checklist
In `.env`, set:
- `PRIVATE_STORE_CATEGORY_ID` — category where store channels get created
- `PAYMENT_CHANNEL_ID` — channel where ProBot payment confirmations are posted/watched
- `PROBOT_ID` — ProBot's own bot user ID (so only real ProBot messages are trusted)
- `STORE_OWNER_ID` — the user credits get paid to
- `STORE_PAYMENT_TIMEOUT_MINUTES` — optional, defaults to 15

⚠️ **Message Content intent required.** Recognizing the `#credit <owner_id> <amount>` command needs
the bot to actually read message text, which Discord treats as a privileged intent. Go to
https://discord.com/developers/applications → your application → **Bot** → scroll to
**Privileged Gateway Intents** → enable **Message Content Intent** → Save Changes. Without this
enabled on the developer portal, `message.content` arrives empty and payments will never be
detected, even though the code itself is correct.

⚠️ Why this approach instead of parsing ProBot's confirmation directly: ProBot takes a small fee on
transfers, so the amount shown in its confirmation is always less than what was actually paid, and
it refers to the payer by plain username text rather than an @mention — both make the confirmation
message itself unreliable to parse. Tracking the buyer's original command and matching ProBot's
*reply* to it sidesteps both problems.

## Notes / things you may want to customize

- Right now Close **deletes** the channel. If you'd rather keep a transcript, swap the
  `setTimeout(() => interaction.channel.delete()...)` block in `index.js` for something that
  moves the channel to an "Archived" category and locks it instead, or add a transcript-logging
  library (e.g. `discord-html-transcripts`).
- The emoji set you provided (`Hearts`, `bell_gn`, `booot`, `hhh`, `fgz`, `aha`, `NOT_verified`)
  only had 7 icons for 7 buttons, so each is used once — feel free to shuffle them around in
  `config.json` to match your taste (e.g. use `NOT_verified` for something else and reuse `Hearts`
  elsewhere).
- These are custom emojis from a specific server, so the bot **must be in that same server** (or
  have access to it) to render them — if buttons show a blank/broken emoji, it means the bot
  can't see that emoji's source server.
