/* ═══════════ РОЗБІР ІНВЕСТИЦІЙНИХ ДАНИХ (IBKR + BINANCE) ═══════════
   Брокер і біржа віддають сирі відповіді у своїх форматах; апці потрібні
   три рівні списки: позиції, операції та історія вартості портфеля.
   Розбір живе в інтерфейсі з тієї ж причини, що й mononorm: формати
   звітів міняються частіше за все інше, і правити їх треба без
   перезбирання застосунку. Сирі файли на диску лишаються недоторканими —
   перерозібрати можна будь-коли.

   Усі суми — в ВАЛЮТІ ІНСТРУМЕНТА. Конверсію в базову валюту робить
   апка своїми курсами: тут ми навмисне нічого не перераховуємо, щоб
   нормалізатор не залежав від курсів і не «запікав» їх у дані.        */
(function () {
  const num = v => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const r2 = n => Math.round(n * 100) / 100;

  /* IBKR пише дати як "20260815", а час — як "20260810;101112".
     Нам скрізь потрібен лише день: історія вартості й операції в апці
     живуть по днях, тож частину після ';' просто відкидаємо. */
  const day = s => {
    const d = String(s || "").split(";")[0];
    return /^\d{8}$/.test(d) ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : null;
  };

  /* ── IBKR FLEX XML ─────────────────────────────────────────────────
     Особливість Flex-звітів: усі дані сидять в АТРИБУТАХ елементів, а
     не в текстових вузлах. Тому скрізь getAttribute, і жодного
     textContent. Другий підводний камінь: користувач сам налаштовує,
     які секції входять у його Flex Query, — тож будь-якої секції може
     просто не бути, і це не помилка розбору, а привід попередити.    */
  function parseIbkr(xml, pos, ivt, navh, warn) {
    if (typeof DOMParser === "undefined") {
      warn.push("IBKR: середовище без DOMParser — XML не розібрано.");
      return;
    }
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    /* DOMParser ніколи не кидає — зіпсований XML він мовчки загортає
       в документ з <parsererror>. Якщо його не перевірити, далі все
       «розбереться» в нуль записів без жодного сигналу людині. */
    if (doc.getElementsByTagName("parsererror").length) {
      warn.push("IBKR: файл не схожий на коректний XML — звіт пропущено.");
      return;
    }
    // Поля XML не є розміткою: відхиляємо некоректний код валюти ще до
    // накопичення позицій, щоб підготовлений звіт не записав HTML у кеш.
    if (doc.documentElement.localName !== 'FlexQueryResponse' || doc.doctype) {
      warn.push('IBKR: потрібен FlexQueryResponse без DTD — звіт пропущено.');
      return;
    }
    for (const node of doc.querySelectorAll('[currency]')) {
      const currency = node.getAttribute('currency');
      if (currency && !/^[A-Z][A-Z0-9]{2,9}$/.test(currency)) {
        warn.push('IBKR: некоректний код валюти — звіт пропущено.');
        return;
      }
    }
    const statements = doc.getElementsByTagName("FlexStatement");
    if (!statements.length) {
      warn.push("IBKR: у файлі немає жодного FlexStatement — це точно Flex-звіт?");
      return;
    }
    let seq = 0; // резервний лічильник для операцій без власного id
    for (const st of statements) {
      const acct = st.getAttribute("accountId") || "";
      const baseCcy = st.getAttribute("currency") || "USD";
      const missing = [];
      const section = name => {
        const el = st.getElementsByTagName(name)[0];
        if (!el) missing.push(name);
        return el;
      };
      /* id позиції включає рахунок: у людини може бути кілька рахунків
         IBKR з тим самим тікером, і без рахунку вони злипнуться. */
      const pid = sym => "ibkr:" + sym + (acct ? ":" + acct : "");

      /* ── відкриті позиції ── */
      const op = section("OpenPositions");
      if (op) for (const p of op.getElementsByTagName("OpenPosition")) {
        const symbol = p.getAttribute("symbol") || "";
        if (!symbol) { warn.push("IBKR: позиція без тікера — пропущено."); continue; }
        const qty = num(p.getAttribute("position"));
        const price = num(p.getAttribute("markPrice"));
        const cat = (p.getAttribute("assetCategory") || "").toUpperCase();
        const descr = p.getAttribute("description") || "";
        /* IBKR і ETF, і акції маркує однаково як STK — розрізнити можна
           лише за описом. Це евристика, але для відображення її досить:
           на суми kind не впливає. */
        let kind = "stock";
        if (cat === "CASH") kind = "cash";
        else if (cat === "CRYPTO") kind = "crypto";
        else if (cat === "FUND" || /\b(ETF|FUND)\b/i.test(descr)) kind = "etf";
        pos.push({
          id: pid(symbol), src: "ibkr", kind,
          symbol, name: descr || symbol,
          qty, avgCost: num(p.getAttribute("costBasisPrice")),
          ccy: p.getAttribute("currency") || baseCcy,
          price,
          value: qty != null && price != null ? r2(qty * price) : null,
          /* біржа лістингу потрібна модулю котирувань: за нею апка
             вгадує суфікс Yahoo-символа (FWB → .F тощо) */
          exch: p.getAttribute("listingExchange") || ""
        });
      }

      /* ── угоди ── */
      const tr = section("Trades");
      if (tr) for (const t of tr.getElementsByTagName("Trade")) {
        const symbol = t.getAttribute("symbol") || "";
        const date = day(t.getAttribute("tradeDate"));
        if (!symbol || !date) { warn.push("IBKR: угода без тікера або дати — пропущено."); continue; }
        const side = (t.getAttribute("buySell") || "").toUpperCase();
        if (side !== "BUY" && side !== "SELL") {
          warn.push("IBKR: угода " + symbol + " " + date + " з невідомим напрямком «" + side + "» — пропущено.");
          continue;
        }
        const qty = Math.abs(num(t.getAttribute("quantity")) || 0);
        const price = num(t.getAttribute("tradePrice"));
        /* Комісію свідомо НЕ виносимо окремим записом type 'fee':
           у списку операцій вона лише подвоювала б рядки, а для
           підсумків апка й так бере amount угоди. Тому — в note. */
        const fee = Math.abs(num(t.getAttribute("ibCommission")) || 0);
        const ctry = t.getAttribute("issuerCountryCode") || "";
        if (ctry) {
          const ps = pos.find(x => x.symbol === symbol && x.src === "ibkr");
          if (ps && !ps.country) ps.country = ctry;
        }
        /* Реалізований P&L брокер рахує сам (FIFO) — беремо готовий,
           щоб картка позиції показувала «продано з прибутком X», а не
           змушувала апку вгадувати, які лоти закрились. */
        const pnl = num(t.getAttribute("fifoPnlRealized"));
        ivt.push({
          id: "ibkr:" + (t.getAttribute("transactionID") || t.getAttribute("tradeID") || "t" + seq++),
          src: "ibkr", type: side === "BUY" ? "buy" : "sell",
          date, symbol, qty, price,
          amount: price != null ? r2(Math.abs(qty * price)) : null,
          ccy: t.getAttribute("currency") || baseCcy,
          pnl: pnl ? r2(pnl) : 0,
          note: fee ? "комісія " + fee.toFixed(2) : ""
        });
      }

      /* ── грошові операції ── */
      const ct = section("CashTransactions");
      if (ct) for (const c of ct.getElementsByTagName("CashTransaction")) {
        const raw = c.getAttribute("type") || "";
        const amt = num(c.getAttribute("amount"));
        const date = day(c.getAttribute("dateTime"));
        if (amt == null || !date) { warn.push("IBKR: грошова операція без суми або дати — пропущено."); continue; }
        /* Порівнюємо за входженням, а не точно: IBKR любить варіації на
           кшталт "Broker Interest Received" / "Broker Interest Paid". */
        const low = raw.toLowerCase();
        let type = null;
        if (low.includes("payment in lieu") || low.includes("dividend")) type = "div";
        else if (low.includes("withholding tax")) type = "tax";
        else if (low.includes("deposits/withdrawals")) type = amt > 0 ? "deposit" : "withdraw";
        else if (low.includes("broker interest")) type = "interest";
        else if (low.includes("fee")) type = "fee";
        if (!type) {
          warn.push("IBKR: невідомий тип грошової операції «" + raw + "» (" + date + ") — пропущено.");
          continue;
        }
        /* Напрямок несе type, тому сума завжди додатна: інакше апці
           довелося б вгадувати, чи мінус у податку — це «повернули». */
        ivt.push({
          id: "ibkr:" + (c.getAttribute("transactionID") || "c" + seq++),
          src: "ibkr", type, date,
          symbol: c.getAttribute("symbol") || "",
          qty: null, price: null,
          amount: r2(Math.abs(amt)),
          ccy: c.getAttribute("currency") || baseCcy,
          note: c.getAttribute("description") || ""
        });
      }

      /* ── історія вартості портфеля ──
         Секція буває під двома іменами залежно від версії Flex Query,
         тож дивимось обидва. Дублікати по даті зливаємо — останній
         виграє: у звітах, що перекриваються, свіже число точніше. */
      const byDate = {};
      for (const tag of ["EquitySummaryInBase", "EquitySummaryByReportDateInBase"])
        for (const e of st.getElementsByTagName(tag)) {
          const d = day(e.getAttribute("reportDate"));
          const total = num(e.getAttribute("total"));
          if (d && total != null) byDate[d] = total;
        }
      if (!Object.keys(byDate).length) missing.push("EquitySummary");
      for (const d of Object.keys(byDate).sort())
        navh.push({ date: d, value: r2(byDate[d]), ccy: baseCcy });

      /* ── гроші на рахунку ──
         BASE_SUMMARY — це підсумковий рядок у базовій валюті, сума вже
         порахованих валютних рядків. Взяти і його — порахувати кеш двічі. */
      const cr = section("CashReport");
      if (cr) for (const c of cr.getElementsByTagName("CashReportCurrency")) {
        const ccy = c.getAttribute("currency") || "";
        if (!ccy || ccy === "BASE_SUMMARY") continue;
        const cash = num(c.getAttribute("endingCash"));
        /* Закриті валютні позиції лишають хвости на кшталт 0.0000001 —
           показувати такий «рахунок» людині нема сенсу. */
        if (cash == null || Math.abs(cash) < 0.005) continue;
        pos.push({
          id: pid(ccy), src: "ibkr", kind: "cash",
          symbol: ccy, name: "Гроші " + ccy,
          qty: 1, avgCost: null, ccy,
          price: r2(cash), value: r2(cash)
        });
      }

      if (missing.length)
        warn.push("IBKR (" + (acct || "рахунок") + "): у звіті немає секцій " + missing.join(", ") +
          " — додайте їх у Flex Query, якщо ці дані потрібні.");
    }
  }

  /* ── BINANCE ───────────────────────────────────────────────────────
     Binance роздає той самий актив по кількох гаманцях: спот, Earn
     (гнучкий і фіксований), фандинг. Людині цікава ОДНА позиція «скільки
     в мене BTC», тож усе зливаємо за активом і сумуємо кількість.
     avgCost лишаємо null: історію угод у v1 не тягнемо, а вигадувати
     середню ціну з нічого — гірше, ніж чесно показати прочерк.       */
  function parseBinance(raw, pos, warn, ivt) {
    /* ── угоди спота (myTrades по парах {актив}USDT) ──
       Дають журнал крипти, мітки на графіку і середню ціну входу.
       Суми — в USDT; для валютної лінзи апки це 'USD' (стейбл ≈ долар,
       і власного курсу USDT апка все одно не має). */
    if (ivt && raw.trades) {
      for (const asset of Object.keys(raw.trades)) {
        const list = Array.isArray(raw.trades[asset]) ? raw.trades[asset] : [];
        for (const t of list) {
          const ms = +t.time || 0;
          if (!ms) continue;
          const qty = parseFloat(t.qty) || 0;
          const quote = parseFloat(t.quoteQty) || 0;
          if (!qty || !quote) continue;
          ivt.push({
            id: "bin:" + (t.id != null ? asset + ":" + t.id : "t" + ms),
            src: "binance",
            type: t.isBuyer ? "buy" : "sell",
            date: new Date(ms).toISOString().slice(0, 10),
            symbol: asset,
            qty,
            price: parseFloat(t.price) || (quote / qty),
            amount: Math.round(quote * 100) / 100,
            ccy: "USD",
            pnl: 0,
            note: t.commission && parseFloat(t.commission)
              ? "комісія " + t.commission + " " + (t.commissionAsset || "") : ""
          });
        }
      }
    }
    const STABLE = { USDT: 1, USDC: 1, DAI: 1, BUSD: 1 };
    const prices = raw.prices || {};
    const map = {}; // asset → позиція, що збирається

    const add = (asset, qty, fromEarn) => {
      if (!asset || !(qty > 0)) return;
      /* Активи з префіксом LD — це старий спосіб Binance показувати
         кошти в Earn прямо в балансах (LDBTC = BTC у Flexible Earn).
         Ми ті ж кошти беремо з earnFlexible, тож LD-рядки — дублікати. */
      if (/^LD/.test(asset) && asset.length > 2) return;
      let p = map[asset];
      if (!p) {
        p = map[asset] = {
          id: "binance:" + asset, src: "binance",
          kind: STABLE[asset] ? "cash" : "crypto",
          symbol: asset, name: asset,
          qty: 0, avgCost: null, ccy: "USD",
          price: null, value: null
        };
      }
      p.qty += qty;
      if (fromEarn && !/\(\+ Earn\)/.test(p.name)) p.name += " (+ Earn)";
    };

    for (const b of raw.account && Array.isArray(raw.account.balances) ? raw.account.balances : [])
      add(b.asset, (num(b.free) || 0) + (num(b.locked) || 0), false);
    for (const key of ["earnFlexible", "earnLocked"])
      for (const row of Array.isArray(raw[key]) ? raw[key] : [])
        add(row.asset, num(row.totalAmount) || 0, true);
    for (const f of Array.isArray(raw.funding) ? raw.funding : [])
      add(f.asset, (num(f.free) || 0) + (num(f.locked) || 0) + (num(f.freeze) || 0), false);

    for (const asset of Object.keys(map).sort()) {
      const p = map[asset];
      /* Стейблкоїни торгуються самі до себе, пари X+USDT для них нема —
         ціна за визначенням одиниця. Для решти беремо спотову пару до
         USDT; якщо її нема (делістинг, екзотика) — позицію показуємо
         без вартості, а не ховаємо: кількість людині все одно важлива. */
      /* Сума кількох гаманців у double дає хвости типу 0.12000000000001.
         Вісім знаків — рідна точність Binance, тож нічого не втрачаємо. */
      p.qty = Math.round(p.qty * 1e8) / 1e8;
      /* Ціна приходить або числом (старий кеш), або обʼєктом {p, chg} —
         тепер біржа віддає ще й добову зміну, і рядок позиції може
         сказати «▲2,3% сьогодні», не ходячи в мережу вдруге. */
      const t = prices[asset + "USDT"];
      const price = STABLE[asset] ? 1 : (t && typeof t === "object" ? num(t.p) : num(t));
      if (price == null) {
        warn.push("Binance: немає ціни для " + asset + " — позиція показана без вартості.");
      } else {
        p.price = price;
        p.value = r2(p.qty * price);
        if (t && typeof t === "object" && t.chg != null && !STABLE[asset]) p.dayChg = num(t.chg);
      }
      pos.push(p);
    }
  }

  window.invNormalize = function (input) {
    const { ibkrXml, binanceRaw } = input || {};
    const pos = [], ivt = [], navh = [], warn = [];
    /* Кожне джерело — у власному try: зіпсований звіт IBKR не має
       права поховати справні дані Binance, і навпаки. Назовні звідси
       не вилітає нічого — все погане перетворюється на warn. */
    /* Flex-звіт обмежений 365 днями, а інвестують людьми РОКАМИ — тому
       XML-ів може бути кілька (живий із веб-сервісу + імпортовані за
       старіші періоди), і вони склеюються:
       · позиції і кеш — ТІЛЬКИ з найсвіжішого файлу (за toDate):
         це знімок «зараз», зшивати його з торішнім не можна;
       · операції — з усіх файлів, перекриття прибирає дедуп: справжні
         id брокера унікальні назавжди, а для рядків без id (резервні
         "t0"/"c0", що злипаються МІЖ файлами) — підпис із полів;
       · історія вартості — обʼєднання по датах. */
    if (ibkrXml) {
      const xmls = (Array.isArray(ibkrXml) ? ibkrXml : [ibkrXml]).filter(Boolean);
      const toD = x => { const m = String(x).match(/toDate="(\d{8})"/); return m ? m[1] : "00000000"; };
      const newest = xmls.reduce((a, b) => (toD(b) > toD(a) ? b : a), xmls[0]);
      for (const x of xmls) {
        try { parseIbkr(String(x), x === newest ? pos : [], ivt, navh, warn); }
        catch (e) { warn.push("IBKR: не вдалося розібрати звіт (" + (e && e.message || e) + ")."); }
      }
      if (xmls.length > 1) {
        const seen = new Set();
        const sig = t => /:(t|c)\d+$/.test(t.id || "")
          ? [t.date, t.type, t.symbol, t.qty, t.amount, t.ccy].join("|")
          : t.id;
        for (let i = ivt.length - 1; i >= 0; i--) {
          const k = sig(ivt[i]);
          if (seen.has(k)) ivt.splice(i, 1); else seen.add(k);
        }
        const nseen = new Set();
        for (let i = navh.length - 1; i >= 0; i--) {
          if (nseen.has(navh[i].date)) navh.splice(i, 1); else nseen.add(navh[i].date);
        }
        navh.sort((a, b) => (a.date < b.date ? -1 : 1));
        ivt.sort((a, b) => (a.date < b.date ? -1 : 1));
      }
    }
    if (binanceRaw) {
      try { parseBinance(binanceRaw, pos, warn, ivt); }
      catch (e) { warn.push("Binance: не вдалося розібрати дані (" + (e && e.message || e) + ")."); }
    }
    return { pos, ivt, navh, warn };
  };
})();
