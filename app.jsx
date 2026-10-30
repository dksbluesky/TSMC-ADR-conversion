const { useEffect, useMemo, useRef, useState } = React;
const Core = window.TSMCMarketData;

const INITIAL_MANUAL = { adr: '', fx: '', tw2330: '', twB: '', twC: '' };
const SNAPSHOT_KEY = 'tsmcAdrPremarketSnapshot.v1';
const ACTUAL_OPEN_KEY = 'tsmcAdrActualOpen.v1';
const MIN_FORWARD_OBSERVATIONS = 120;

function readLocalArray(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(saved) ? saved : (saved ? [saved] : []);
  } catch { return []; }
}

function App() {
  const [tickers, setTickers] = useState({ b: '006208', c: '00878' });
  const [bundle, setBundle] = useState({});
  const [manual, setManual] = useState(INITIAL_MANUAL);
  const [manualDisplay, setManualDisplay] = useState({});
  const [manualTimes, setManualTimes] = useState({});
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [errors, setErrors] = useState([]);
  const [calendar, setCalendar] = useState(null);
  const [calendarError, setCalendarError] = useState('');
  const [snapshots, setSnapshots] = useState(() => readLocalArray(SNAPSHOT_KEY));
  const [actualOpenings, setActualOpenings] = useState(() => readLocalArray(ACTUAL_OPEN_KEY));
  const [actualOpenError, setActualOpenError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const actualCheckInFlight = useRef(false);
  const lastActualCheck = useRef(0);

  const proxyUrls = rawUrl => {
    const encoded = encodeURIComponent(rawUrl);
    return [
      { name: '線路 0 (cors.dev)', url: `https://proxy.cors.dev/${rawUrl}` },
      { name: '線路 A (allorigins)', url: `https://api.allorigins.win/get?url=${encoded}`, wrapped: true },
      { name: '線路 B (corsproxy)', url: `https://corsproxy.io/?${encoded}` },
      { name: '線路 C (thingproxy)', url: `https://thingproxy.freeboard.io/fetch/${rawUrl}` }
    ];
  };

  const fetchProxiedJson = async rawUrl => {
    const failures = [];
    for (const proxy of proxyUrls(rawUrl)) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(proxy.url, { signal: controller.signal, credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        return proxy.wrapped ? JSON.parse(payload.contents) : payload;
      } catch (error) {
        failures.push(`${proxy.name}: ${error?.name === 'AbortError' ? '逾時' : error?.message || '連線失敗'}`);
      } finally {
        window.clearTimeout(timeout);
      }
    }
    throw new Error(failures.join('；') || '所有行情代理線路均失敗。');
  };

  const fetchYahoo = async (symbol, market) => {
    const rawUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1mo&_t=${Date.now()}`;
    return Core.parseYahooChart(await fetchProxiedJson(rawUrl), market, Date.now(), market === 'TW' ? 14 : 7);
  };

  const fetchYahooOpenings = async (symbol, targetDates) => {
    const rawUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo&_t=${Date.now()}`;
    return Core.parseYahooOpenings(await fetchProxiedJson(rawUrl), 'TW', targetDates, Date.now());
  };

  const fetchTaiwanCalendar = async () => {
    const rawUrl = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';
    return Core.parseTaiwanClosedDates(await fetchProxiedJson(rawUrl));
  };

  const fetchTwseDailyQuote = async (symbol, targetDate) => {
    const month = targetDate.slice(0, 7).replace('-', '');
    const rawUrl = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${month}01&stockNo=${symbol}&response=json`;
    const payload = await fetchProxiedJson(rawUrl);
    return Core.parseTwseDailyQuote(payload, symbol, targetDate, Date.now());
  };

  const runAutoSync = async () => {
    setLoading(true);
    setErrors([]);
    const names = ['adr', 'tw2330', 'twB', 'twC', 'fx'];
    const requests = [
      fetchYahoo('TSM', 'US'), fetchYahoo('2330.TW', 'TW'),
      fetchYahoo(`${tickers.b}.TW`, 'TW'), fetchYahoo(`${tickers.c}.TW`, 'TW'),
      fetch('https://open.er-api.com/v6/latest/USD').then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }).then(json => Core.validateFxResponse(json))
    ];
    const results = await Promise.allSettled([...requests, fetchTaiwanCalendar()]);
    const next = {};
    const failures = [];
    results.forEach((result, i) => {
      if (i < names.length) {
        if (result.status === 'fulfilled') next[names[i]] = result.value;
        else failures.push(`${names[i]}: ${result.reason?.message || '來源讀取失敗'}`);
      }
    });
    const calendarResult = results[names.length].status === 'fulfilled' ? results[names.length].value : null;
    if (calendarResult) {
      setCalendar(calendarResult);
      setCalendarError('');
      const syncTime = Date.now();
      const expectedDate = Core.latestCompletedTaiwanSessionDate(syncTime, calendarResult);
      if (expectedDate) {
        for (const [key, symbol] of [['twB', tickers.b], ['twC', tickers.c]]) {
          if (Core.taiwanQuoteFreshness(next[key], expectedDate, syncTime) === 'FRESH') continue;
          try {
            next[key] = await fetchTwseDailyQuote(symbol, expectedDate);
          } catch (error) {
            failures.push(`${symbol} TWSE 備援未驗證：${error?.message || '讀取失敗'}`);
          }
        }
      }
    } else {
      setCalendar(null);
      setCalendarError(`台灣交易日曆無法驗證：${results[names.length].reason?.message || '來源讀取失敗'}`);
    }
    try { Core.validateBundle(next); }
    catch (error) { failures.push(error.message); }
    setBundle(next);
    setLastUpdated(new Date());
    setErrors(failures);
    setLoading(false);
  };

  useEffect(() => { runAutoSync(); }, [tickers.b, tickers.c]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const resolveInput = (key, autoValue, autoTimestamp) => {
    return Core.resolvePrice(manual[key], manualTimes[key], autoValue, autoTimestamp);
  };

  const inputs = {
    adr: resolveInput('adr', bundle.adr?.latest?.price, bundle.adr?.latest?.barTimestampMs),
    fx: resolveInput('fx', bundle.fx?.price, bundle.fx?.timestampMs),
    tw2330: resolveInput('tw2330', bundle.tw2330?.latest?.price, bundle.tw2330?.latest?.barTimestampMs),
    twB: resolveInput('twB', bundle.twB?.latest?.price, bundle.twB?.latest?.barTimestampMs),
    twC: resolveInput('twC', bundle.twC?.latest?.price, bundle.twC?.latest?.barTimestampMs)
  };
  const previousAdr = bundle.adr?.previous?.price;
  const taipeiDate = Core.taipeiDateKey(clock);
  const tradingDay = Core.isTaiwanTradingDay(taipeiDate, calendar);
  const expectedTaiwanCloseDate = Core.latestCompletedTaiwanSessionDate(clock, calendar);
  const taiwanFreshness = Object.fromEntries(['tw2330', 'twB', 'twC'].map(key => [
    key,
    inputs[key]?.source === '手動輸入' ? 'MANUAL' : Core.taiwanQuoteFreshness(bundle[key], expectedTaiwanCloseDate, clock)
  ]));
  const baseline = useMemo(() => Core.verifiedTaiwanBaseline({
    tw2330: inputs.tw2330?.price, twB: inputs.twB?.price, twC: inputs.twC?.price
  }, taiwanFreshness), [inputs.tw2330?.price, inputs.twB?.price, inputs.twC?.price,
    taiwanFreshness.tw2330, taiwanFreshness.twB, taiwanFreshness.twC]);
  const parity = inputs.adr && inputs.fx ? (inputs.adr.price / 5) * inputs.fx.price : null;
  const premium = parity && inputs.tw2330 ? ((parity - inputs.tw2330.price) / inputs.tw2330.price) * 100 : null;
  const adrOvernightMove = Number.isFinite(previousAdr) && previousAdr > 0 && inputs.adr?.price > 0
    ? (inputs.adr.price / previousAdr - 1) * 100 : null;
  const completeSync = (() => {
    try { Core.validateBundle(bundle); }
    catch { return false; }
    return ['tw2330', 'twB', 'twC'].every(key => taiwanFreshness[key] === 'FRESH');
  })();
  const inputMaxTimestamp = Math.max(0, ...Object.values(inputs).filter(Boolean).map(x => x.timestampMs || 0));
  const todaySnapshot = snapshots.find(item => item.targetDate === taipeiDate) || null;
  const metrics = Core.calculateForwardMetrics(snapshots, actualOpenings, { twB: tickers.b, twC: tickers.c });
  const actualByDate = new Map();
  for (const item of actualOpenings) {
    const merged = actualByDate.get(item.targetDate) || { targetDate: item.targetDate, actualOpen: {}, symbols: {}, retrievedAt: 0 };
    Object.assign(merged.actualOpen, item.actualOpen || {});
    Object.assign(merged.symbols, item.symbols || {});
    merged.retrievedAt = Math.max(merged.retrievedAt, item.retrievedAt || 0);
    actualByDate.set(item.targetDate, merged);
  }
  const todayActual = actualByDate.get(taipeiDate) || null;
  const recentHistory = [...snapshots].sort((a, b) => b.targetDate.localeCompare(a.targetDate)).slice(0, 10);
  const freshnessText = key => {
    const latest = bundle[key]?.latest?.sessionDate || '—';
    const expected = expectedTaiwanCloseDate || '交易日曆未驗證';
    return taiwanFreshness[key] === 'MANUAL'
      ? '行情狀態：MANUAL（手動備援）'
      : `行情狀態：${taiwanFreshness[key]}；最新收盤 ${latest}；應為 ${expected}`;
  };

  const checkActualOpenings = async () => {
    if (actualCheckInFlight.current) return;
    const now = Date.now();
    const completedByDate = new Map();
    for (const item of actualOpenings) {
      if (!completedByDate.has(item.targetDate)) completedByDate.set(item.targetDate, new Set());
      Object.keys(item.actualOpen || {}).forEach(fieldName => completedByDate.get(item.targetDate).add(fieldName));
    }
    const pending = snapshots.filter(item => {
      const have = completedByDate.get(item.targetDate) || new Set();
      return ['tw2330', 'twB', 'twC'].some(fieldName => !have.has(fieldName)) &&
        Core.mayRetrieveActualOpen(now, item.targetDate);
    });
    if (!pending.length) return;

    actualCheckInFlight.current = true;
    lastActualCheck.current = now;
    try {
      const requests = new Map();
      for (const item of pending) {
        const symbols = {
          tw2330: '2330.TW',
          twB: `${item.symbols?.twB || tickers.b}.TW`,
          twC: `${item.symbols?.twC || tickers.c}.TW`
        };
        const have = completedByDate.get(item.targetDate) || new Set();
        for (const [fieldName, symbol] of Object.entries(symbols)) {
          if (have.has(fieldName)) continue;
          if (!requests.has(symbol)) requests.set(symbol, new Set());
          requests.get(symbol).add(item.targetDate);
        }
      }
      const fetched = new Map();
      const failures = [];
      await Promise.all([...requests.entries()].map(async ([symbol, dates]) => {
        try { fetched.set(symbol, await fetchYahooOpenings(symbol, [...dates])); }
        catch (error) { failures.push(`${symbol}: ${error?.message || '開盤價讀取失敗'}`); }
      }));

      const additions = [];
      for (const item of pending) {
        const symbols = {
          tw2330: '2330.TW',
          twB: `${item.symbols?.twB || tickers.b}.TW`,
          twC: `${item.symbols?.twC || tickers.c}.TW`
        };
        const have = completedByDate.get(item.targetDate) || new Set();
        for (const [fieldName, symbol] of Object.entries(symbols)) {
          if (have.has(fieldName)) continue;
          const quote = fetched.get(symbol)?.[item.targetDate];
          if (!quote) continue;
          const ticker = fieldName === 'tw2330' ? '2330' : symbols[fieldName].replace(/\.TW$/, '');
          additions.push({
            outcomeKey: `${item.targetDate}:${fieldName}`,
            targetDate: item.targetDate,
            retrievedAt: Date.now(),
            source: 'Yahoo Finance chart API daily open',
            symbols: { [fieldName]: ticker },
            actualOpen: { [fieldName]: Core.roundToTick(quote.price, fieldName === 'tw2330' ? 'stock' : 'etf') },
            sourceBars: { [fieldName]: { sessionDate: quote.sessionDate, barTimestampMs: quote.barTimestampMs } }
          });
        }
      }

      let updated = actualOpenings;
      for (const outcome of additions) updated = Core.appendImmutableRecord(updated, outcome, 'outcomeKey');
      if (updated !== actualOpenings) {
        localStorage.setItem(ACTUAL_OPEN_KEY, JSON.stringify(updated));
        setActualOpenings(updated);
      }
      setActualOpenError(failures.join('；'));
    } catch (error) {
      setActualOpenError(error?.message || '實際開盤價無法保存。');
    } finally {
      actualCheckInFlight.current = false;
    }
  };

  const captureSnapshot = () => {
    const now = Date.now();
    if (!baseline?.tw2330 ||
        !Core.mayCaptureSnapshot(now, tradingDay, true, todaySnapshot, inputMaxTimestamp)) return;
    const record = {
      targetDate: Core.taipeiDateKey(now), capturedAt: now,
      cutoffAt: Core.taiwanMarketOpenMs(Core.taipeiDateKey(now)),
      model: 'previous-close-baseline-v1',
      prices: baseline,
      freshness: taiwanFreshness,
      symbols: { twB: tickers.b, twC: tickers.c },
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value && {
        price: value.price, source: value.source, timestampMs: value.timestampMs || null
      }]))
    };
    const updated = Core.appendImmutableRecord(snapshots, record);
    if (updated === snapshots) return;
    try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(updated)); }
    catch (error) { setErrors(current => [...current, `快照無法寫入本機儲存：${error?.message || '儲存失敗'}`]); return; }
    setSnapshots(updated);
  };

  useEffect(() => { captureSnapshot(); }, [clock, baseline?.tw2330, baseline?.twB, baseline?.twC, tradingDay, todaySnapshot]);
  useEffect(() => {
    if (clock - lastActualCheck.current < 60 * 1000) return;
    lastActualCheck.current = clock;
    checkActualOpenings();
  }, [clock, snapshots, actualOpenings, tickers.b, tickers.c]);

  const updateManual = (key, value) => {
    setManual(current => ({ ...current, [key]: value }));
    setManualDisplay(current => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setManualTimes(current => ({ ...current, [key]: Date.now() }));
  };

  const revealManualValue = key => setManualDisplay(current => {
    const next = { ...current };
    delete next[key];
    return next;
  });
  const formatManualValue = key => setManualDisplay(current => ({
    ...current,
    [key]: Core.formatPriceInput(manual[key], key === 'fx' ? 'fx' : 'price')
  }));
  const inputValue = key => {
    if (manual[key] !== '') return Object.prototype.hasOwnProperty.call(manualDisplay, key)
      ? manualDisplay[key] : manual[key];
    return Core.formatPriceInput(inputs[key]?.price, key === 'fx' ? 'fx' : 'price');
  };

  const fmt = value => Number.isFinite(value) && value > 0
    ? new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
    : '—';
  const fmtError = value => Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
    : '—';
  const sourceTime = (item, key) => {
    if (!item?.timestampMs) return '手動輸入時間未記錄';
    if (item.source === '手動輸入') return `手動輸入；記錄於 ${new Date(item.timestampMs).toLocaleString('zh-TW')}`;
    const zone = key === 'adr' ? 'America/New_York' : key === 'fx' ? 'UTC' : 'Asia/Taipei';
    return `${new Intl.DateTimeFormat('zh-TW', { timeZone: zone, dateStyle: 'medium', timeStyle: 'medium' }).format(item.timestampMs)} (${zone})`;
  };
  const quoteSource = key => inputs[key]?.source === '手動輸入'
    ? '手動備援'
    : bundle[key]?.source || '來源尚未驗證';
  const quoteRetrievedAt = key => bundle[key]?.retrievedAtMs
    ? `；TWSE 擷取於 ${new Date(bundle[key].retrievedAtMs).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`
    : '';
  const field = (key, label, step = '0.01') => (
    <label className="flex items-center justify-between gap-3 text-sm text-slate-600">
      <span>{label}</span>
      <input aria-label={label} type="number" step={step} className="input-field w-32 px-2 py-1 rounded text-right text-slate-700"
        placeholder="自動資料 / 手動備援" value={inputValue(key)}
        onFocus={() => revealManualValue(key)} onBlur={() => formatManualValue(key)}
        onChange={event => updateManual(key, event.target.value)} />
    </label>
  );

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-5xl mx-auto">
      <div className="flex flex-col md:flex-row justify-between items-center mb-6 pb-4 border-b border-slate-300 gap-4">
        <div><h1 className="text-xl font-bold text-slate-900">📊 台積電 ADR 行情推算機</h1>
          <p className="text-xs text-slate-500 mt-1">ADR 理論折算與台股前收基準（尚非驗證預測）</p></div>
        <button onClick={runAutoSync} disabled={loading} className="btn-live text-white px-8 py-2 rounded-lg font-bold shadow-lg min-w-[160px]">
          {loading ? '同步中…' : '↻ 強制重抓'}
        </button>
      </div>

      <div className="bg-slate-100 text-sm px-4 py-2 rounded mb-6 border border-slate-300">
        <span className={`status-dot ${loading ? 'status-yellow' : completeSync ? 'status-green' : 'status-red'}`}></span>
        <span>{loading ? '正在讀取資料來源…' : completeSync ? '所有行情與匯率來源均通過驗證' : '行情部分未通過新鮮度驗證；各標的狀態如下，可使用手動備援'}</span>
        {lastUpdated && <span className="text-slate-500 text-xs ml-2">(檢查於 {lastUpdated.toLocaleTimeString('zh-TW')})</span>}
        {errors.map(error => <div key={error} className="text-red-700 text-xs mt-1">{error}</div>)}
        {calendarError && <div className="text-red-700 text-xs mt-1">{calendarError}</div>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 space-y-5">
          <section className="glass-panel p-5 rounded-xl border-l-4 border-blue-500 space-y-3">
            <h3 className="text-slate-900 font-bold">美股 ADR (TSM) 與匯率</h3>
            {field('adr', '最新已完成美股收盤價')}
            <div className="text-xs text-slate-500">ADR 交易日：{bundle.adr?.latest?.sessionDate || '—'}；Yahoo K 棒時間：{sourceTime(inputs.adr, 'adr')}</div>
            <div className="text-xs text-slate-500">前一個已完成收盤：{fmt(previousAdr)} ({bundle.adr?.previous?.sessionDate || '—'})</div>
            <div className="text-xs text-slate-500">ADR 前收至最新收盤變動：{Number.isFinite(adrOvernightMove) ? `${adrOvernightMove > 0 ? '+' : ''}${adrOvernightMove.toFixed(2)}%` : '—'}（市場背景，非開盤預測）</div>
            <div className="text-xs text-slate-500">來源：Yahoo Finance chart API（cors.dev 與既有代理備援）</div>
            {field('fx', 'USD/TWD 匯率', '0.00001')}
            <div className="text-xs text-slate-500">匯率更新時間：{sourceTime(inputs.fx, 'fx')}</div>
          </section>

          <section className="glass-panel p-5 rounded-xl border-l-4 border-green-500 space-y-3">
            <h3 className="text-slate-900 font-bold">台股最新已完成收盤 (基準)</h3>
            {field('tw2330', '2330 台積電', '0.01')}
            <div className="text-xs text-slate-500">{freshnessText('tw2330')}；來源 {quoteSource('tw2330')}；市場時間 {sourceTime(inputs.tw2330, 'tw2330')}{quoteRetrievedAt('tw2330')}</div>
            <div className="flex items-center justify-between gap-2"><input aria-label="006208 ticker" type="text" className="input-field w-24 px-2 py-1 rounded text-xs" value={tickers.b} onChange={e => setTickers(v => ({ ...v, b: e.target.value.trim() }))} />
              <input aria-label={`${tickers.b} previous close`} type="number" step="0.01" className="input-field w-32 px-2 py-1 rounded text-right text-slate-700" placeholder="自動資料 / 手動備援" value={inputValue('twB')} onFocus={() => revealManualValue('twB')} onBlur={() => formatManualValue('twB')} onChange={e => updateManual('twB', e.target.value)} /></div>
            <div className="text-xs text-slate-500">{freshnessText('twB')}；來源 {quoteSource('twB')}；市場時間 {sourceTime(inputs.twB, 'twB')}{quoteRetrievedAt('twB')}</div>
            <div className="flex items-center justify-between gap-2"><input aria-label="00878 ticker" type="text" className="input-field w-24 px-2 py-1 rounded text-xs" value={tickers.c} onChange={e => setTickers(v => ({ ...v, c: e.target.value.trim() }))} />
              <input aria-label={`${tickers.c} previous close`} type="number" step="0.01" className="input-field w-32 px-2 py-1 rounded text-right text-slate-700" placeholder="自動資料 / 手動備援" value={inputValue('twC')} onFocus={() => revealManualValue('twC')} onBlur={() => formatManualValue('twC')} onChange={e => updateManual('twC', e.target.value)} /></div>
            <div className="text-xs text-slate-500">{freshnessText('twC')}；來源 {quoteSource('twC')}；市場時間 {sourceTime(inputs.twC, 'twC')}{quoteRetrievedAt('twC')}</div>
            <p className="text-xs text-slate-500">欄位可手動覆寫自動資料；輸入值會標示為手動備援。</p>
          </section>
        </div>

        <div className="lg:col-span-7 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="glass-panel p-4 rounded-xl text-center min-h-[96px]"><div className="text-xs text-slate-500">ADR 理論折算價</div>
              <div className="text-2xl font-mono font-bold mt-1">{fmt(parity)}</div><div className="text-xs text-slate-500">TSM ADR ÷ 5 × USD/TWD；市場背景，不作預測</div></div>
            <div className="glass-panel p-4 rounded-xl text-center min-h-[96px]"><div className="text-xs text-slate-500">相對 2330 前收差異</div>
              <div className="text-2xl font-mono font-bold mt-1">{Number.isFinite(premium) ? `${premium > 0 ? '+' : ''}${premium.toFixed(2)}%` : '—'}</div>
              <div className="text-xs text-slate-500">診斷值，不作預測漲幅</div></div>
          </div>

          <section className="glass-panel rounded-xl overflow-hidden border border-slate-300">
            <div className="bg-slate-100 px-6 py-3 border-b border-slate-300"><h3 className="font-bold text-slate-900 text-sm">今日開盤參考 — 前收基準</h3></div>
            {baseline ? <table className="w-full text-left text-sm"><thead><tr className="border-b border-slate-300 bg-slate-100 text-slate-500">
              <th className="p-4">基準說明</th><th className="p-4">2330</th><th className="p-4">{tickers.b}</th><th className="p-4">{tickers.c}</th></tr></thead>
              <tbody><tr><td className="p-4 text-slate-600 font-bold">前一收盤價<br/><span className="text-xs font-normal">非驗證預測</span></td>
                <td className="p-4 font-mono font-bold text-lg">{fmt(baseline.tw2330)}</td><td className="p-4 font-mono">{fmt(baseline.twB)}</td><td className="p-4 font-mono">{fmt(baseline.twC)}</td></tr></tbody></table>
              : <div className="p-10 text-center text-slate-400">尚無有效前收基準；請等待 2330 最新收盤驗證或使用手動備援。</div>}
          </section>

          <section className="glass-panel p-5 rounded-xl">
            <h3 className="font-bold text-slate-900">開盤前快照與實際開盤</h3>
            {todaySnapshot ? <div className="text-sm text-slate-600 mt-2"><p>已保存 {new Date(todaySnapshot.capturedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}；模型：前收基準。此紀錄不會被後續行情覆寫。</p>
              <p className="mt-1">前收基準：2330 {fmt(todaySnapshot.prices.tw2330)}；{todaySnapshot.symbols?.twB || tickers.b} {fmt(todaySnapshot.prices.twB)}；{todaySnapshot.symbols?.twC || tickers.c} {fmt(todaySnapshot.prices.twC)}</p>
              {todaySnapshot.freshness && <p className="text-xs text-slate-500 mt-1">快照狀態：2330 {todaySnapshot.freshness.tw2330}；{todaySnapshot.symbols?.twB || tickers.b} {todaySnapshot.freshness.twB}；{todaySnapshot.symbols?.twC || tickers.c} {todaySnapshot.freshness.twC}</p>}
              {todayActual ? <><p className="mt-1">實際開盤：2330 {fmt(todayActual.actualOpen.tw2330)}；{todayActual.symbols?.twB || tickers.b} {fmt(todayActual.actualOpen.twB)}；{todayActual.symbols?.twC || tickers.c} {fmt(todayActual.actualOpen.twC)}</p>
                <p className="text-xs text-slate-500 mt-1">擷取於 {new Date(todayActual.retrievedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}；來源 Yahoo Finance 日線開盤價</p></>
                : <p className="mt-1">實際開盤資料將於 09:01 後自動查詢；應用程式需保持開啟，或之後重新開啟以補抓。</p>}</div>
              : <p className="text-sm text-slate-600 mt-2">{tradingDay ? '交易日 08:45 至開盤前需保持應用程式開啟，且基準資料有效，才能保存不可變快照。' : '尚未確認今天是台股交易日；不會保存快照。'}</p>}
            {actualOpenError && <p className="text-xs text-red-700 mt-2">實際開盤價讀取狀態：{actualOpenError}</p>}
            <p className="text-xs text-slate-500 mt-1">快照與實際開盤分開儲存在此瀏覽器；後續資料不會改寫已保存的前收基準。關閉應用程式時不會在背景擷取。</p>
          </section>

          <section className="glass-panel p-5 rounded-xl">
            <h3 className="font-bold text-slate-900">前收基準前向追蹤（僅本機）</h3>
            <p className="text-xs text-slate-500 mt-1">只比較已保存的開盤前前收基準與同日實際開盤。尚未累積 120 筆有效觀測前，數值僅供觀察，不宣稱準確度。</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
              {[
                ['tw2330', '2330'], ['twB', '006208'], ['twC', '00878']
              ].map(([fieldName, label]) => {
                const metric = metrics[fieldName];
                const enough = metric.validObservations >= MIN_FORWARD_OBSERVATIONS;
                return <div key={fieldName} className="border border-slate-200 rounded-lg p-3">
                  <div className="text-sm font-bold">{fieldName === 'twB' ? tickers.b : fieldName === 'twC' ? tickers.c : label}</div>
                  <div className="text-xs text-slate-500 mt-1">有效觀測：{metric.validObservations}</div>
                  <div className="text-sm mt-1">MAE：{metric.mae === null ? '—' : `${fmtError(metric.mae)} 元`}</div>
                  <div className="text-xs text-slate-500">方向準確率：{metric.directionalAccuracy === null ? '無方向預測' : `${metric.directionalAccuracy.toFixed(1)}% (${metric.directionalCalls} 筆)`}</div>
                  <div className="text-xs mt-1 text-slate-500">{enough ? '前向觀測已達 120 筆' : `觀察中：尚差 ${MIN_FORWARD_OBSERVATIONS - metric.validObservations} 筆`}</div>
                </div>;
              })}
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead><tr className="border-b border-slate-200 text-slate-500"><th className="py-2 pr-3">日期</th><th className="py-2 pr-3">2330 前收 / 開盤 / 誤差</th><th className="py-2 pr-3">{tickers.b} 前收 / 開盤 / 誤差</th><th className="py-2 pr-3">{tickers.c} 前收 / 開盤 / 誤差</th></tr></thead>
                <tbody>{recentHistory.map(snapshot => {
                  const actual = actualByDate.get(snapshot.targetDate)?.actualOpen;
                  const cells = ['tw2330', 'twB', 'twC'].map(fieldName => {
                    const predicted = snapshot.prices?.[fieldName];
                    const opened = actual?.[fieldName];
                    return opened > 0 ? `${fmt(predicted)} / ${fmt(opened)} / ${fmtError(Math.abs(predicted - opened))}` : `${fmt(predicted)} / 待取得 / —`;
                  });
                  return <tr key={snapshot.targetDate} className="border-b border-slate-100"><td className="py-2 pr-3">{snapshot.targetDate}</td>{cells.map((cell, index) => <td key={index} className="py-2 pr-3 font-mono">{cell}</td>)}</tr>;
                })}</tbody>
              </table>
              {!recentHistory.length && <p className="text-sm text-slate-500 py-3">尚無本機快照。快照會在台灣交易日 08:45 後、09:00 開盤前自動保存。</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
