// Перезавантаження сторінки зі збереженим localStorage.
//
// Симптом: на CI-раннері (Linux, повільний) settings.mjs і invcstat.mjs
// падали по черзі, а локально й на повторі проходили. В обох випадках після
// page.reload() сторінка бачила СТАРИЙ localStorage: settings записав
// setSec='zzz', а нова сторінка прочитала попереднє 'app' (→ 'data');
// invcstat дочекався прапорця invcStSync у deskState, а після reload його
// не було, і одноразове вирівнювання станів спрацювало вдруге. Chromium
// передає записи localStorage у процес браузера асинхронно, і reload іноді
// їх випереджає.
//
// Проби перевіряють логіку апки, а не доставку localStorage у Chromium, тож
// стан переносимо через window.name: він переживає reload у тій самій
// вкладці, а RESTORE_SCRIPT (init script, ДО скриптів апки) кладе знімок
// назад у localStorage. Сторінка стартує рівно з того, що було перед reload.

const MARK = 'groshi-probe-restore:';

// Реєструвати в context.addInitScript ПЕРШИМ, раніше за посів даних:
// посів бачить уже відновлений стан і вдруге не сіє.
export function RESTORE_SCRIPT() {
  const mark = 'groshi-probe-restore:';
  if (!window.name.startsWith(mark)) return;
  const snap = JSON.parse(window.name.slice(mark.length));
  window.name = '';
  localStorage.clear();
  for (const [k, v] of Object.entries(snap)) localStorage.setItem(k, v);
}

export async function reloadKeepingStorage(page) {
  await page.evaluate(mark => {
    const snap = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      snap[k] = localStorage.getItem(k);
    }
    window.name = mark + JSON.stringify(snap);
  }, MARK);
  await page.reload();
}
