// Two-Regime Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, its filters, a per-protocol detail drawer and the live-token
// reference. The drawer recomputes each row's implied value from the row's own published
// parts (TVL x category multiple x size/age adjustment), so the page and board.json are
// visibly the same arithmetic. No network: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('app');
  var params = new URLSearchParams(location.search);
  var state = {
    q: params.get('q') || '',
    category: params.get('category') || 'all',
    regime: params.get('regime') || 'all',
    wl: params.get('wl') === '1',
    tab: params.get('tab') || 'board',
    sort: params.get('sort') || 'rank',
    dir: 1,
    selected: params.get('detail') || null,
  };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtSigned(v) {
    return (v >= 0 ? '+' : '') + v.toFixed(3);
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  var V = DATA.validation;
  var C = DATA.counts;

  // --- header -------------------------------------------------------------
  var header = el('header', { class: 'top' },
    el('h1', null, 'TWO-', el('span', { class: 'teal', text: 'REGIME' }), ' ', el('span', { class: 'amber', text: 'RADAR' })),
    el('div', { class: 'tagline', text: 'Pre-token protocols priced twice: once by the peers whose TVL is rising, once by the peers whose TVL is falling back — because the snapshot says those two groups price a launch differently.' }),
    el('div', { class: 'meta', text: 'model ' + DATA.version + ' · snapshot ' + DATA.as_of + ' · ' + C.protocols + ' protocols · ' + C.pretoken + ' record no token' })
  );

  // --- the proof strip: the model grading itself, on frame one ------------
  function proofCell(k, v, small, s, sClass) {
    var val = el('div', { class: 'v' }, v);
    if (small) val.appendChild(el('small', { text: ' ' + small }));
    return el('div', { class: 'cell' },
      el('div', { class: 'k', text: k }), val,
      el('div', { class: 's' + (sClass ? ' ' + sClass : ''), text: s }));
  }
  var negLoo = V.loo.neg - V.loo.regime;
  var negTime = V.time.neg - V.time.regime;
  var proof = el('section', { class: 'proof' },
    proofCell('Leave-one-out error', V.loo.regime.toFixed(3), 'median |log10|',
      'baseline ' + V.loo.base.toFixed(3) + ' · within 2x on ' + Math.round(V.loo.within2x * 100) + '% of ' + V.peers + ' peers'),
    proofCell('Time-split error', V.time.regime.toFixed(3), 'median |log10|',
      'fit on ' + V.time.train + ' earlier-listed, priced ' + V.time.test + ' later · baseline ' + V.time.base.toFixed(3)),
    proofCell('Negative control', 'regimes swapped',
      null,
      'LOO ' + V.loo.neg.toFixed(3) + ' (' + fmtSigned(negLoo) + (Math.abs(negLoo) < 0.01 ? ', a wash' : '') + ') · time ' + V.time.neg.toFixed(3) + ' (' + fmtSigned(negTime) + ' worse)',
      negTime > 0 ? 'ok' : 'bad'),
    proofCell('Worst miss, unsmoothed', V.loo.worst.name + ' x' + V.loo.worst.factor, null,
      'the model ' + (V.loo.worst.direction === 'under' ? 'under' : 'over') + '-priced it on leave-one-out — read the rank ranges, not the points',
      'bad')
  );
  var mom = DATA.model.regimes.momentum;
  var rev = DATA.model.regimes.reversion;
  var method = el('p', { class: 'method' },
    'Fitted on the snapshot\u2019s own figures: ',
    el('b', { text: C.peers + ' launch-type tokens' }),
    ' that trade today (wrapper, bridge, liquid-staking and exchange tokens set aside — their caps price an underlying asset). The board ranks launch candidates only: protocols that record no token and pass the house\u2019s own screen (no wrapped, staked or bridged products, no versioned clones, no exchange products), ' + C.candidates + ' of the ' + C.pretoken + ' tokenless protocols. Momentum = 7-day TVL up (' + mom.peer_count + ' peers), mean-reversion = flat or down (' + rev.peer_count + '). A trend-TVL basis was tested and left out (leave-one-out \u0394 ' + fmtSigned(V.trendBasis.delta) + '). Implied value is this board\u2019s own claim, not a prediction that a token will exist.'
  );

  // --- controls -------------------------------------------------------------
  var search = el('input', { type: 'search', placeholder: 'Search name or slug', value: state.q });
  search.addEventListener('input', function () { state.q = search.value; renderTable(); });
  var catSel = el('select', null);
  catSel.appendChild(el('option', { value: 'all', text: 'All categories' }));
  var cats = [];
  DATA.rows.forEach(function (r) { var c = r.category || 'Uncategorized'; if (cats.indexOf(c) < 0) cats.push(c); });
  cats.sort().forEach(function (c) { catSel.appendChild(el('option', { value: c, text: c })); });
  catSel.value = state.category;
  catSel.addEventListener('change', function () { state.category = catSel.value; renderTable(); });
  var regSel = el('select', null,
    el('option', { value: 'all', text: 'Both regimes' }),
    el('option', { value: 'momentum', text: 'Momentum only' }),
    el('option', { value: 'reversion', text: 'Mean-reversion only' }));
  regSel.value = state.regime;
  regSel.addEventListener('change', function () { state.regime = regSel.value; renderTable(); });
  var wlBox = el('input', { type: 'checkbox' });
  wlBox.checked = state.wl;
  wlBox.addEventListener('change', function () { state.wl = wlBox.checked; renderTable(); });
  var tabBoard = el('button', { text: 'Pre-token board', onclick: function () { state.tab = 'board'; renderTable(); } });
  var tabLive = el('button', { text: 'Already trading', onclick: function () { state.tab = 'live'; renderTable(); } });
  var controls = el('nav', { class: 'controls' },
    search, catSel, regSel,
    el('label', { class: 'chk' }, wlBox, 'Watchlist only (' + C.watchlist + ')'),
    el('div', { class: 'tabs' }, tabBoard, tabLive)
  );

  var countLine = el('div', { class: 'count' });
  var tableHost = el('div', { id: 'board' });

  // --- the board --------------------------------------------------------------
  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.wl && !r.watchlist) return false;
      if (state.regime !== 'all' && r.regime !== state.regime) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorized') !== state.category) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
  }
  function sortedRows(rows) {
    var key = state.sort;
    var dir = state.dir;
    var val = function (r) {
      if (key === 'tvl') return r.tvl_usd;
      if (key === 'change') return r.change_7d === null ? -1e9 : r.change_7d;
      if (key === 'age') return r.age_days === null ? -1 : r.age_days;
      if (key === 'implied') return r.implied_value_usd;
      if (key === 'name') return r.name;
      return r.rank;
    };
    return rows.slice().sort(function (a, b) {
      var va = val(a); var vb = val(b);
      if (typeof va === 'string') return dir * va.localeCompare(vb);
      return dir * (va - vb);
    });
  }
  function sortHead(label, key) {
    var th = el('th', { text: label });
    th.addEventListener('click', function () {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'name' ? 1 : -1; }
      renderTable();
    });
    return th;
  }
  function boardTable() {
    var rows = sortedRows(filtered());
    countLine.textContent = rows.length + ' of ' + C.board + ' board rows · every watchlist protocol is on the board · click a row for its pricing and farm plan';
    var thead = el('tr', null,
      sortHead('#', 'rank'), sortHead('Protocol', 'name'), sortHead('Category', 'rank'), sortHead('Chain', 'rank'),
      sortHead('TVL', 'tvl'), sortHead('7d', 'change'), sortHead('Age', 'age'), sortHead('Regime', 'rank'),
      sortHead('Implied value', 'implied'), sortHead('x TVL', 'implied'));
    var body = el('tbody', null);
    rows.forEach(function (r) {
      var chip = el('span', { class: 'chip ' + (r.regime === 'momentum' ? 'mom' : 'rev'), text: r.regime === 'momentum' ? 'momentum' : 'mean-rev.' });
      var nameCell = el('td', null, r.name, r.watchlist ? el('span', { class: 'wl', text: 'watchlist' }) : null, el('span', { class: 'slug', text: r.slug }));
      var tr = el('tr', { class: state.selected === r.slug ? 'sel' : '' },
        el('td', { class: 'rank' }, String(r.rank), el('span', { class: 'rng', text: 'refits ' + r.rank_lo + '-' + r.rank_hi })),
        nameCell,
        el('td', { text: r.category || 'Uncategorized' }),
        el('td', { text: r.chains.length ? r.chains[0] : 'n/a' }),
        el('td', { text: fmtUsd(r.tvl_usd) }),
        el('td', { class: r.change_7d === null ? '' : (r.change_7d > 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { text: fmtAge(r.age_days) }),
        el('td', null, chip),
        el('td', { text: fmtUsd(r.implied_value_usd) }),
        el('td', { text: (r.implied_value_usd / r.tvl_usd).toFixed(2) + 'x' }));
      tr.addEventListener('click', function () { state.selected = r.slug; renderTable(); });
      body.appendChild(tr);
    });
    return el('table', null, el('thead', null, thead), body);
  }
  function liveTable() {
    countLine.textContent = 'The ' + DATA.live.length + ' largest tokens that already trade, at the snapshot\u2019s own figures. Shown for scale and kept off the board: a launch radar ranks what does not trade yet.';
    var thead = el('tr', null,
      el('th', { text: 'Protocol' }), el('th', { text: 'Symbol' }), el('th', { text: 'Category' }), el('th', { text: 'Chain' }),
      el('th', { text: 'TVL' }), el('th', { text: 'Market cap' }), el('th', { text: 'Cap / TVL' }));
    var body = el('tbody', null);
    DATA.live.forEach(function (r) {
      body.appendChild(el('tr', null,
        el('td', { text: r.name }),
        el('td', { text: r.symbol || 'n/a' }),
        el('td', { text: r.category || 'Uncategorized' }),
        el('td', { text: '—' }),
        el('td', { text: fmtUsd(r.tvl_usd) }),
        el('td', { text: fmtUsd(r.mcap_usd) }),
        el('td', { text: r.ratio === null ? 'n/a' : r.ratio.toFixed(2) + 'x' })));
    });
    return el('table', null, el('thead', null, thead), body);
  }

  // --- the detail drawer ------------------------------------------------------
  function drawer(row) {
    var fit = DATA.model.regimes[row.regime];
    var hasOwn = fit.multiples && Object.prototype.hasOwnProperty.call(fit.multiples, row.category || 'Uncategorized');
    var multLabel = hasOwn
      ? row.multiple.toFixed(3) + ' category multiple (' + (row.category || 'Uncategorized') + ', ' + row.regime + ' peers)'
      : row.multiple.toFixed(3) + ' regime median multiple (no ' + (row.category || 'Uncategorized') + ' peers in the ' + row.regime + ' set, so the regime\u2019s own median prices it)';
    var recomputed = Math.max(1, Math.round(row.tvl_usd * row.multiple * row.adjustment));
    var n = C.board;
    var band = el('div', { class: 'rangebar' },
      el('div', { class: 'band', style: 'left:' + ((row.rank_lo - 1) / n * 100) + '%;width:' + (Math.max(1, (row.rank_hi - row.rank_lo)) / n * 100) + '%' }),
      el('div', { class: 'mark', style: 'left:calc(' + ((row.rank - 0.5) / n * 100) + '% - 1px)' }));
    var steps = el('ol', { class: 'steps' });
    row.farm_steps.forEach(function (s) { steps.appendChild(el('li', { text: s })); });
    var d = el('aside', { class: 'drawer' },
      el('button', { class: 'x', text: 'x', onclick: function () { state.selected = null; renderTable(); } }),
      el('h2', { text: row.name }),
      el('div', { class: 'sub', text: (row.category || 'Uncategorized') + ' · ' + (row.chains.join(', ') || 'no chain listed') + ' · ' + row.slug + (row.watchlist ? ' · on the house watchlist' : ' · below the watchlist floor, found by the radar') }),
      el('span', { class: 'chip ' + (row.regime === 'momentum' ? 'mom' : 'rev'), text: row.regime === 'momentum' ? 'momentum regime' : 'mean-reversion regime' }),
      el('dl', { class: 'kv' },
        el('dt', { text: 'Board rank' }), el('dd', { text: '#' + row.rank + ' of ' + n }),
        el('dt', { text: 'Rank range (150 refits)' }), el('dd', { text: row.rank_lo + ' - ' + row.rank_hi }),
        el('dt', { text: 'TVL' }), el('dd', { text: fmtUsd(row.tvl_usd) }),
        el('dt', { text: '7-day TVL move' }), el('dd', { text: fmtPct(row.change_7d) }),
        el('dt', { text: 'Age (tracked since)' }), el('dd', { text: fmtAge(row.age_days) + (row.listed_at ? ' · ' + row.listed_at : '') }),
        el('dt', { text: 'Implied value' }), el('dd', { text: fmtUsd(row.implied_value_usd) })),
      el('h3', { class: 'sec', text: 'How the model prices it' }),
      el('div', { class: 'eq' },
        fmtUsd(row.tvl_usd) + ' TVL x ' + multLabel + ' x ' + row.adjustment.toFixed(3) + ' size/age adjustment = ',
        el('span', { class: 'big', text: fmtUsd(row.implied_value_usd) }),
        el('div', { class: 's', text: 'This page recomputed the product from the row\u2019s published parts: ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ' — matches board.json.' : ' — differs from board.json; trust board.json.') })),
      el('h3', { class: 'sec', text: 'Rank range across refits' }),
      band,
      el('div', { class: 's', text: 'Band: ranks ' + row.rank_lo + '-' + row.rank_hi + ' (10th-90th percentile of 150 bootstrap refits of the peer set). Wide band = the peers disagree about this one.' }),
      el('h3', { class: 'sec', text: 'Farm plan' }),
      steps);
    return d;
  }

  var footer = el('footer', null,
    el('b', { text: 'The model in one line: ' }),
    'implied = TVL x shrunk category median of cap/TVL among the regime\u2019s peers x exp(regime intercept ' +
    '(momentum ' + mom.intercept.toFixed(3) + ', mean-reversion ' + rev.intercept.toFixed(3) + ') + size slope ' + DATA.model.size_slope.toFixed(3) +
    ' x centred log TVL + age slope ' + DATA.model.age_slope.toFixed(3) + ' x years). Baseline for comparison: TVL x ' + DATA.model.global_median_ratio.toFixed(3) +
    ' (the peer set\u2019s single median). Data: ' + DATA.source + '. A protocol here records no token in that snapshot; that is DefiLlama\u2019s record, not proof none exists.'
  );

  function renderTable() {
    tabBoard.className = state.tab === 'board' ? 'on' : '';
    tabLive.className = state.tab === 'live' ? 'on' : '';
    tableHost.textContent = '';
    var old = app.querySelector('aside.drawer');
    if (old) old.remove();
    if (state.tab === 'live') {
      tableHost.appendChild(liveTable());
    } else {
      tableHost.appendChild(boardTable());
      if (state.selected) {
        var row = null;
        DATA.rows.forEach(function (r) { if (r.slug === state.selected) row = r; });
        if (row) app.appendChild(drawer(row));
      }
    }
  }

  app.appendChild(header);
  app.appendChild(proof);
  app.appendChild(method);
  app.appendChild(controls);
  app.appendChild(countLine);
  app.appendChild(tableHost);
  app.appendChild(footer);
  app.setAttribute('aria-busy', 'false');
  renderTable();
})();
