// Штучні операції для знімків і проб. Поля повторюють запис, що його
// видає desktop/dist/mononorm.js (amount завжди у гривні й додатний,
// напрямок у dir), тож екрани з даними малюються так само, як зі справжніми.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function syntheticTx(days = 120) {
  const kinds = [
    ['Продукти', 'Супермаркет', '5411', false],
    ['Кафе і ресторани', 'Кава', '5814', false],
    ['Транспорт', 'Таксі', '4121', false],
    ['Підписки', 'Музика', '4899', false],
    ['Зарплата', 'Надходження', '', true],
    ['Фриланс', 'Надходження', '', true],
  ];
  const out = [];
  let n = 0;
  const start = Date.now() - days * 864e5;
  for (let d = 0; d < days; d++) {
    const date = new Date(start + d * 864e5).toISOString().slice(0, 10);
    for (let k = 0; k < 3; k++) {
      const [cat, sub, mcc, income] = kinds[(d * 3 + k) % kinds.length];
      out.push({
        id: 's' + (++n), date, time: `1${k}:00`,
        merchant: `${sub} ${d % 7}`,
        amount: income ? 20000 + (d % 5) * 1500 : 60 + ((d * 37 + k * 91) % 900),
        dir: income ? 'income' : 'expense', conf: 'mono', balance: 50000,
        mcc, cat, sub, account: 'Чорна картка', acctype: 'black',
      });
    }
    /* Рух коштів і перекази людям — раз на десять днів: потрібні пробам
       підсумків (advdata.mjs), а частіше вони б перекосили решту картинки. */
    if (d % 10 === 5) {
      const ex = (cat, sub, amount, dir = 'expense', merchant = sub) => out.push({
        id: 's' + (++n), date, time: '18:00', merchant, amount, dir, conf: 'mono',
        balance: 50000, mcc: '', cat, sub, account: 'Чорна картка', acctype: 'black',
      });
      ex('Між рахунками', 'Свої рахунки', 15000);
      ex('Між рахунками', 'Свої рахунки', 15000, 'income');
      ex('Інвестиції', 'Брокер', 8000, 'expense', 'TransferGo');
      ex('Перекази', 'Людям', 2500, 'expense', 'Олена П.');
      ex('Готівка', 'Банкомат', 3000, 'expense', 'Банкомат');
    }
  }
  return out;
}

// Запуск напряму пише файл; імпорт з інших проб лише дає syntheticTx().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(root, '.test-artifacts');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'synthetic.json'), JSON.stringify(syntheticTx()));
  console.log('synthetic.json:', syntheticTx().length, 'операцій');
}
