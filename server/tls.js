// TLS certificate for the phone side. Prefer certs/cert.pem + certs/key.pem (e.g. from mkcert);
// otherwise generate a self-signed cert once and cache it. Phones show a one-time warning for the
// self-signed one; after accepting it the page is still a secure context, which is what DeviceMotion needs.
const fs = require('fs');
const path = require('path');

function loadOrCreateCert(certDir, lan) {
  const certPath = path.join(certDir, 'cert.pem');
  const keyPath = path.join(certDir, 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), source: 'certs/' };
  }
  const selfsigned = require('selfsigned');
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lan.map((l) => ({ type: 7, ip: l.address })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'motion-demo' }], {
    keySize: 2048, days: 3650, algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private);
  return { cert: pems.cert, key: pems.private, source: 'self-signed (generated)' };
}

module.exports = { loadOrCreateCert };
