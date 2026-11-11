// scripts/mp3gain.mjs —— 調整自製 mp3 的音量,不重新壓縮,音質不變
// 用法:node scripts/mp3gain.mjs <檔案.mp3> [dB]
//   只給檔案:顯示格式(取樣率、聲道、長度),不改檔
//   給 dB:直接改寫原檔,例如 -6 是音量減半;舊版可從 git 取回
// 只能一格 1.5 dB 調整,會取最接近的格數
// 原理:改每個音框的 global_gain(mp3gain 的做法),只支援 MPEG Layer III(.mp3)
// 零相依套件

import { readFileSync, writeFileSync } from 'node:fs';

const [file, dbArg] = process.argv.slice(2);
if (!file) {
  console.log('用法:node scripts/mp3gain.mjs <檔案.mp3> [dB]   例:node scripts/mp3gain.mjs assets/audio/228-meeting.mp3 -6');
  process.exit(1);
}

const buf = readFileSync(file);

if (buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp') {
  console.error('這是 m4a/mp4 檔,不是 mp3。請先轉成 mp3 再調整。');
  process.exit(1);
}

// 跳過開頭的 ID3v2 標籤與結尾的 ID3v1 標籤
let start = 0;
if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'ID3') {
  const size = ((buf[6] & 127) << 21) | ((buf[7] & 127) << 14) | ((buf[8] & 127) << 7) | (buf[9] & 127);
  const hasFooter = (buf[5] & 0x10) !== 0;
  start = 10 + size + (hasFooter ? 10 : 0);
}
let end = buf.length;
if (end >= 128 && buf.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128;

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// 讀 i 位置的音框標頭,不是合法的 Layer III 標頭就回傳 null
function readHeader(i) {
  if (i + 4 > end) return null;
  if (buf[i] !== 0xFF || (buf[i + 1] & 0xE0) !== 0xE0) return null;
  const version = (buf[i + 1] >> 3) & 3; // 3=MPEG-1、2=MPEG-2、0=MPEG-2.5
  const layer = (buf[i + 1] >> 1) & 3;   // 1=Layer III
  const bitrateIndex = buf[i + 2] >> 4;
  const rateIndex = (buf[i + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const lsf = version !== 3;
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  const bitrate = (lsf ? BITRATES_V2 : BITRATES_V1)[bitrateIndex] * 1000;
  const padding = (buf[i + 2] >> 1) & 1;
  const length = Math.floor((lsf ? 72 : 144) * bitrate / sampleRate) + padding;
  if (i + length > end) return null;
  return {
    lsf,
    sampleRate,
    length,
    channels: (buf[i + 3] >> 6) === 3 ? 1 : 2,
    hasCrc: (buf[i + 1] & 1) === 0,
    samples: lsf ? 576 : 1152,
  };
}

// 下一個音框也接得上,才當作真的標頭(避免把資料裡的 0xFF 誤認成標頭)
function readConfirmedHeader(i) {
  const h = readHeader(i);
  if (!h) return null;
  if (i + h.length === end) return h;
  if (readHeader(i + h.length)) return h;
  return null;
}

function findNextFrame(from) {
  for (let j = from; j + 4 <= end; j++) {
    if (readConfirmedHeader(j)) return j;
  }
  return -1;
}

function exitNotMp3() {
  console.error('找不到 mp3 音訊。這個檔可能不是 mp3(例如 .m4a、.wav),或檔案已損壞。');
  process.exit(1);
}

const frames = [];
let gapBytes = 0;
let pos = findNextFrame(start);
if (pos < 0) exitNotMp3();
while (pos >= 0 && pos < end) {
  const h = readHeader(pos);
  if (!h) {
    const next = findNextFrame(pos + 1);
    if (next < 0) break; // 後面是結尾標籤之類的資料,不處理
    gapBytes += next - pos;
    pos = next;
    continue;
  }
  frames.push({ pos, header: h });
  pos += h.length;
}

// 真的 mp3 幾乎整個檔都是音框;只找到零星幾個,是別種檔案裡碰巧長得像
const frameBytes = frames.reduce((sum, f) => sum + f.header.length, 0);
if (frames.length < 10 || frameBytes < (end - start) / 2) exitNotMp3();

const first = frames[0].header;
const seconds = frames.reduce((sum, f) => sum + f.header.samples / f.header.sampleRate, 0);
const minutes = Math.floor(seconds / 60);
const secs = Math.round(seconds % 60).toString().padStart(2, '0');
console.log(`${file}`);
console.log(`  ${first.sampleRate} Hz、${first.channels === 1 ? '單聲道' : '立體聲'}、長 ${minutes}:${secs}、${frames.length} 個音框`);
if (first.sampleRate < 32000) console.log('  注意:取樣率偏低,音質接近電話;有原始錄音的話建議換原始檔');

if (dbArg === undefined) process.exit(0);

const db = Number(dbArg);
const steps = Math.round(db / 1.5);
if (!Number.isFinite(db) || steps === 0) {
  console.error('dB 要是數字,而且至少 ±1.5(例如 -6 是減半、-3 是小一點)');
  process.exit(1);
}
if (frames.some(f => f.header.hasCrc)) {
  console.error('這個檔的音框有 CRC 校驗,本工具不支援,檔案未修改。');
  process.exit(1);
}
if (gapBytes > 0) {
  console.error(`音框之間有 ${gapBytes} bytes 無法辨識的資料,為了安全不處理,檔案未修改。`);
  process.exit(1);
}

function getBits(bitPos, count) {
  let value = 0;
  for (let k = 0; k < count; k++) {
    const p = bitPos + k;
    value = (value << 1) | ((buf[p >> 3] >> (7 - (p & 7))) & 1);
  }
  return value;
}

function setBits(bitPos, count, value) {
  for (let k = 0; k < count; k++) {
    const p = bitPos + k;
    const mask = 1 << (7 - (p & 7));
    if ((value >> (count - 1 - k)) & 1) buf[p >> 3] |= mask;
    else buf[p >> 3] &= ~mask;
  }
}

// side info 的格式:MPEG-1 每聲道 2 個 granule、每段 59 bits;MPEG-2/2.5 只有 1 個、每段 63 bits
// global_gain 在每段第 21 bit 起的 8 bits
let changed = 0;
let clipped = 0;
for (const f of frames) {
  const h = f.header;
  const sideInfoBit = (f.pos + 4 + (h.hasCrc ? 2 : 0)) * 8;
  const gainBits = [];
  if (h.lsf) {
    const base = sideInfoBit + 8 + (h.channels === 1 ? 1 : 2);
    for (let ch = 0; ch < h.channels; ch++) gainBits.push(base + ch * 63 + 21);
  } else {
    const base = sideInfoBit + 9 + (h.channels === 1 ? 5 : 3) + 4 * h.channels;
    for (let k = 0; k < 2 * h.channels; k++) gainBits.push(base + k * 59 + 21);
  }
  for (const bit of gainBits) {
    const gain = getBits(bit, 8);
    if (gain === 0) continue; // 0 是靜音或檔頭資訊框,不動
    let next = gain + steps;
    if (next < 1) { next = 1; clipped++; }
    if (next > 255) { next = 255; clipped++; }
    setBits(bit, 8, next);
    changed++;
  }
}

writeFileSync(file, buf);
const percent = Math.round(Math.pow(2, steps / 4) * 100);
console.log(`  已調整音量 ${steps > 0 ? '+' : ''}${(steps * 1.5).toFixed(1)} dB(約為原本的 ${percent}%),改了 ${changed} 處`);
if (clipped > 0) console.log(`  注意:有 ${clipped} 處已到上下限,沒有完全照比例調整`);
if (steps > 0) console.log('  注意:調大聲時,原本就很大聲的地方可能會破音,請試聽');
