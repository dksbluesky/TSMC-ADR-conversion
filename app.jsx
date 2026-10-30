const { useEffect, useState } = React;
const Core = window.TSMCMarketData;
const OPENING_FORECAST_STORAGE_KEY = 'tsmcOpeningForecast.v1';

function readSavedOpeningForecast() {
  try {
    const value = JSON.parse(localStorage.getItem(OPENING_FORECAST_STORAGE_KEY) || 'null');
    return Core.validateOpeningForecastSnapshot(value) ? value : null;
  } catch { return null; }
}

const INITIAL_MANUAL = { adr: '', fx: '', tw2330: '', twB: '', twC: '' };
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
  const [clock, setClock] = useState(Date.now());
  const [savedForecast, setSavedForecast] = useState(readSavedOpeningForecast);

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

  const fetchProxiedText = async (rawUrl, validateText = value => value) => {
    const failures = [];
    for (const proxy of proxyUrls(rawUrl)) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(proxy.url, { signal: controller.signal, credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        if (proxy.wrapped) {
          const payload = JSON.parse(body);
          if (typeof payload.contents !== 'string') throw new Error('Proxy response has no text content.');
          return validateText(payload.contents, Date.now());
        }
        return validateText(body, Date.now());
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

  const fetchTaiwanCalendar = async () => {
    const rawUrl = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';
    return Core.parseTaiwanClosedDates(await fetchProxiedJson(rawUrl));
  };

  const fetchFubonExposure = async () => {
    return fetchProxiedText('https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId=006208',
      (html, retrievedAtMs) => Core.parseFubonTaiwan50Exposure(html, retrievedAtMs));
  };

  const fetchTwseDailyQuote = async (symbol, targetDate) => {
    const month = targetDate.slice(0, 7).replace('-', '');
    const rawUrl = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${month}01&stockNo=${symbol}&response=json`;
    const payload = await fetchProxiedJson(rawUrl);
    return Core.parseTwseDailyQuote(payload, symbol, targetDate, Date.now());
  };

  const savePremarketForecast = (quotes, sessionCalendar) => {
    const capturedAtMs = Date.now();
    const targetDate = Core.taipeiDateKey(capturedAtMs);
    const targetOpenMs = Core.zonedTimeToUtc(targetDate, 9, 0, Core.TIME_ZONES.TW);
    if (!sessionCalendar || !Core.isTaiwanTradingDay(targetDate, sessionCalendar) || capturedAtMs >= targetOpenMs) return;
    const previousDate = Core.previousTaiwanTradingDate(targetDate, sessionCalendar);
    const freshness = {
      tw2330: Core.taiwanQuoteFreshness(quotes.tw2330, previousDate, capturedAtMs),
      twB: Core.taiwanQuoteFreshness(quotes.twB, previousDate, capturedAtMs)
    };
    const estimates = Core.estimateOpeningPrices({
      nowMs: capturedAtMs, targetDate, adr: quotes.adr,
      quotes: { tw2330: quotes.tw2330, twB: quotes.twB }, freshness,
      exposure: quotes.exposure, calendar: sessionCalendar
    });
    const record = { targetDate, capturedAtMs, forecasts: estimates };
    if (!Core.validateOpeningForecastSnapshot(record)) return;
    try {
      const existing = readSavedOpeningForecast();
      const merged = Core.mergeOpeningForecastSnapshot(existing, record);
      if (!merged) return;
      if (merged !== existing) localStorage.setItem(OPENING_FORECAST_STORAGE_KEY, JSON.stringify(merged));
      setSavedForecast(merged);
    } catch (error) {
      throw new Error(`開盤估計無法保存：${error?.message || '本機儲存失敗'}`);
    }
  };

  const runAutoSync = async () => {
    setLoading(true);
    setErrors([]);
    const names = ['adr', 'tw2330', 'twB', 'twC', 'fx', 'exposure'];
    const requests = [
      fetchYahoo('TSM', 'US'), fetchYahoo('2330.TW', 'TW'),
      fetchYahoo(`${tickers.b}.TW`, 'TW'), fetchYahoo(`${tickers.c}.TW`, 'TW'),
      fetch('https://open.er-api.com/v6/latest/USD').then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }).then(json => Core.validateFxResponse(json)), tickers.b === '006208' ? fetchFubonExposure() : Promise.resolve(null)
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
    if (calendarResult) {
      try { savePremarketForecast(next, calendarResult); }
      catch (error) { failures.push(error.message); }
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
  const expectedTaiwanCloseDate = Core.latestCompletedTaiwanSessionDate(clock, calendar);
  const taiwanFreshness = Object.fromEntries(['tw2330', 'twB', 'twC'].map(key => [
    key,
    inputs[key]?.source === '手動輸入' ? 'MANUAL' : Core.taiwanQuoteFreshness(bundle[key], expectedTaiwanCloseDate, clock)
  ]));
  const currentTaiwanDate = Core.taipeiDateKey(clock);
  const forecasts = savedForecast?.targetDate === currentTaiwanDate ? savedForecast.forecasts : {
    tw2330: { status: 'UNAVAILABLE', reason: '尚未保存符合目標交易日與時段條件的開盤估計。' },
    twB: { status: 'UNAVAILABLE', reason: '尚未保存符合目標交易日與時段條件的開盤估計。' },
    twC: { status: 'NO_ESTIMATE', reason: 'No validated independent overnight signal is available for 00878.' }
  };
  const adrOvernightMove = Number.isFinite(previousAdr) && previousAdr > 0 && inputs.adr?.price > 0
    ? (inputs.adr.price / previousAdr - 1) * 100 : null;
  const completeSync = (() => {
    try { Core.validateBundle(bundle); }
    catch { return false; }
    const validEtfWeight = tickers.b !== '006208' || (
      Number.isFinite(bundle.exposure?.weight) && bundle.exposure.weight > 0 && bundle.exposure.weight <= 1 &&
      bundle.exposure.sessionDate === expectedTaiwanCloseDate
    );
    return validEtfWeight && ['tw2330', 'twB', 'twC'].every(key => taiwanFreshness[key] === 'FRESH');
  })();
  const freshnessText = key => {
    const latest = bundle[key]?.latest?.sessionDate || '—';
    const expected = expectedTaiwanCloseDate || '交易日曆未驗證';
    return taiwanFreshness[key] === 'MANUAL'
      ? '行情狀態：MANUAL（手動備援）'
      : `行情狀態：${taiwanFreshness[key]}；最新收盤 ${latest}；應為 ${expected}`;
  };

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
    if (item.source === '手動輸入') {
      if (key !== 'fx') return `手動輸入；記錄於 ${new Date(item.timestampMs).toLocaleString('zh-TW')}`;
      const taipeiTime = new Intl.DateTimeFormat('zh-TW', {
        timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23'
      }).format(item.timestampMs);
      return `手動輸入；記錄於 ${taipeiTime} (Asia/Taipei)`;
    }
    const zone = key === 'adr' ? 'America/New_York' : 'Asia/Taipei';
    const options = { timeZone: zone, dateStyle: 'medium', timeStyle: 'medium' };
    if (key === 'fx') options.hourCycle = 'h23';
    const formattedTime = new Intl.DateTimeFormat('zh-TW', options).format(item.timestampMs);
    return `${formattedTime} (${zone})`;
  };
  const exactMarketCloseTime = (timestamp, market) => Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('zh-TW', {
      timeZone: market === 'US' ? 'America/New_York' : 'Asia/Taipei',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23'
    }).format(timestamp) + (market === 'US' ? ' ET' : ' 台灣時間') : '—';
  const pct = value => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)}%` : '—';
  const targetPreviousTaiwanDate = Core.previousTaiwanTradingDate(currentTaiwanDate, calendar);
  const priorCloseForCard = (key, forecast) => {
    if (forecast?.status === 'ESTIMATE') return {
      price: forecast.previousClose, date: forecast.previousCloseDate, label: '預估基準前收', source: '已驗證'
    };
    if (taiwanFreshness[key] === 'MANUAL' && Number.isFinite(inputs[key]?.price)) return {
      price: inputs[key].price, date: '', label: '手動前收', source: '手動備援'
    };
    const quote = bundle[key];
    const candidate = quote?.latest?.sessionDate === currentTaiwanDate ? quote?.previous : quote?.latest;
    const candidateQuote = candidate ? { ...quote, latest: candidate } : null;
    if (Core.taiwanQuoteFreshness(candidateQuote, targetPreviousTaiwanDate, clock) !== 'FRESH') return null;
    return { price: candidate.price, date: candidate.sessionDate, label: '已驗證前收', source: '已驗證' };
  };
  const estimateCard = (symbol, name, forecast, key) => {
    const isEstimate = forecast?.status === 'ESTIMATE';
    const historical = isEstimate && (forecast.targetDate !== currentTaiwanDate ||
      clock >= Core.zonedTimeToUtc(forecast.targetDate, 9, 0, Core.TIME_ZONES.TW));
    const changeClass = forecast?.changePercent > 0 ? 'text-up' : forecast?.changePercent < 0 ? 'text-down' : 'text-slate-700';
    const previousClose = priorCloseForCard(key, forecast);
    const unavailableText = key === 'twC' ? '無預估模型' : '尚無有效估計';
    return <article key={symbol} className="forecast-card glass-panel p-4 rounded-xl flex flex-col">
      <div className="flex justify-between items-start gap-2 min-w-0">
        <h3 className="font-bold text-slate-900 min-w-0">{symbol} <span className="font-medium">{name}</span></h3>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] leading-tight font-medium ${isEstimate ? 'bg-slate-100 text-slate-600' : 'bg-slate-50 text-slate-500'}`}>
          {isEstimate ? historical ? '歷史估計' : '暫定估計' : '暫無估計'}
        </span>
      </div>
      <div className="forecast-main mt-3">
        {isEstimate ? <>
          <div className="forecast-price text-3xl font-mono font-bold text-slate-950 leading-none" aria-label={`估計開盤價 ${fmt(forecast.estimatedOpen)}`}>{fmt(forecast.estimatedOpen)}</div>
          <div className={`mt-2 text-sm font-semibold ${changeClass}`}>{pct(forecast.changePercent)}</div>
        </> : <div className="forecast-state text-sm font-semibold text-slate-500">{unavailableText}</div>}
      </div>
      <div className="forecast-baseline mt-auto pt-3 border-t border-slate-100 flex items-end justify-between gap-2">
        <div className="text-xs text-slate-500">{previousClose?.label || '前收尚未驗證'}
          {previousClose?.date && <span className="block mt-0.5 text-[11px]">{previousClose.date.replace(/-/g, '/')}</span>}
          {previousClose?.source === '手動備援' && <span className="block mt-0.5 text-[11px]">手動備援</span>}
        </div>
        <div className="text-base font-mono font-semibold tabular-nums text-slate-700">{previousClose ? fmt(previousClose.price) : '—'}</div>
      </div>
    </article>;
  };
  const forecastDetails = (symbol, name, forecast, key) => {
    const isEstimate = forecast?.status === 'ESTIMATE';
    const isEtf = key === 'twB';
    const adrText = isEstimate
      ? `TSM ADR：${fmt(forecast.adrPrevious.price)}（${forecast.adrPrevious.sessionDate}，${exactMarketCloseTime(forecast.adrPrevious.closeTimestampMs, 'US')}）→ ${fmt(forecast.adrLatest.price)}（${forecast.adrLatest.sessionDate}，${exactMarketCloseTime(forecast.adrLatest.closeTimestampMs, 'US')}）`
      : '';
    return <article key={symbol} className="rounded-lg bg-slate-50 p-3 space-y-2 text-xs text-slate-600 leading-relaxed">
      <h3 className="font-semibold text-slate-800">{symbol} {name}</h3>
      {isEstimate ? <>
        <p>估計建立於：{exactMarketCloseTime(forecast.capturedAtMs, 'TW')}；目標交易日：{forecast.targetDate}。前收 {fmt(forecast.previousClose)}，日期 {forecast.previousCloseDate}，時間 {exactMarketCloseTime(forecast.previousCloseTimestampMs, 'TW')}。</p>
        <p>公式：{isEtf
          ? `前收 × [1 + ADR 報酬率 × TSMC 權重（${(forecast.exposureWeight * 100).toFixed(2)}%）]`
          : '前收 × (1 + TSM ADR 隔夜報酬率)'}</p>
        <p>ADR 隔夜報酬：{pct(forecast.adrReturn * 100)}。{adrText}</p>
        {isEtf && <p>權重來源：富邦投信 006208 持股；資料日 {forecast.exposureDate}；擷取 {exactMarketCloseTime(forecast.exposureRetrievedAtMs, 'TW')}。來源：<a className="source-link" href="https://www.fubon.com/asset-management/fund/info/006208" target="_blank" rel="noreferrer">富邦投信 006208</a>。</p>}
        <p>假設：{isEtf
          ? 'TSMC 隔夜報酬僅按基金當日 TSMC 持股權重傳導；其他成分股、匯率、追蹤誤差及折溢價變動視為 0。'
          : '假設 TSMC 普通股與 ADR 隔夜百分比報酬 1:1；未以 ADR 折算價推估。'} USD/TWD 變動未納入；Yahoo 日線時間戳是 K 棒時間，收盤時點依交易時段推算，非來源發布時間。尚未經回測驗證。</p>
      </> : <p>{forecast?.reason || (key === 'twC' ? '此標的目前沒有可用的獨立隔夜市場訊號。' : '尚未保存符合目標交易日與時段條件的開盤估計。')}</p>}
      <p>市場資料來源：<a className="source-link" href="https://query1.finance.yahoo.com/v8/finance/chart/TSM" target="_blank" rel="noreferrer">Yahoo Finance Chart API</a>；台股收盤與交易日資料：<a className="source-link" href="https://www.twse.com.tw/" target="_blank" rel="noreferrer">TWSE</a>。</p>
    </article>;
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
    <div className="page-shell min-h-screen p-4 md:p-8 max-w-7xl mx-auto">
      <header className="app-header flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-slate-900">台股開盤預估</h1>
          <p className="text-xs text-slate-500 mt-1">Target session · {currentTaiwanDate.replace(/-/g, '/')}</p>
        </div>
        <div className="header-controls flex items-center gap-2">
          <span className="compact-status" title={loading ? '正在讀取資料來源' : completeSync ? '行情資料已通過驗證' : '行情資料尚未完整通過驗證'}>
            <span className={`status-dot ${loading ? 'status-yellow' : completeSync ? 'status-green' : 'status-red'}`}></span>
            {loading ? '同步中' : completeSync ? '資料完整' : '部分資料'}
          </span>
          <span className="provisional-label">暫定模型</span>
          <button onClick={runAutoSync} disabled={loading} className="btn-live text-white px-3 py-2 rounded-lg text-sm font-semibold min-w-[88px]">
            {loading ? '同步中…' : '↻ 重整'}
          </button>
        </div>
      </header>

      <section className="mb-4" aria-label="台股開盤預估卡片">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {estimateCard('2330', '台積電', forecasts.tw2330, 'tw2330')}
          {estimateCard(tickers.b, '富邦台50', forecasts.twB, 'twB')}
          {estimateCard(tickers.c, '國泰永續高股息', forecasts.twC, 'twC')}
        </div>
      </section>

      <section className="market-overview grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-3 mb-4" aria-label="隔夜市場與資料狀態">
        <div className="market-summary glass-panel rounded-xl p-3 md:p-4">
          <h2 className="text-xs font-semibold text-slate-500 mb-2">隔夜市場</h2>
          <div className="grid grid-cols-3 gap-2">
            <div><div className="summary-label">TSM ADR</div><div className="summary-value">{fmt(inputs.adr?.price)}</div></div>
            <div><div className="summary-label">ADR 隔夜變動</div><div className={`summary-value ${adrOvernightMove > 0 ? 'text-up' : adrOvernightMove < 0 ? 'text-down' : ''}`}>{Number.isFinite(adrOvernightMove) ? `${adrOvernightMove > 0 ? '+' : ''}${adrOvernightMove.toFixed(2)}%` : '—'}</div></div>
            <div><div className="summary-label">USD/TWD 參考</div><div className="summary-value">{fmt(inputs.fx?.price)}</div></div>
          </div>
        </div>
        <div className="data-summary glass-panel rounded-xl p-3 md:p-4">
          <h2 className="text-xs font-semibold text-slate-500 mb-2">資料與模型</h2>
          <div className="data-summary-row"><span>行情驗證</span><strong>{loading ? '同步中' : completeSync ? '完整' : '部分'}</strong></div>
          <div className="data-summary-row"><span>估計狀態</span><strong>暫定・未回測</strong></div>
        </div>
      </section>

      <details className="glass-panel rounded-xl px-4 md:px-5 mb-3">
        <summary className="disclosure-summary font-semibold text-slate-800">估計公式、假設與資料時間</summary>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 pb-4">
          {forecastDetails('2330', '台積電', forecasts.tw2330, 'tw2330')}
          {forecastDetails(tickers.b, '富邦台50', forecasts.twB, 'twB')}
          {forecastDetails(tickers.c, '國泰永續高股息', forecasts.twC, 'twC')}
        </div>
      </details>

      <details className="glass-panel rounded-xl px-4 md:px-5 mb-4">
        <summary className="disclosure-summary font-semibold text-slate-800">行情來源、驗證與手動覆寫</summary>
        {(errors.length > 0 || calendarError) && <div className="pb-3 text-xs text-rose-700">
          {errors.map(error => <div key={error}>{error}</div>)}
          {calendarError && <div>{calendarError}</div>}
        </div>}
        {lastUpdated && <p className="pb-3 text-xs text-slate-500">最近檢查：{new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(lastUpdated)}</p>}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pb-4">
          <section className="bg-slate-50 border border-slate-100 p-4 rounded-lg space-y-3 min-w-0">
            <h3 className="text-slate-900 font-bold">美股 ADR (TSM) 與匯率</h3>
            {field('adr', '最新已完成美股收盤價')}
            <div className="text-xs text-slate-500 break-words">ADR 交易日：{bundle.adr?.latest?.sessionDate || '—'}；Yahoo K 棒時間：{sourceTime(inputs.adr, 'adr')}</div>
            <div className="text-xs text-slate-500">前一個已完成收盤：{fmt(previousAdr)} ({bundle.adr?.previous?.sessionDate || '—'})</div>
            <div className="text-xs text-slate-500">ADR 前收至最新收盤變動：{Number.isFinite(adrOvernightMove) ? `${adrOvernightMove > 0 ? '+' : ''}${adrOvernightMove.toFixed(2)}%` : '—'}（市場背景，非開盤預測）</div>
            <div className="text-xs text-slate-500 break-words">來源：Yahoo Finance chart API（cors.dev 與既有代理備援）；<a className="source-link" href="https://query1.finance.yahoo.com/v8/finance/chart/TSM" target="_blank" rel="noreferrer">Yahoo Finance</a></div>
            {field('fx', inputs.fx?.source === '手動輸入' ? 'USD/TWD 匯率（手動輸入）' : 'USD/TWD 每日參考匯率（非即時）', '0.01')}
            <div className="text-xs text-slate-500 break-words">{inputs.fx?.source === '手動輸入' ? '匯率手動輸入時間（台灣時間）' : '匯率來源更新時間（台灣時間；來源發布時間，非擷取時間）'}：{sourceTime(inputs.fx, 'fx')}；<a className="source-link" href="https://open.er-api.com/v6/latest/USD" target="_blank" rel="noreferrer">匯率來源</a></div>
          </section>

          <section className="bg-slate-50 border border-slate-100 p-4 rounded-lg space-y-3 min-w-0">
            <h3 className="text-slate-900 font-bold">台股最新已完成收盤 (基準)</h3>
            {field('tw2330', '2330 台積電', '0.01')}
            <div className="text-xs text-slate-500 break-words">{freshnessText('tw2330')}；來源 {quoteSource('tw2330')}；市場時間 {sourceTime(inputs.tw2330, 'tw2330')}{quoteRetrievedAt('tw2330')}；<a className="source-link" href="https://www.twse.com.tw/" target="_blank" rel="noreferrer">TWSE</a></div>
            <div className="manual-ticker-row flex items-center justify-between gap-2"><input aria-label="006208 ticker" type="text" className="input-field w-24 px-2 py-1 rounded text-xs" value={tickers.b} onChange={e => setTickers(v => ({ ...v, b: e.target.value.trim() }))} />
              <input aria-label={`${tickers.b} previous close`} type="number" step="0.01" className="input-field w-32 px-2 py-1 rounded text-right text-slate-700" placeholder="自動資料 / 手動備援" value={inputValue('twB')} onFocus={() => revealManualValue('twB')} onBlur={() => formatManualValue('twB')} onChange={e => updateManual('twB', e.target.value)} /></div>
            <div className="text-xs text-slate-500 break-words">{freshnessText('twB')}；來源 {quoteSource('twB')}；市場時間 {sourceTime(inputs.twB, 'twB')}{quoteRetrievedAt('twB')}</div>
            <div className="manual-ticker-row flex items-center justify-between gap-2"><input aria-label="00878 ticker" type="text" className="input-field w-24 px-2 py-1 rounded text-xs" value={tickers.c} onChange={e => setTickers(v => ({ ...v, c: e.target.value.trim() }))} />
              <input aria-label={`${tickers.c} previous close`} type="number" step="0.01" className="input-field w-32 px-2 py-1 rounded text-right text-slate-700" placeholder="自動資料 / 手動備援" value={inputValue('twC')} onFocus={() => revealManualValue('twC')} onBlur={() => formatManualValue('twC')} onChange={e => updateManual('twC', e.target.value)} /></div>
            <div className="text-xs text-slate-500 break-words">{freshnessText('twC')}；來源 {quoteSource('twC')}；市場時間 {sourceTime(inputs.twC, 'twC')}{quoteRetrievedAt('twC')}</div>
            <p className="text-xs text-slate-500">欄位可手動覆寫自動資料；輸入值會標示為手動備援。</p>
          </section>
        </div>
      </details>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
