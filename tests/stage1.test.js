const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Core = require('../market-data.js');

const utc = value => Date.parse(`${value}Z`);
const yahoo = (symbol, rows) => ({ chart: { result: [{
  meta: { symbol }, timestamp: rows.map(row => utc(row[0]) / 1000),
  indicators: { quote: [{ close: rows.map(row => row[1]) }] }
}] } });

function forecastForSessions({ nowMs, targetDate, previousTaiwanDate, adrPreviousDate, adrLatestDate, calendar }) {
  const taiwanClose = Core.exchangeCloseMs(previousTaiwanDate, 'TW');
  const adr = {
    market: 'US', source: 'Yahoo Finance chart API',
    previous: { price: 300, sessionDate: adrPreviousDate, closeTimestampMs: Core.exchangeCloseMs(adrPreviousDate, 'US') },
    latest: { price: 315, sessionDate: adrLatestDate, closeTimestampMs: Core.exchangeCloseMs(adrLatestDate, 'US') }
  };
  const quotes = {
    tw2330: { symbol: '2330.TW', latest: { price: 2000, sessionDate: previousTaiwanDate, barTimestampMs: taiwanClose, closeTimestampMs: taiwanClose } },
    twB: { symbol: '006208.TW', latest: { price: 250, sessionDate: previousTaiwanDate, barTimestampMs: taiwanClose, closeTimestampMs: taiwanClose } },
    twIndex: { symbol: 'IX0001', latest: { price: 28000, sessionDate: previousTaiwanDate, barTimestampMs: taiwanClose, closeTimestampMs: taiwanClose } }
  };
  const exposure = { weight: 0.572285, sessionDate: previousTaiwanDate, retrievedAtMs: nowMs - 1000 };
  const indexWeight = { weight: 0.416361, sessionDate: previousTaiwanDate, retrievedAtMs: nowMs - 1000, source: 'TAIFEX TAIEX constituents and market-value weights' };
  const freshness = {
    tw2330: Core.taiwanQuoteFreshness(quotes.tw2330, previousTaiwanDate, nowMs),
    twB: Core.taiwanQuoteFreshness(quotes.twB, previousTaiwanDate, nowMs),
    twIndex: Core.taiwanQuoteFreshness(quotes.twIndex, previousTaiwanDate, nowMs)
  };
  return Core.estimateOpeningPrices({ nowMs, targetDate, adr, quotes, freshness, exposure, indexWeight, calendar });
}

test('DST-aware US close times change from EST to EDT', () => {
  assert.equal(Core.exchangeCloseMs('2026-03-06', 'US'), utc('2026-03-06T21:00:00'));
  assert.equal(Core.exchangeCloseMs('2026-03-09', 'US'), utc('2026-03-09T20:00:00'));
});

test('ADR and Taiwan quotes align to completed exchange sessions at Taiwan 08:45 without look-ahead', () => {
  const cutoff = utc('2026-03-09T00:45:00'); // 08:45 Asia/Taipei, Monday
  const adr = Core.parseYahooChart(yahoo('TSM', [
    ['2026-03-05T14:30:00', 295], ['2026-03-06T14:30:00', 300],
    ['2026-03-09T13:30:00', 315]
  ]), 'US', cutoff);
  const tw = Core.parseYahooChart(yahoo('2330.TW', [
    ['2026-03-05T01:00:00', 1900], ['2026-03-06T01:00:00', 1950],
    ['2026-03-09T01:00:00', 1990]
  ]), 'TW', cutoff);
  assert.equal(adr.latest.sessionDate, '2026-03-06');
  assert.equal(tw.latest.sessionDate, '2026-03-06');
  assert.ok(adr.latest.closeTimestampMs <= cutoff);
  assert.ok(tw.latest.closeTimestampMs <= cutoff);
  assert.equal((adr.latest.price / 5) * 32.5, 1950);
  assert.equal(Core.baseline({ tw2330: tw.latest.price, twB: 50.05, ix0001: 28000.126 }).tw2330, 1950);
  assert.equal(Core.baseline({ tw2330: 2000, twB: 250, ix0001: 28000.126 }).ix0001, 28000.13);
});

test('US holidays and TWSE holiday rows are excluded while an announced make-up day is retained', () => {
  assert.equal(Core.isUsTradingDay('2026-07-03'), false); // Independence Day observed
  assert.equal(Core.isUsTradingDay('2026-11-26'), false); // Thanksgiving
  assert.equal(Core.isUsTradingDay('2026-11-27'), true);
  const calendar = Core.parseTaiwanClosedDates({
    fields: ['日期', '名稱', '說明'],
    data: [
      ['115/05/01', '勞動節', '市場休市'],
      ['115/05/09', '補行交易', '因連續假期補行交易']
    ]
  });
  assert.equal(Core.isTaiwanTradingDay('2026-05-01', calendar), false);
  assert.equal(Core.isTaiwanTradingDay('2026-05-09', calendar), true);
  assert.equal(Core.isTaiwanTradingDay('2026-05-04', null), false);
});

test('next eligible Taiwan session keeps normal weekday behavior and skips open or closed days', () => {
  const calendar = { closed: new Set(['2026-11-02']), open: new Set() };
  assert.equal(Core.nextEligibleTaiwanTradingDate(utc('2026-03-09T00:45:00'), calendar), '2026-03-09');
  assert.equal(Core.nextEligibleTaiwanTradingDate(utc('2026-03-09T01:05:00'), calendar), '2026-03-10');
  assert.equal(Core.nextEligibleTaiwanTradingDate(utc('2026-10-31T02:00:00'), calendar), '2026-11-03');
  assert.equal(Core.nextEligibleTaiwanTradingDate(utc('2026-11-01T02:00:00'), calendar), '2026-11-03');
});

test('Friday 2026-10-30 US close supports a Saturday forecast for Taiwan Monday 2026-11-02', () => {
  const calendar = { closed: new Set(), open: new Set() };
  const nowMs = utc('2026-10-31T02:00:00'); // Saturday 10:00 Taiwan, after Friday US close
  const targetDate = Core.nextEligibleTaiwanTradingDate(nowMs, calendar);
  assert.equal(targetDate, '2026-11-02');
  assert.equal(Core.previousTaiwanTradingDate(targetDate, calendar), '2026-10-30');
  const forecasts = forecastForSessions({
    nowMs, targetDate, previousTaiwanDate: '2026-10-30',
    adrPreviousDate: '2026-10-29', adrLatestDate: '2026-10-30', calendar
  });
  assert.equal(forecasts.tw2330.status, 'ESTIMATE');
  assert.equal(forecasts.tw2330.targetDate, '2026-11-02');
  assert.equal(forecasts.tw2330.previousCloseDate, '2026-10-30');
  assert.equal(forecasts.twB.status, 'ESTIMATE');
  assert.equal(forecasts.twB.exposureDate, '2026-10-30');
  assert.equal(forecasts.ix0001.status, 'ESTIMATE');
  assert.equal(forecasts.ix0001.targetDate, '2026-11-02');
  assert.equal(forecasts.ix0001.previousCloseDate, '2026-10-30');
  assert.equal(forecasts.ix0001.indexWeightDate, '2026-10-30');
  assert.equal(forecasts.ix0001.estimatedOpen, 28582.91);
  const sundayNowMs = utc('2026-11-01T02:00:00');
  assert.equal(Core.nextEligibleTaiwanTradingDate(sundayNowMs, calendar), '2026-11-02');
  assert.equal(forecastForSessions({
    nowMs: sundayNowMs, targetDate: '2026-11-02', previousTaiwanDate: '2026-10-30',
    adrPreviousDate: '2026-10-29', adrLatestDate: '2026-10-30', calendar
  }).tw2330.status, 'ESTIMATE');

  const staleAdr = forecastForSessions({
    nowMs, targetDate, previousTaiwanDate: '2026-10-30',
    adrPreviousDate: '2026-10-28', adrLatestDate: '2026-10-29', calendar
  });
  assert.equal(staleAdr.tw2330.status, 'UNAVAILABLE');
  const mismatchedBaseline = forecastForSessions({
    nowMs, targetDate, previousTaiwanDate: '2026-10-29',
    adrPreviousDate: '2026-10-29', adrLatestDate: '2026-10-30', calendar
  });
  assert.equal(mismatchedBaseline.tw2330.status, 'UNAVAILABLE');
});

test('Taiwan holiday moves weekend forecast to the next session while retaining Friday baseline', () => {
  const calendar = { closed: new Set(['2026-11-02']), open: new Set() };
  const nowMs = utc('2026-10-31T02:00:00');
  const targetDate = Core.nextEligibleTaiwanTradingDate(nowMs, calendar);
  assert.equal(targetDate, '2026-11-03');
  assert.equal(Core.previousTaiwanTradingDate(targetDate, calendar), '2026-10-30');
  const forecasts = forecastForSessions({
    nowMs, targetDate, previousTaiwanDate: '2026-10-30',
    adrPreviousDate: '2026-10-29', adrLatestDate: '2026-10-30', calendar
  });
  assert.equal(forecasts.tw2330.status, 'ESTIMATE');
  assert.equal(forecasts.tw2330.targetDate, '2026-11-03');
  assert.equal(forecasts.ix0001.status, 'ESTIMATE');
});

test('US Thanksgiving stale ADR close is rejected; first later completed ADR session can forecast', () => {
  const calendar = { closed: new Set(), open: new Set() };
  assert.equal(Core.isUsTradingDay('2026-11-26'), false);
  const beforeUsReopens = utc('2026-11-27T00:30:00'); // Friday 08:30 Taiwan
  assert.equal(Core.nextEligibleTaiwanTradingDate(beforeUsReopens, calendar), '2026-11-27');
  const stale = forecastForSessions({
    nowMs: beforeUsReopens, targetDate: '2026-11-27', previousTaiwanDate: '2026-11-26',
    adrPreviousDate: '2026-11-24', adrLatestDate: '2026-11-25', calendar
  });
  assert.equal(stale.tw2330.status, 'UNAVAILABLE');

  const afterFridayUsClose = utc('2026-11-28T01:00:00');
  const targetDate = Core.nextEligibleTaiwanTradingDate(afterFridayUsClose, calendar);
  assert.equal(targetDate, '2026-11-30');
  const fresh = forecastForSessions({
    nowMs: afterFridayUsClose, targetDate, previousTaiwanDate: '2026-11-27',
    adrPreviousDate: '2026-11-25', adrLatestDate: '2026-11-27', calendar
  });
  assert.equal(fresh.tw2330.status, 'ESTIMATE');
  assert.equal(fresh.ix0001.status, 'ESTIMATE');
});

test('saved weekend forecast remains valid and immutable after its target opening', () => {
  const calendar = { closed: new Set(), open: new Set() };
  const capturedAtMs = utc('2026-10-31T02:00:00');
  const estimates = forecastForSessions({
    nowMs: capturedAtMs, targetDate: '2026-11-02', previousTaiwanDate: '2026-10-30',
    adrPreviousDate: '2026-10-29', adrLatestDate: '2026-10-30', calendar
  });
  const saved = { targetDate: '2026-11-02', capturedAtMs, forecasts: estimates };
  assert.equal(Core.validateOpeningForecastSnapshot(saved), true);

  const afterOpenMs = utc('2026-11-02T01:05:00');
  const afterOpenEstimate = forecastForSessions({
    nowMs: afterOpenMs, targetDate: '2026-11-02', previousTaiwanDate: '2026-10-30',
    adrPreviousDate: '2026-10-29', adrLatestDate: '2026-10-30', calendar
  });
  assert.equal(afterOpenEstimate.tw2330.status, 'UNAVAILABLE');
  assert.equal(afterOpenEstimate.ix0001.status, 'UNAVAILABLE');
  assert.equal(Core.validateOpeningForecastSnapshot(saved), true);
  const laterCandidate = { ...saved, forecasts: {
    ...saved.forecasts,
    tw2330: { ...saved.forecasts.tw2330, estimatedOpen: saved.forecasts.tw2330.estimatedOpen + 100 }
  } };
  assert.equal(Core.mergeOpeningForecastSnapshot(saved, laterCandidate), saved);
  assert.equal(saved.forecasts.tw2330.targetDate, '2026-11-02');
  assert.equal(saved.forecasts.ix0001.targetDate, '2026-11-02');
});

test('TWSE OpenAPI live response shape and ROC compact dates parse correctly', () => {
  // These row shapes and dates were returned by the live TWSE OpenAPI schedule for ROC 115.
  const calendar = Core.parseTaiwanClosedDates([
    { Name: '中華民國開國紀念日', Date: '1150101', Description: '依規定放假1日。' },
    { Name: '國曆新年開始交易日', Date: '1150102', Description: '國曆新年開始交易。' },
    { Name: '市場無交易，僅辦理結算交割作業', Date: '1150212', Description: '' },
    { Name: '農曆春節後開始交易日', Date: '1150223', Description: '農曆春節後開始交易。' }
  ]);
  assert.equal(Core.isTaiwanTradingDay('2026-01-01', calendar), false);
  assert.equal(Core.isTaiwanTradingDay('2026-01-02', calendar), true);
  assert.equal(Core.isTaiwanTradingDay('2026-02-12', calendar), false);
  assert.equal(Core.isTaiwanTradingDay('2026-02-23', calendar), true);
});

test('missing, unfinished, invalid, and stale ADR observations are rejected', () => {
  const cutoff = utc('2026-03-09T00:45:00');
  assert.throws(() => Core.parseYahooChart({ chart: { result: [] } }, 'US', cutoff), /missing/);
  assert.throws(() => Core.parseYahooChart(yahoo('TSM', [
    ['2026-03-06T14:30:00', 300], ['2026-03-09T13:30:00', 310]
  ]), 'US', cutoff), /Fewer than two/);
  assert.throws(() => Core.parseYahooChart(yahoo('TSM', [
    ['2026-02-20T14:30:00', 300], ['2026-02-23T14:30:00', 310]
  ]), 'US', cutoff), /stale/);
  assert.throws(() => Core.parseYahooChart(yahoo('TSM', [
    ['2026-03-05T14:30:00', 295], ['2026-03-06T14:30:00', 0],
    ['2026-03-09T13:30:00', 310]
  ]), 'US', cutoff), /Fewer than two/);
});

test('partial synchronization and stale or failed FX cannot be reported as complete', () => {
  const now = utc('2026-03-09T00:45:00');
  const quote = { latest: { price: 100, sessionDate: '2026-03-06', barTimestampMs: now - 1, closeTimestampMs: now - 1 } };
  const fx = Core.validateFxResponse({ rates: { TWD: 32.5 }, time_last_update_unix: (now - 1000) / 1000 }, now);
  const full = { adr: quote, tw2330: quote, twB: quote, twIndex: quote, fx };
  assert.equal(Core.validateBundle(full, now), true);
  assert.throws(() => Core.validateBundle({ ...full, fx: null }, now), /Incomplete synchronization/);
  assert.throws(() => Core.validateFxResponse({ rates: { TWD: 32.5 } }, now), /timestamp/);
  assert.throws(() => Core.validateFxResponse({ rates: { TWD: 32.5 }, time_last_update_unix: 1 }, now), /stale/);
});

test('Taiwan quotes from different sessions are validated per symbol', () => {
  const now = utc('2026-03-09T00:45:00');
  const quote = date => ({ latest: {
    price: 100, sessionDate: date, barTimestampMs: now - 1, closeTimestampMs: now - 1
  } });
  const fx = { price: 32.5, timestampMs: now - 1000 };
  const bundle = { adr: quote('2026-03-06'), tw2330: quote('2026-03-06'),
    twB: quote('2026-03-05'), twIndex: quote('2026-03-05'), fx };
  assert.equal(Core.taiwanSessionsAligned([bundle.tw2330, bundle.twB, bundle.twIndex]), false);
  assert.equal(Core.validateBundle(bundle, now), true);
  assert.equal(Core.taiwanQuoteFreshness(bundle.tw2330, '2026-03-06', now), 'FRESH');
  assert.equal(Core.taiwanQuoteFreshness(bundle.twB, '2026-03-06', now), 'STALE');
  assert.equal(Core.taiwanSessionsAligned([quote('2026-03-06'), quote('2026-03-06')]), true);
});

test('mixed fresh and stale Taiwan closes retain only the independently verified 2330 baseline', () => {
  const now = utc('2026-10-30T02:07:00');
  const calendar = { closed: new Set(), open: new Set() };
  const expected = Core.latestCompletedTaiwanSessionDate(now, calendar);
  const quote = (date, price) => ({ latest: {
    price, sessionDate: date, barTimestampMs: Core.exchangeCloseMs(date, 'TW') - 60_000,
    closeTimestampMs: Core.exchangeCloseMs(date, 'TW')
  } });
  const tw2330 = quote('2026-10-29', 2415);
  const twB = quote('2026-10-28', 249.05);
  const twIndex = quote('2026-10-29', 28000.25);

  assert.equal(expected, '2026-10-29');
  assert.equal(Core.taiwanQuoteFreshness(tw2330, expected, now), 'FRESH');
  assert.equal(Core.taiwanQuoteFreshness(twB, expected, now), 'STALE');
  assert.equal(Core.taiwanQuoteFreshness(twIndex, expected, now), 'FRESH');
  const baseline = Core.verifiedTaiwanBaseline({
    tw2330: tw2330.latest.price, twB: twB.latest.price, ix0001: twIndex.latest.price
  }, { tw2330: 'FRESH', twB: 'STALE', ix0001: 'FRESH' });
  assert.deepEqual(baseline, { tw2330: 2415, twB: null, ix0001: 28000.25 });
  assert.equal(Core.taiwanQuoteFreshness(null, expected, now), 'UNAVAILABLE');
});

test('delayed Yahoo ETF close uses a matching official TWSE session row as fallback', () => {
  const now = utc('2026-10-30T02:07:00');
  const expected = '2026-10-29';
  const yahooQuote = Core.parseYahooChart(yahoo('006208.TW', [
    ['2026-10-27T01:00:00', 247.1],
    ['2026-10-28T01:00:00', 249.05],
    ['2026-10-29T01:00:00', null],
    ['2026-10-30T01:00:00', 239.2]
  ]), 'TW', now, 14);
  assert.equal(yahooQuote.latest.sessionDate, '2026-10-28');
  assert.equal(Core.taiwanQuoteFreshness(yahooQuote, expected, now), 'STALE');

  const retrievedAt = Core.exchangeCloseMs(expected, 'TW') + 60_000;
  const twseQuote = Core.parseTwseDailyQuote({
    stat: 'OK', date: '20261001', title: '115年10月 006208 富邦台50 各日成交資訊',
    fields: ['日期', '成交股數', '開盤價', '最高價', '最低價', '收盤價'],
    data: [['115/10/28', '1,000', '248.60', '250.00', '247.00', '249.05'],
      ['115/10/29', '2,000', '248.45', '249.00', '244.60', '245.75']]
  }, '006208', expected, retrievedAt);
  assert.equal(twseQuote.latest.price, 245.75);
  assert.equal(twseQuote.latest.sessionDate, expected);
  assert.equal(twseQuote.latest.closeTimestampMs, Core.exchangeCloseMs(expected, 'TW'));
  assert.equal(twseQuote.retrievedAtMs, retrievedAt);
  assert.equal(twseQuote.source, 'TWSE official STOCK_DAY');
  assert.equal(Core.taiwanQuoteFreshness(twseQuote, expected, retrievedAt), 'FRESH');
});

test('TWSE ETF fallback rejects mismatched symbol, month, date, invalid price, and pre-close retrieval', () => {
  const date = '2026-10-29';
  const retrievedAt = Core.exchangeCloseMs(date, 'TW') + 60_000;
  const body = {
    stat: 'OK', date: '20261001', title: '115年10月 006208 富邦台50',
    fields: ['日期', '收盤價'], data: [['115/10/29', '245.75']]
  };
  assert.throws(() => Core.parseTwseDailyQuote({ ...body, title: '115年10月 2330 台積電' }, '006208', date, retrievedAt), /does not match/);
  assert.throws(() => Core.parseTwseDailyQuote({ ...body, date: '20260901' }, '006208', date, retrievedAt), /does not match/);
  assert.throws(() => Core.parseTwseDailyQuote({ ...body, data: [['115/10/28', '245.75']] }, '006208', date, retrievedAt), /no unique completed row/);
  assert.throws(() => Core.parseTwseDailyQuote({ ...body, data: [['115/10/29', '—']] }, '006208', date, retrievedAt), /invalid or not yet complete/);
  assert.throws(() => Core.parseTwseDailyQuote(body, '006208', date, Core.exchangeCloseMs(date, 'TW') - 1), /invalid or not yet complete/);
});

test('Fugle returns only the exact dated IX0001 daily close', () => {
  const retrievedAt = utc('2026-10-31T02:00:00');
  const body = { symbol: 'IX0001', timeframe: 'D', data: [
    { date: '2026-10-29', close: 27900 }, { date: '2026-10-30', close: 28012.34 }
  ] };
  const quote = Core.parseFugleIndexClose(body, '2026-10-30', retrievedAt);
  assert.equal(quote.latest.price, 28012.34);
  assert.equal(quote.latest.sessionDate, '2026-10-30');
  assert.equal(quote.previous.price, 27900);
  assert.equal(quote.source, 'Fugle historical candles');
  assert.throws(() => Core.parseFugleIndexClose({ ...body, symbol: '2330' }, '2026-10-30', retrievedAt), /not daily IX0001/);
  assert.throws(() => Core.parseFugleIndexClose({ ...body, timeframe: '1' }, '2026-10-30', retrievedAt), /not daily IX0001/);
  assert.throws(() => Core.parseFugleIndexClose({ ...body, data: body.data.slice(0, 1) }, '2026-10-30', retrievedAt), /no unique IX0001 close/);
  assert.throws(() => Core.parseFugleIndexClose({ ...body, data: [...body.data, body.data[1]] }, '2026-10-30', retrievedAt), /no unique IX0001 close/);
  assert.throws(() => Core.parseFugleIndexClose({ ...body, data: [body.data[0], { date: '2026-10-30', close: 0 }] }, '2026-10-30', retrievedAt), /no unique IX0001 close/);
});

test('TAIFEX TSMC weight must be unique, dated, and no more than 45 days old', () => {
  const retrievedAt = utc('2026-10-31T02:00:00');
  const html = `<div>資料日期：2026/10/30</div><table><tr><th>股票代號</th><th>股票名稱</th><th>比重</th></tr><tr><td>2330</td><td>台積電</td><td>41.6361%</td></tr></table>`;
  const weight = Core.parseTaiexTsmcWeight(html, '2026-10-30', retrievedAt);
  assert.ok(Math.abs(weight.weight - 0.416361) < 1e-12);
  assert.equal(weight.sessionDate, '2026-10-30');
  assert.equal(weight.source, 'TAIFEX TAIEX constituents and market-value weights');
  assert.throws(() => Core.parseTaiexTsmcWeight(html.replace('41.6361%', '—'), '2026-10-30', retrievedAt), /no unique valid/);
  assert.throws(() => Core.parseTaiexTsmcWeight(html + html, '2026-10-30', retrievedAt), /no unique valid/);
  assert.throws(() => Core.parseTaiexTsmcWeight(html.replace('2026/10/30', '2026/09/01'), '2026-10-30', retrievedAt), /stale/);
  assert.throws(() => Core.parseTaiexTsmcWeight(html.replace('2026/10/30', '2026/11/01'), '2026-10-30', retrievedAt), /future-dated/);
  assert.throws(() => Core.parseTaiexTsmcWeight(html.replace('2330', '2317'), '2026-10-30', retrievedAt), /no unique valid/);
});

test('manual fallback prices produce independent previous-close baselines', () => {
  assert.deepEqual(Core.resolvePrice('300', 100, 299, 90), { price: 300, timestampMs: 100, source: '手動輸入' });
  assert.deepEqual(Core.resolvePrice('', null, 299, 90), { price: 299, timestampMs: 90, source: '自動來源' });
  assert.equal(Core.resolvePrice('-1', 100, 299, 90), null);
  const fromManual = Core.baseline({ tw2330: '1900', twB: '52.15', ix0001: '20340.25' });
  assert.deepEqual(fromManual, { tw2330: 1900, twB: 52.15, ix0001: 20340.25 });
  const changedIndex = Core.baseline({ tw2330: '1900', twB: '52.15', ix0001: '21080.08' });
  assert.equal(changedIndex.twB, fromManual.twB);
  assert.equal(changedIndex.tw2330, fromManual.tw2330);
  assert.equal(changedIndex.ix0001, 21080.08);
  assert.deepEqual(Core.baseline({ tw2330: 1900, twB: 52.15, ix0001: 0 }), { tw2330: 1900, twB: 52.15, ix0001: null });
  assert.equal(Core.baseline({ tw2330: 0, twB: null, ix0001: 0 }), null);
});

test('price inputs format floating-point source values without rounding calculation inputs', () => {
  assert.equal(Core.formatPriceInput(431.80999755859375), '431.81');
  assert.equal(Core.formatPriceInput(249.05000305), '249.05');
  assert.equal(Core.formatPriceInput(35.65000152), '35.65');
  assert.equal(Core.formatPriceInput(32.55178, 'fx'), '32.55');
  assert.equal(Core.formatPriceInput(32.5, 'fx'), '32.50');
  const manualFx = Core.resolvePrice('32.55178', 1, 32.5, 2);
  const automaticFx = Core.resolvePrice('', null, 32.55178, 2);
  assert.equal(manualFx.price, 32.55178);
  assert.equal(automaticFx.price, 32.55178);
  assert.equal(Core.formatPriceInput(manualFx.price, 'fx'), '32.55');
  assert.equal(Core.formatPriceInput(automaticFx.price, 'fx'), '32.55');
  assert.equal((431.81 / 5) * automaticFx.price, 2811.23682436);
  assert.notEqual((431.81 / 5) * automaticFx.price, (431.81 / 5) * 32.55);
  const rawManual = '431.80999755859375';
  assert.deepEqual(Core.resolvePrice(rawManual, 1, 430, 2), {
    price: 431.80999755859375, timestampMs: 1, source: '手動輸入'
  });
});

test('stock and ETF price rounding respects Taiwan tick bands', () => {
  assert.equal(Core.tickSize(9.99, 'stock'), 0.01);
  assert.equal(Core.tickSize(10, 'stock'), 0.05);
  assert.equal(Core.tickSize(50, 'stock'), 0.1);
  assert.equal(Core.tickSize(100, 'stock'), 0.5);
  assert.equal(Core.tickSize(500, 'stock'), 1);
  assert.equal(Core.tickSize(1000, 'stock'), 5);
  assert.equal(Core.tickSize(49.99, 'etf'), 0.01);
  assert.equal(Core.tickSize(50, 'etf'), 0.05);
  assert.equal(Core.roundToTick(2002, 'stock'), 2000);
  assert.equal(Core.roundToTick(52.13, 'etf'), 52.15);
});

test('Fubon 006208 holdings parser returns the reported TSMC weight and rejects unusable reports', () => {
  const html = `<div><span>資料日期：</span><span>2026/03/06</span></div><table><tr><th>股票代碼</th><th>股票名稱</th><th>股數</th><th>金額</th><th>權重(%)</th></tr>
    <tr><td>2330</td><td>台積電</td><td>1,000</td><td>2,000</td><td>57.2285</td></tr></table>`;
  const exposure = Core.parseFubonTaiwan50Exposure(html, utc('2026-03-09T00:40:00'));
  assert.ok(Math.abs(exposure.weight - 0.572285) < 1e-12);
  assert.equal(exposure.sessionDate, '2026-03-06');
  assert.equal(exposure.source, 'Fubon ETF official 006208 assets page');
  assert.throws(() => Core.parseFubonTaiwan50Exposure('<div>no holdings</div>', utc('2026-03-09T00:40:00')), /report date/);
  assert.throws(() => Core.parseFubonTaiwan50Exposure(html.replace('57.2285', '—'), utc('2026-03-09T00:40:00')), /unique valid/);
  assert.throws(() => Core.parseFubonTaiwan50Exposure(html + html, utc('2026-03-09T00:40:00')), /unique valid/);
});

test('opening estimates use ADR return and date-matched 006208 exposure, then round to Taiwan ticks', () => {
  const now = utc('2026-03-09T00:45:00'); // Monday 08:45 Taiwan time
  const calendar = { closed: new Set(), open: new Set() };
  const twClose = Core.exchangeCloseMs('2026-03-06', 'TW');
  const adr = {
    market: 'US', source: 'Yahoo Finance chart API',
    previous: { price: 300, sessionDate: '2026-03-05', closeTimestampMs: Core.exchangeCloseMs('2026-03-05', 'US') },
    latest: { price: 315, sessionDate: '2026-03-06', closeTimestampMs: Core.exchangeCloseMs('2026-03-06', 'US') }
  };
  const quotes = {
    tw2330: { symbol: '2330.TW', latest: { price: 2000, sessionDate: '2026-03-06', closeTimestampMs: twClose } },
    twB: { symbol: '006208.TW', latest: { price: 250, sessionDate: '2026-03-06', closeTimestampMs: twClose } },
    twIndex: { symbol: 'IX0001', latest: { price: 28000, sessionDate: '2026-03-06', closeTimestampMs: twClose } }
  };
  const exposure = { weight: 0.572285, sessionDate: '2026-03-06', retrievedAtMs: now - 1000, source: 'Fubon ETF official 006208 assets page' };
  const indexWeight = { weight: 0.4, sessionDate: '2026-03-06', retrievedAtMs: now - 1000, source: 'TAIFEX TAIEX constituents and market-value weights' };
  const forecasts = Core.estimateOpeningPrices({ adr, quotes, freshness: { tw2330: 'FRESH', twB: 'FRESH', twIndex: 'FRESH' }, exposure, indexWeight, nowMs: now, calendar });
  assert.equal(forecasts.tw2330.estimatedOpen, 2100);
  assert.ok(Math.abs(forecasts.tw2330.changePercent - 5) < 1e-10);
  assert.equal(forecasts.tw2330.previousClose, 2000);
  assert.equal(forecasts.twB.estimatedOpen, 257.15);
  assert.ok(Math.abs(forecasts.twB.changePercent - 2.861425) < 1e-10);
  assert.equal(forecasts.twB.exposureWeight, 0.572285);
  assert.equal(forecasts.ix0001.estimatedOpen, 28560);
  assert.equal(forecasts.ix0001.indexWeight, 0.4);
  assert.equal(forecasts.ix0001.indexWeightDate, '2026-03-06');
  assert.equal(forecasts.tw2330.targetDate, '2026-03-09');
  assert.equal(Core.previousTaiwanTradingDate('2026-03-09', calendar), '2026-03-06');
  const snapshot = { targetDate: '2026-03-09', capturedAtMs: now, forecasts };
  assert.equal(Core.validateOpeningForecastSnapshot(snapshot), true);
  assert.equal(Core.validateOpeningForecastSnapshot({ ...snapshot, capturedAtMs: utc('2026-03-09T01:00:00') }), false);
  assert.equal(Core.mergeOpeningForecastSnapshot(null, snapshot), snapshot);
  assert.equal(Core.mergeOpeningForecastSnapshot(snapshot, snapshot), snapshot);
  const partial = { ...snapshot, forecasts: { ...forecasts, twB: { status: 'UNAVAILABLE' }, ix0001: { status: 'UNAVAILABLE' } } };
  const merged = Core.mergeOpeningForecastSnapshot(partial, snapshot);
  assert.equal(merged.forecasts.tw2330, partial.forecasts.tw2330);
  assert.equal(merged.forecasts.twB.status, 'ESTIMATE');
  assert.equal(merged.forecasts.ix0001.status, 'ESTIMATE');
  const revised2330 = { ...snapshot, forecasts: { ...forecasts, tw2330: { ...forecasts.tw2330, estimatedOpen: 9999 } } };
  assert.equal(Core.mergeOpeningForecastSnapshot(snapshot, revised2330), snapshot);
});

test('opening forecasts reject missing, stale, mismatched, and out-of-window inputs', () => {
  const now = utc('2026-03-09T00:45:00');
  const calendar = { closed: new Set(), open: new Set() };
  const twClose = Core.exchangeCloseMs('2026-03-06', 'TW');
  const adr = {
    market: 'US', previous: { price: 300, sessionDate: '2026-03-05', closeTimestampMs: Core.exchangeCloseMs('2026-03-05', 'US') },
    latest: { price: 315, sessionDate: '2026-03-06', closeTimestampMs: Core.exchangeCloseMs('2026-03-06', 'US') }
  };
  const quotes = {
    tw2330: { symbol: '2330.TW', latest: { price: 2000, sessionDate: '2026-03-06', closeTimestampMs: twClose } },
    twB: { symbol: '006208.TW', latest: { price: 250, sessionDate: '2026-03-06', closeTimestampMs: twClose } },
    twIndex: { symbol: 'IX0001', latest: { price: 28000, sessionDate: '2026-03-06', closeTimestampMs: twClose } }
  };
  const exposure = { weight: 0.57, sessionDate: '2026-03-06', retrievedAtMs: now - 1000 };
  const indexWeight = { weight: 0.416361, sessionDate: '2026-03-06', retrievedAtMs: now - 1000 };
  const base = { quotes, freshness: { tw2330: 'FRESH', twB: 'FRESH', twIndex: 'FRESH' }, exposure, indexWeight, nowMs: now, calendar };
  assert.equal(Core.estimateOpeningPrices({ ...base, adr: null }).tw2330.status, 'UNAVAILABLE');
  assert.equal(Core.estimateOpeningPrices({ ...base, adr, freshness: { tw2330: 'STALE', twB: 'STALE' } }).tw2330.status, 'UNAVAILABLE');
  const mismatched = { ...quotes, twB: { ...quotes.twB, latest: { ...quotes.twB.latest, sessionDate: '2026-03-05' } } };
  assert.equal(Core.estimateOpeningPrices({ ...base, adr, quotes: mismatched }).twB.status, 'UNAVAILABLE');
  const oldExposure = { ...exposure, sessionDate: '2026-03-05' };
  assert.equal(Core.estimateOpeningPrices({ ...base, adr, exposure: oldExposure }).twB.status, 'UNAVAILABLE');
  assert.equal(Core.estimateOpeningPrices({ ...base, adr, exposure: null }).twB.status, 'UNAVAILABLE');
  assert.equal(Core.estimateOpeningPrices({ ...base, adr, indexWeight: null }).ix0001.status, 'UNAVAILABLE');
  assert.equal(Core.estimateOpeningPrices({ ...base, adr, freshness: { tw2330: 'FRESH', twB: 'FRESH', twIndex: 'STALE' } }).ix0001.status, 'UNAVAILABLE');
  const mismatchedIndex = { ...quotes, twIndex: { ...quotes.twIndex, latest: { ...quotes.twIndex.latest, sessionDate: '2026-03-05' } } };
  assert.equal(Core.estimateOpeningPrices({ ...base, adr, quotes: mismatchedIndex }).ix0001.status, 'UNAVAILABLE');
  assert.equal(Core.estimateOpeningPrices({ ...base, adr, indexWeight: { ...indexWeight, sessionDate: '2026-01-01' } }).ix0001.status, 'UNAVAILABLE');
  const oldAdr = { ...adr,
    previous: { price: 295, sessionDate: '2026-03-04', closeTimestampMs: Core.exchangeCloseMs('2026-03-04', 'US') },
    latest: { ...adr.latest, price: 300, sessionDate: '2026-03-05', closeTimestampMs: Core.exchangeCloseMs('2026-03-05', 'US') }
  };
  assert.equal(Core.estimateOpeningPrices({ ...base, adr: oldAdr }).tw2330.status, 'UNAVAILABLE');
  assert.equal(Core.estimateOpeningPrices({ ...base, adr, freshness: { tw2330: 'MANUAL', twB: 'MANUAL' } }).tw2330.status, 'UNAVAILABLE');
  const afterOpen = Core.estimateOpeningPrices({ ...base, adr, nowMs: utc('2026-03-09T01:05:00') });
  assert.equal(afterOpen.tw2330.status, 'UNAVAILABLE');
  const targetMismatch = Core.estimateOpeningPrices({ ...base, adr, targetDate: '2026-03-10' });
  assert.equal(targetMismatch.tw2330.status, 'UNAVAILABLE');
  const postOpenCloses = {
    tw2330: { symbol: '2330.TW', latest: { price: 2050, sessionDate: '2026-03-09', closeTimestampMs: Core.exchangeCloseMs('2026-03-09', 'TW') } },
    twB: { symbol: '006208.TW', latest: { price: 255, sessionDate: '2026-03-09', closeTimestampMs: Core.exchangeCloseMs('2026-03-09', 'TW') } }
  };
  assert.equal(Core.estimateOpeningPrices({ ...base, adr, quotes: postOpenCloses, nowMs: utc('2026-03-09T06:00:00') }).tw2330.status, 'UNAVAILABLE');
});

test('service worker installs the changed app shell and activates the new cache version', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const cacheVersion = source.match(/CACHE_NAME\s*=\s*'tsmc-adr-shell-v(\d+)'/)?.[1];
  assert.ok(cacheVersion);
  assert.ok(html.includes('type="text/babel" src="./app.jsx"'));
  const handlers = {};
  const added = [];
  const deleted = [];
  let skipWaitingCalled = false;
  const self = {
    location: { origin: 'https://example.test' }, registration: { scope: 'https://example.test/' },
    skipWaiting: () => { skipWaitingCalled = true; return Promise.resolve(); },
    clients: { claim: () => Promise.resolve() },
    addEventListener: (name, handler) => { handlers[name] = handler; }
  };
  const caches = {
    open: async name => ({ addAll: async files => { added.push({ name, files }); }, put: async () => {} }),
    keys: async () => ['tsmc-adr-shell-v2', 'another-cache', 'tsmc-adr-shell-v3', 'tsmc-adr-shell-v4', 'tsmc-adr-shell-v5', 'tsmc-adr-shell-v6', 'tsmc-adr-shell-v7', 'tsmc-adr-shell-v8', 'tsmc-adr-shell-v9', 'tsmc-adr-shell-v10'],
    delete: async key => { deleted.push(key); return true; },
    match: async () => null
  };
  vm.runInNewContext(source, { self, caches, URL, fetch: async () => ({ ok: true }) });
  let installPromise;
  handlers.install({ waitUntil: promise => { installPromise = promise; } });
  await installPromise;
  assert.equal(added[0].name, `tsmc-adr-shell-v${cacheVersion}`);
  assert.ok(added[0].files.includes('./app.jsx'));
  assert.ok(added[0].files.includes('./market-data.js'));
  assert.equal(skipWaitingCalled, true);
  let activatePromise;
  handlers.activate({ waitUntil: promise => { activatePromise = promise; } });
  await activatePromise;
  assert.deepEqual(deleted.sort(), ['another-cache', 'tsmc-adr-shell-v2', 'tsmc-adr-shell-v3', 'tsmc-adr-shell-v4', 'tsmc-adr-shell-v5', 'tsmc-adr-shell-v6', 'tsmc-adr-shell-v7', 'tsmc-adr-shell-v8', 'tsmc-adr-shell-v9', 'tsmc-adr-shell-v10'].sort());
});

test('TSMC app provides a local Fugle key entry path for isolated iOS app storage', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.jsx'), 'utf8');
  assert.match(source, /useState\(\(\) => localStorage\.getItem\('fugle_api_key'\)/);
  assert.match(source, /localStorage\.setItem\('fugle_api_key', apiKey\)/);
  assert.match(source, /id="fugle-api-key" type="password"/);
  assert.match(source, /onClick=\{saveFugleApiKey\}/);
});
