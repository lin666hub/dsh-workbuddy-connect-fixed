import fs from 'node:fs';

const token = process.argv[2];
const file = process.argv[3];
const url = process.argv[4];

const bytes = fs.readFileSync(file);
const boundary = '----dshBoundary2026';
const head = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.split(/[\\/]/).pop()}"\r\nContent-Type: application/gzip\r\n\r\n`,
  'ascii',
);
const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'ascii');

const response = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `token ${token}`,
    'User-Agent': 'dsh',
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  },
  body: Buffer.concat([head, bytes, tail]),
});
const text = await response.text();
console.log('status:', response.status);
console.log(text.slice(0, 600));
