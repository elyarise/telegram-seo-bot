const cheerio = require('cheerio');

// Determine if a page looks like a client-rendered SPA with almost no
// server-rendered content (React/Vue/Vite apps without SSR).
function isLikelySpa($) {
  const hasRootDiv = $('#root, #app, #__next, #app-root, #__nuxt').length > 0;
  const hasModuleScript = $('script[type="module"]').length > 0;
  const bodyClone = $('body').clone();
  bodyClone.find('script, style, svg').remove();
  const text = bodyClone.text().replace(/\s+/g, ' ').trim();
  return (hasRootDiv || hasModuleScript) && text.length < 150;
}

/**
 * Analyze a single page's raw HTML for technical & on-page SEO issues.
 * @param {string} html - raw HTML source
 * @param {string} keywordsCsv - comma-separated target keywords (optional)
 * @returns {{score:number, issues:Array, spaDetected:boolean, meta:Object}}
 */
function analyzeHtml(html, keywordsCsv) {
  const $ = cheerio.load(html);
  const issues = [];
  let score = 100;
  const add = (sev, text, penalty) => { issues.push({ sev, text }); score -= penalty; };

  const spaDetected = isLikelySpa($);

  const titleText = ($('title').first().text() || '').trim();
  if (!titleText) add('crit', 'Отсутствует тег <title>', 18);
  else if (titleText.length < 30 || titleText.length > 60) add('warn', `Длина title ${titleText.length} символов (оптимально 30–60)`, 6);
  else add('good', `Title оптимальной длины (${titleText.length} симв.)`, 0);

  const descText = ($('meta[name="description"]').attr('content') || '').trim();
  if (!descText) add('crit', 'Отсутствует meta description', 15);
  else if (descText.length < 120 || descText.length > 160) add('warn', `Длина description ${descText.length} символов (оптимально 120–160)`, 5);
  else add('good', 'Meta description оптимальной длины', 0);

  const h1Count = $('h1').length;
  if (h1Count === 0) add('crit', 'Нет тега H1 на странице', 15);
  else if (h1Count > 1) add('warn', `Найдено ${h1Count} тегов H1 (должен быть один)`, 7);
  else add('good', 'Ровно один H1', 0);

  const robotsContent = $('meta[name="robots"]').attr('content') || '';
  if (/noindex/i.test(robotsContent)) add('crit', '⚠️ Meta robots содержит noindex — страница закрыта от индексации', 25);

  const hasCanonical = $('link[rel="canonical"]').length > 0;
  if (!hasCanonical) add('warn', 'Нет canonical-тега', 5);
  else add('good', 'Canonical указан', 0);

  if ($('meta[name="viewport"]').length === 0) add('warn', 'Нет meta viewport — возможны проблемы с мобильной адаптацией', 6);

  const imgs = $('img');
  const imgsTotal = imgs.length;
  let imgsMissingAlt = 0;
  imgs.each((_, el) => { const alt = $(el).attr('alt'); if (!alt || !alt.trim()) imgsMissingAlt++; });
  if (imgsTotal && imgsMissingAlt) add('warn', `${imgsMissingAlt} из ${imgsTotal} изображений без alt-текста`, Math.min(10, imgsMissingAlt * 2));
  else if (imgsTotal) add('good', 'У всех изображений есть alt', 0);

  const hasSchema = $('script[type="application/ld+json"]').length > 0;
  if (!hasSchema) add('warn', 'Нет структурированных данных (Schema.org / JSON-LD)', 5);
  else add('good', 'Структурированные данные найдены', 0);

  const inlineStyles = $('[style]').length + $('style').length;
  const inlineScripts = $('script').filter((_, el) => !$(el).attr('src')).length;
  if (inlineStyles + inlineScripts > 15) add('warn', `Много инлайн-стилей/скриптов (${inlineStyles + inlineScripts}) — может замедлять рендер`, 5);

  const bodyText = $('body').text().toLowerCase();
  const h1Texts = $('h1').map((_, el) => $(el).text().toLowerCase()).get();
  const kwList = (keywordsCsv || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  const keywordResults = [];
  kwList.forEach(kw => {
    const inTitle = titleText.toLowerCase().includes(kw);
    const inH1 = h1Texts.some(h => h.includes(kw));
    const inBody = bodyText.includes(kw);
    if (!inTitle && !inH1 && !inBody) { keywordResults.push({ kw, status: 'missing' }); score -= 10; }
    else if (!inTitle && !inH1) { keywordResults.push({ kw, status: 'partial' }); score -= 4; }
    else { keywordResults.push({ kw, status: 'ok' }); }
  });

  const h2Count = $('h2').length;
  const rawBodyText = $('body').text().trim();
  const wordCount = rawBodyText ? rawBodyText.split(/\s+/).filter(Boolean).length : 0;

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    issues,
    spaDetected,
    keywordResults,
    meta: { titleText, descText, h1Count, imgsMissingAlt, imgsTotal, hasSchema, hasCanonical, h2Count, wordCount }
  };
}

module.exports = { analyzeHtml, isLikelySpa };
