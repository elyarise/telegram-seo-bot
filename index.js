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

  if (result.keywordResults && result.keywordResults.length) {
    lines.push('');
    lines.push('🔑 <b>Ключевые слова:</b>');
    result.keywordResults.forEach(k => {
      const icon = k.status === 'ok' ? '✅' : k.status === 'partial' ? '🟡' : '🔴';
      const desc = k.status === 'ok' ? 'есть в title/H1'
        : k.status === 'partial' ? 'есть в тексте, но не в title/H1'
        : 'не найдено ни в title, ни в H1, ни в тексте';
      lines.push(`${icon} «${escapeHtml(k.kw)}» — ${desc}`);
    });
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

// Rough, unofficial heuristic — there is no industry-standard "GEO score".
// Approximates how likely a page is to be picked up and cited by AI answer
// engines (ChatGPT, Perplexity, etc.), which lean on similar on-page signals
// to classic SEO: clear structure, structured data, enough real content.
function geoScore(meta) {
  let score = 0;
  if (meta.hasSchema) score += 30;
  if (meta.h1Count === 1) score += 15;
  if (meta.h2Count >= 2) score += 15;
  if (meta.titleText && meta.titleText.length >= 30 && meta.titleText.length <= 60) score += 15;
  if (meta.descText && meta.descText.length >= 120 && meta.descText.length <= 160) score += 10;
  if (meta.wordCount >= 300) score += 15;
  return Math.min(100, score);
}

const METRICS = [
  { key: 'score', label: 'SEO-скор', hint: 'общая оценка страницы', higherBetter: true },
  { key: 'titleLen', label: 'Длина title', hint: 'влияет на кликабельность в поиске (норма 30–60)' },
  { key: 'descLen', label: 'Длина description', hint: 'влияет на CTR из поиска (норма 120–160)' },
  { key: 'h1Count', label: 'Кол-во H1', hint: 'главный заголовок страницы — должен быть один' },
  { key: 'imgsMissingAlt', label: 'Картинок без alt', hint: 'хуже доступность и картиночный поиск', higherBetter: false },
  { key: 'hasSchema', label: 'Structured data', hint: 'помогает попасть в расширенные сниппеты в поиске', higherBetter: true },
  { key: 'geo', label: 'GEO-потенциал', hint: 'приблизительная оценка: вероятность, что нейросеть процитирует страницу в ответе', higherBetter: true }
];

function metricValues(result) {
  return {
    score: result.score,
    titleLen: result.meta.titleText.length,
    descLen: result.meta.descText.length,
    h1Count: result.meta.h1Count,
    imgsMissingAlt: result.meta.imgsMissingAlt,
    hasSchema: result.meta.hasSchema ? 'есть' : 'нет',
    geo: geoScore(result.meta)
  };
}

async function runComparison(ctx, chatId, urlA, urlB, keywords) {
  const wait = await ctx.reply('🔎 Скачиваю и сравниваю обе страницы…');
  try {
    const [htmlA, htmlB] = await Promise.all([fetchHtml(urlA), fetchHtml(urlB)]);
    const a = analyzeHtml(htmlA, keywords);
    const b = analyzeHtml(htmlB, keywords);
    const va = metricValues(a);
    const vb = metricValues(b);

    let out = `⚖️ <b>Сравнение сайтов</b>\n\n`;
    out += `🔵 ${escapeHtml(urlA)}\n🟠 ${escapeHtml(urlB)}\n`;

    METRICS.forEach(m => {
      const x = va[m.key], y = vb[m.key];
      let winMark = '';
      if (m.higherBetter !== undefined && x !== y) {
        let aWins;
        if (typeof x === 'number' && typeof y === 'number') aWins = m.higherBetter ? x > y : x < y;
        else aWins = x === 'есть';
        winMark = aWins ? '🏆 лучше у 🔵' : '🏆 лучше у 🟠';
      }
      out += `\n<b>${escapeHtml(m.label)}</b> <i>(${escapeHtml(m.hint)})</i>\n🔵 ${x}\n🟠 ${y}\n`;
      if (winMark) out += `${winMark}\n`;
    });

    if (a.keywordResults && a.keywordResults.length) {
      out += `\n🔑 <b>Ключевые слова</b>\n`;
      a.keywordResults.forEach((kwA, idx) => {
        const kwB = b.keywordResults[idx];
        const iconFor = (status) => status === 'ok' ? '✅' : status === 'partial' ? '🟡' : '🔴';
        out += `\n«${escapeHtml(kwA.kw)}»\n🔵 ${iconFor(kwA.status)}\n🟠 ${iconFor(kwB.status)}\n`;
      });
    }

    out += `\n📊 <b>Итог</b>\n`;
    if (va.score !== vb.score) {
      const better = va.score > vb.score ? '🔵' : '🟠';
      out += `По техническому SEO выше шансы на органическую выдачу у сайта ${better} — но это только on-page факторы, без учёта ссылочной массы, возраста домена и глубины контента.\n`;
    } else {
      out += `По техническому SEO сайты примерно на одном уровне.\n`;
    }
    if (va.geo !== vb.geo) {
      const betterGeo = va.geo > vb.geo ? '🔵' : '🟠';
      out += `По GEO (вероятности попасть в ответ нейросети) выше шансы у сайта ${betterGeo} — это ориентировочная оценка, официального стандарта GEO-скоринга пока не существует.`;
    } else {
      out += `По GEO-показателям сайты примерно равны.`;
    }

    if (a.spaDetected || b.spaDetected) out += '\n\n⚙️ Один из сайтов похож на SPA без серверного рендеринга — сравнение может быть некорректным.';
    await ctx.telegram.editMessageText(chatId, wait.message_id, undefined, out, {
      parse_mode: 'HTML',
      reply_markup: menuButtons().reply_markup
    });
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
