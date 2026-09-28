const addressInput = document.getElementById('addr');
const portInput = document.getElementById('port');
const statusView = document.getElementById('s');
const latitudeView = document.getElementById('lat');
const longitudeView = document.getElementById('lon');
const metricsView = document.getElementById('metrics');
const query = new URLSearchParams(location.search);
addressInput.value = query.get('addr') || '';
portInput.value = query.get('port') || '8787';

let watchId = null;
let connection = null;
let connecting = null;
let wasmReady = null;
let responseBuffer = new Uint8Array(0);
let sending = false;
let latestPosition = null;
let running = false;
let sendTimer = null;
let lastFixAt = 0;
let lastAttemptAt = 0;
let lastSuccessAt = 0;
let sentCount = 0;
let connectCount = 0;
let lastLatency = 0;
const encoder = new TextEncoder();
const SEND_INTERVAL_MS = 1000;
const MAX_FIX_AGE_MS = 15000;

function status(message) { statusView.textContent = message; }
function updateMetrics() {
  const age = lastFixAt ? ((Date.now() - lastFixAt) / 1000).toFixed(1) + '초' : '-';
  const since = lastSuccessAt ? ((Date.now() - lastSuccessAt) / 1000).toFixed(1) + '초' : '-';
  metricsView.textContent = `GPS 수신 후 ${age} · 마지막 전송 후 ${since}\n전송 ${sentCount}회 · Tailcat 연결 ${connectCount}회 · 응답 ${lastLatency}ms`;
}

function loadTailcat() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const go = new Go();
      let result;
      try {
        result = await WebAssembly.instantiateStreaming(fetch('tailcat.wasm'), go.importObject);
      } catch (_) {
        const response = await fetch('tailcat.wasm');
        if (!response.ok) throw new Error(`Tailcat 로드 실패 (HTTP ${response.status})`);
        result = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
      }
      go.run(result.instance);
      for (let i = 0; i < 100; i++) {
        if (window.tailcatDial) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Tailcat 준비 시간 초과');
    })();
  }
  return wasmReady;
}

async function getConnection() {
  await loadTailcat();
  if (connection) return connection;
  if (!connecting) {
    connecting = tailcatDial({
      addr: addressInput.value.trim(),
      port: Number(portInput.value) || 8787,
      derpMapURL: 'https://tailcat.dev/derpmap.json'
    }).then(result => {
      connection = result;
      connectCount++;
      responseBuffer = new Uint8Array(0);
      updateMetrics();
      return result;
    }).finally(() => { connecting = null; });
  }
  return connecting;
}

function appendBytes(left, right) {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function headerEnd(bytes) {
  for (let i = 0; i <= bytes.length - 4; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

async function readResponse(stream) {
  while (true) {
    const end = headerEnd(responseBuffer);
    if (end >= 0) {
      const header = new TextDecoder().decode(responseBuffer.slice(0, end));
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error('서버 응답 길이가 없습니다.');
      const total = end + 4 + Number(match[1]);
      if (responseBuffer.length >= total) {
        responseBuffer = responseBuffer.slice(total);
        if (!/^HTTP\/1\.1 200\b/.test(header)) {
          const error = new Error(/^HTTP\/1\.1 403\b/.test(header)
            ? 'AAOS에서 mGPS를 모의 위치 앱으로 선택하세요.'
            : `서버 오류: ${header.split('\r\n')[0]}`);
          error.keepConnection = true;
          throw error;
        }
        return;
      }
    }
    const chunk = await stream.read();
    if (chunk === null) throw new Error('Tailcat 연결이 종료되었습니다.');
    responseBuffer = appendBytes(responseBuffer, chunk);
  }
}

function onPosition(position) {
  latestPosition = position;
  lastFixAt = Date.now();
  latitudeView.textContent = position.coords.latitude.toFixed(6);
  longitudeView.textContent = position.coords.longitude.toFixed(6);
  updateMetrics();
  transmit();
}

async function transmit() {
  if (!running || sending || !latestPosition) return;
  const now = Date.now();
  if (now - lastAttemptAt < SEND_INTERVAL_MS - 100) return;
  if (now - lastFixAt > MAX_FIX_AGE_MS) {
    status('휴대폰 GPS가 15초 넘게 갱신되지 않아 전송을 멈췄습니다. 위치 서비스를 확인하세요.');
    return;
  }
  lastAttemptAt = now;
  sending = true;
  try {
      const current = latestPosition;
      const coords = current.coords;
      const body = JSON.stringify({
        lat: coords.latitude, lon: coords.longitude,
        altitude: coords.altitude || 0, speed: coords.speed || 0,
        heading: coords.heading || 0, accuracy: coords.accuracy || 10
      });
      const bodyBytes = encoder.encode(body);
      status('GPS 확인됨 · Tailcat 연결 및 전송 중…');
      const started = Date.now();
      const stream = await getConnection();
      if (!running) return;
      const request = `POST /api/location HTTP/1.1\r\nHost: mockgps\r\nContent-Type: application/json\r\nContent-Length: ${bodyBytes.length}\r\nConnection: keep-alive\r\n\r\n${body}`;
      await stream.write(encoder.encode(request));
      await readResponse(stream);
      lastLatency = Date.now() - started;
      lastSuccessAt = Date.now();
      sentCount++;
      status('전송 완료 · ' + new Date().toLocaleTimeString());
      updateMetrics();
  } catch (error) {
    if (!error.keepConnection) {
      if (connection) connection.close();
      connection = null;
    }
    status('전송 실패: ' + (error.message || String(error)) + ' · 1초 후 재시도합니다.');
  } finally {
    sending = false;
  }
}

function geoError(error) {
  if (error.code === 1) status('위치 권한이 거부되었습니다. 브라우저의 이 사이트 위치 권한을 허용한 뒤 다시 누르세요.');
  else if (error.code === 2) status('위치를 확인할 수 없습니다. 휴대폰 위치 서비스를 켜고 다시 시도하세요.');
  else status('GPS 응답 시간 초과입니다. 위치 서비스와 신호를 확인한 뒤 다시 누르세요.');
}

function start() {
  if (!addressInput.value.trim()) return status('Tailcat 주소가 없습니다. QR을 다시 스캔하세요.');
  if (!navigator.geolocation) return status('이 브라우저는 GPS를 지원하지 않습니다. Safari 또는 Chrome에서 열어 주세요.');
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  if (sendTimer !== null) clearInterval(sendTimer);
  running = true;
  latestPosition = null;
  lastFixAt = 0;
  lastAttemptAt = 0;
  sendTimer = setInterval(() => { updateMetrics(); transmit(); }, SEND_INTERVAL_MS);
  updateMetrics();
  status('위치 확인 중… 권한 팝업이 없다면 이미 허용된 상태일 수 있습니다.');
  navigator.geolocation.getCurrentPosition(position => {
    if (!running) return;
    onPosition(position);
    watchId = navigator.geolocation.watchPosition(onPosition, geoError, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 15000
    });
  }, geoError, {enableHighAccuracy: false, maximumAge: 5000, timeout: 15000});
}

function stop() {
  running = false;
  latestPosition = null;
  if (sendTimer !== null) clearInterval(sendTimer);
  sendTimer = null;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (connection) connection.close();
  connection = null;
  status('중지됨');
  updateMetrics();
}
