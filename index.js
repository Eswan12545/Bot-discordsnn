require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  AttachmentBuilder
} = require('discord.js');
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');

const BANNER_PATH = path.join(__dirname, 'assets', 'banner.png');
const BANNER_EXISTS = fs.existsSync(BANNER_PATH);
const STORE_BANNER_PATH = path.join(__dirname, 'assets', 'store-banner.png');
const STORE_BANNER_EXISTS = fs.existsSync(STORE_BANNER_PATH);

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ---------- Private Store system ----------

const STORE_DATA_PATH = path.join(__dirname, 'store-data.json');

// Prices in credits and durations for each store option.
const STORE_PRICES = { week: 150000, month: 500000 };
const STORE_DURATIONS_MS = {
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000
};
const STORE_LABELS = { week: '1 Week Store', month: '1 Month Store' };

// Loads persisted store records from disk. Shape:
// { [channelId]: { ownerId, expiresAt, type, reminderSent } }
function loadStoreData() {
  try {
    if (!fs.existsSync(STORE_DATA_PATH)) return {};
    return JSON.parse(fs.readFileSync(STORE_DATA_PATH, 'utf8'));
  } catch (err) {
    console.error('[store] Failed to read store-data.json, starting fresh:', err);
    return {};
  }
}

function saveStoreData(data) {
  try {
    fs.writeFileSync(STORE_DATA_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[store] Failed to write store-data.json:', err);
  }
}

let storeData = loadStoreData();

// ---------- Autoline data (JSON-file backed, same pattern as store-data) ----------
// Shape: { [guildId]: { channels: [channelId, ...], mode: 'image'|'link', line: '...' } }
const AUTOLINE_DATA_PATH = path.join(__dirname, 'autoline-data.json');

function loadAutolineData() {
  try {
    if (!fs.existsSync(AUTOLINE_DATA_PATH)) return {};
    return JSON.parse(fs.readFileSync(AUTOLINE_DATA_PATH, 'utf8'));
  } catch (err) {
    console.error('[autoline] Failed to read autoline-data.json, starting fresh:', err);
    return {};
  }
}

function saveAutolineData(data) {
  try {
    fs.writeFileSync(AUTOLINE_DATA_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[autoline] Failed to write autoline-data.json:', err);
  }
}

let autolineData = loadAutolineData();

function getAutolineGuildEntry(guildId) {
  if (!autolineData[guildId]) {
    autolineData[guildId] = { channels: [], mode: 'image', line: null };
  }
  return autolineData[guildId];
}

// True if this member can manage the autoline settings (Administrator or
// any ADMIN_ROLE_IDS role) — mirrors isSellerOrAdmin's admin-only check.
function isAdmin(member) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (ADMIN_ROLE_IDS.some(id => member.roles.cache.has(id))) return true;
  return false;
}

// Purchases/renewals waiting on a ProBot payment, keyed by the buyer's user ID.
// { typeKey, requiredAmount, renewChannelId (only for renewals), timeoutHandle }
const pendingStorePurchases = new Map();

function formatCredits(n) {
  return n.toLocaleString('en-US');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ---------- helpers ----------

const ADMIN_ROLE_IDS = (process.env.ADMIN_ROLE_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

const TICKET_TYPES = {
  shop: {
    label: 'Shop',
    prefix: 'shop',
    categoryId: process.env.SHOP_CATEGORY_ID,
    roleId: process.env.SHOP_ROLE_ID
  },
  mediator: {
    label: 'Mediator',
    prefix: 'mediator',
    categoryId: process.env.MEDIATOR_CATEGORY_ID,
    roleId: process.env.MEDIATOR_ROLE_ID
  },
  support: {
    label: 'Support',
    prefix: 'support',
    categoryId: process.env.SUPPORT_CATEGORY_ID,
    roleId: process.env.SUPPORT_ROLE_ID
  },
  apply: {
    label: 'Apply',
    prefix: 'apply',
    categoryId: process.env.APPLY_CATEGORY_ID,
    roleId: process.env.APPLY_ROLE_ID
  }
};

// The two application types offered inside an Apply ticket.
const APPLY_TYPES = {
  seller: {
    label: 'Apply Seller',
    description: 'Apply as a seller',
    emoji: '<a:discord:1317320586804068393>',
    roleId: process.env.APPLY_SELLER_ROLE_ID
  },
  staff: {
    label: 'Apply Staff',
    description: 'Apply as staff',
    emoji: '<a:qfzezeef:1317492452537401404>',
    roleId: process.env.APPLY_STAFF_ROLE_ID
  }
};

// True if this member can manage a ticket of the given typeKey
// (has Administrator, an ADMIN_ROLE_IDS role, or that ticket type's own role).
function isSellerOrAdmin(member, typeKey) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (ADMIN_ROLE_IDS.some(id => member.roles.cache.has(id))) return true;
  const type = TICKET_TYPES[typeKey];
  if (type && type.roleId && member.roles.cache.has(type.roleId)) return true;
  return false;
}

// ---- BUG FIX ----
// The old code pushed every configured role ID straight into the
// permissionOverwrites array. If a role ID in .env was wrong, outdated, or
// pointed at a role from a different server, discord.js's
// PermissionOverwrites.resolve() would throw:
//   DiscordjsTypeError [InvalidType]: Supplied parameter is not a cached User or Role
// which crashed ticket creation. This helper checks that a role actually
// exists in the guild's cache before it's allowed anywhere near an overwrite,
// and logs a clear warning naming the bad env var so it's easy to fix.
function safeRoleId(guild, id, label) {
  if (!id) return null;
  if (!guild.roles.cache.has(id)) {
    console.warn(`[config] Ignoring ${label}="${id}" — no role with that ID exists in this server. Check your .env.`);
    return null;
  }
  return id;
}

// Role names that are generic/default (given to basically everyone on join)
// and therefore not useful to display next to a ticket opener's name.
const GENERIC_ROLE_NAMES = ['member', 'members', 'unverified', 'verified'];

// Returns the display name of a member's highest *meaningful* role — skips
// @everyone and generic roles like "Member" that don't actually distinguish
// this user (e.g. "VIP", "Buyer", "Trusted Seller" still show up fine).
// Falls back to null if the member has no roles worth displaying.
function getHighestRoleName(member) {
  if (!member || !member.roles) return null;
  const everyoneId = member.guild.roles.everyone.id;
  const meaningful = member.roles.cache
    .filter(r => r.id !== everyoneId && !GENERIC_ROLE_NAMES.includes(r.name.trim().toLowerCase()))
    .sort((a, b) => b.position - a.position)
    .first();
  return meaningful ? meaningful.name : null;
}

function buildPanelEmbed() {
  const embed = new EmbedBuilder()
    .setTitle(config.panel.title)
    .setDescription(config.panel.description)
    .setColor(config.panel.color || '#2b2d31');

  if (BANNER_EXISTS) {
    embed.setImage('attachment://banner.png');
  } else if (config.panel.imageUrl && !config.panel.imageUrl.includes('YOUR_BANNER_IMAGE')) {
    embed.setImage(config.panel.imageUrl);
  }
  if (config.panel.footer) embed.setFooter({ text: config.panel.footer });
  return embed;
}

function buildPanelButtons() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_open_shop')
      .setLabel('Shop Ticket')
      .setEmoji(config.emojis.shop)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('ticket_open_mediator')
      .setLabel('Ticket Mediator')
      .setEmoji(config.emojis.mediator)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('ticket_open_support')
      .setLabel('Ticket Support')
      .setEmoji(config.emojis.support)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket_open_apply')
      .setLabel('Ticket Apply')
      .setEmoji(config.emojis.apply)
      .setStyle(ButtonStyle.Secondary)
  );
  return row;
}

function buildManageButtons() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_add_user')
      .setLabel('Add User')
      .setEmoji(config.emojis.addUser)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('ticket_remove_user')
      .setLabel('Remove User')
      .setEmoji(config.emojis.removeUser)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('ticket_rename')
      .setLabel('Rename')
      .setEmoji(config.emojis.rename)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Close')
      .setEmoji(config.emojis.close)
      .setStyle(ButtonStyle.Danger)
  );
  return row;
}

// The "Choose your application type" select menu shown inside Apply tickets.
function buildApplyTypeRow(disabled = false) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('apply_type_select')
    .setPlaceholder('Select application type')
    .setDisabled(disabled)
    .addOptions(
      Object.entries(APPLY_TYPES).map(([value, info]) => ({
        label: info.label,
        description: info.description,
        value,
        emoji: info.emoji
      }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

function buildApplyTypeEmbed() {
  return new EmbedBuilder()
    .setTitle('<a:tbs_letter_A:1317949715383582761> Apply Team')
    .setDescription('Choose your application type below to get started.')
    .setColor(config.panel.color || '#2b2d31');
}

// ---------- Private Store: panel + select menu ----------

function buildStorePanelEmbed(guild) {
  const s = config.privateStore || {};
  const title = (s.title || '<a:tbs_letter_A:1317949715383582761> Private Store Menu').replace(/{guild}/g, guild.name);
  const description = (s.description ||
    'Create or manage your exclusive store channel with the options below.'
  ).replace(/{guild}/g, guild.name);
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(s.color || config.panel.color || '#2b2d31');
  if (s.footer && s.footer.trim()) embed.setFooter({ text: s.footer.replace(/{guild}/g, guild.name) });
  if (STORE_BANNER_EXISTS) {
    embed.setImage('attachment://store-banner.png');
  } else if (s.imageUrl && !s.imageUrl.includes('YOUR_BANNER_IMAGE')) {
    embed.setImage(s.imageUrl);
  }
  return embed;
}

function buildStoreSelectRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('store_menu_select')
    .setPlaceholder('Select an option')
    .addOptions(
      {
        label: '1 Week Store',
        description: `Get a private store for 1 week (${formatCredits(STORE_PRICES.week)} credits)`,
        value: 'store_week',
        emoji: '<a:discord:1317320586804068393>'
      },
      {
        label: '1 Month Store',
        description: `Get a private store for 1 month (${formatCredits(STORE_PRICES.month)} credits)`,
        value: 'store_month',
        emoji: '<a:discord:1317320586804068393>'
      },
      {
        label: 'Renew Store',
        description: 'Extend the duration of an existing store',
        value: 'store_renew',
        emoji: '<a:qfzezeef:1317492452537401404>'
      }
    );
  return new ActionRowBuilder().addComponents(menu);
}

// Registers a pending purchase/renewal and auto-expires it if unpaid.
function registerPendingPurchase(buyerId, entry) {
  const existing = pendingStorePurchases.get(buyerId);
  if (existing && existing.timeoutHandle) clearTimeout(existing.timeoutHandle);

  const timeoutMinutes = Number(process.env.STORE_PAYMENT_TIMEOUT_MINUTES) || 15;
  const timeoutHandle = setTimeout(() => {
    pendingStorePurchases.delete(buyerId);
  }, timeoutMinutes * 60 * 1000);

  pendingStorePurchases.set(buyerId, { ...entry, timeoutHandle });
}

function paymentInstructionsText(requiredAmount, ownerId, paymentChannelId) {
  return (
    `To complete your purchase, pay **${formatCredits(requiredAmount)}** credits to <@${ownerId}> using ProBot in <#${paymentChannelId}>.\n\n` +
    `For example: \`#credit ${ownerId} ${requiredAmount}\`\n\n` +
    `Once the payment goes through, your store will be created automatically — no need to come back and confirm.`
  );
}

// Creates the actual private store channel once payment is confirmed.
async function fulfillNewStore(guild, buyerId, typeKey) {
  const member = await guild.members.fetch(buyerId).catch(() => null);
  if (!member) {
    console.error(`[store] Could not fetch member ${buyerId} in guild ${guild.id} — can't create their store.`);
    return;
  }

  const categoryId = process.env.PRIVATE_STORE_CATEGORY_ID;
  if (categoryId && !guild.channels.cache.has(categoryId)) {
    console.warn(`[store] PRIVATE_STORE_CATEGORY_ID="${categoryId}" was not found in this guild's channel cache — the channel will be created with no category. Double check the ID and that the bot can see it.`);
  }
  const overwrites = [
    // Visible to everyone now (previously hidden entirely) — only sending
    // messages stays restricted to the owner, staff, and the bot.
    { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles
      ]
    }
  ];

  // Give admins/staff visibility into every private store as it's created —
  // previously only the buyer + the bot could see these channels at all, so
  // staff had no way to know a store had even been made.
  for (const adminRoleId of ADMIN_ROLE_IDS) {
    const validAdminRoleId = safeRoleId(guild, adminRoleId, 'ADMIN_ROLE_IDS');
    if (!validAdminRoleId) continue;
    overwrites.push({
      id: validAdminRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    });
  }

  let channel;
  try {
    channel = await guild.channels.create({
      name: `store-${member.user.username}`.toLowerCase().slice(0, 90),
      type: ChannelType.GuildText,
      parent: categoryId || undefined,
      topic: `store-owner:${member.id}`,
      permissionOverwrites: overwrites
    });
  } catch (err) {
    console.error('[store] Failed to create private store channel:', err);
    member.send('Your payment went through, but I couldn\'t create your store channel automatically. Please contact staff.').catch(() => null);
    return;
  }

  console.log(`[store] Created store channel #${channel.name} (${channel.id}) for ${member.user.tag} under category ${categoryId || '(none)'}`);

  const expiresAt = Date.now() + STORE_DURATIONS_MS[typeKey];
  storeData[channel.id] = {
    ownerId: member.id,
    expiresAt,
    type: typeKey,
    reminderSent: false
  };
  saveStoreData(storeData);

  const expiryDate = new Date(expiresAt).toUTCString();

  await channel.send({
    content: `${member}`,
    embeds: [
      new EmbedBuilder()
        .setTitle('🏬 Private Store')
        .setDescription(
          `Welcome to your private store, ${member}!\n\n` +
          `**Plan:** ${STORE_LABELS[typeKey]}\n` +
          `**Expires:** ${expiryDate}\n\n` +
          `You have full control over this channel. Use the **Renew Store** option in the store panel before it expires to keep it active.`
        )
        .setColor(config.panel.color || '#2b2d31')
        .setTimestamp()
    ]
  }).catch(() => null);

  member.send(
    `💖 Payment confirmed! Your **${STORE_LABELS[typeKey]}** is ready: ${channel}\n` +
    `It will expire on **${expiryDate}**. You'll get a reminder 24 hours before it does.`
  ).catch(() => null);

  // Let staff know a new store just got created, since only the buyer +
  // admin roles can see the store channel itself.
  if (process.env.LOG_CHANNEL_ID) {
    const logChannel = await guild.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) {
      logChannel.send({
        embeds: [
          new EmbedBuilder()
            .setDescription(`🏬 New private store created: ${channel} for ${member} (**${STORE_LABELS[typeKey]}**, expires ${expiryDate})`)
            .setColor('#2b2d31')
            .setTimestamp()
        ]
      }).catch(err => console.error('Failed to send store-created log message:', err));
    }
  }
}

// Extends an existing store's expiry once a renewal payment is confirmed.
async function fulfillRenewal(guild, buyerId, channelId, typeKey) {
  const record = storeData[channelId];
  if (!record) return;

  const base = record.expiresAt > Date.now() ? record.expiresAt : Date.now();
  record.expiresAt = base + STORE_DURATIONS_MS[typeKey];
  record.reminderSent = false;
  saveStoreData(storeData);

  const expiryDate = new Date(record.expiresAt).toUTCString();
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (channel) {
    // Reassert the same visibility rules used for brand-new stores. This
    // matters for stores that were created before the "visible to everyone,
    // but only owner/staff/bot can send" fix — renewing didn't used to touch
    // permissions at all, so an old store stayed hidden forever.
    await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
      ViewChannel: true,
      SendMessages: false
    }).catch(err => console.error(`[store] Failed to refresh @everyone overwrite on renewal for channel ${channelId}:`, err));

    await channel.permissionOverwrites.edit(buyerId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
      ManageChannels: true,
      ManageMessages: true
    }).catch(err => console.error(`[store] Failed to refresh owner overwrite on renewal for channel ${channelId}:`, err));

    for (const adminRoleId of ADMIN_ROLE_IDS) {
      const validAdminRoleId = safeRoleId(guild, adminRoleId, 'ADMIN_ROLE_IDS');
      if (!validAdminRoleId) continue;
      await channel.permissionOverwrites.edit(validAdminRoleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      }).catch(err => console.error(`[store] Failed to refresh admin overwrite on renewal for channel ${channelId}:`, err));
    }

    channel.send({
      embeds: [
        new EmbedBuilder()
          .setDescription(`🔔 This store has been renewed (**${STORE_LABELS[typeKey]}**). New expiry: **${expiryDate}**.`)
          .setColor(config.panel.color || '#2b2d31')
          .setTimestamp()
      ]
    }).catch(() => null);
  }

  const member = await guild.members.fetch(buyerId).catch(() => null);
  if (member) {
    member.send(`💖 Payment confirmed! Your store <#${channelId}> has been renewed until **${expiryDate}**.`).catch(() => null);
  }
}

async function findExistingTicket(guild, userId) {
  const channels = await guild.channels.fetch();
  return channels.find(
    ch => ch && ch.type === ChannelType.GuildText && ch.topic && ch.topic.includes(`owner:${userId}`)
  );
}

// ---- BUG FIX ----
// Clicking the ticket button rapidly (double/triple click, or a slow
// connection making someone click again thinking it didn't register) used to
// fire createTicketChannel() multiple times before the first ticket channel
// finished being created. Since findExistingTicket() only sees channels that
// already exist, all those overlapping calls would pass the "already have a
// ticket" check and each create their own channel + welcome message — this
// is what caused the same message to appear 2-3 times.
// This Set tracks who currently has a ticket-creation in progress, so any
// extra clicks while it's still being created are rejected immediately
// instead of starting a second channel.
const ticketCreationInProgress = new Set();

async function createTicketChannel(interaction, typeKey) {
  const type = TICKET_TYPES[typeKey];
  const guild = interaction.guild;
  const member = interaction.member;

  if (ticketCreationInProgress.has(member.id)) {
    return interaction.reply({
      content: 'Your ticket is already being created — please wait a moment.',
      ephemeral: true
    });
  }

  const existing = await findExistingTicket(guild, member.id);
  if (existing) {
    return interaction.reply({
      content: `You already have an open ticket: <#${existing.id}>`,
      ephemeral: true
    });
  }

  ticketCreationInProgress.add(member.id);
  try {
    await createTicketChannelInner(interaction, typeKey);
  } finally {
    ticketCreationInProgress.delete(member.id);
  }
}

async function createTicketChannelInner(interaction, typeKey) {
  const type = TICKET_TYPES[typeKey];
  const guild = interaction.guild;
  const member = interaction.member;

  const categoryId = type.categoryId;
  if (!categoryId) {
    return interaction.reply({
      content: `The ${type.label} ticket category has not been configured yet. Ask an admin to set it in .env.`,
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  // ---- BUG FIX ----
  // Every role/user ID that ends up in this array is validated first with
  // safeRoleId()/guild caches, instead of being trusted blindly. This is
  // what stops the InvalidType crash from PermissionOverwrites.resolve().
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles
      ]
    }
  ];

  const validTypeRoleId = safeRoleId(guild, type.roleId, `${typeKey.toUpperCase()}_ROLE_ID`);
  if (validTypeRoleId) {
    overwrites.push({
      id: validTypeRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages
      ]
    });
  }

  for (const adminRoleId of ADMIN_ROLE_IDS) {
    const validAdminRoleId = safeRoleId(guild, adminRoleId, 'ADMIN_ROLE_IDS');
    if (!validAdminRoleId) continue;
    overwrites.push({
      id: validAdminRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages
      ]
    });
  }

  let channel;
  try {
    channel = await guild.channels.create({
      name: `${type.prefix}-${member.user.username}`.toLowerCase().slice(0, 90),
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `owner:${member.id} | type:${typeKey}`,
      permissionOverwrites: overwrites
    });
  } catch (err) {
    console.error('Failed to create ticket channel:', err);
    return interaction.editReply({
      content: 'Could not create your ticket channel. Please tell an admin to check the category/role IDs in .env and the bot\'s permissions.'
    });
  }

  const openerRoleName = getHighestRoleName(member);
  const openerLabel = openerRoleName ? `${member} (${openerRoleName})` : `${member}`;

  // Extra instructions shown only in Shop and Mediator tickets, telling the
  // buyer how to state the product they need using the `need <product>`
  // format, plus a note about high-value items needing a mediator.
  const productRequestNote =
    (typeKey === 'shop' || typeKey === 'mediator')
      ? `\n\nOur staff team is with you on this order ticket.\n` +
        `Please specify your request using the following command:\n\n` +
        `\`need <product>\`\n\n` +
        `**Note:** please request a mediator if the item is worth more than 2 million credits.`
      : '';

  const welcomeEmbed = new EmbedBuilder()
    .setTitle(`${config.emojis[typeKey]} ${type.label} Ticket`)
    .setDescription(
      `Hello ${openerLabel}, thanks for opening a **${type.label}** ticket.\n` +
      `A member of our staff will be with you shortly.\n\n` +
      `**Seller controls:** add/remove users, rename, or close this ticket using the buttons below.` +
      productRequestNote
    )
    .setColor(config.panel.color || '#2b2d31')
    .setTimestamp();

  await channel.send({
    content: `${member} ${validTypeRoleId ? `<@&${validTypeRoleId}>` : ''}`,
    embeds: [welcomeEmbed],
    components: [buildManageButtons()]
  });

  // Apply tickets additionally get an application-type picker, matching the
  // "Choose your application type" flow (Apply Seller / Apply Staff).
  if (typeKey === 'apply') {
    const files = BANNER_EXISTS ? [new AttachmentBuilder(BANNER_PATH, { name: 'banner.png' })] : [];
    await channel.send({
      embeds: [BANNER_EXISTS ? buildApplyTypeEmbed().setImage('attachment://banner.png') : buildApplyTypeEmbed()],
      components: [buildApplyTypeRow()],
      files
    });
  }

  await interaction.editReply({ content: `Your ticket has been created: ${channel}` });

  const logChannelId = process.env.LOG_CHANNEL_ID;
  if (logChannelId) {
    const logChannel = await guild.channels.fetch(logChannelId).catch(() => null);
    if (logChannel) {
      logChannel.send({
        embeds: [
          new EmbedBuilder()
            .setDescription(`🧾 ${member} opened a **${type.label}** ticket: ${channel}`)
            .setColor('#2b2d31')
            .setTimestamp()
        ]
      }).catch(err => console.error('Failed to send log message:', err));
    }
  }
}

function parseTicketTopic(topic) {
  if (!topic) return {};
  const ownerMatch = topic.match(/owner:(\d+)/);
  const typeMatch = topic.match(/type:(\w+)/);
  return {
    ownerId: ownerMatch ? ownerMatch[1] : null,
    type: typeMatch ? typeMatch[1] : null
  };
}

function parseUserInput(guild, input) {
  const idMatch = input.match(/\d{15,}/);
  if (!idMatch) return null;
  return guild.members.fetch(idMatch[0]).catch(() => null);
}

function applyModalFor(applyKey) {
  const info = APPLY_TYPES[applyKey];
  const modal = new ModalBuilder()
    .setCustomId(`apply_modal_${applyKey}`)
    .setTitle(info.label)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('apply_age')
          .setLabel('Your age')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('apply_experience')
          .setLabel(applyKey === 'seller' ? 'Selling experience' : 'Relevant experience')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('apply_reason')
          .setLabel(applyKey === 'seller' ? 'Why do you want to sell here?' : 'Why do you want to join staff?')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
      )
    );
  return modal;
}

// ---------- 24/7 voice presence ----------
// Joins the channel set in VOICE_CHANNEL_ID and stays connected. If Discord
// drops the connection (network blip, voice server move, etc.) it
// automatically rejoins instead of just going silent.

function joinAndStayInVoice(guild) {
  const channelId = process.env.VOICE_CHANNEL_ID;
  if (!channelId) return;

  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased()) {
    console.warn(`[voice] VOICE_CHANNEL_ID="${channelId}" is not a valid voice channel in this server.`);
    return;
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: true
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Discord sometimes disconnects briefly during a move between
      // channels/servers rather than a real drop. Give it a moment to
      // resolve on its own before forcing a full rejoin.
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
      // It's recovering by itself, nothing more to do.
    } catch {
      // Real disconnect: destroy and rejoin from scratch.
      connection.destroy();
      console.log('[voice] Connection lost, rejoining in 5s...');
      setTimeout(() => joinAndStayInVoice(guild), 5_000);
    }
  });

  connection.on('error', err => {
    console.error('[voice] Connection error:', err);
  });

  console.log(`[voice] Joined voice channel "${channel.name}" for 24/7 presence.`);
}

// ---------- crash prevention ----------
// ---- BUG FIX ----
// Previously, any unhandled promise rejection (e.g. a fire-and-forget
// logChannel.send() failing because the channel was deleted, or a Discord
// API hiccup) had no listener attached, which crashes the whole Node
// process. If you were running the bot under something that auto-restarts
// it (pm2, nodemon, a hosting platform's restart policy), this looked like
// "the bot keeps crashing and reloading over and over". These two handlers
// log the error instead of letting it kill the process.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Caught an unhandled promise rejection (bot stays alive):', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Caught an uncaught exception (bot stays alive):', err);
});

client.on('error', (err) => {
  console.error('[client error]', err);
});

client.on('shardError', (err) => {
  console.error('[shard error]', err);
});

// ---------- Private Store: payment watcher ----------
// ---- BUG FIX ----
// The original approach tried to detect payments purely from ProBot's
// confirmation message: checking that it @mentioned both the owner and the
// buyer, and that it contained a large-enough number. Two things broke that:
//   1. ProBot takes a ~5% fee, so the *transferred* amount shown in the
//      confirmation (e.g. $142,500) is always less than what the buyer
//      actually paid (150,000) — so the amount check failed every time.
//   2. ProBot refers to the payer by plain username text ("eswanhinio_,
//      has transferred..."), not an @mention — so the buyer was never found
//      in the message's mentions at all.
//
// Fix: instead of trying to parse who-paid-what out of ProBot's reply, track
// the ORIGINAL "#credit <owner_id> <amount>" command the buyer types
// (before ProBot processes/deletes it). ProBot's confirmation is sent as a
// reply to that original command, so when it arrives we look up who sent
// the command it's replying to — no mention-parsing or amount-matching
// against the post-fee total needed at all.

// messageId (of the buyer's original "#credit ..." command) -> { buyerId, timeoutHandle }
const pendingCreditCommands = new Map();

// ---- BUG FIX 2 ----
// ProBot doesn't transfer credits immediately after "#credit <id> <amount>".
// It first replies (to that command) with an anti-fraud prompt like
// "eswanhinio_, transfer fees: 7500, amount: $142500. type these numbers to
// confirm: 88367" — that reply has none of "transferred"/"paid"/"sent" in it,
// so it was being flagged as "not successful" and the buyer's tracked entry
// got deleted right then. When the buyer typed "88367" and ProBot's REAL
// "... has transferred $142500 to ..." confirmation came back, it was a
// reply to the "88367" message, not to the original "#credit" command — so
// by then nothing was being tracked anymore and the store never got created.
//
// Fix: keep a buyerId -> timeout entry alive for the whole flow. Any
// non-"#credit" message the buyer sends while their flow is active (i.e.
// the confirmation code) also gets tracked by its message ID, so whichever
// message ProBot ends up replying to, we can still trace it back to the
// buyer. We only stop tracking the buyer once we see a message that's
// clearly the final success text, or a clear failure, or the flow times out.
const activeCreditBuyers = new Map(); // buyerId -> { timeoutHandle }

const CREDIT_COMMAND_RE = /^#credit\s+(\d{5,})\s+(\d+)/i;
const FAILURE_HINTS_RE = /insufficient|cooldown|cannot|can't|unable|expired|error|not enough/i;
const CONFIRM_PROMPT_HINTS_RE = /confirm|type these numbers|verification/i;

// ---------- Auto product listing (Private Store + Products category) ----------
// Sellers just type their product in plain text inside their store channel
// (private store category) OR inside the dedicated products category, and
// the bot detects it, deletes the raw message, and posts one clean designed
// embed instead — with a 10% tax automatically added and shown as "+tax".

const PRODUCTS_CATEGORY_ID = '1438246349148786698';
const PRODUCT_TAX_RATE = 0.10; // Robuyot tax: 10%
const WASIT_TAX_RATE = 0.05; // Wasit (broker) tax: extra 5% on top
const TAX_LOG_CHANNEL_ID = '1528958323641286847';

// Accepts flexible formats, e.g.:
//   product: Nitro Boost | price: 100
//   name: Nitro Boost - price: 100
//   Nitro Boost - 100
//   Nitro Boost : 100 credits
const PRODUCT_LABELED_RE = /(?:product|name)\s*[:\-]\s*(.+?)\s*[|,]?\s*(?:price)\s*[:\-]\s*([\d,.]+)/i;
const PRODUCT_SIMPLE_RE = /^(.{2,80}?)\s*[-:]\s*([\d,.]+)\s*(?:credits?)?$/i;

// The seller's official multi-line "formula" template, e.g.:
//   🧾 (or any emoji)
//   Pπ0duct : Nitro Boost
//   Pr!ce : 100
//   If Y0u Want 0pen T!cket And T@g Me
//   For: <@&1438246284237471799> @here
// Letters like "π", "!", "0" are decorative leetspeak, so we match them
// loosely rather than requiring the exact symbols.
const TEMPLATE_PRODUCT_LINE_RE = /P.{0,2}0duct\s*:\s*(.+)/i;
const TEMPLATE_PRICE_LINE_RE = /Pr.ce\s*:\s*([\d,.]+)/i;
const ROLE_MENTION_RE = /<@&(\d+)>/;
const HERE_MENTION_RE = /@here/i;

// Shared tax math — used by both the auto product listing and the !tax command.
// Cascading logic (so every number is derivable from the one above it):
//   1) Robuyot tax  = price * 10%
//   2) total (no Wasit) = price + Robuyot tax
//   3) Wasit tax    = total (no Wasit) * 5%   <- computed on top of step 2, not on the raw price
//   4) totalWithWasit = total (no Wasit) + Wasit tax
function computeTaxBreakdown(price) {
  const tax = Math.round(price * PRODUCT_TAX_RATE * 100) / 100;
  const total = Math.round((price + tax) * 100) / 100;
  const wasitTax = Math.round(total * WASIT_TAX_RATE * 100) / 100;
  const totalWithWasit = Math.round((total + wasitTax) * 100) / 100;
  return { price, tax, wasitTax, totalWithWasit, total };
}

function parseProductMessage(content) {
  if (!content) return null;
  const text = content.trim();

  // 1) Try the official template first (multi-line, "Pπ0duct :" / "Pr!ce :").
  const templateProduct = text.match(TEMPLATE_PRODUCT_LINE_RE);
  const templatePrice = text.match(TEMPLATE_PRICE_LINE_RE);
  if (templateProduct && templatePrice) {
    const name = templateProduct[1].trim();
    const rawPrice = Number(templatePrice[1].replace(/,/g, ''));
    if (name && Number.isFinite(rawPrice) && rawPrice > 0) {
      const roleMatch = text.match(ROLE_MENTION_RE);
      const hasHere = HERE_MENTION_RE.test(text);
      const pingParts = [];
      if (roleMatch) pingParts.push(`<@&${roleMatch[1]}>`);
      if (hasHere) pingParts.push('@here');

      return { name, ...computeTaxBreakdown(rawPrice), ping: pingParts.join(' ') || null };
    }
  }

  // 2) Fall back to simpler one-line formats.
  let match = text.match(PRODUCT_LABELED_RE);
  if (!match) match = text.match(PRODUCT_SIMPLE_RE);
  if (!match) return null;

  const name = match[1].trim();
  const rawPrice = Number(match[2].replace(/,/g, ''));
  if (!name || !Number.isFinite(rawPrice) || rawPrice <= 0) return null;

  return { name, ...computeTaxBreakdown(rawPrice), ping: null };
}

function buildProductEmbed(product, seller) {
  return new EmbedBuilder()
    .setColor('#2b2d31')
    .setAuthor({
      name: `${seller.user.tag} • New Product`,
      iconURL: seller.displayAvatarURL ? seller.displayAvatarURL() : undefined
    })
    .setTitle(`🏬 ${product.name}`)
    .setDescription(
      `💰 **Price:** \`${formatCredits(product.price)} credits\`\n` +
      `🧾 **Tax:** \`+tax (${formatCredits(product.tax)} credits)\`\n` +
      `📋 **Total:** \`${formatCredits(product.total)} credits\`\n\n` +
      `🔔 Seller: ${seller}\n` +
      `💖 If you want to purchase, open a ticket and tag the seller!`
    )
    .setFooter({ text: 'Super Nova Shop — Product Listing' })
    .setTimestamp();
}

// Tax log embed — Arabic style matching "حساب ضريبة اليوم بوت" screenshot.
// Works for both: (a) product listings (products category -> tax channel)
// and (b) the standalone !tax <amount> command. `context` is optional footer text.
function buildTaxLogEmbed(breakdown, context) {
  const embed = new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle('💰 حساب ضريبة اليوم بوت')
    .addFields(
      { name: '🤖 ضريبة الروبوت:', value: `\`+tax (${formatCredits(breakdown.tax)})\``, inline: false },
      { name: '⚖️ ضريبة الوسيط:', value: `\`+tax (${formatCredits(breakdown.wasitTax)})\``, inline: false },
      { name: '🛑 المبلغ بدون ضريبة الوسيط:', value: `\`${formatCredits(breakdown.total)}\``, inline: false },
      { name: '🧮 المبلغ الاجمالي:', value: `\`${formatCredits(breakdown.totalWithWasit)}\``, inline: false },
      { name: '💰 المبلغ بدون ضرائب:', value: `\`${formatCredits(breakdown.price)}\``, inline: false }
    )
    .setTimestamp();
  if (context) embed.setFooter({ text: context });
  return embed;
}

// Buttons shown under the !tax panel, matching the screenshot:
// green "حساب مع الوسيط" (calculate with broker) + red "Close".
function buildTaxPanelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('tax_calc_wasit')
      .setLabel('حساب مع الوسيط')
      .setEmoji('🧮')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('tax_close')
      .setLabel('Close')
      .setEmoji('⛔')
      .setStyle(ButtonStyle.Danger)
  );
}

// !tax <amount> command — anyone can type it anywhere the bot can see, e.g.
// "!tax 4555" — posts the same tax breakdown panel as the screenshot.
const TAX_COMMAND_RE = /^!tax\s+([\d,.]+)/i;

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    const match = message.content.trim().match(TAX_COMMAND_RE);
    if (!match) return;

    const amount = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      await message.reply('⚠️ Please provide a valid amount, e.g. `!tax 4555`.').catch(() => null);
      return;
    }

    const breakdown = computeTaxBreakdown(amount);
    const embed = buildTaxLogEmbed(breakdown, `Requested by ${message.author.tag}`);

    await message.channel.send({
      embeds: [embed],
      components: [buildTaxPanelButtons()]
    });
    await message.delete().catch(() => null);
  } catch (err) {
    console.error('[tax-command] Failed to process !tax command:', err);
  }
});

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    const parentId = message.channel.parentId;
    const isPrivateStoreChannel = parentId && parentId === process.env.PRIVATE_STORE_CATEGORY_ID;
    const isProductsChannel = parentId && parentId === PRODUCTS_CATEGORY_ID;

    // DEBUG: log every message seen in ANY channel so we can see in the
    // console whether the category check or the regex is what's failing.
    console.log(`[product-debug] msg in #${message.channel.name} (parentId=${parentId}) | isPrivateStore=${isPrivateStoreChannel} isProducts=${isProductsChannel} | content="${message.content}"`);

    if (!isPrivateStoreChannel && !isProductsChannel) return;

    const product = parseProductMessage(message.content);
    console.log(`[product-debug] parseProductMessage ->`, product);
    if (!product) return; // not a product-shaped message, leave it alone

    const embed = buildProductEmbed(product, message.member || message.author);

    // Post the clean designed listing once, in the same channel as always...
    await message.channel.send({
      content: product.ping || undefined,
      embeds: [embed]
    });
    // ...then remove the seller's raw text so only the formatted line shows.
    await message.delete().catch(err => {
      console.error('[product] Could not delete raw product message (missing Manage Messages perm?):', err);
    });

    // Products category ONLY: also log the tax breakdown to the dedicated
    // tax channel. Private store behavior stays exactly as before.
    if (isProductsChannel) {
      try {
        const taxChannel = await message.guild.channels.fetch(TAX_LOG_CHANNEL_ID);
        if (taxChannel) {
          const seller = message.member || message.author;
          const taxEmbed = buildTaxLogEmbed(product, `Product: ${product.name} • Seller: ${seller.user ? seller.user.tag : seller.tag}`);
          await taxChannel.send({ embeds: [taxEmbed] });
        }
      } catch (err) {
        console.error('[product] Could not send tax log to dedicated channel:', err);
      }
    }

    console.log(`[product] Listed "${product.name}" (${product.price} + tax ${product.tax} = ${product.total}) in #${message.channel.name}`);
  } catch (err) {
    console.error('[product] Failed to process potential product message:', err);
  }
});

client.on('messageCreate', async message => {
  try {
    const paymentChannelId = process.env.PAYMENT_CHANNEL_ID;
    const probotId = process.env.PROBOT_ID;
    const ownerId = process.env.STORE_OWNER_ID;
    if (!paymentChannelId || !probotId || !ownerId) {
      console.warn('[store] Payment watcher disabled: PAYMENT_CHANNEL_ID / PROBOT_ID / STORE_OWNER_ID missing from .env');
      return;
    }
    if (message.channel.id !== paymentChannelId) return;

    // Step 1: a human sends "#credit <owner_id> <amount>" — if they have a
    // pending store purchase/renewal for at least that amount, remember that
    // this message ID belongs to them so we can recognize ProBot's reply.
    if (message.author.id !== probotId) {
      console.log(`[store] Message in payment channel from ${message.author.tag}: "${message.content}"`);

      const match = message.content.match(CREDIT_COMMAND_RE);
      if (!match) {
        // Not a "#credit" command — but if this buyer already has an active
        // credit flow (waiting on ProBot's anti-fraud confirmation), this is
        // likely the confirmation code they were told to type. Track this
        // message ID too so we catch ProBot's reply to it.
        const activeFlow = activeCreditBuyers.get(message.author.id);
        if (activeFlow) {
          console.log(`[store] -> ${message.author.tag} has an active credit flow; tracking this message (${message.id}) in case it's their ProBot confirmation code.`);
          pendingCreditCommands.set(message.id, { buyerId: message.author.id, timeoutHandle: activeFlow.timeoutHandle });
        } else {
          console.log('[store] -> Not a "#credit <id> <amount>" command, ignoring. (If your content looks right, Message Content Intent may not actually be enabled — check the Developer Portal.)');
        }
        return;
      }

      const [, targetId, amountStr] = match;
      if (targetId !== ownerId) {
        console.log(`[store] -> #credit was sent to ${targetId}, not the configured STORE_OWNER_ID (${ownerId}), ignoring.`);
        return;
      }

      const pending = pendingStorePurchases.get(message.author.id);
      if (!pending) {
        console.log(`[store] -> ${message.author.tag} paid the owner but has no pending store purchase (never picked an option, or it already expired). Ignoring.`);
        return;
      }
      if (parseInt(amountStr, 10) < pending.requiredAmount) {
        console.log(`[store] -> ${message.author.tag} paid ${amountStr}, but their pending purchase needs ${pending.requiredAmount}. Ignoring.`);
        return;
      }

      console.log(`[store] -> Tracking command ${message.id} from ${message.author.tag}, waiting for ProBot's reply.`);
      const timeoutHandle = setTimeout(() => {
        pendingCreditCommands.delete(message.id);
        activeCreditBuyers.delete(message.author.id);
      }, 15 * 60 * 1000);
      pendingCreditCommands.set(message.id, { buyerId: message.author.id, timeoutHandle });
      activeCreditBuyers.set(message.author.id, { timeoutHandle });
      return;
    }

    // Step 2: ProBot posts a confirmation, as a reply to the command above
    // (or, if ProBot's flow has an anti-fraud confirmation step, a reply to
    // the confirmation-code message tracked in Step 1).
    console.log(`[store] ProBot message in payment channel. reference=${message.reference ? message.reference.messageId : 'none'}, tracked commands=${pendingCreditCommands.size}`);
    if (pendingCreditCommands.size === 0) {
      console.log('[store] -> No commands currently being tracked, ignoring this ProBot message.');
      return;
    }
    const repliedToId = message.reference && message.reference.messageId;
    if (!repliedToId) {
      console.log('[store] -> This ProBot message is not a reply to anything, so it can\'t be matched to a buyer. (If ProBot never replies to the command, tell me exactly what its confirmation message looks like so I can adjust the matching.)');
      return;
    }
    if (!pendingCreditCommands.has(repliedToId)) {
      console.log(`[store] -> ProBot replied to message ${repliedToId}, which isn't a tracked "#credit" command. Ignoring.`);
      return;
    }

    const { buyerId } = pendingCreditCommands.get(repliedToId);
    pendingCreditCommands.delete(repliedToId);

    const text = [message.content || '', ...message.embeds.map(e => `${e.title || ''} ${e.description || ''}`)].join(' ').toLowerCase();
    const looksSuccessful = /transferred|paid|sent/.test(text);
    console.log(`[store] -> Matched reply to buyer ${buyerId}. Message text: "${text}". Looks successful: ${looksSuccessful}`);

    if (!looksSuccessful) {
      // Not the final success message yet. If it's ProBot's anti-fraud
      // "type these numbers to confirm" prompt, keep the buyer's flow alive
      // and wait for their confirmation code + ProBot's real reply to it.
      // If it looks like an actual failure, stop tracking them.
      if (CONFIRM_PROMPT_HINTS_RE.test(text) && !FAILURE_HINTS_RE.test(text)) {
        console.log('[store] -> Looks like ProBot\'s anti-fraud confirmation prompt, not a final result. Still waiting for the buyer\'s confirmation code and the real result.');
      } else {
        console.log('[store] -> Doesn\'t look like a success message and doesn\'t look like a confirmation prompt either — treating as a failed payment and no longer tracking this buyer. Send me the exact wording if this was actually a successful payment.');
        const activeFlow = activeCreditBuyers.get(buyerId);
        if (activeFlow) clearTimeout(activeFlow.timeoutHandle);
        activeCreditBuyers.delete(buyerId);
      }
      return;
    }

    // Success — stop tracking this buyer's flow entirely.
    const activeFlow = activeCreditBuyers.get(buyerId);
    if (activeFlow) clearTimeout(activeFlow.timeoutHandle);
    activeCreditBuyers.delete(buyerId);

    const pending = pendingStorePurchases.get(buyerId);
    if (!pending) {
      console.log(`[store] -> Buyer ${buyerId}'s pending purchase is gone (already fulfilled or timed out). Ignoring.`);
      return;
    }

    clearTimeout(pending.timeoutHandle);
    pendingStorePurchases.delete(buyerId);

    console.log(`[store] -> Fulfilling ${pending.renewChannelId ? 'renewal' : 'new store'} for buyer ${buyerId}...`);
    if (pending.renewChannelId) {
      await fulfillRenewal(message.guild, buyerId, pending.renewChannelId, pending.typeKey);
    } else {
      await fulfillNewStore(message.guild, buyerId, pending.typeKey);
    }
    console.log(`[store] -> Done.`);
  } catch (err) {
    console.error('[store] Error handling payment message:', err);
  }
});

// ---------- Private Store: expiry watcher ----------
// Every 10 minutes: DMs owners 24h before their store expires (once), and
// deletes the channel + record once it actually expires.

const STORE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

async function checkStoreExpiries() {
  const now = Date.now();
  let changed = false;

  for (const [channelId, record] of Object.entries(storeData)) {
    if (record.expiresAt <= now) {
      const guild = client.guilds.cache.first(); // single-guild bot; adjust if multi-guild
      const channel = guild ? await guild.channels.fetch(channelId).catch(() => null) : null;
      if (channel) {
        await channel.delete().catch(() => null);
      }
      const member = guild ? await guild.members.fetch(record.ownerId).catch(() => null) : null;
      if (member) {
        member.send('⏰ Your private store has expired and its channel was removed. Open the store panel to purchase a new one.').catch(() => null);
      }
      delete storeData[channelId];
      changed = true;
      continue;
    }

    if (!record.reminderSent && record.expiresAt - now <= REMINDER_WINDOW_MS) {
      const guild = client.guilds.cache.first();
      const member = guild ? await guild.members.fetch(record.ownerId).catch(() => null) : null;
      if (member) {
        member.send(
          `⏰ Your store <#${channelId}> expires in less than 24 hours. Use the **Renew Store** option in the store panel to keep it active.`
        ).catch(() => null);
      }
      record.reminderSent = true;
      changed = true;
    }
  }

  if (changed) saveStoreData(storeData);
}

setInterval(() => {
  checkStoreExpiries().catch(err => console.error('[store] Expiry check failed:', err));
}, STORE_CHECK_INTERVAL_MS);

// ---------- Autoline: periodic auto-posting ----------
// Every AUTOLINE_INTERVAL_MINUTES, post the configured "line" (image or
// link) to every channel registered via /add-autoline-channel, for every
// guild that has one set.
const AUTOLINE_INTERVAL_MS = (Number(process.env.AUTOLINE_INTERVAL_MINUTES) || 60) * 60 * 1000;

async function postAutolines() {
  for (const [guildId, entry] of Object.entries(autolineData)) {
    if (!entry.line || !entry.channels || entry.channels.length === 0) continue;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    for (const channelId of entry.channels) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;

      try {
        if (entry.mode === 'link') {
          await channel.send({ content: entry.line });
        } else {
          const embed = new EmbedBuilder()
            .setColor('Green')
            .setImage(entry.line)
            .setTimestamp();
          await channel.send({ embeds: [embed] });
        }
      } catch (err) {
        console.error(`[autoline] Failed to post line in channel ${channelId} (guild ${guildId}):`, err);
      }
    }
  }
}

setInterval(() => {
  postAutolines().catch(err => console.error('[autoline] Auto-post cycle failed:', err));
}, AUTOLINE_INTERVAL_MS);

// ---------- ready ----------

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  if (process.env.VOICE_CHANNEL_ID) {
    client.guilds.cache.forEach(guild => joinAndStayInVoice(guild));
  }

  checkStoreExpiries().catch(err => console.error('[store] Initial expiry check failed:', err));
});

// If the bot somehow gets disconnected from the voice channel by an outside
// action (kicked, channel deleted, etc.), the state change above handles
// reconnecting. This also covers the case where the bot restarts and needs
// to rejoin fresh — already handled by the 'ready' event.

// ---------- new member welcome ----------

client.on('guildMemberAdd', async member => {
  try {
    const welcomeChannelId = process.env.WELCOME_CHANNEL_ID;
    if (!welcomeChannelId) return;

    const channel = await member.guild.channels.fetch(welcomeChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const w = config.welcome || {};
    const description = (w.description ||
      'We\'re glad to have you here at **{guild}**.\nTake a look around, check the info channels, and open a ticket any time you need help or want to place an order.'
    )
      .replace(/{user}/g, `${member}`)
      .replace(/{guild}/g, member.guild.name)
      .replace(/{memberCount}/g, member.guild.memberCount);

    const embed = new EmbedBuilder()
      .setTitle((w.title || 'Welcome to {guild}! <a:Hearts:1317319217141514321>').replace(/{guild}/g, member.guild.name))
      .setDescription(description)
      .setColor(w.color || config.panel.color || '#2b2d31')
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .setFooter({ text: `Member #${member.guild.memberCount}` })
      .setTimestamp();

    const files = [];
    if (BANNER_EXISTS) {
      embed.setImage('attachment://banner.png');
      files.push(new AttachmentBuilder(BANNER_PATH, { name: 'banner.png' }));
    } else if (w.imageUrl) {
      embed.setImage(w.imageUrl);
    }

    await channel.send({ content: `${member}`, embeds: [embed], files });
  } catch (err) {
    console.error('Welcome message error:', err);
  }
});

// ---------- interactions ----------

client.on('interactionCreate', async interaction => {
  try {
    // Slash command: /panel
    if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
      // Ack immediately (deferReply is instant, no file upload yet),
      // then edit the reply with the embed/buttons/banner.
      // This avoids the 3s interaction-token timeout when the banner
      // image takes a moment to upload.
      await interaction.deferReply();

      const files = BANNER_EXISTS ? [new AttachmentBuilder(BANNER_PATH, { name: 'banner.png' })] : [];
      await interaction.editReply({
        embeds: [buildPanelEmbed()],
        components: [buildPanelButtons()],
        files
      });
      return;
    }

    // Slash command: /storepanel — posts the Private Store Menu panel
    if (interaction.isChatInputCommand() && interaction.commandName === 'storepanel') {
      await interaction.deferReply();
      const files = STORE_BANNER_EXISTS ? [new AttachmentBuilder(STORE_BANNER_PATH, { name: 'store-banner.png' })] : [];
      await interaction.editReply({
        embeds: [buildStorePanelEmbed(interaction.guild)],
        components: [buildStoreSelectRow()],
        files
      });
      return;
    }

    // ---------- Autoline commands ----------
    if (interaction.isChatInputCommand() && interaction.commandName === 'add-autoline-channel') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: '⛔ Admins only.', ephemeral: true });
      }
      const room = interaction.options.getChannel('room');
      const entry = getAutolineGuildEntry(interaction.guild.id);
      if (!entry.channels.includes(room.id)) entry.channels.push(room.id);
      saveAutolineData(autolineData);
      return interaction.reply({ content: '**تم اضافة الروم بنجاح**' });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'remove-autoline-channel') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: '⛔ Admins only.', ephemeral: true });
      }
      const room = interaction.options.getChannel('room');
      const entry = getAutolineGuildEntry(interaction.guild.id);
      entry.channels = entry.channels.filter(id => id !== room.id);
      saveAutolineData(autolineData);
      return interaction.reply({ content: '**تم ازالة الروم بنجاح**' });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'line-mode') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: '⛔ Admins only.', ephemeral: true });
      }
      const mode = interaction.options.getString('mode');
      const entry = getAutolineGuildEntry(interaction.guild.id);
      entry.mode = mode;
      saveAutolineData(autolineData);
      return interaction.reply({ content: `تم ضبط وضع الإرسال إلى ${mode}`, ephemeral: true });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'set-autoline-line') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: '⛔ Admins only.', ephemeral: true });
      }
      await interaction.deferReply();
      const line = interaction.options.getString('line');
      const entry = getAutolineGuildEntry(interaction.guild.id);
      entry.line = line;
      saveAutolineData(autolineData);

      const embed = new EmbedBuilder()
        .setDescription('**تم تحديد الخط**')
        .setColor('Green')
        .setTimestamp()
        .setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL({ dynamic: true }) || undefined });

      if (entry.mode === 'link') {
        embed.addFields({ name: 'الرابط', value: line });
      } else {
        embed.setImage(line);
      }

      return interaction.editReply({ embeds: [embed] });
    }

    // !tax panel buttons
    if (interaction.isButton() && interaction.customId === 'tax_close') {
      await interaction.message.delete().catch(() => null);
      return;
    }
    if (interaction.isButton() && interaction.customId === 'tax_calc_wasit') {
      const totalField = interaction.message.embeds[0]?.fields?.find(f => f.name.includes('المبلغ الاجمالي'));
      await interaction.reply({
        content: `🧮 المبلغ الاجمالي (مع ضريبة الوسيط): ${totalField ? totalField.value : 'N/A'}`,
        ephemeral: true
      }).catch(() => null);
      return;
    }

    // Panel buttons -> open ticket
    if (interaction.isButton() && interaction.customId.startsWith('ticket_open_')) {
      const typeKey = interaction.customId.replace('ticket_open_', '');
      if (TICKET_TYPES[typeKey]) {
        await createTicketChannel(interaction, typeKey);
      }
      return;
    }

    // Apply-type select menu inside an Apply ticket
    if (interaction.isStringSelectMenu() && interaction.customId === 'apply_type_select') {
      const applyKey = interaction.values[0];
      if (!APPLY_TYPES[applyKey]) return;
      return interaction.showModal(applyModalFor(applyKey));
    }

    // Private Store panel select menu
    if (interaction.isStringSelectMenu() && interaction.customId === 'store_menu_select') {
      const choice = interaction.values[0];

      if (choice === 'store_renew') {
        const modal = new ModalBuilder()
          .setCustomId('store_renew_modal')
          .setTitle('Renew Store')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('renew_channel_id')
                .setLabel('Your store\'s channel ID')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('renew_duration')
                .setLabel('New duration: type "week" or "month"')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      const typeKey = choice === 'store_week' ? 'week' : choice === 'store_month' ? 'month' : null;
      if (!typeKey) return;

      if (pendingStorePurchases.has(interaction.user.id)) {
        return interaction.reply({
          content: 'You already have a pending store purchase awaiting payment. Please complete or wait for it to expire first.',
          ephemeral: true
        });
      }

      const requiredAmount = STORE_PRICES[typeKey];
      registerPendingPurchase(interaction.user.id, { typeKey, requiredAmount });
      console.log(`[store] Registered pending "${typeKey}" purchase for ${interaction.user.tag} (needs ${requiredAmount} credits).`);

      return interaction.reply({
        content: paymentInstructionsText(requiredAmount, process.env.STORE_OWNER_ID, process.env.PAYMENT_CHANNEL_ID),
        ephemeral: true
      });
    }

    // Ticket management buttons
    if (interaction.isButton() && ['ticket_add_user', 'ticket_remove_user', 'ticket_rename', 'ticket_close'].includes(interaction.customId)) {
      const { ownerId: currentOwnerId, type: currentTypeKey } = parseTicketTopic(interaction.channel.topic);
      const isOwner = currentOwnerId && interaction.user.id === currentOwnerId;
      const isStaff = isSellerOrAdmin(interaction.member, currentTypeKey);

      // Rename and Close: allowed for the ticket owner (client) OR staff/admin.
      // Add User / Remove User: staff/admin only.
      const clientAllowedActions = ['ticket_rename', 'ticket_close'];
      const allowed = clientAllowedActions.includes(interaction.customId)
        ? (isOwner || isStaff)
        : isStaff;

      if (!allowed) {
        return interaction.reply({ content: 'Only that ticket type\'s role or admins can manage this ticket.', ephemeral: true });
      }

      if (interaction.customId === 'ticket_add_user') {
        const modal = new ModalBuilder()
          .setCustomId('modal_add_user')
          .setTitle('Add User to Ticket')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('user_input')
                .setLabel('User ID or @mention')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'ticket_remove_user') {
        const modal = new ModalBuilder()
          .setCustomId('modal_remove_user')
          .setTitle('Remove User from Ticket')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('user_input')
                .setLabel('User ID or @mention')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'ticket_rename') {
        const modal = new ModalBuilder()
          .setCustomId('modal_rename')
          .setTitle('Rename Ticket')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('new_name')
                .setLabel('New channel name')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(90)
            )
          );
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'ticket_close') {
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket_close_confirm').setLabel('Confirm Close').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('ticket_close_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({ content: 'Are you sure you want to close this ticket?', components: [confirmRow], ephemeral: true });
      }
    }

    // Close confirmation
    if (interaction.isButton() && interaction.customId === 'ticket_close_cancel') {
      return interaction.update({ content: 'Close cancelled.', components: [] });
    }

    if (interaction.isButton() && interaction.customId === 'ticket_close_confirm') {
      const { ownerId, type: closeTypeKey } = parseTicketTopic(interaction.channel.topic);
      const isOwnerClosing = ownerId && interaction.user.id === ownerId;
      if (!isOwnerClosing && !isSellerOrAdmin(interaction.member, closeTypeKey)) {
        return interaction.reply({ content: 'Only the ticket owner, that ticket type\'s role, or admins can close this ticket.', ephemeral: true });
      }
      await interaction.update({ content: 'Closing ticket...', components: [] });

      if (ownerId) {
        await interaction.channel.permissionOverwrites.edit(ownerId, { SendMessages: false, ViewChannel: true }).catch(() => null);
      }

      if (process.env.LOG_CHANNEL_ID) {
        const logChannel = await interaction.guild.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
        if (logChannel) {
          logChannel.send({
            embeds: [
              new EmbedBuilder()
                .setDescription(`${config.emojis.close} Ticket **#${interaction.channel.name}** was closed by ${interaction.user}`)
                .setColor('#2b2d31')
                .setTimestamp()
            ]
          }).catch(err => console.error('Failed to send close log message:', err));
        }
      }

      // Ticket stays — we don't delete the channel. It's just renamed/locked
      // so staff/admins can still review it (only they can delete it manually
      // via Discord if they want to clean it up later).
      const archivedName = interaction.channel.name.startsWith('closed-')
        ? interaction.channel.name
        : `closed-${interaction.channel.name}`.slice(0, 100);
      await interaction.channel.setName(archivedName).catch(() => null);

      // Move it into the "Closed Tickets" category if one is configured.
      // lockPermissions: false keeps this channel's own overwrites (owner
      // locked out, staff role still able to see it) instead of resetting
      // them to match whatever the closed-tickets category has set.
      if (process.env.CLOSED_TICKETS_CATEGORY_ID) {
        const closedCategory = await interaction.guild.channels
          .fetch(process.env.CLOSED_TICKETS_CATEGORY_ID)
          .catch(() => null);
        if (closedCategory) {
          await interaction.channel.setParent(closedCategory.id, { lockPermissions: false }).catch(err => {
            console.error('Failed to move closed ticket into closed-tickets category:', err);
          });
        } else {
          console.error('CLOSED_TICKETS_CATEGORY_ID is set but that category could not be found/fetched.');
        }
      }

      await interaction.followUp({ content: `${config.emojis.close} Ticket closed. The channel has been locked and kept for records — it was **not** deleted.`, ephemeral: true }).catch(() => null);
      return;
    }

    // Modal submissions
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_add_user') {
        const input = interaction.fields.getTextInputValue('user_input');
        const memberToAdd = await parseUserInput(interaction.guild, input);
        if (!memberToAdd) {
          return interaction.reply({ content: 'Could not find that user. Provide a valid ID or mention.', ephemeral: true });
        }
        await interaction.channel.permissionOverwrites.edit(memberToAdd.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true
        });
        return interaction.reply({ content: `${config.emojis.addUser} Added ${memberToAdd} to the ticket.` });
      }

      if (interaction.customId === 'modal_remove_user') {
        const input = interaction.fields.getTextInputValue('user_input');
        const memberToRemove = await parseUserInput(interaction.guild, input);
        if (!memberToRemove) {
          return interaction.reply({ content: 'Could not find that user. Provide a valid ID or mention.', ephemeral: true });
        }
        await interaction.channel.permissionOverwrites.delete(memberToRemove.id);
        return interaction.reply({ content: `${config.emojis.removeUser} Removed ${memberToRemove} from the ticket.` });
      }

      if (interaction.customId === 'modal_rename') {
        const newName = interaction.fields.getTextInputValue('new_name').toLowerCase().replace(/\s+/g, '-').slice(0, 90);
        await interaction.channel.setName(newName);
        return interaction.reply({ content: `${config.emojis.rename} Ticket renamed to **${newName}**.` });
      }

      // Private Store renewal request
      if (interaction.customId === 'store_renew_modal') {
        const channelId = interaction.fields.getTextInputValue('renew_channel_id').trim().replace(/\D/g, '');
        const durationInput = interaction.fields.getTextInputValue('renew_duration').trim().toLowerCase();
        const typeKey = durationInput.startsWith('week') ? 'week' : durationInput.startsWith('month') ? 'month' : null;

        if (!typeKey) {
          return interaction.reply({ content: 'Duration must be "week" or "month".', ephemeral: true });
        }

        const record = storeData[channelId];
        if (!record) {
          return interaction.reply({ content: 'No store found with that channel ID.', ephemeral: true });
        }
        if (record.ownerId !== interaction.user.id && !isSellerOrAdmin(interaction.member, 'mediator')) {
          return interaction.reply({ content: 'That store does not belong to you.', ephemeral: true });
        }

        if (pendingStorePurchases.has(interaction.user.id)) {
          return interaction.reply({
            content: 'You already have a pending store request awaiting payment. Please complete or wait for it to expire first.',
            ephemeral: true
          });
        }

        const requiredAmount = STORE_PRICES[typeKey];
        registerPendingPurchase(interaction.user.id, { typeKey, requiredAmount, renewChannelId: channelId });

        return interaction.reply({
          content: paymentInstructionsText(requiredAmount, process.env.STORE_OWNER_ID, process.env.PAYMENT_CHANNEL_ID),
          ephemeral: true
        });
      }

      // Apply Seller / Apply Staff application forms
      if (interaction.customId.startsWith('apply_modal_')) {
        const applyKey = interaction.customId.replace('apply_modal_', '');
        const info = APPLY_TYPES[applyKey];
        if (!info) return;

        const age = interaction.fields.getTextInputValue('apply_age');
        const experience = interaction.fields.getTextInputValue('apply_experience');
        const reason = interaction.fields.getTextInputValue('apply_reason');

        const resultEmbed = new EmbedBuilder()
          .setTitle(`${info.emoji} ${info.label}`)
          .setColor(config.panel.color || '#2b2d31')
          .addFields(
            { name: 'Applicant', value: `${interaction.user}`, inline: true },
            { name: 'Age', value: age, inline: true },
            { name: applyKey === 'seller' ? 'Selling experience' : 'Relevant experience', value: experience },
            { name: applyKey === 'seller' ? 'Why sell here?' : 'Why join staff?', value: reason }
          )
          .setTimestamp();

        const validApplyRoleId = safeRoleId(interaction.guild, info.roleId, `APPLY_${applyKey.toUpperCase()}_ROLE_ID`);

        await interaction.reply({
          content: validApplyRoleId ? `**Wait For:** <@&${validApplyRoleId}>` : '**Wait For:** a team member to review this.',
          embeds: [resultEmbed]
        });

        // Disable the select menu on the original picker message so it can't be resubmitted.
        if (interaction.message) {
          await interaction.message.edit({ components: [buildApplyTypeRow(true)] }).catch(() => null);
        }
        return;
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    // ---- BUG FIX ----
    // If the interaction had already been deferred (e.g. /storepanel calls
    // deferReply() then crashes before editReply()), the old code only
    // handled the "not replied and not deferred" case — a deferred
    // interaction that then errors was left stuck on "Bot is thinking..."
    // forever with no feedback. Now both cases are handled.
    if (interaction.isRepliable()) {
      const payload = { content: 'Something went wrong handling that action.', ephemeral: true };
      if (interaction.deferred && !interaction.replied) {
        interaction.editReply(payload).catch(() => null);
      } else if (!interaction.replied) {
        interaction.reply(payload).catch(() => null);
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
