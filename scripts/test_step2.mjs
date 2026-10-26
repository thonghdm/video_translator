import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

function httpRequest(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// 1. Kiểm tra mô phỏng cơ chế Range Request của MediaServer
test('Step 2: MediaServer HTTP Range Request Logic Verification', async () => {
  const dummyBuffer = Buffer.alloc(10000);
  for (let i = 0; i < dummyBuffer.length; i++) {
    dummyBuffer[i] = i % 256;
  }

  const validToken = '4f8a9b1c2d3e4f5a6b7c8d9e0f1a2b3c';

  const server = http.createServer((req, res) => {
    const urlParts = req.url.split('/media/');
    const token = urlParts[1];

    if (token !== validToken) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': dummyBuffer.length,
        'Accept-Ranges': 'bytes',
      });
      res.end(dummyBuffer);
      return;
    }

    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : dummyBuffer.length - 1;
    const chunksize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${dummyBuffer.length}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    });
    res.end(dummyBuffer.subarray(start, end + 1));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // Test 1: Token sai -> 403 Forbidden
  const forbiddenRes = await httpRequest({
    host: '127.0.0.1',
    port,
    path: '/media/invalid_token',
    method: 'GET',
  });
  assert.equal(forbiddenRes.statusCode, 403);

  // Test 2: Đúng token không Range -> 200 OK
  const okRes = await httpRequest({
    host: '127.0.0.1',
    port,
    path: `/media/${validToken}`,
    method: 'GET',
  });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.headers['accept-ranges'], 'bytes');
  assert.equal(Number(okRes.headers['content-length']), 10000);

  // Test 3: Range request bytes=0-99 -> 206 Partial Content (100 bytes)
  const rangeRes1 = await httpRequest({
    host: '127.0.0.1',
    port,
    path: `/media/${validToken}`,
    method: 'GET',
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(rangeRes1.statusCode, 206);
  assert.equal(rangeRes1.headers['content-range'], 'bytes 0-99/10000');
  assert.equal(rangeRes1.body.length, 100);
  assert.equal(rangeRes1.body[0], dummyBuffer[0]);
  assert.equal(rangeRes1.body[99], dummyBuffer[99]);

  // Test 4: Range request bytes=9900- -> 206 Partial Content (100 bytes cuối)
  const rangeRes2 = await httpRequest({
    host: '127.0.0.1',
    port,
    path: `/media/${validToken}`,
    method: 'GET',
    headers: { Range: 'bytes=9900-' },
  });
  assert.equal(rangeRes2.statusCode, 206);
  assert.equal(rangeRes2.headers['content-range'], 'bytes 9900-9999/10000');
  assert.equal(rangeRes2.body.length, 100);
  assert.equal(rangeRes2.body[0], dummyBuffer[9900]);
  assert.equal(rangeRes2.body[99], dummyBuffer[9999]);

  server.close();
});

// 2. Kiểm tra cơ chế tách dòng CRLF cho output ffmpeg
test('Step 2: CRLF and CR progress parser verification', () => {
  function parseCRLF(rawText) {
    const lines = [];
    let cur = '';
    for (let i = 0; i < rawText.length; i++) {
      const ch = rawText[i];
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && i + 1 < rawText.length && rawText[i + 1] === '\n') {
          i++;
        }
        lines.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.length > 0) lines.push(cur);
    return lines;
  }

  const sample = "frame= 100 fps=30\rframe= 200 fps=31\nframe= 300 fps=30\r\nDone";
  const result = parseCRLF(sample);
  assert.equal(result.length, 4);
  assert.equal(result[0], "frame= 100 fps=30");
  assert.equal(result[1], "frame= 200 fps=31");
  assert.equal(result[2], "frame= 300 fps=30");
  assert.equal(result[3], "Done");
});

// 3. Kiểm tra cơ chế dập tắt tiến trình con khi timeout
test('Step 2: Subprocess tree kill simulation', async () => {
  const start = Date.now();
  const child = spawn('powershell.exe', ['-Command', 'Start-Sleep -Seconds 10'], {
    windowsHide: true,
  });

  // Hủy sau 500ms
  await new Promise((r) => setTimeout(r, 500));
  child.kill();

  await new Promise((r) => child.on('exit', r));
  const elapsed = Date.now() - start;

  // Đảm bảo thoát nhanh dưới 2.5 giây, không chờ 10 giây
  assert.ok(elapsed < 2500, `Tiến trình phải bị dập tắt nhanh, thực tế: ${elapsed}ms`);
});
