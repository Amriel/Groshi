'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Ключ надходить лише через середовище процесу: аргументи командного
// рядка й повідомлення CI можуть зберігатися у журналах.
function signInstaller(installer, publicKeyPath) {
  if (!installer || path.extname(installer).toLowerCase() !== '.exe') {
    throw new Error('Потрібен шлях до інсталятора .exe');
  }
  const encoded = process.env.GROSHI_SIGNING_KEY;
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('GROSHI_SIGNING_KEY не заданий або має неправильний формат');
  }
  const der = Buffer.from(encoded, 'base64');
  if (der.toString('base64') !== encoded) {
    der.fill(0);
    throw new Error('GROSHI_SIGNING_KEY має неправильний формат');
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('Не вдалося прочитати ключ підписування');
  } finally {
    der.fill(0);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Потрібен ключ Ed25519');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  if (publicKeyPath) {
    const expected = fs.readFileSync(publicKeyPath, 'utf8').trim();
    const actual = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    if (!/^[0-9a-fA-F]{64}$/.test(expected)
        || !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), actual)) {
      throw new Error('Ключ підписування не відповідає вбудованому відкритому ключу');
    }
  }
  const stat = fs.statSync(installer);
  if (!stat.isFile() || stat.size === 0 || stat.size > 100 * 1024 * 1024) {
    throw new Error('Інсталятор має бути звичайним файлом розміром до 100 МіБ');
  }
  const bytes = fs.readFileSync(installer);
  if (bytes.length === 0 || bytes.length > 100 * 1024 * 1024) {
    throw new Error('Інсталятор має неправильний розмір');
  }
  const signature = crypto.sign(null, bytes, privateKey);
  if (!crypto.verify(null, bytes, publicKey, signature)) {
    throw new Error('Не вдалося перевірити створений підпис');
  }
  const output = `${installer}.sig`;
  fs.writeFileSync(output, `${signature.toString('hex')}\n`);
  return output;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (!(args.length === 1 || (args.length === 3 && args[1] === '--public-key'))) {
      throw new Error('Використання: node scripts/sign-update.cjs <installer.exe> [--public-key <update-key.pub>]');
    }
    const output = signInstaller(args[0], args[2]);
    console.log(`Підпис створено: ${output}`);
  } catch (error) {
    // Повідомлення crypto не виводимо: помилки ключа вже перетворені
    // на безпечний текст без вмісту змінної середовища.
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { signInstaller };
