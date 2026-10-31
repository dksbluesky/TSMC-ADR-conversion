(function (root) {
  const TIME_ZONES = { US: 'America/New_York', TW: 'Asia/Taipei' };
  const DAY_MS = 24 * 60 * 60 * 1000;

  function partsInZone(timestamp, zone) {
    const values = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(timestamp));
    return Object.fromEntries(values.filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  }

  function dateKey(timestamp, zone) {
    const p = partsInZone(timestamp, zone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }

  // Convert a local exchange close to UTC without assuming a fixed offset (DST safe).
  function zonedTimeToUtc(date, hour, minute, zone) {
    const [year, month, day] = date.split('-').map(Number);
    const desiredUtc = Date.UTC(year, month - 1, day, hour, minute);
    let candidate = desiredUtc;
    for (let i = 0; i < 3; i++) {
      const p = partsInZone(candidate, zone);
      const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      candidate += desiredUtc - represented;
    }
    return candidate;
  }

  function exchangeCloseMs(date, market) {
    return market === 'US'
      ? zonedTimeToUtc(date, 16, 0, TIME_ZONES.US)
      : zonedTimeToUtc(date, 13, 30, TIME_ZONES.TW);
  }

  function weekday(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  }

  function nthWeekday(year, month, targetWeekday, n) {
    const first = weekday(year, month, 1);
    return 1 + ((targetWeekday - first + 7) % 7) + (n - 1) * 7;
  }

  function lastWeekday(year, month, targetWeekday) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return lastDay - ((weekday(year, month, lastDay) - targetWeekday + 7) % 7);
  }

  function observedFixedDate(year, month, day) {
    const dow = weekday(year, month, day);
    const date = new Date(Date.UTC(year, month - 1, day + (dow === 6 ? -1 : dow === 0 ? 1 : 0)));
    return date.toISOString().slice(0, 10);
  }

  function easterSunday(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(year, month - 1, day));
  }

  function usMarketHolidays(year) {
    const holidays = new Set([
      observedFixedDate(year, 1, 1),
      `${year}-01-${String(nthWeekday(year, 1, 1, 3)).padStart(2, '0')}`,
      `${year}-02-${String(nthWeekday(year, 2, 1, 3)).padStart(2, '0')}`,
      `${year}-05-${String(lastWeekday(year, 5, 1)).padStart(2, '0')}`,
      observedFixedDate(year, 7, 4),
      `${year}-09-${String(nthWeekday(year, 9, 1, 1)).padStart(2, '0')}`,
      `${year}-11-${String(nthWeekday(year, 11, 4, 4)).padStart(2, '0')}`,
      observedFixedDate(year, 12, 25)
    ]);
    if (year >= 2022) holidays.add(observedFixedDate(year, 6, 19));
    const goodFriday = easterSunday(year);
    goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
    holidays.add(goodFriday.toISOString().slice(0, 10));
    // Saturday New Year's Day is observed by US equity markets on the preceding Friday.
    if (weekday(year, 1, 1) === 6) holidays.add(`${year - 1}-12-31`);
    return holidays;
  }

  function isUsTradingDay(date) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (day === 0 || day === 6) return false;
    return !usMarketHolidays(Number(date.slice(0, 4))).has(date);
  }

  function parseYahooChart(json, market, nowMs = Date.now(), maxAgeDays = 7) {
    const result = json?.chart?.result?.[0];
    const timestamps = result?.timestamp;
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(timestamps) || !Array.isArray(closes) || !TIME_ZONES[market]) {
      throw new Error('Yahoo response is missing daily timestamps or closing prices.');
    }

    const zone = TIME_ZONES[market];
    const completed = [];
    for (let i = 0; i < Math.min(timestamps.length, closes.length); i++) {
      const timestamp = Number(timestamps[i]) * 1000;
      const price = Number(closes[i]);
      if (!Number.isFinite(timestamp) || !Number.isFinite(price) || price <= 0) continue;
      const sessionDate = dateKey(timestamp, zone);
      if (market === 'US' && !isUsTradingDay(sessionDate)) continue;
      const closeTimestamp = exchangeCloseMs(sessionDate, market);
      // Yahoo daily-bar timestamps are often at session open. The bar is usable only
      // after the exchange's regular close, never merely because its timestamp passed.
      if (closeTimestamp > nowMs) continue;
      completed.push({ price, sessionDate, barTimestampMs: timestamp, closeTimestampMs: closeTimestamp });
    }
    completed.sort((a, b) => a.closeTimestampMs - b.closeTimestampMs);
    if (completed.length < 2) throw new Error('Fewer than two completed regular-session closes were returned.');

    const latest = completed[completed.length - 1];
    const previous = completed[completed.length - 2];
    if (nowMs - latest.closeTimestampMs > maxAgeDays * DAY_MS) {
      throw new Error(`Latest ${market} close is stale (${latest.sessionDate}).`);
    }
    return { latest, previous, market, symbol: result.meta?.symbol || '', source: 'Yahoo Finance chart API' };
  }

  function normalizeTaiwanSessionDate(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{2,4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (!match) return null;
    let year = Number(match[1]);
    if (year < 1911) year += 1911;
    const key = `${year}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
    const parsed = new Date(`${key}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === key ? key : null;
  }

  function parseTwseDailyQuote(json, symbol, expectedDate, retrievedAtMs = Date.now()) {
    if (!/^\d{4,6}$/.test(String(symbol || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate || '')) {
      throw new Error('TWSE fallback request has an invalid symbol or target date.');
    }
    const expectedMonth = expectedDate.slice(0, 7).replace('-', '');
    if (json?.stat !== 'OK' || String(json?.date || '').slice(0, 6) !== expectedMonth ||
        !String(json?.title || '').includes(String(symbol))) {
      throw new Error(`TWSE response does not match ${symbol} for ${expectedDate.slice(0, 7)}.`);
    }
    if (!Number.isFinite(retrievedAtMs) || retrievedAtMs > Date.now() + 1000) {
      throw new Error('TWSE response retrieval timestamp is invalid or future-dated.');
    }
    const fields = json.fields || [];
    const dateIndex = fields.indexOf('日期');
    const closeIndex = fields.indexOf('收盤價');
    if (dateIndex < 0 || closeIndex < 0 || !Array.isArray(json.data)) {
      throw new Error('TWSE daily response is missing date or close fields.');
    }
    const matches = json.data.filter(row => normalizeTaiwanSessionDate(row?.[dateIndex]) === expectedDate);
    if (matches.length !== 1) throw new Error(`TWSE has no unique completed row for ${symbol} on ${expectedDate}.`);
    const rawPrice = String(matches[0][closeIndex] || '').replace(/,/g, '').trim();
    const price = Number(rawPrice);
    const closeTimestampMs = exchangeCloseMs(expectedDate, 'TW');
    if (!Number.isFinite(price) || price <= 0 || closeTimestampMs > retrievedAtMs) {
      throw new Error(`TWSE close for ${symbol} on ${expectedDate} is invalid or not yet complete.`);
    }
    // STOCK_DAY supplies a trading date, not a per-row publication timestamp.
    // Use the official session close as the market timestamp and retain receipt time separately.
    return {
      latest: {
        price, sessionDate: expectedDate, barTimestampMs: closeTimestampMs, closeTimestampMs
      },
      market: 'TW', symbol: `${symbol}.TW`, source: 'TWSE official STOCK_DAY',
      retrievedAtMs
    };
  }

  function parseFugleIndexClose(json, expectedDate, retrievedAtMs = Date.now()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate || '') ||
        !Number.isFinite(retrievedAtMs) || retrievedAtMs <= 0 || retrievedAtMs > Date.now() + 1000) {
      throw new Error('Fugle index request date or retrieval timestamp is invalid.');
    }
    if (json?.symbol !== 'IX0001' || json?.timeframe !== 'D' || !Array.isArray(json?.data)) {
      throw new Error('Fugle response is not daily IX0001 index data.');
    }
    const validRows = json.data.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row?.date || '') && Number.isFinite(Number(row?.close)) && Number(row.close) > 0);
    const matches = validRows.filter(row => row.date === expectedDate);
    if (matches.length !== 1) throw new Error(`Fugle has no unique IX0001 close for ${expectedDate}.`);
    const price = Number(matches[0].close);
    const closeTimestampMs = exchangeCloseMs(expectedDate, 'TW');
    if (!Number.isFinite(price) || price <= 0 || closeTimestampMs > retrievedAtMs) {
      throw new Error(`Fugle IX0001 close for ${expectedDate} is invalid or not yet complete.`);
    }
    const previous = validRows.filter(row => row.date < expectedDate).sort((a, b) => b.date.localeCompare(a.date))[0];
    return {
      market: 'TW', symbol: 'IX0001', source: 'Fugle historical candles',
      latest: { price, sessionDate: expectedDate, barTimestampMs: closeTimestampMs, closeTimestampMs },
      previous: previous ? {
        price: Number(previous.close), sessionDate: previous.date,
        barTimestampMs: exchangeCloseMs(previous.date, 'TW'), closeTimestampMs: exchangeCloseMs(previous.date, 'TW')
      } : null,
      retrievedAtMs
    };
  }

  function parseTaiexTsmcWeight(html, referenceDate, retrievedAtMs = Date.now(), maxAgeDays = 45) {
    if (typeof html !== 'string' || !html.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate || '') ||
        !Number.isFinite(retrievedAtMs) || retrievedAtMs <= 0 || retrievedAtMs > Date.now() + 1000) {
      throw new Error('TAIFEX weight response, reference date, or retrieval timestamp is invalid.');
    }
    const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
    const cellText = value => value.replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/\s+/g, ' ').trim();
    const weightRows = [];
    for (const row of rows) {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => cellText(match[1]));
      const codeIndex = cells.findIndex(value => value === '2330');
      if (codeIndex < 0) continue;
      if (cells[codeIndex + 1] !== '台積電') continue;
      const match = cells[codeIndex + 2]?.match(/^(\d+(?:\.\d+)?)%$/);
      if (match) weightRows.push(Number(match[1]) / 100);
    }
    if (weightRows.length !== 1 || !Number.isFinite(weightRows[0]) || weightRows[0] <= 0 || weightRows[0] > 1) {
      throw new Error('TAIFEX page has no unique valid 2330 TAIEX weight.');
    }
    const text = cellText(html);
    const dateMatch = text.match(/資料日期\s*[:：]?\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (!dateMatch) throw new Error('TAIFEX page is missing its weight date.');
    const sessionDate = `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`;
    const publishedAtMs = Date.parse(`${sessionDate}T12:00:00+08:00`);
    const referenceAtMs = Date.parse(`${referenceDate}T12:00:00+08:00`);
    if (!Number.isFinite(publishedAtMs) || !Number.isFinite(referenceAtMs) || publishedAtMs > referenceAtMs ||
        referenceAtMs - publishedAtMs > maxAgeDays * DAY_MS) {
      throw new Error(`TAIFEX 2330 weight is future-dated or stale (${sessionDate}).`);
    }
    return {
      weight: weightRows[0], sessionDate, retrievedAtMs,
      source: 'TAIFEX TAIEX constituents and market-value weights'
    };
  }

  function validateFxResponse(json, nowMs = Date.now(), maxAgeMs = 96 * 60 * 60 * 1000) {
    const price = Number(json?.rates?.TWD);
    const timestamp = Number(json?.time_last_update_unix) * 1000;
    if (!Number.isFinite(price) || price <= 0) throw new Error('USD/TWD source did not return a valid TWD rate.');
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > nowMs || nowMs - timestamp > maxAgeMs) {
      throw new Error('USD/TWD source timestamp is missing, future-dated, or stale.');
    }
    return { price, timestampMs: timestamp, source: 'exchangerate-api.com' };
  }

  function validateBundle(bundle, nowMs = Date.now()) {
    const required = ['adr', 'tw2330', 'twB', 'twIndex', 'fx'];
    const missing = required.filter(key => !bundle?.[key]);
    if (missing.length) throw new Error(`Incomplete synchronization: ${missing.join(', ')} unavailable.`);
    for (const key of required.slice(0, 4)) {
      const item = bundle[key];
      if (!Number.isFinite(item.latest?.price) || item.latest.price <= 0 ||
          !Number.isFinite(item.latest?.barTimestampMs) || item.latest.closeTimestampMs > nowMs) {
        throw new Error(`Invalid or not-yet-completed price observation: ${key}.`);
      }
    }
    for (const key of ['tw2330', 'twB', 'twIndex']) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bundle[key].latest?.sessionDate || '')) {
        throw new Error(`Invalid Taiwan session date: ${key}.`);
      }
    }
    if (!Number.isFinite(bundle.fx.price) || bundle.fx.price <= 0 ||
        !Number.isFinite(bundle.fx.timestampMs) || bundle.fx.timestampMs > nowMs ||
        nowMs - bundle.fx.timestampMs > 96 * 60 * 60 * 1000) {
      throw new Error('Invalid or stale USD/TWD observation.');
    }
    return true;
  }

  function taiwanSessionsAligned(quotes) {
    const dates = (quotes || []).filter(Boolean).map(item => item.latest?.sessionDate).filter(Boolean);
    return new Set(dates).size <= 1;
  }

  function latestCompletedTaiwanSessionDate(nowMs, calendar) {
    if (!calendar) return null;
    let date = taipeiDateKey(nowMs);
    for (let day = 0; day < 31; day++) {
      if (isTaiwanTradingDay(date, calendar) && exchangeCloseMs(date, 'TW') <= nowMs) return date;
      const previous = new Date(`${date}T12:00:00+08:00`);
      previous.setUTCDate(previous.getUTCDate() - 1);
      date = previous.toISOString().slice(0, 10);
    }
    return null;
  }

  function previousTaiwanTradingDate(targetDate, calendar) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate || '') || !calendar) return null;
    let date = targetDate;
    for (let day = 0; day < 31; day++) {
      const previous = new Date(`${date}T12:00:00+08:00`);
      previous.setUTCDate(previous.getUTCDate() - 1);
      date = previous.toISOString().slice(0, 10);
      if (isTaiwanTradingDay(date, calendar)) return date;
    }
    return null;
  }

  function nextEligibleTaiwanTradingDate(nowMs, calendar) {
    if (!Number.isFinite(nowMs) || !calendar) return null;
    const today = taipeiDateKey(nowMs);
    let date = today;
    if (isTaiwanTradingDay(today, calendar) && nowMs >= zonedTimeToUtc(today, 9, 0, TIME_ZONES.TW)) {
      const nextDay = new Date(`${today}T12:00:00+08:00`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      date = nextDay.toISOString().slice(0, 10);
    }
    for (let day = 0; day < 31; day++) {
      if (isTaiwanTradingDay(date, calendar)) return date;
      const nextDay = new Date(`${date}T12:00:00+08:00`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      date = nextDay.toISOString().slice(0, 10);
    }
    return null;
  }

  function taiwanQuoteFreshness(quote, expectedDate, nowMs = Date.now()) {
    const latest = quote?.latest;
    if (!expectedDate || !Number.isFinite(latest?.price) || latest.price <= 0 ||
        !Number.isFinite(latest?.barTimestampMs) || !Number.isFinite(latest?.closeTimestampMs) ||
        latest.closeTimestampMs > nowMs || !/^\d{4}-\d{2}-\d{2}$/.test(latest.sessionDate || '')) {
      return 'UNAVAILABLE';
    }
    if (latest.sessionDate === expectedDate) return 'FRESH';
    return latest.sessionDate < expectedDate ? 'STALE' : 'UNAVAILABLE';
  }

  function resolvePrice(manualValue, manualTimestamp, automaticValue, automaticTimestamp) {
    if (manualValue !== '' && manualValue !== null && manualValue !== undefined) {
      const price = Number(manualValue);
      if (!Number.isFinite(price) || price <= 0) return null;
      return { price, timestampMs: manualTimestamp || null, source: '手動輸入' };
    }
    if (!Number.isFinite(automaticValue) || automaticValue <= 0) return null;
    return { price: automaticValue, timestampMs: automaticTimestamp || null, source: '自動來源' };
  }

  function formatPriceInput(value, kind = 'price') {
    if (value === '' || value === null || value === undefined) return '';
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return String(value);
    if (kind === 'fx') return number.toFixed(2);
    return number.toFixed(2);
  }

  function baseline(prices) {
    const result = {
      tw2330: roundToTick(prices?.tw2330, 'stock'),
      twB: roundToTick(prices?.twB, 'etf'),
      ix0001: Number.isFinite(Number(prices?.ix0001)) && Number(prices.ix0001) > 0
        ? Number(Number(prices.ix0001).toFixed(2)) : null
    };
    return Object.values(result).some(Number.isFinite) ? result : null;
  }

  function verifiedTaiwanBaseline(prices, freshness) {
    const accepted = {};
    for (const key of ['tw2330', 'twB', 'ix0001']) {
      if (freshness?.[key] === 'FRESH' || freshness?.[key] === 'MANUAL') accepted[key] = prices?.[key];
    }
    return baseline(accepted);
  }

  function tickSize(price, type) {
    if (type === 'etf') return price < 50 ? 0.01 : 0.05;
    if (price < 10) return 0.01;
    if (price < 50) return 0.05;
    if (price < 100) return 0.1;
    if (price < 500) return 0.5;
    if (price < 1000) return 1;
    return 5;
  }

  function roundToTick(value, type) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    let tick = tickSize(n, type);
    let rounded = Math.round((n + Number.EPSILON) / tick) * tick;
    // Re-evaluate around price-band boundaries so the returned value is legal in its band.
    for (let i = 0; i < 3; i++) {
      const nextTick = tickSize(rounded, type);
      if (nextTick === tick) break;
      tick = nextTick;
      rounded = Math.round((n + Number.EPSILON) / tick) * tick;
    }
    const decimals = tick < 0.1 ? 2 : tick < 1 ? 1 : 0;
    return Number(rounded.toFixed(decimals));
  }

  function parseFubonTaiwan50Exposure(html, retrievedAtMs = Date.now()) {
    if (typeof html !== 'string' || !html.trim()) throw new Error('Fubon 006208 holdings page is empty.');
    if (!Number.isFinite(retrievedAtMs) || retrievedAtMs <= 0 || retrievedAtMs > Date.now() + 1000) {
      throw new Error('Fubon holdings retrieval timestamp is invalid or future-dated.');
    }
    const visibleText = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    const reportText = visibleText.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ');
    const dateMatch = reportText.match(/資料日期\s*[:：]\s*(\d{4})\s*[/-]\s*(\d{1,2})\s*[/-]\s*(\d{1,2})/);
    if (!dateMatch) throw new Error('Fubon holdings report date was not found.');
    const sessionDate = `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`;
    const parsedDate = new Date(`${sessionDate}T00:00:00Z`);
    if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== sessionDate) {
      throw new Error('Fubon holdings report date is invalid.');
    }
    const rows = [...visibleText.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const matches = [];
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(cell => cell[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').trim());
      if (cells[0] !== '2330') continue;
      const weightText = cells[cells.length - 1].replace(/[% ,]/g, '');
      const percent = Number(weightText);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) continue;
      matches.push(percent / 100);
    }
    if (matches.length !== 1) throw new Error('Fubon holdings page has no unique valid 2330 weight.');
    return {
      weight: matches[0], sessionDate, retrievedAtMs,
      source: 'Fubon ETF official 006208 assets page'
    };
  }

  function estimateOpeningPrices(options = {}) {
    const { nowMs = Date.now(), adr, quotes, freshness, exposure, indexWeight, calendar } = options;
    const targetDate = options.targetDate || nextEligibleTaiwanTradingDate(nowMs, calendar);
    const result = { tw2330: null, twB: null, ix0001: null };
    const validTargetDate = /^\d{4}-\d{2}-\d{2}$/.test(targetDate || '');
    const targetOpenMs = validTargetDate
      ? zonedTimeToUtc(targetDate, 9, 0, TIME_ZONES.TW) : NaN;
    if (!calendar || !validTargetDate || targetDate !== nextEligibleTaiwanTradingDate(nowMs, calendar) ||
        !isTaiwanTradingDay(targetDate, calendar) ||
        nowMs >= targetOpenMs) {
      const reason = 'A new estimate can be captured only for the next eligible Taiwan session before it opens.';
      result.tw2330 = { status: 'UNAVAILABLE', reason };
      result.twB = { status: 'UNAVAILABLE', reason };
      result.ix0001 = { status: 'UNAVAILABLE', reason };
      return result;
    }
    const previousTaiwanDate = previousTaiwanTradingDate(targetDate, calendar);
    if (!previousTaiwanDate) {
      const reason = 'The target session has no verified previous Taiwan trading close.';
      result.tw2330 = { status: 'UNAVAILABLE', reason };
      result.twB = { status: 'UNAVAILABLE', reason };
      result.ix0001 = { status: 'UNAVAILABLE', reason };
      return result;
    }
    const previousTaiwanCloseMs = exchangeCloseMs(previousTaiwanDate, 'TW');
    const adrLatest = adr?.latest;
    const adrPrevious = adr?.previous;
    const adrSessionsValid = adr?.market === 'US' &&
      /^\d{4}-\d{2}-\d{2}$/.test(adrLatest?.sessionDate || '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(adrPrevious?.sessionDate || '') &&
      isUsTradingDay(adrLatest.sessionDate) && isUsTradingDay(adrPrevious.sessionDate) &&
      adrLatest.closeTimestampMs === exchangeCloseMs(adrLatest.sessionDate, 'US') &&
      adrPrevious.closeTimestampMs === exchangeCloseMs(adrPrevious.sessionDate, 'US');
    const adrReturn = adrSessionsValid && adrLatest?.price > 0 && adrPrevious?.price > 0 &&
      Number.isFinite(adrLatest.closeTimestampMs) && Number.isFinite(adrPrevious.closeTimestampMs) &&
      adrPrevious.closeTimestampMs < adrLatest.closeTimestampMs && adrLatest.closeTimestampMs <= nowMs
      ? adrLatest.price / adrPrevious.price - 1 : null;
    const validAdr = Number.isFinite(adrReturn);
    const makeEstimate = (key, expectedSymbol, roundPrice, factor = 1) => {
      const quote = quotes?.[key];
      const latest = quote?.latest;
      if (quote?.symbol !== expectedSymbol || freshness?.[key] !== 'FRESH' ||
          !Number.isFinite(latest?.price) || latest.price <= 0 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(latest.sessionDate || '') ||
          !Number.isFinite(latest.closeTimestampMs) || latest.closeTimestampMs > nowMs ||
          latest.closeTimestampMs !== exchangeCloseMs(latest.sessionDate, 'TW') ||
          latest.sessionDate !== previousTaiwanDate || latest.closeTimestampMs !== previousTaiwanCloseMs) {
        return { status: 'UNAVAILABLE', reason: 'Previous Taiwan close is missing, stale, or not session-matched.' };
      }
      if (!validAdr || adrLatest.closeTimestampMs <= previousTaiwanCloseMs ||
          adrLatest.closeTimestampMs >= targetOpenMs || adrLatest.closeTimestampMs > nowMs) {
        return { status: 'UNAVAILABLE', reason: 'A completed TSM ADR session after the Taiwan baseline is required.' };
      }
      const predictedReturn = adrReturn * factor;
      const unroundedPrice = latest.price * (1 + predictedReturn);
      const estimatedOpen = roundPrice(unroundedPrice);
      if (!Number.isFinite(estimatedOpen)) return { status: 'UNAVAILABLE', reason: 'Forecast price is invalid.' };
      return {
        status: 'ESTIMATE', targetDate, previousClose: latest.price, previousCloseDate: latest.sessionDate,
        previousCloseTimestampMs: latest.closeTimestampMs, previousCloseBarTimestampMs: latest.barTimestampMs,
        capturedAtMs: nowMs, adrReturn, factor,
        predictedReturn, changePercent: predictedReturn * 100, estimatedOpen,
        adrLatest, adrPrevious, adrSource: adr.source || 'Yahoo Finance chart API'
      };
    };
    result.tw2330 = makeEstimate('tw2330', '2330.TW', value => roundToTick(value, 'stock'));
    const etf = makeEstimate('twB', '006208.TW', value => roundToTick(value, 'etf'), exposure?.weight);
    if (!Number.isFinite(exposure?.weight) || exposure.weight <= 0 || exposure.weight > 1 ||
        exposure.sessionDate !== previousTaiwanDate ||
        !Number.isFinite(exposure.retrievedAtMs) || exposure.retrievedAtMs > nowMs) {
      result.twB = { status: 'UNAVAILABLE', reason: 'A valid 006208 TSMC weight for the previous-close session is unavailable.' };
    } else if (etf.status === 'ESTIMATE') {
      result.twB = { ...etf, exposureDate: exposure.sessionDate, exposureWeight: exposure.weight,
        exposureRetrievedAtMs: exposure.retrievedAtMs, exposureSource: exposure.source };
    } else result.twB = etf;
    const index = makeEstimate('twIndex', 'IX0001', value => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? Number(number.toFixed(2)) : null;
    }, indexWeight?.weight);
    const referenceAtMs = Date.parse(`${previousTaiwanDate}T12:00:00+08:00`);
    const weightAtMs = Date.parse(`${indexWeight?.sessionDate || ''}T12:00:00+08:00`);
    if (!Number.isFinite(indexWeight?.weight) || indexWeight.weight <= 0 || indexWeight.weight > 1 ||
        indexWeight.sessionDate > previousTaiwanDate || !Number.isFinite(indexWeight.retrievedAtMs) ||
        indexWeight.retrievedAtMs > nowMs || !Number.isFinite(referenceAtMs) || !Number.isFinite(weightAtMs) ||
        referenceAtMs - weightAtMs > 45 * DAY_MS) {
      result.ix0001 = { status: 'UNAVAILABLE', reason: 'A valid, dated TSMC weight for TAIEX is unavailable or stale.' };
    } else if (index.status === 'ESTIMATE') {
      result.ix0001 = { ...index, indexWeight: indexWeight.weight, indexWeightDate: indexWeight.sessionDate,
        indexWeightRetrievedAtMs: indexWeight.retrievedAtMs, indexWeightSource: indexWeight.source };
    } else result.ix0001 = index;
    return result;
  }

  function validateOpeningForecastSnapshot(snapshot) {
    const targetDate = snapshot?.targetDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate || '') || !Number.isFinite(snapshot?.capturedAtMs) ||
        snapshot.capturedAtMs >= zonedTimeToUtc(targetDate, 9, 0, TIME_ZONES.TW) ||
        !snapshot?.forecasts || !['tw2330', 'twB', 'ix0001'].some(key => snapshot.forecasts[key]?.status === 'ESTIMATE')) return false;
    for (const key of ['tw2330', 'twB', 'ix0001']) {
      const item = snapshot.forecasts[key];
      if (item?.status !== 'ESTIMATE') continue;
      if (item.targetDate !== targetDate || !Number.isFinite(item.estimatedOpen) || item.estimatedOpen <= 0 ||
          !Number.isFinite(item.capturedAtMs) || item.capturedAtMs >= zonedTimeToUtc(targetDate, 9, 0, TIME_ZONES.TW) ||
          !Number.isFinite(item.previousClose) || item.previousClose <= 0 ||
          !Number.isFinite(item.previousCloseTimestampMs) ||
          !Number.isFinite(item.adrLatest?.closeTimestampMs) ||
          item.adrLatest.closeTimestampMs <= item.previousCloseTimestampMs ||
          item.adrLatest.closeTimestampMs > item.capturedAtMs ||
          item.adrLatest.closeTimestampMs >= zonedTimeToUtc(targetDate, 9, 0, TIME_ZONES.TW)) return false;
      if (key === 'twB' && (item.exposureDate !== item.previousCloseDate ||
          !Number.isFinite(item.exposureWeight) || item.exposureWeight <= 0 || item.exposureWeight > 1)) return false;
      if (key === 'ix0001' && (!/^\d{4}-\d{2}-\d{2}$/.test(item.indexWeightDate || '') ||
          item.indexWeightDate > item.previousCloseDate ||
          !Number.isFinite(item.indexWeight) || item.indexWeight <= 0 || item.indexWeight > 1 ||
          !Number.isFinite(item.indexWeightRetrievedAtMs) || item.indexWeightRetrievedAtMs > item.capturedAtMs)) return false;
    }
    return true;
  }

  function mergeOpeningForecastSnapshot(existing, candidate) {
    if (!validateOpeningForecastSnapshot(candidate)) return null;
    if (!validateOpeningForecastSnapshot(existing) || existing.targetDate < candidate.targetDate) return candidate;
    if (existing.targetDate > candidate.targetDate) return existing;
    const forecasts = { ...existing.forecasts };
    let changed = false;
    for (const key of ['tw2330', 'twB', 'ix0001']) {
      if (forecasts[key]?.status !== 'ESTIMATE' && candidate.forecasts[key]?.status === 'ESTIMATE') {
        forecasts[key] = candidate.forecasts[key];
        changed = true;
      }
    }
    if (!changed) return existing;
    const merged = { ...existing, forecasts };
    return validateOpeningForecastSnapshot(merged) ? merged : null;
  }

  function taipeiDateKey(timestamp) { return dateKey(timestamp, TIME_ZONES.TW); }

  function parseTaiwanClosedDates(json) {
    let rows;
    if (Array.isArray(json)) {
      rows = json.map(row => ({
        date: row?.Date || row?.date || row?.日期,
        text: [row?.Name, row?.Description, row?.名稱, row?.說明].filter(Boolean).join(' ')
      }));
    } else if (Array.isArray(json?.data)) {
      const fields = json.fields || [];
      const dateIndex = fields.indexOf('日期');
      const textIndexes = fields.map((field, index) => /名稱|說明/.test(field) ? index : -1).filter(i => i >= 0);
      if (dateIndex < 0 || textIndexes.length === 0) throw new Error('TWSE holiday calendar schema is unrecognized.');
      rows = json.data.map(row => ({ date: row?.[dateIndex], text: textIndexes.map(i => String(row?.[i] || '')).join(' ') }));
    } else {
      throw new Error('TWSE holiday calendar response has no data rows.');
    }
    const closed = new Set();
    const open = new Set();
    for (const row of rows) {
      const rawDate = String(row.date || '').trim();
      let match = rawDate.match(/^(\d{3,4})[/-](\d{1,2})[/-](\d{1,2})$/);
      if (!match) {
        const compact = rawDate.match(/^(\d{3,4})(\d{2})(\d{2})$/);
        if (compact) match = compact;
      }
      if (!match) continue;
      let year = Number(match[1]);
      if (year < 1900) year += 1911;
      const key = `${year}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
      if (/補行交易|開市|開始交易|最後交易日|交易日/.test(row.text)) open.add(key);
      else if (/無交易|休市|放假|停止交易|不交易|補假/.test(row.text)) closed.add(key);
    }
    return { closed, open };
  }

  function isTaiwanTradingDay(date, calendar) {
    const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay();
    if (calendar?.open?.has(date)) return true;
    if (weekday === 0 || weekday === 6) return false;
    if (!calendar) return false;
    return !calendar.closed.has(date);
  }

  const api = {
    TIME_ZONES, dateKey, zonedTimeToUtc, exchangeCloseMs, usMarketHolidays, isUsTradingDay, parseYahooChart,
    normalizeTaiwanSessionDate, parseTwseDailyQuote, parseFugleIndexClose, parseTaiexTsmcWeight,
    validateFxResponse, validateBundle, taiwanSessionsAligned, resolvePrice, formatPriceInput, baseline, verifiedTaiwanBaseline, tickSize, roundToTick,
    latestCompletedTaiwanSessionDate, taiwanQuoteFreshness, previousTaiwanTradingDate, nextEligibleTaiwanTradingDate,
    parseFubonTaiwan50Exposure, estimateOpeningPrices, validateOpeningForecastSnapshot,
    mergeOpeningForecastSnapshot,
    taipeiDateKey,
    parseTaiwanClosedDates, isTaiwanTradingDay
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TSMCMarketData = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
