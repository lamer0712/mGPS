const addressInput = document.getElementById('addr');
const toggleButton = document.getElementById('toggle');
const statusView = document.getElementById('s');
const latitudeView = document.getElementById('lat');
const longitudeView = document.getElementById('lon');
const metricsView = document.getElementById('metrics');
const query = new URLSearchParams(location.search);
addressInput.value = query.get('addr') || '';

let watchId = null;
let connection = null;
let connecting = null;
let wasmReady = null;
let responseBuffer = new Uint8Array(0);
let sending = false;
let pendingPosition = null;
let running = false;
let lastFixAt = 0;
let lastSuccessAt = 0;
let lastFixTimestamp = null;
let lastFixLatitude = null;
let lastFixLongitude = null;
let sentCount = 0;
let connectCount = 0;
let lastLatency = 0;
const encoder = new TextEncoder();

function status(message) { statusView.textContent = message; }
function updateToggle() { toggleButton.textContent = running ? '정지' : '전송 시작'; }
function updateMetrics() {
  const fixTime = lastFixAt ? new Date(lastFixAt).toLocaleTimeString() : '-';
  const sendTime = lastSuccessAt ? new Date(lastSuccessAt).toLocaleTimeString() : '-';
  metricsView.textContent = `마지막 GPS 수신 ${fixTime} · 마지막 전송 ${sendTime}\n전송 ${sentCount}회 · Tailcat 연결 ${connectCount}회 · 응답 ${lastLatency}ms`;
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
      port: 8787,
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
  if (!running) return;
  if (position.timestamp === lastFixTimestamp && position.coords.latitude === lastFixLatitude && position.coords.longitude === lastFixLongitude) return;
  lastFixTimestamp = position.timestamp;
  lastFixLatitude = position.coords.latitude;
  lastFixLongitude = position.coords.longitude;
  pendingPosition = position;
  lastFixAt = Date.now();
  latitudeView.textContent = position.coords.latitude.toFixed(6);
  longitudeView.textContent = position.coords.longitude.toFixed(6);
  updateMetrics();
  transmit();
}

async function transmit() {
  if (!running || sending || !pendingPosition) return;
  sending = true;
  try {
    while (running && pendingPosition) {
      const current = pendingPosition;
      pendingPosition = null;
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
      if (!running) return;
      lastLatency = Date.now() - started;
      lastSuccessAt = Date.now();
      sentCount++;
      status('전송 완료 · ' + new Date().toLocaleTimeString());
      updateMetrics();
    }
  } catch (error) {
    if (!error.keepConnection) {
      if (connection) connection.close();
      connection = null;
    }
    if (running) status('전송 실패: ' + (error.message || String(error)) + ' · 다음 GPS 수신 시 다시 전송합니다.');
  } finally {
    sending = false;
    if (running && pendingPosition) transmit();
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
  running = true;
  pendingPosition = null;
  lastFixAt = 0;
  lastFixTimestamp = null;
  lastFixLatitude = null;
  lastFixLongitude = null;
  updateToggle();
  updateMetrics();
  status('위치 확인 중… 권한 팝업이 없다면 이미 허용된 상태일 수 있습니다.');
  navigator.geolocation.getCurrentPosition(position => {
    if (!running) return;
    onPosition(position);
    watchId = navigator.geolocation.watchPosition(onPosition, geoError, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 15000
    });
  }, error => { if (running) { stop(); geoError(error); } }, {enableHighAccuracy: false, maximumAge: 5000, timeout: 15000});
}

function stop() {
  running = false;
  pendingPosition = null;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (connection) connection.close();
  connection = null;
  updateToggle();
  status('중지됨');
  updateMetrics();
}

function toggleTransmission() { if (running) stop(); else start(); }
