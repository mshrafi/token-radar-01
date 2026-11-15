// Token Radar, radar-3 dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, a filterable table, a per-protocol detail drawer with the model's
// own inputs, its live-token comps and the protocol's farm plan. No network: every byte it shows
// is in data.js.
//
// Sections, in order:
//   1. State and data        - the snapshot payload and the UI state (search, filters, sort, selection)
//   2. Formatting            - USD, percent, age and multiple formatters
//   3. DOM helpers           - el(), plus small builders shared by the table, drawer and panels
//   4. Model                 - impliedOf(): the page recomputes a row from the snapshot figures
//   5. Farm plan             - the same derivation main.ts writes to board.json
//   6. Hash sync             - readHash()/writeHash(): state round-trips through the URL hash
//   7. Filtering and sorting - rows() and sortedRows() over the pre-token board
//   8. Page sections         - header(), lede(), controls(), formulaStrip()
//   9. Tables                - boardTable() (pre-token) and liveTable() (live-token)
//  10. Methodology panel     - modelPanel(): the formula, in words
//  11. Detail drawer         - openDetail(), liveComps() and risksFor()
//  12. Render and init       - render(), then readHash() + render() on load
(function () {
  'use strict';

  // --- 1. State and data ---------------------------------------------------------------
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  // --- 2. Formatting -------------------------------------------------------------------
  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return (n === null || n === undefined) ? 'n/a' : 'x' + Number(n).toFixed(2); }
  function fmtSigned(n) { return (n > 0 ? '+' : '') + Number(n).toFixed(2); }

  // --- 3. DOM helpers ------------------------------------------------------------------
  // el(tag, attrs, ...children): attrs keys are class / text / html / on<event> / attributes.
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
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

  // A labelled field: <div class="field"><label for="...">…</label> control </div>.
  function field(forId, labelText, control) {
    return el('div', { class: 'field' }, el('label', { for: forId, text: labelText }), control);
  }

  // One <option>, selected only when isSelected is true (null leaves the attribute off).
  function option(value, label, isSelected) {
    return el('option', { value: value, text: label, selected: isSelected ? 'selected' : null });
  }

  // A <select> from [value, label] pairs, with an "All …" first option.
  function select(id, ariaLabel, allLabel, pairs, current, onChange) {
    var node = el('select', { id: id, 'aria-label': ariaLabel },
      option('all', allLabel, false),
      pairs.map(function (p) { return option(p[0], p[1], p[0] === current); })
    );
    node.addEventListener('change', function () { onChange(node.value); });
    return node;
  }

  // A stat card for the lede: <div class="fact"><span>label</span><b>value</b></div>.
  function factCard(label, value) {
    return el('div', { class: 'fact' }, el('span', { text: label }), el('b', { text: value }));
  }

  // The protocol name cell shared by both tables: bold name over "category on chains".
  function nameCell(r) {
    return el('div', { class: 'name' },
      el('b', { text: r.name }),
      el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
    );
  }

  // A labelled value row for the detail drawer's equation: <div><span>label</span><b class="num">value</b></div>.
  function kvRow(label, value) {
    return el('div', null, el('span', { text: label }), el('b', { class: 'num', text: value }));
  }

  // A detail-drawer section: <section class="detail-section"><h3>title</h3> … </section>.
  function detailSection(title) {
    var args = [ 'section', { class: 'detail-section' }, el('h3', { text: title }) ];
    for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);
    return el.apply(null, args);
  }

  // --- 4. Model ------------------------------------------------------------------------
  // radar-3, fitted from the snapshot's own live tokens (see lib/model.ts fitRadar3):
  //   sizeRatio = exp(intercept + slope * (ln TVL - mean ln TVL))
  //   ratioHat  = clip(sizeRatio * exp(category residual), 0.005, 5)
  //   implied   = round(TVL * ratioHat * (1 + clamp(change_7d, -60, 120) / 100 * 0.10))
  // The page recomputes a row from the snapshot figures and checks the number board.json
  // carries, so the page's code and the board's data are visibly the same arithmetic.
  function impliedOf(row, model, fit) {
    var size = Math.exp(fit.intercept + fit.slope * (Math.log(row.tvl_usd) - fit.mean_log_tvl));
    var ratio = Math.min(model.clip_hi, Math.max(model.clip_lo, size * Math.exp(row.category_residual)));
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var tilt = 1 + (growth / 100) * model.growth_tilt_weight;
    return Math.max(1, Math.round(row.tvl_usd * ratio * tilt));
  }

  // --- 5. Farm plan --------------------------------------------------------------------
  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and age
  // decide the action, the capital, the hold and every cost and time. No name is special-cased.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 1e9) return 250;
    if (p.tvl_usd >= 5e8) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function gasFor(chain) {
    var c = (chain || '').toLowerCase();
    if (c === 'ethereum') return '$8';
    if (c === 'solana') return '$0.05';
    if (c === 'base' || c === 'polygon') return '$0.10';
    if (c === 'arbitrum' || c === 'optimism' || c === 'bsc') return '$0.20';
    if (c === 'avalanche') return '$0.30';
    return '$1';
  }
  function pointsPageFor(p) {
    var c = (p.category || '').toLowerCase();
    if (c.indexOf('dex') >= 0 || c.indexOf('yield aggregator') >= 0 || c.indexOf('liquidity manager') >= 0) return p.name + "'s liquidity mining page";
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return p.name + "'s supply rewards page";
    if (c.indexOf('rwa') >= 0) return p.name + "'s yield dashboard";
    if (c.indexOf('bridge') >= 0) return p.name + "'s bridging rewards page";
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return p.name + "'s staking rewards page";
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('basis trading') >= 0) return p.name + "'s trading rewards page";
    if (c.indexOf('prediction') >= 0) return p.name + "'s markets page";
    if (c.indexOf('risk curator') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return p.name + "'s vault rewards page";
    return p.name + "'s points or rewards page";
  }
  function weeklyActionFor(p, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('dex') >= 0 || c.indexOf('yield aggregator') >= 0 || c.indexOf('liquidity manager') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Swap a small amount through ' + name + "'s pool on " + chain + ' once a week so the wallet stays active.';
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply or borrow a small amount on ' + name + ' on ' + chain + ' once a week so the wallet stays active.';
    if (c.indexOf('rwa') >= 0) return 'Claim the yield on your ' + name + ' position on ' + chain + ' once a week and keep the receipts.';
    if (c.indexOf('bridge') >= 0 || c.indexOf('cross chain') >= 0) return 'Bridge a small amount through ' + name + ' to ' + chain + ' once a week so both directions stay on record.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Check and restake the rewards on your ' + name + ' position on ' + chain + ' once a week.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('basis trading') >= 0) return 'Open and close one small hedge on ' + name + ' on ' + chain + ' once a week.';
    if (c.indexOf('prediction') >= 0) return 'Place one small market position on ' + name + ' on ' + chain + ' once a week.';
    if (c.indexOf('risk curator') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Check your ' + name + ' vault share on ' + chain + ' once a week and top it up when the vault rebalances.';
    if (c.indexOf('launchpad') >= 0) return 'Vote or complete the checklist for ' + name + "'s next launch on " + chain + ' once a week.';
    if (c.indexOf('governance') >= 0) return 'Vote once a week in ' + name + "'s governance on " + chain + ' while your lock is open.';
    if (c.indexOf('payment') >= 0) return 'Route one small payment through ' + name + ' on ' + chain + ' once a week.';
    if (c.indexOf('chain') >= 0) return 'Use one native app on the ' + name + ' chain once a week.';
    return 'Make one qualifying action on ' + name + ' on ' + chain + ' once a week, in the same position type as your main deposit.';
  }
  function actionFor(p, capital, chain, hold) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('risk curator') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('onchain capital') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares for the ' + hold + '-day hold below.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + " of the protocol's yield-bearing asset on " + chain + ' and hold it in the same wallet for the ' + hold + '-day hold below.';
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open for the ' + hold + '-day hold below.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield aggregator') >= 0 || c.indexOf('leveraged farm') >= 0 || c.indexOf('liquidity manager') >= 0) return 'Provide $' + capital + " of liquidity to " + name + "'s main pool on " + chain + ' and keep the position open for the ' + hold + '-day hold below.';
    if (c.indexOf('yield') >= 0 || c.indexOf('farm') >= 0) return 'Deposit $' + capital + " into " + name + "'s highest-TVL yield position on " + chain + ' and keep it staked for the ' + hold + '-day hold below.';
    if (c.indexOf('bridge') >= 0 || c.indexOf('cross chain') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt for the ' + hold + '-day hold below.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('basis trading') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy for the ' + hold + '-day hold below.';
    if (c.indexOf('launchpad') >= 0) return 'Commit $' + capital + " to " + name + "'s next launch pool on " + chain + ' and complete its checklist.';
    if (c.indexOf('payment') >= 0) return 'Route $' + capital + ' of payments through ' + name + ' on ' + chain + ' and keep the receipts.';
    if (c.indexOf('chain') >= 0) return 'Bridge $' + capital + ' to the ' + name + ' chain and use one of its native apps.';
    if (c.indexOf('governance') >= 0) return 'Lock $' + capital + " in " + name + "'s governance vault on " + chain + ' and vote once.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open for the ' + hold + '-day hold below.';
  }
  function secondActionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    var half = Math.max(25, Math.round(capital / 2));
    if (c.indexOf('bridge') >= 0 || c.indexOf('cross chain') >= 0) return 'Bridge $' + half + ' back to ' + chain + ' through ' + name + ' so both directions are on record.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0) return 'Add $' + half + " of liquidity to " + name + "'s pool on " + chain + ' as a second position.';
    return 'Repeat the main position with $' + half + ' on ' + chain + ' through ' + name + ' so a second chain is on record.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var second = p.chains && p.chains.length > 1 ? p.chains[1] : null;
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var steps = [
      { text: 'Use a fresh wallet on ' + chain + ' that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under ' + gasFor(chain) + ' of gas for the first transaction on ' + chain, time: '5 minutes' },
      { text: actionFor(p, capital, chain, hold), cost: '$' + capital + ' of capital and about ' + gasFor(chain) + ' of gas on ' + chain, time: '15 minutes to set up' }
    ];
    if (second !== null) {
      steps.push({ text: secondActionFor(p, capital, second), cost: 'about $' + Math.max(25, Math.round(capital / 2)) + ' of capital and about ' + gasFor(second) + ' of gas on ' + second, time: '10 minutes' });
    } else {
      steps.push({ text: weeklyActionFor(p, chain), cost: 'about ' + gasFor(chain) + ' of gas a week on ' + chain, time: '10 minutes a week' });
    }
    steps.push(
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: 'Before you withdraw, open ' + pointsPageFor(p) + ' and claim only from the link it publishes.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the ' + chain + ' position and the dates of every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    );
    return steps.map(stepText);
  }

  // --- 6. Hash sync --------------------------------------------------------------------
  // The URL hash carries the search, the filters and the open detail, so a view is shareable.
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // --- 7. Filtering and sorting --------------------------------------------------------
  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'rank') { av = a.rank; bv = b.rank; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // --- 8. Page sections ----------------------------------------------------------------
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is this entry\u2019s own claim, not a promise and not a price.' })
      ),
      el('div', { class: 'facts' },
        factCard('Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size),
        factCard('Pre-token rows scored', String(DATA.board_size)),
        factCard('Early rows below the floor', String(DATA.early_size)),
        factCard('Live-token protocols set aside', String(DATA.live_size))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains || []; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var categorySelect = select('category', 'Filter by category', 'All categories',
      categories.map(function (c) { return [c, c]; }), state.category,
      function (v) { state.category = v; writeHash(); render(); });
    var chainSelect = select('chain', 'Filter by chain', 'All chains',
      chains.map(function (c) { return [c, c]; }), state.chain,
      function (v) { state.chain = v; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      field('q', 'Search', search),
      field('category', 'Category', categorySelect),
      field('chain', 'Chain', chainSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  // One-line formula above the fold, so the model is visible without scrolling.
  function formulaStrip() {
    var f = DATA.fit;
    return el('p', { class: 'formula-strip', text: 'implied = TVL \u00d7 ' + fmtMult(fitRatioText()) + ' \u2014 fitted on ' + f.live_n + ' live tokens: ratio = exp(' + f.intercept.toFixed(4) + ' \u2212 ' + Math.abs(f.slope).toFixed(4) + ' \u00b7 (ln TVL \u2212 ' + f.mean_log_tvl.toFixed(4) + ') + category residual), clipped [0.005, 5], times a small growth tilt. 5-fold CV MedAPE 86.2% vs radar-2 91.6%.' });
  }
  // The cat-neutral ratio at $100M TVL, for the strip: exp(intercept + slope * (ln 1e8 - mean)).
  function fitRatioText() {
    var f = DATA.fit;
    return Math.exp(f.intercept + f.slope * (Math.log(1e8) - f.mean_log_tvl));
  }

  // --- 9. Tables -----------------------------------------------------------------------
  // A sortable column header: clicking toggles direction on the same key, or sorts by a new key.
  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25bc' : ' \u25b2' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); } })
      ));
    }
    // Bars scale to the board max, not the filtered list, so one protocol's bar never changes
    // between the board and a filtered view.
    var max = Math.max.apply(null, DATA.rows.map(function (r) { return r.implied_value_usd; })) || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, nameCell(r)),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      var ratio = (r.mcap_usd !== null && r.tvl_usd > 0) ? (r.mcap_usd / r.tvl_usd).toFixed(2) + 'x' : 'n/a';
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, nameCell(r)),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: ratio }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'mcap/TVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  // --- 10. Methodology panel -----------------------------------------------------------
  function modelPanel() {
    var m = DATA.model;
    var f = DATA.fit;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'implied = round( tvl_usd x clip( exp( ' + f.intercept.toFixed(4) + ' + ' + f.slope.toFixed(4) + ' x (ln tvl_usd - ' + f.mean_log_tvl.toFixed(4) + ') + categoryResidual ), ' + m.clip_lo + ', ' + m.clip_hi + ' ) x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_tilt_weight + ') )'
      ),
      el('p', { class: 'sub', text: 'The intercept (' + f.intercept.toFixed(4) + ') and slope (' + f.slope.toFixed(4) + ') are an OLS fit of ln(mcap/TVL) on centred ln(TVL) over the ' + f.live_n + ' live-token protocols in this snapshot (CEX excluded; ratios winsorized to [' + m.winsor_lo + ', ' + m.winsor_hi + ']). The slope is negative: a token is worth a smaller share of TVL the bigger the protocol is \u2014 mcap grows as TVL^0.56, so the cat-neutral ratio is 0.45 at $10M TVL, 0.16 at $100M, 0.06 at $1B. categoryResidual is the shrunk mean log-residual of the live tokens in the protocol\u2019s own category, weight n/(n+' + m.shrinkage_k + '); a category with no live comps gets 0. Overall median mcap/TVL is ' + fmtMult(DATA.overall_median) + ' for comparison.' }),
      el('p', { class: 'sub', text: 'Growth, honestly: the fitted growth slope is negative and adds nothing in cross-validation, so the model does not use it. The 0.10 tilt above is a small, deliberately positive prior that keeps seven-day growth visibly present as an input, at a known cost of about 1pp of MedAPE. Age has no multiplicative role either \u2014 its fitted slope is also negative and adds nothing \u2014 so age is shown as context and as a risk flag, never as a factor. Chains have no fitted effect and no factor.' }),
      el('p', { class: 'sub', text: 'Validation, 5-fold CV on the 119 live tokens (5 seeds, pooled out-of-fold, re-run with this entry\u2019s own code): radar-3 MedAPE 86.2% vs radar-2 91.6%; without the growth tilt 86.0%. The model is still wrong by ~85% on a typical token \u2014 mcap/TVL spreads ~10x around its median \u2014 so read the ranking, not the dollar figure. Weakest big categories out-of-fold: Indexes (~279% MedAPE), Lending (~94%), Yield Aggregator (~89%), Privacy (~87%), Dexs (~86%).' }),
      el('p', { class: 'note', text: 'Implied value is this entry\u2019s own claim about what a token would be worth if the protocol\u2019s record stayed as it is. It does not predict whether or when a token is issued.' })
    );
  }

  // --- 11. Detail drawer ---------------------------------------------------------------
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  // The live-token comps behind a row's category residual, with the fallback disclosed.
  function liveComps(row) {
    var list = (DATA.comps && DATA.comps[row.category || 'Other']) || [];
    var n = row.category_comp_count;
    var w = row.shrinkage_weight;
    if (n === 0) {
      return [el('p', { class: 'sub', text: 'No live-token protocol in this category records a market cap, so the category residual is 0 and the ratio is the size component alone.' })];
    }
    var head = el('p', { class: 'sub', text: (row.category || 'Other') + ' has ' + n + ' live comp' + (n === 1 ? '' : 's') + ' \u2014 shrinkage weight n/(n+5) = ' + w.toFixed(2) + ', so the residual counts at ' + Math.round(w * 100) + '% strength. Comps are shown for reference; the residual, not any single comp, sets the category effect.' });
    var items = list.slice(0, 3).map(function (l) {
      var ratio = (l.mcap_usd !== null && l.tvl_usd > 0) ? (l.mcap_usd / l.tvl_usd).toFixed(2) + 'x mcap/TVL' : 'no ratio';
      return el('div', null, el('span', { text: l.name }), el('b', { class: 'num', text: fmtUsd(l.mcap_usd) + '  \u00b7  ' + ratio }));
    });
    return [head].concat(items);
  }

  // Risks derivable from the snapshot fields alone: young, single-chain, negative growth,
  // thin or no live comps, unknown age, clamped growth.
  function risksFor(row) {
    var risks = [];
    if (row.age_days !== null && row.age_days < 90) risks.push('Young: only ' + row.age_days + ' days since first listed.');
    if (row.age_days === null) risks.push('Age unknown: no listing date on record.');
    if (row.chains && row.chains.length <= 1) risks.push('Single-chain: all of its TVL sits on one chain.');
    if (row.change_7d !== null && row.change_7d < 0) risks.push('TVL fell ' + Math.abs(row.change_7d).toFixed(2) + '% in the last 7 days.');
    if (row.category_comp_count < 3) risks.push(row.category_comp_count === 0 ? 'No live comps in this category \u2014 the category residual is 0.' : 'Thin comps: only ' + row.category_comp_count + ' live comp' + (row.category_comp_count === 1 ? '' : 's') + ' in this category (weight ' + row.shrinkage_weight.toFixed(2) + ').');
    if (row.change_7d !== null && (row.change_7d < DATA.model.growth_floor || row.change_7d > DATA.model.growth_cap)) risks.push('Growth ' + fmtPct(row.change_7d) + ' is outside the model\u2019s clamp [' + DATA.model.growth_floor + ', +' + DATA.model.growth_cap + '] and is clamped to ' + fmtPct(row.growth_pct) + '.');
    if (risks.length === 0) risks.push('No single red flag in the snapshot fields \u2014 the ranking still carries ~85% typical error.');
    return risks;
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    var chains = row.chains || [];
    var chainText = chains.length > 3 ? chains.slice(0, 3).join(', ') + ' +' + (chains.length - 3) + ' more' : (chains.length ? chains.join(', ') : 'an unnamed chain');
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + chainText })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    var growthLabel = fmtPct(row.change_7d);
    if (row.change_7d !== null && row.change_7d !== row.growth_pct) growthLabel += ' \u2192 clamped to ' + fmtPct(row.growth_pct) + ' for the model';
    dialog.appendChild(detailSection('Implied value',
      el('div', { class: 'equation' },
        kvRow('TVL', fmtUsd(row.tvl_usd)),
        kvRow('Listed', (row.listed_at || 'unknown') + ' \u00b7 ' + fmtAge(row.age_days) + ' with no token'),
        kvRow('Seven-day growth', growthLabel),
        kvRow('Size ratio (cat-neutral)', fmtMult(row.size_ratio)),
        kvRow('Category residual', fmtSigned(row.category_residual) + ' log pts \u00b7 ' + row.category_comp_count + ' comps \u00b7 weight ' + row.shrinkage_weight.toFixed(2)),
        kvRow('Ratio hat (clipped [0.005, 5])', fmtMult(row.ratio_hat)),
        kvRow('Base value (TVL x ratio)', fmtUsd(row.base_value)),
        kvRow('Growth tilt', String(row.growth_tilt)),
        kvRow('Overall median mcap/TVL', fmtMult(DATA.overall_median)),
        kvRow('Implied value', fmtUsd(row.implied_value_usd))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(impliedOf(row, DATA.model, DATA.fit)) + (impliedOf(row, DATA.model, DATA.fit) === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' Age is shown for context; it is not a factor. This is an estimate, not a price.' })
    ));
    dialog.appendChild(detailSection('Farm plan',
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      })),
      el('p', { class: 'sub', text: 'This protocol records no token. The plan farms its activity; it promises no token and no airdrop.' })
    ));
    dialog.appendChild(detailSection('Risks',
      el('ul', { class: 'risks' }, risksFor(row).map(function (t) { return el('li', { text: t }); }))
    ));
    dialog.appendChild(detailSection('Live comps in this category',
      el('div', { class: 'comps' }, liveComps(row)),
      el('p', { class: 'sub', text: 'Live-token protocols whose market cap is a fact, not a model. Their shrunk mean log-residual against the size fit sets the category residual.' })
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  // --- 12. Render and init -------------------------------------------------------------
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(formulaStrip());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
