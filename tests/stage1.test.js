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
  assert.equal(Core.baseline({ tw2330: tw.latest.price, twB: 50.05, twC: 20.12 }).tw2330, 1950);
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
  const full = { adr: quote, tw2330: quote, twB: quote, twC: quote, fx };
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
    twB: quote('2026-03-05'), twC: quote('2026-03-05'), fx };
  assert.equal(Core.taiwanSessionsAligned([bundle.tw2330, bundle.twB, bundle.twC]), false);
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
  const twC = quote('2026-10-28', 35.65);

  assert.equal(expected, '2026-10-29');
  assert.equal(Core.taiwanQuoteFreshness(tw2330, expected, now), 'FRESH');
  assert.equal(Core.taiwanQuoteFreshness(twB, expected, now), 'STALE');
  assert.equal(Core.taiwanQuoteFreshness(twC, expected, now), 'STALE');
  const baseline = Core.verifiedTaiwanBaseline({
    tw2330: tw2330.latest.price, twB: twB.latest.price, twC: twC.latest.price
  }, { tw2330: 'FRESH', twB: 'STALE', twC: 'STALE' });
  assert.deepEqual(baseline, { tw2330: 2415, twB: null, twC: null });
  assert.equal(Core.mayCaptureSnapshot(Core.snapshotCutoffMs('2026-10-30'), true,
    Boolean(baseline?.tw2330), null, Core.snapshotCutoffMs('2026-10-30') - 1), true);
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
    stat: 'OK', date: '20261001', title: '115年10月 00878 國泰永續高股息',
    fields: ['日期', '收盤價'], data: [['115/10/29', '35.30']]
  };
  assert.throws(() => Core.parseTwseDailyQuote(body, '006208', date, retrievedAt), /does not match/);
  assert.throws(() => Core.parseTwseDailyQuote({ ...body, date: '20260901' }, '00878', date, retrievedAt), /does not match/);
  assert.throws(() => Core.parseTwseDailyQuote({ ...body, data: [['115/10/28', '35.30']] }, '00878', date, retrievedAt), /no unique completed row/);
  assert.throws(() => Core.parseTwseDailyQuote({ ...body, data: [['115/10/29', '—']] }, '00878', date, retrievedAt), /invalid or not yet complete/);
  assert.throws(() => Core.parseTwseDailyQuote(body, '00878', date, Core.exchangeCloseMs(date, 'TW') - 1), /invalid or not yet complete/);
});

test('manual fallback prices produce independent previous-close baselines', () => {
  assert.deepEqual(Core.resolvePrice('300', 100, 299, 90), { price: 300, timestampMs: 100, source: '手動輸入' });
  assert.deepEqual(Core.resolvePrice('', null, 299, 90), { price: 299, timestampMs: 90, source: '自動來源' });
  assert.equal(Core.resolvePrice('-1', 100, 299, 90), null);
  const fromManual = Core.baseline({ tw2330: '1900', twB: '52.15', twC: '20.34' });
  assert.deepEqual(fromManual, { tw2330: 1900, twB: 52.15, twC: 20.34 });
  const changed00878 = Core.baseline({ tw2330: '1900', twB: '52.15', twC: '21.08' });
  assert.equal(changed00878.twB, fromManual.twB);
  assert.equal(changed00878.tw2330, fromManual.tw2330);
  assert.equal(changed00878.twC, 21.08);
  assert.deepEqual(Core.baseline({ tw2330: 1900, twB: 52.15, twC: 0 }), { tw2330: 1900, twB: 52.15, twC: null });
  assert.equal(Core.baseline({ tw2330: 0, twB: null, twC: 0 }), null);
});

test('price inputs format floating-point source values without rounding calculation inputs', () => {
  assert.equal(Core.formatPriceInput(431.80999755859375), '431.81');
  assert.equal(Core.formatPriceInput(249.05000305), '249.05');
  assert.equal(Core.formatPriceInput(35.65000152), '35.65');
  assert.equal(Core.formatPriceInput(32.55178, 'fx'), '32.55178');
  assert.equal(Core.formatPriceInput(32.5, 'fx'), '32.5');
  const rawManual = '431.80999755859375';
  assert.deepEqual(Core.resolvePrice(rawManual, 1, 430, 2), {
    price: 431.80999755859375, timestampMs: 1, source: '手動輸入'
  });
});

test('08:45 snapshot cutoff, trading day, valid data, timestamps, and immutable saved record are enforced', () => {
  const cutoff = Core.snapshotCutoffMs('2026-03-09');
  assert.equal(Core.mayCaptureSnapshot(cutoff - 1, true, true, null, cutoff - 10), false);
  assert.equal(Core.mayCaptureSnapshot(cutoff, true, true, null, cutoff - 10), true);
  assert.equal(Core.mayCaptureSnapshot(cutoff + 31_000, true, true, null, cutoff - 10), true);
  assert.equal(Core.mayCaptureSnapshot(Core.taiwanMarketOpenMs('2026-03-09') - 1,
    true, true, null, cutoff - 10), true);
  assert.equal(Core.mayCaptureSnapshot(Core.taiwanMarketOpenMs('2026-03-09'),
    true, true, null, cutoff - 10), false);
  assert.equal(Core.mayCaptureSnapshot(cutoff + 1_000, false, true, null, cutoff - 10), false);
  assert.equal(Core.mayCaptureSnapshot(cutoff + 1_000, true, false, null, cutoff - 10), false);
  assert.equal(Core.mayCaptureSnapshot(cutoff + 1_000, true, true, null, cutoff + 2_000), false);
  assert.equal(Core.mayCaptureSnapshot(cutoff + 1_000, true, true, { targetDate: '2026-03-09' }, cutoff - 10), false);
  assert.equal(Core.mayCaptureSnapshot(Core.snapshotCutoffMs('2026-03-10'), true, true,
    { targetDate: '2026-03-09' }, Core.snapshotCutoffMs('2026-03-10') - 1), true);
});

test('actual Taiwan opens are accepted only after the target session opens', () => {
  const openAt = Core.taiwanMarketOpenMs('2026-03-09');
  assert.equal(Core.mayRetrieveActualOpen(openAt + 59_999, '2026-03-09'), false);
  assert.equal(Core.mayRetrieveActualOpen(openAt + 60_000, '2026-03-09'), true);
  const json = { chart: { result: [{
    timestamp: [utc('2026-03-09T01:00:00') / 1000],
    indicators: { quote: [{ open: [2005] }] }
  }] } };
  assert.deepEqual(Core.parseYahooOpenings(json, 'TW', ['2026-03-09'], openAt + 60_000), {
    '2026-03-09': {
      price: 2005,
      sessionDate: '2026-03-09',
      barTimestampMs: utc('2026-03-09T01:00:00'),
      retrievedAtMs: openAt + 60_000
    }
  });
  assert.deepEqual(Core.parseYahooOpenings(json, 'TW', ['2026-03-09'], openAt), {});
});

test('forward outcomes append once and calculate baseline MAE without inventing directional calls', () => {
  const snapshots = [{ targetDate: '2026-03-09', prices: { tw2330: 2000, twB: 50, twC: 20 } }];
  const outcome = { outcomeKey: '2026-03-09:tw2330', targetDate: '2026-03-09',
    symbols: { tw2330: '2330' }, actualOpen: { tw2330: 2010 } };
  let appended = Core.appendImmutableRecord([], outcome, 'outcomeKey');
  assert.equal(Core.appendImmutableRecord(appended, { ...outcome, actualOpen: { tw2330: 1 } }, 'outcomeKey'), appended);
  appended = Core.appendImmutableRecord(appended, {
    outcomeKey: '2026-03-09:twB', targetDate: '2026-03-09',
    symbols: { twB: '006208' }, actualOpen: { twB: 50.5 }
  }, 'outcomeKey');
  const metrics = Core.calculateForwardMetrics(snapshots, appended, { twB: '006208', twC: '00878' });
  assert.equal(metrics.tw2330.validObservations, 1);
  assert.equal(metrics.tw2330.mae, 10);
  assert.equal(metrics.tw2330.directionalCalls, 0);
  assert.equal(metrics.tw2330.directionalAccuracy, null);
  assert.equal(metrics.twB.validObservations, 1);
  assert.equal(metrics.twB.mae, 0.5);

  const directional = Core.calculateForwardMetrics([
    { targetDate: '2026-03-09', prices: { tw2330: 2000 }, predictions: { tw2330: 2005 } }
  ], appended);
  assert.equal(directional.tw2330.directionalCalls, 1);
  assert.equal(directional.tw2330.directionalAccuracy, 100);
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

test('service worker installs the changed app shell and activates the new cache version', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
  const handlers = {};
  const added = [];
  const deleted = [];
  const self = {
    location: { origin: 'https://example.test' }, registration: { scope: 'https://example.test/' },
    clients: { claim: () => Promise.resolve() },
    addEventListener: (name, handler) => { handlers[name] = handler; }
  };
  const caches = {
    open: async name => ({ addAll: async files => { added.push({ name, files }); }, put: async () => {} }),
    keys: async () => ['tsmc-adr-shell-v2', 'another-cache', 'tsmc-adr-shell-v3'],
    delete: async key => { deleted.push(key); return true; },
    match: async () => null
  };
  vm.runInNewContext(source, { self, caches, URL, fetch: async () => ({ ok: true }) });
  let installPromise;
  handlers.install({ waitUntil: promise => { installPromise = promise; } });
  await installPromise;
  assert.equal(added[0].name, 'tsmc-adr-shell-v3');
  assert.ok(added[0].files.includes('./app.jsx'));
  assert.ok(added[0].files.includes('./market-data.js'));
  let activatePromise;
  handlers.activate({ waitUntil: promise => { activatePromise = promise; } });
  await activatePromise;
  assert.deepEqual(deleted.sort(), ['another-cache', 'tsmc-adr-shell-v2'].sort());
});
