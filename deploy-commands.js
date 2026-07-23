require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Post the ticket dashboard panel in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('storepanel')
    .setDescription('Post the Private Store Menu panel in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ---------- Autoline ----------
  new SlashCommandBuilder()
    .setName('add-autoline-channel')
    .setDescription('اضافة روم خط تلقائي')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option =>
      option.setName('room').setDescription('الروم').setRequired(true)),
  new SlashCommandBuilder()
    .setName('remove-autoline-channel')
    .setDescription('ازالة روم خط تلقائي')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option =>
      option.setName('room').setDescription('الروم').setRequired(true)),
  new SlashCommandBuilder()
    .setName('line-mode')
    .setDescription('اختر بين إرسال صورة أو رابط')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option =>
      option.setName('mode').setDescription('اختر بين الصورة والرابط').setRequired(true)
        .addChoices(
          { name: 'صورة', value: 'image' },
          { name: 'رابط', value: 'link' }
        )),
  new SlashCommandBuilder()
    .setName('set-autoline-line')
    .setDescription('تحديد الخط')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option =>
      option.setName('line').setDescription('الخط').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered for guild', process.env.GUILD_ID);
  } catch (err) {
    console.error(err);
  }
})();
