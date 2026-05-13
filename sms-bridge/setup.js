/**
 * setup.js — Downloads and installs express + cors without npm.
 * Run once: node setup.js
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const zlib  = require('zlib');

const INSTALL_DIR = 'C:\\PalawanSMS\\node_modules';

// Packages to install: [name, tarball URL from registry.npmjs.org]
const PACKAGES = [
  {
    name: 'express',
    url:  'https://registry.npmjs.org/express/-/express-4.19.2.tgz',
    deps: ['accepts','array-flatten','body-parser','content-disposition',
           'content-type','cookie','cookie-signature','debug','depd',
           'encodeurl','escape-html','etag','finalhandler','fresh',
           'http-errors','merge-descriptors','methods','on-finished',
           'parseurl','path-to-regexp','proxy-addr','qs','range-parser',
           'safe-buffer','send','serve-static','setprototypeof',
           'statuses','type-is','utils-merge','vary'],
  },
  {
    name: 'cors',
    url:  'https://registry.npmjs.org/cors/-/cors-2.8.5.tgz',
    deps: ['object-assign','vary'],
  },
];

// We'll fetch the full dependency tree from the registry
const fetched = new Set();

function mkdirp(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'palawan-setup/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error for ' + url)); }
      });
    }).on('error', reject);
  });
}

function downloadTarball(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    function get(u) {
      https.get(u, { headers: { 'User-Agent': 'palawan-setup/1.0' } }, res => {
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
    const gunzip  = zlib.createGunzip();
    const entries = [];
    let   buf     = Buffer.alloc(0);

    fs.createReadStream(tarPath).pipe(gunzip).on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
    }).on('end', () => {
      // Parse tar manually
      let offset = 0;
      while (offset < buf.length - 512) {
        const header = buf.slice(offset, offset + 512);
        const name   = header.slice(0, 100).toString('utf8').replace(/\0/g, '');
        if (!name) break;
        const sizeOctal = header.slice(124, 136).toString('utf8').replace(/\0/g, '').trim();
        const size      = parseInt(sizeOctal, 8) || 0;
        offset += 512;

        // Strip leading "package/" from path
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
    process.stdout.write('  [skip] ' + name + ' already installed\n');
    return;
  }

  process.stdout.write('  [get]  ' + name + ' ... ');

  let meta;
  try {
    meta = await fetchJson('https://registry.npmjs.org/' + name + '/latest');
  } catch(e) {
    process.stdout.write('FAILED (' + e.message + ')\n');
    return;
  }

  const tarUrl  = meta.dist.tarball;
  const tmpFile = path.join('C:\\PalawanSMS', name + '.tgz');

  try {
    await downloadTarball(tarUrl, tmpFile);
    await extractTarball(tmpFile, destDir);
    fs.unlinkSync(tmpFile);
    process.stdout.write('OK\n');
  } catch(e) {
    process.stdout.write('FAILED (' + e.message + ')\n');
    return;
  }

  // Install dependencies recursively
  const deps = Object.keys(meta.dependencies || {});
  for (const dep of deps) {
    await installPackage(dep);
  }
}

async function main() {
  console.log('');
  console.log('============================================');
  console.log(' Palawan Connect - SMS Bridge Setup');
  console.log('============================================');
  console.log('');
  console.log('Installing to: ' + INSTALL_DIR);
  console.log('');

  mkdirp(INSTALL_DIR);

  // Top-level packages
  const roots = ['express', 'cors'];
  for (const pkg of roots) {
    await installPackage(pkg);
  }

  console.log('');
  console.log('============================================');
  console.log(' Done! Run START-SERVER.bat to launch.');
  console.log('============================================');
  console.log('');
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
