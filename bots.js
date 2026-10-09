// البوتات المدمجة. كل بوت له أوامر (commands) وممكن يكون له onJoin لما عضو جديد ينضم.
// الدالة بتاخد ctx فيه: user, args, argStr, group, isAdmin, reply(), save(), nameOf(), remind()

const DUR = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };

function calc(expr) {
  const e = String(expr)
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632))
    .replace(/\^/g, '**').replace(/×/g, '*').replace(/÷/g, '/');
  if (!e.trim() || e.length > 60 || !/^[0-9+\-*/%().\s]+$/.test(e)) return null;
  try {
    const r = Function('"use strict";return (' + e + ')')();
    return typeof r === 'number' && isFinite(r) ? r : null;
  } catch { return null; }
}

const rnd = n => require('crypto').randomInt(0, n);

module.exports = [
  {
    key: 'assistant',
    name: '🤖 بوت المساعد',
    desc: 'حاسبة، نرد، عملة، اختيار عشوائي، وقت أي دولة، وتذكيرات.',
    commands: {
      '/help': c => c.reply(
        'الأوامر المتاحة:\n' +
        '/calc 2+2*3  ← حاسبة\n/dice [عدد]  ← نرد\n/coin  ← صورة أو كتابة\n' +
        '/choose أ | ب | ج  ← اختيار عشوائي\n/time [منطقة]  ← الوقت، مثال: /time Asia/Tokyo\n' +
        '/remind 10m نص  ← تذكير (s ثواني، m دقائق، h ساعات، d أيام)\n/who  ← معلومات الجروب\n/id  ← رقمك\n/ping'),
      '/ping': c => c.reply('pong 🏓'),
      '/id': c => c.reply('رقمك: ' + c.user.id),
      '/coin': c => c.reply(rnd(2) ? '🪙 صورة' : '🪙 كتابة'),
      '/dice': c => {
        const n = Math.min(Math.max(parseInt(c.args[0], 10) || 6, 2), 1000);
        c.reply('🎲 ' + (rnd(n) + 1) + ' (من ' + n + ')');
      },
      '/choose': c => {
        const o = c.argStr.split(/[|،,]/).map(x => x.trim()).filter(Boolean);
        c.reply(o.length < 2 ? 'اكتب خيارين على الأقل، مثال: /choose شاي | قهوة' : '🎯 ' + o[rnd(o.length)]);
      },
      '/calc': c => {
        const r = calc(c.argStr);
        c.reply(r === null ? 'مش قادر أحسبها. مثال: /calc (5+3)*2' : '🧮 ' + c.argStr + ' = ' + r);
      },
      '/time': c => {
        const tz = c.argStr || 'Africa/Cairo';
        try {
          c.reply('🕒 ' + new Date().toLocaleString('ar-EG', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }) + '  (' + tz + ')');
        } catch { c.reply('منطقة زمنية غير معروفة. مثال: /time Asia/Riyadh أو /time Europe/Paris'); }
      },
      '/remind': c => {
        const m = /^(\d+)([smhd])\s+([\s\S]+)$/.exec(c.argStr);
        if (!m) return c.reply('مثال: /remind 10m كلّم أحمد');
        const ms = +m[1] * DUR[m[2]];
        if (ms < 1e3 || ms > 7 * DUR.d) return c.reply('المدة من ثانية لحد 7 أيام');
        c.remind(ms, m[3].slice(0, 300));
        c.reply('⏰ تمام، هفكّرك بعد ' + m[1] + m[2]);
      },
      '/who': c => {
        if (!c.group) return c.reply('أنت: ' + c.user.name + '\nرقمك: ' + c.user.id);
        c.reply('👥 ' + c.group.name + '\nعدد الأعضاء: ' + c.group.members.length +
          '\nالمشرفين: ' + c.group.admins.map(c.nameOf).join('، '));
      }
    }
  },
  {
    key: 'welcome',
    name: '👋 بوت الترحيب',
    desc: 'يرحّب بالأعضاء الجدد ويعرض قواعد الجروب. المشرف يحدد القواعد بـ /setrules.',
    commands: {
      '/rules': c => {
        if (!c.group) return c.reply('الأمر ده للجروبات.');
        c.reply(c.group.rules ? '📜 قواعد الجروب:\n' + c.group.rules : 'لسه مفيش قواعد. المشرف يكتب: /setrules نص القواعد');
      },
      '/setrules': c => {
        if (!c.group) return c.reply('الأمر ده للجروبات.');
        if (!c.isAdmin) return c.reply('⛔ الأمر ده للمشرفين فقط.');
        if (!c.argStr) return c.reply('اكتب القواعد بعد الأمر، مثال: /setrules ممنوع الإعلانات');
        c.group.rules = c.argStr.slice(0, 1000); c.save();
        c.reply('✅ تم حفظ القواعد.');
      }
    },
    onJoin: c => c.reply('أهلًا ' + c.user.name + ' 👋 نورت ' + c.group.name + '!' +
      (c.group.rules ? '\n\n📜 قواعد الجروب:\n' + c.group.rules : ''))
  }
];
module.exports.calc = calc;
