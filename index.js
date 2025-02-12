import express from 'express';
import fs from 'fs';
import { makeInMemoryStore, useMultiFileAuthState, makeWASocket } from '@whiskeysockets/baileys';
import axios from "axios";
import * as cheerio from "cheerio";
import multer from 'multer';

const upload = multer({
  dest: './uploads/',
  limits: { fileSize: 1000000 },
  fileFilter(req, file, cb) {
    if (!file.originalname.match(/\.(jpg|jpeg|png)$/)) {
      return cb(new Error('Please upload an image'));
    }
    cb(undefined, true);
  }
});

const app = express();
const port = process.env.PORT || 3000;
const store = makeInMemoryStore({});
let sock;

// Fungsi untuk membaca dan menyimpan pengaturan
const settingsFile = './settings.json';
// Fungsi untuk membaca dan menyimpan pengaturan

const loadSettings = () => {
    if (!fs.existsSync(settingsFile)) {
        fs.writeFileSync(settingsFile, JSON.stringify({
            prefixes: ['!'],
            commands: { tagall: 'Tag all!' },
            welcomeMessage: "Selamat datang, @user! Semoga betah di grup 😊"
        }, null, 2));
    }
    return JSON.parse(fs.readFileSync(settingsFile));
};

const saveSettings = (data) => {
    fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2));
};
let settings = loadSettings(); // Load data dari settings.json

const sendMessage = async (jid, text, quoted) => {
    try {
        await sock.sendMessage(jid, { text }, { quoted });
    } catch (error) {
        console.error(`❌ Gagal mengirim pesan ke ${jid}:`, error);
    }
};
const sendImageMessage = async (jid, imageUrl, caption, quoted) => {
    try {
        await sock.sendMessage(jid, { image: { url: imageUrl }, caption }, { quoted });
    } catch (error) {
        console.error(`❌ Gagal mengirim gambar ke ${jid}:`, error);
    }
};

// Fungsi leveling

async function handleLeveling(sender, command, msg) {
    try {
        // Ambil argumen setelah "leveling"
        const args = command.split(" ").slice(1);

        if (args.length === 0 || args.length > 2) {
            return sendMessage(sender, "⚠️ Format salah! Gunakan: `!leveling [level] [bonus exp (opsional)]`", msg);
        }

        let lvl = args[0];
        let bexp = args[1] || "0"; // Default bonus EXP adalah 0

        if (!/^\d+$/.test(lvl) || !/^\d+$/.test(bexp)) {
            return sendMessage(sender, "⚠️ Level dan bonus EXP harus berupa angka!", msg);
        }

        sendMessage(sender, "⏳ Sedang mengambil data...", msg);

        const response = await axios.get(`https://coryn.club/leveling.php?lv=${lvl}&gap=7&bonusEXP=${bexp}`);
        const html = response.data;
        const $ = cheerio.load(html);
        let result = [];

        $(".level-row").each(function () {
            let level = $(this).find(".level-col-1 > b").text().trim();
            let boss = $(this).find(".level-col-2 > p:nth-child(1) > b > a").text().trim();
            let location = $(this).find(".level-col-2 > p:nth-child(2)").text().trim();
            let fullBreak = $(this).find(".level-col-3 > p:nth-child(1) > b").text().trim();
            let noBreak = $(this).find(".level-col-3 > p:nth-child(4)").text().trim();

            if (fullBreak) {
                result.push({
                    level,
                    boss,
                    location,
                    exp: { fullBreak, noBreak }
                });
            }
        });

        if (result.length === 0) {
            return sendMessage(sender, `❌ Tidak ada hasil untuk level ${lvl} dengan bonus EXP ${bexp}%`, msg);
        }

        let replyMsg = `*📌 Leveling Level ${lvl} & Bonus EXP ${bexp}%*\n`;
        result.forEach(data => {
            replyMsg += `\n----------------------\n`;
            replyMsg += `📌 *Boss:* ${data.boss}\n`;
            replyMsg += `📌 *Level:* ${data.level}\n`;
            replyMsg += `📌 *Lokasi:* ${data.location}\n`;
            replyMsg += `📌 *EXP Full Break:* ${data.exp.fullBreak}\n`;
            replyMsg += `📌 *EXP No Break:* ${data.exp.noBreak}\n`;
        });

        sendMessage(sender, replyMsg, msg);
    } catch (err) {
        sendMessage(sender, `❌ Terjadi kesalahan: ${err.message}`, msg);
    }
}

// Fungsi tag all members
async function tagAllMembers(sock, msg, args) {
    try {
        if (!msg.key.remoteJid.endsWith("@g.us")) {
            return sock.sendMessage(msg.key.remoteJid, { text: "⚠️ Perintah ini hanya bisa digunakan dalam grup." }, { quoted: msg });
        }

        const groupMetadata = await sock.groupMetadata(msg.key.remoteJid);
        const members = groupMetadata.participants.map(member => member.id);

        if (members.length === 0) {
            return sock.sendMessage(msg.key.remoteJid, { text: "⚠️ Tidak bisa mendapatkan daftar anggota grup." }, { quoted: msg });
        }

        // Ambil argumen sebagai pesan opsional
        const pesan = args.length ? args.join(" ") : "Tidak ada pesan tambahan.";
        const mentions = members.map(id => `@${id.split("@")[0]}`).join(" ");
        const mentionText = `📢 TAG ALL: ${pesan}\n\n${mentions}`;

        // Kirim pesan dengan mention
        await sock.sendMessage(msg.key.remoteJid, {
            text: mentionText,
            mentions: members
        });

        console.log(`Tagall berhasil dikirim di grup ${groupMetadata.subject}`);

    } catch (error) {
        console.error("Error di tagAllMembers:", error);
    }
}
async function handleGroupUpdate(update) {
    try {
        console.log("🔄 Group participants update:", JSON.stringify(update, null, 2));

        if (!update || !update.id || !update.participants || !update.action) {
            console.error("⚠️ Invalid update format:", update);
            return;
        }

        const { id, participants, action } = update;
        const metadata = await sock.groupMetadata(id);
        const botNumber = sock.user.id.split(':')[0] + "@s.whatsapp.net";
        const isBotAdmin = metadata.participants.find(p => p.id === botNumber)?.admin !== null;

        if (!isBotAdmin) {
            console.warn("⚠️ Bot bukan admin, tidak bisa kirim pesan otomatis.");
            return;
        }

        for (const participant of participants) {
            if (action === 'add') {
                // Pesan Welcome
                let welcomeMessage = settings.welcomeMessage.replace('@user', `@${participant.split("@")[0]}`);

                await sock.sendMessage(id, {
                    text: welcomeMessage,
                    mentions: [participant]
                });

                console.log(`✅ Welcome message dikirim ke ${participant}`);
            } else if (action === 'remove') {
                // Pesan Leave
                let leaveMessage = settings.leaveMessage.replace('@user', `@${participant.split("@")[0]}`);

                await sock.sendMessage(id, {
                    text: leaveMessage,
                    mentions: [participant]
                });

                console.log(`❌ Leave message dikirim untuk ${participant}`);
            }

            await delay(1000); // Hindari spam
        }
    } catch (error) {
        console.error("❌ Error in handleGroupUpdate:", error);
    }
}

// Fungsi addCommandImage
async function addCommandImage(command, imageUrl, caption) {
    if (command && imageUrl && caption) {
      if (!settings.messages) {
        settings.messages = {};
      }
      settings.messages[command] = {
        type: 'image',
        imageUrl: `http://localhost:3000/${imageUrl}`,
        caption
      };
      saveSettings(settings);
    }
  }
  app.use(express.static('uploads'));
//wellcome
async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ["macOS", "Chrome", "22.04.4"]
    });

    store.bind(sock.ev);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error
                ? lastDisconnect.error.output.statusCode !== 401
                : true;

            if (shouldReconnect) connect();
        } else if (connection === 'open') {
            console.log('WhatsApp bot connected!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || !msg.key.remoteJid) return;
      
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        console.log('Full message received:', text);
      
        // Cek apakah pesan diawali dengan prefix yang valid
        const prefixUsed = settings.prefixes.find(pfx => text.startsWith(pfx));
        if (!prefixUsed) {
          console.log('No valid prefix found.');
          return;
        }
      
        const sender = msg.key.remoteJid;
        const command = text.slice(prefixUsed.length).trim();
        console.log('Command detected:', command);
      
        // Tambahkan perintah untuk menangani respon gambar dengan lebih dari satu perintah
        if (settings.messages[command]) {
          const response = settings.messages[command];
          if (response.type === 'text') {
            await sendMessage(sender, response.content, msg);
          } else if (response.type === 'image') {
            await sendImageMessage(sender, response.imageUrl, response.caption, msg);
          }
        } else if (command.startsWith("leveling")) {
          await handleLeveling(sender, command, msg);
        } else if (command.startsWith("tagall")) {
          const args = command.split(" ").slice(1);
          await tagAllMembers(sock, msg, args);
        } else if (settings.commands[command]) {
          // Respon otomatis dari settings.json
          await sendMessage(sender, settings.commands[command], msg);
        }
      });
    
    
    sock.ev.on('group-participants.update', handleGroupUpdate);

    
}

connect().catch(console.error);

// Halaman utama
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.render('index', { status: sock ? 'Connected' : 'Disconnected', settings });
});
app.post('/update-welcome', (req, res) => {
    const { welcomeMessage } = req.body;
    if (welcomeMessage) {
        settings.welcomeMessage = welcomeMessage;
        saveSettings(settings);
    }
    res.redirect('/');
});
// Endpoint untuk menambah perintah
app.post('/add-command', (req, res) => {
    const { command, response } = req.body;
    if (command && response) {
        settings.commands[command] = response;
        saveSettings(settings);
    }
    res.redirect('/');
});

// Endpoint untuk menambah prefix
app.post('/add-prefix', (req, res) => {
    const { prefix } = req.body;
    if (prefix && !settings.prefixes.includes(prefix)) {
        settings.prefixes.push(prefix);
        saveSettings(settings);
    }
    res.redirect('/');
});

// Endpoint untuk menghapus prefix
app.post('/remove-prefix', (req, res) => {
    const { prefix } = req.body;
    settings.prefixes = settings.prefixes.filter(pfx => pfx !== prefix);
    saveSettings(settings);
    res.redirect('/');
});

// Endpoint untuk menghapus perintah
app.post('/remove-command', (req, res) => {
    const { command } = req.body;
    delete settings.commands[command];
    saveSettings(settings);
    res.redirect('/');
});
// Endpoint untuk mengedit prefix
app.post('/edit-prefix', (req, res) => {
    const { oldPrefix, newPrefix } = req.body;
    if (oldPrefix && newPrefix && settings.prefixes.includes(oldPrefix)) {
        const index = settings.prefixes.indexOf(oldPrefix);
        settings.prefixes[index] = newPrefix;
        saveSettings(settings);
    }
    res.redirect('/');
});

// Endpoint untuk mengedit perintah
app.post('/edit-command', (req, res) => {
    const { oldCommand, newCommand, response } = req.body;
    if (oldCommand && newCommand && settings.commands[oldCommand]) {
        delete settings.commands[oldCommand];
        settings.commands[newCommand] = response;
        saveSettings(settings);
    }
    res.redirect('/');
});
// Endpoint add-command-image
app.post('/add-command-image', upload.single('imageUrl'), (req, res) => {
    const { command, caption } = req.body;
    const imageUrl = req.file.filename;
    addCommandImage(command, imageUrl, caption);
    res.redirect('/');
  });
  // Endpoint remove-command-image
app.post('/remove-command-image', (req, res) => {
    const { command } = req.body;
    if (command) {
      delete settings.messages[command];
      saveSettings(settings);
    }
    res.redirect('/');
  });
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });