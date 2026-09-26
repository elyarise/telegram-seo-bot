require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { analyzeHtml } = require('./analyzer');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Copy .env.example to .env and paste your token from @BotFather.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const UA = 'Mozilla/5.0 (compatible; SEOAuditBot/1.0; +https://t.me/)';
const FETCH_TIMEOUT_MS = 20000;

// ---- Conversation state (in-memory, per chat) ----
// Steps: await_keywords, await_competitor, await_url_a, await_url_b, await_keywords_compare
const chatState = new Map();
const getState = (chatId) => chatState.get(chatId) || null;
const setState = (chatId, obj) => chatState.set(chatId, obj);
const clearState = (chatId) => chatState.delete(chatId);

function isSkip(text) {
  return /^пропустить$/i.test(text.trim());
}

function isValidUrl(str) {
  try { const u = new URL(str.trim()); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Fetching ----
async function fetchHtml(url) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.9' },
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: (s) => s < 500
  });
  const contentType = res.headers['content-type'] || '';
  if (!contentType.includes('text/html')) {
    throw new Error(`По этой ссылке пришёл не HTML (Content-Type: ${contentType || 'неизвестен'})`);
  }
  return res.data;
}

function describeFetchError(err) {
  if (err.response) return `Сайт ответил с ошибкой ${err.response.status}.`;
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return 'Сайт не ответил вовремя (таймаут). Возможно, он слишком медленный или блокирует ботов.';
  if (err.code === 'ENOTFOUND') return 'Не удалось найти такой домен — проверьте ссылку.';
  if (err.code === 'ECONNREFUSED') return 'Сайт отказался принимать соединение.';
  if (err.code === 'ECONNRESET') return 'Соединение с сайтом было неожиданно разорвано — возможно, сайт блокирует автоматические запросы.';
  if (/certificate|SSL|TLS/i.test(err.message || '')) return 'Проблема с SSL-сертификатом сайта.';
  if (/Maximum number of redirects/i.test(err.message || '')) return 'Слишком много перенаправлений — сайт зациклил редиректы.';
  return err.message ? `Не удалось скачать страницу: ${err.message}` : 'Не удалось скачать страницу по неизвестной причине.';
}

// ---- Formatting ----
function scoreEmoji(score) {
  if (score >= 80) return '🟢';
  if (score >= 55) return '🟡';
  return '🔴';
}

function formatReport(url, result) {
  const lines = [];
  lines.push(`${scoreEmoji(result.score)} Анализ: <b>${escapeHtml(url)}</b>`);
  lines.push(`SEO-результат: <b>${result.score}/100</b>`);
  lines.push('');

  if (result.spaDetected) {
    lines.push('⚙️ <b>Похоже, это SPA (рендерится в браузере)</b>');
    lines.push('Сервер отдаёт почти пустой HTML — реальный контент дорисовывается JavaScript\'ом уже в браузере. Поисковые роботы могут увидеть именно эту пустую версию. Проверьте настройку SSR/prerendering (Next.js, Nuxt, react-snap и т.п.).');
    lines.push('');
  }

  lines.push('Результат:');
  lines.push('');

  const crit = result.issues.filter(i => i.sev === 'crit');
  const warn = result.issues.filter(i => i.sev === 'warn');
  const good = result.issues.filter(i => i.sev === 'good');

  if (crit.length) {
    lines.push('🔴 Блокирует индексацию или ранжирование:');
    crit.forEach(i => lines.push(`• ${escapeHtml(i.text)}`));
    lines.push('');
  }
  if (warn.length) {
    lines.push('🟡 Влияет на кликабельность и качество:');
    warn.forEach(i => lines.push(`• ${escapeHtml(i.text)}`));
    lines.push('');
  }
  if (good.length) {
    lines.push(`✅ Соответствует стандартам (${good.length}):`);
    good.forEach(i => lines.push(`• ${escapeHtml(i.text)}`));
  }
  return lines.join('\n');
}

// ---- Running analysis / comparison ----
async function runAnalysis(ctx, chatId, url, keywords) {
  const wait = await ctx.reply('🔎 Скачиваю и анализирую страницу…');
  try {
    const html = await fetchHtml(url);
    const result = analyzeHtml(html, keywords);
    let report = formatReport(url, result);
    if (report.length > 3900) report = report.slice(0, 3800) + '\n\n… (отчёт обрезан — слишком много пунктов)';
    setState(chatId, { url, keywords }); // keep for the "compare" button
    await ctx.telegram.editMessageText(chatId, wait.message_id, undefined, report, {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('⚖️ Сравнить с конкурентом', 'start_compare')],
        [Markup.button.callback('🔄 Проанализировать другой сайт', 'new_analysis')]
      ]).reply_markup
    });
  } catch (err) {
    clearState(chatId);
    await ctx.telegram.editMessageText(chatId, wait.message_id, undefined, '⚠️ ' + describeFetchError(err));
  }
}

async function runComparison(ctx, chatId, urlA, urlB, keywords) {
  const wait = await ctx.reply('🔎 Скачиваю и сравниваю обе страницы…');
  try {
    const [htmlA, htmlB] = await Promise.all([fetchHtml(urlA), fetchHtml(urlB)]);
    const a = analyzeHtml(htmlA, keywords);
    const b = analyzeHtml(htmlB, keywords);
    const rows = [
      ['SEO-скор', a.score, b.score],
      ['Длина title', a.meta.titleText.length, b.meta.titleText.length],
      ['Длина description', a.meta.descText.length, b.meta.descText.length],
      ['Кол-во H1', a.meta.h1Count, b.meta.h1Count],
      ['Картинок без alt', a.meta.imgsMissingAlt, b.meta.imgsMissingAlt],
      ['Structured data', a.meta.hasSchema ? 'есть' : 'нет', b.meta.hasSchema ? 'есть' : 'нет']
    ];
    let out = `⚖️ Сравнение\n<b>${escapeHtml(urlA)}</b> vs <b>${escapeHtml(urlB)}</b>\n\nРезультат:\n`;
    rows.forEach(r => { out += `${escapeHtml(r[0])}: <b>${r[1]}</b> vs <b>${r[2]}</b>\n`; });
    if (a.spaDetected || b.spaDetected) out += '\n⚙️ Один из сайтов похож на SPA без серверного рендеринга — сравнение может быть некорректным.';
    await ctx.telegram.editMessageText(chatId, wait.message_id, undefined, out, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.telegram.editMessageText(chatId, wait.message_id, undefined, '⚠️ ' + describeFetchError(err));
  }
}

// ---- Welcome ----
function menuText() {
  return 'Проверю технический и on-page SEO страницы: title, description, H1, ' +
    'robots/canonical, alt-теги, структурированные данные, признаки SPA без SSR.\n\n' +
    'Можно просто прислать ссылку, или выбрать режим ниже:';
}

function menuButtons() {
  return Markup.inlineKeyboard([
    Markup.button.callback('🔍 Проверить один сайт', 'mode_single'),
    Markup.button.callback('⚖️ Сравнить два сайта', 'mode_compare')
  ]);
}

function sendWelcome(ctx) {
  return ctx.reply('Привет! ' + menuText(), menuButtons());
}

function sendMenu(ctx) {
  return ctx.reply(menuText(), menuButtons());
}

bot.start((ctx) => { clearState(ctx.chat.id); return sendWelcome(ctx); });
bot.help((ctx) => { clearState(ctx.chat.id); return sendWelcome(ctx); });

// ---- Button presses ----
bot.action('mode_single', async (ctx) => {
  await ctx.answerCbQuery();
  clearState(ctx.chat.id);
  await ctx.reply('Пришлите ссылку на сайт, который нужно проверить.');
});

bot.action('mode_compare', async (ctx) => {
  await ctx.answerCbQuery();
  setState(ctx.chat.id, { step: 'await_url_a' });
  await ctx.reply('Пришлите ссылку на первый сайт.');
});

bot.action('start_compare', async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const state = getState(chatId);
  if (!state || !state.url) {
    await ctx.reply('Не нашла предыдущий анализ — пришлите ссылку заново.');
    return;
  }
  setState(chatId, { step: 'await_competitor', mainUrl: state.url, keywords: state.keywords || '' });
  await ctx.reply('Пришлите ссылку на сайт конкурента.');
});

bot.action('new_analysis', async (ctx) => {
  await ctx.answerCbQuery();
  clearState(ctx.chat.id);
  await sendMenu(ctx);
});

// ---- Plain text messages, routed by conversation state ----
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  const state = getState(chatId);
  const step = state && state.step;

  if (step === 'await_keywords') {
    const keywords = isSkip(text) ? '' : text;
    clearState(chatId);
    await runAnalysis(ctx, chatId, state.url, keywords);
    return;
  }

  if (step === 'await_competitor') {
    if (!isValidUrl(text)) { await ctx.reply('Это не похоже на ссылку. Пришлите URL конкурента, например: https://example.com'); return; }
    const { mainUrl, keywords } = state;
    clearState(chatId);
    await runComparison(ctx, chatId, mainUrl, text, keywords || '');
    return;
  }

  if (step === 'await_url_a') {
    if (!isValidUrl(text)) { await ctx.reply('Это не похоже на ссылку. Пришлите первый URL.'); return; }
    setState(chatId, { step: 'await_url_b', urlA: text });
    await ctx.reply('Пришлите ссылку на второй сайт (конкурента).');
    return;
  }

  if (step === 'await_url_b') {
    if (!isValidUrl(text)) { await ctx.reply('Это не похоже на ссылку. Пришлите второй URL.'); return; }
    setState(chatId, { step: 'await_keywords_compare', urlA: state.urlA, urlB: text });
    await ctx.reply('Пришлите ключевые слова через запятую, или напишите «пропустить», если не хотите учитывать их при анализе.');
    return;
  }

  if (step === 'await_keywords_compare') {
    const keywords = isSkip(text) ? '' : text;
    const { urlA, urlB } = state;
    clearState(chatId);
    await runComparison(ctx, chatId, urlA, urlB, keywords);
    return;
  }

  // No active conversation: a bare URL starts a single-site check.
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (!urlMatch) {
    await ctx.reply('Пришлите ссылку на страницу, например: https://example.com');
    return;
  }
  setState(chatId, { step: 'await_keywords', url: urlMatch[0] });
  await ctx.reply('Пришлите ключевые слова через запятую, или напишите «пропустить», если не хотите учитывать их при анализе.');
});

// ---- Auto-switch: polling locally, webhook on Render ----
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL; // set automatically by Render for web services

if (PUBLIC_URL) {
  const express = require('express');
  const app = express();
  const webhookPath = `/telegraf/${BOT_TOKEN}`;

  app.get('/', (_req, res) => res.send('SEO audit bot is alive'));
  app.use(bot.webhookCallback(webhookPath));

  app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

  bot.telegram.setWebhook(`${PUBLIC_URL}${webhookPath}`)
    .then(() => console.log('Webhook set to', `${PUBLIC_URL}${webhookPath}`))
    .catch((err) => console.error('Failed to set webhook:', err.message));
} else {
  bot.launch();
  console.log('SEO audit bot is running (polling mode).');
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}