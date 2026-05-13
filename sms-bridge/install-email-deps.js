/**
 * install-email-deps.js
 * Downloads nodemailer and imap-simple into C:\PalawanSMS\node_modules
 * Run once: node install-email-deps.js
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const zlib  = require('zlib');

const INSTALL_DIR = 'C:\\PalawanSMS\\node_modules';
const fetched = new Set();

function mkdirp(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mhc-install/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) return fetchJson(res.headers.location).then(resolve).catch(reject);
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function downloadTarball(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    function get(u) {
      https.get(u, { headers: { 'User-Agent': 'mhc-install/1.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
    }
    get(url);
  });
}

function extractTarball(tarPath, destDir) {
  return new Promise((resolve, reject) => {
    mkdirp(destDir);
    const gunzip = zlib.createGunzip();
    let buf = Buffer.alloc(0);
    fs.createReadStream(tarPath).pipe(gunzip)
      .on('data', chunk => { buf = Buffer.concat([buf, chunk]); })
      .on('end', () => {
        let offset = 0;
        while (offset < buf.length - 512) {
          const header = buf.slice(offset, offset + 512);
          const name   = header.slice(0, 100).toString('utf8').replace(/\0/g, '');
          if (!name) break;
          const size = parseInt(header.slice(124, 136).toString('utf8').replace(/\0/g, '').trim(), 8) || 0;
          offset += 512;
          const relPath = name.replace(/^[^/]+\//, '');
          if (relPath && size > 0) {
            const fullPath = path.join(destDir, relPath);
            mkdirp(path.dirname(fullPath));
            fs.writeFileSync(fullPath, buf.slice(offset, offset + size));
          }
          offset += Math.ceil(size / 512) * 512;
        }
        resolve();
      }).on('error', reject);
  });
}

async function installPackage(name) {
  if (fetched.has(name)) return;
  fetched.add(name);
  const destDir = path.join(INSTALL_DIR, name);
  if (fs.existsSync(path.join(destDir, 'package.json'))) {
    process.stdout.write('  [skip] ' + name + '\n'); return;
  }
  process.stdout.write('  [get]  ' + name + ' ... ');
  let meta;
  try { meta = await fetchJson('https://registry.npmjs.org/' + name + '/latest'); }
  catch(e) { process.stdout.write('FAILED (' + e.message + ')\n'); return; }
  const tmpFile = path.join('C:\\PalawanSMS', name.replace('/', '_') + '.tgz');
  try {
    await downloadTarball(meta.dist.tarball, tmpFile);
    await extractTarball(tmpFile, destDir);
    fs.unlinkSync(tmpFile);
    process.stdout.write('OK\n');
  } catch(e) { process.stdout.write('FAILED (' + e.message + ')\n'); return; }
  for (const dep of Object.keys(meta.dependencies || {})) {
    await installPackage(dep);
  }
}

async function main() {
  console.log('\n============================================');
  console.log(' MyHome Connect - Email Deps Installer');
  console.log('============================================\n');
  mkdirp(INSTALL_DIR);
  // Core email packages
  for (const pkg of ['nodemailer', 'imap-simple', 'express', 'cors']) {
    await installPackage(pkg);
  }
  console.log('\n============================================');
  console.log(' Done! Run START-EMAIL-SERVER.bat to launch.');
  console.log('============================================\n');
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
