// مثال لبوت خارجي. شغّله بعد ما تعمل بوت من (الإعدادات ⚙️ ← بوتاتي) وتاخد التوكن.
//   ويندوز:  set BOT_TOKEN=التوكن&& node example-bot.js
//   ماك/لينكس:  BOT_TOKEN=التوكن node example-bot.js
// بعدها أضف البوت لجروب (برقمه) أو كلمه في محادثة خاصة، وجرّب /hello و /echo كلام و /upper كلام
const SERVER = process.env.SERVER || 'http://localhost:3000';
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.log('لازم تحط التوكن في BOT_TOKEN'); process.exit(1); }

const call = (path, opts) => fetch(`${SERVER}/api/bot/${TOKEN}/${path}`, opts).then(r => r.json());
const send = (chat, text) => call('send', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat, text })
});

(async () => {
  const me = await call('me');
  if (!me.ok) { console.log('التوكن غلط'); process.exit(1); }
  console.log('البوت شغال:', me.name);
  let offset = 0;
  for (;;) {
    try {
      const r = await call(`updates?offset=${offset}&timeout=25`);
      for (const u of r.updates || []) {
        offset = u.update_id + 1;
        const m = u.message, [cmd, ...rest] = m.text.split(/\s+/), arg = rest.join(' ');
        if (cmd === '/hello' || cmd === '/start') await send(m.chat, `أهلًا ${m.from.name} 👋`);
        else if (cmd === '/echo') await send(m.chat, arg || 'اكتب كلام بعد الأمر');
        else if (cmd === '/upper') await send(m.chat, (arg || '').toUpperCase() || 'اكتب كلام بالإنجليزي');
        else if (m.chat_type === 'private') await send(m.chat, 'جرّب /hello أو /echo أو /upper');
      }
    } catch (e) {
      console.log('خطأ:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
})();
